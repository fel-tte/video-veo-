package main

import (
	"context"
	"fmt"
	"log"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"veo3/internal/api"
	"veo3/internal/chrome"
	"veo3/internal/config"
	"veo3/internal/logging"
	"veo3/internal/queue"
	"veo3/internal/storage"
)

type App struct {
	ctx        context.Context
	config     *config.AppConfig
	configPath string
	repo       *storage.Repository
	browser    *chrome.BrowserManager
	selectors  *chrome.SelectorManager
	automator  *chrome.FlowAutomator
	apiClient  *api.Client
	queue      *queue.Manager
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Setup logging
	logDir := filepath.Join(config.GetAppDataDir(), "logs")
	if err := logging.Setup(logDir); err != nil {
		log.Printf("WARNING: failed to setup logging: %v", err)
	}

	// Load config
	a.configPath = config.ConfigPath()
	cfg, err := config.Load(a.configPath)
	if err != nil {
		log.Printf("WARNING: failed to load config: %v, using defaults", err)
		cfg = config.DefaultConfig()
	}
	a.config = cfg

	// Initialize SQLite
	dbPath := filepath.Join(config.GetAppDataDir(), "data.db")
	db, err := storage.NewDB(dbPath)
	if err != nil {
		log.Printf("ERROR: failed to init database: %v", err)
		return
	}
	a.repo = storage.NewRepository(db)

	// Create browser manager (not launched yet)
	a.browser = chrome.NewBrowserManager(cfg, func(status chrome.BrowserStatus) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "browser:status", string(status))
		}
	})

	// Create automation components
	a.selectors = chrome.NewSelectorManager(a.repo)
	a.automator = chrome.NewFlowAutomator(a.browser, a.selectors)
	a.apiClient = api.NewClient()
	a.queue = queue.NewManager(a.repo, a.apiClient, a.automator, cfg, func(event string, data interface{}) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, event, data)
		}
	})
}

func (a *App) shutdown(ctx context.Context) {
	log.Println("Shutting down...")
	if a.queue != nil {
		a.queue.Stop()
	}
	if a.browser != nil {
		a.browser.Close()
	}
	if a.repo != nil {
		a.repo.Close()
	}
	logging.Close()
}

// ============ Browser Bindings ============

func (a *App) LaunchBrowser() error {
	if a.browser == nil {
		return fmt.Errorf("browser manager not initialized")
	}
	return a.browser.Launch()
}

func (a *App) CloseBrowser() error {
	if a.browser == nil {
		return nil
	}
	return a.browser.Close()
}

func (a *App) GetBrowserStatus() string {
	if a.browser == nil {
		return string(chrome.StatusDisconnected)
	}
	return string(a.browser.GetStatus())
}

func (a *App) GetBrowserInfo() *chrome.BrowserInfo {
	if a.browser == nil {
		return &chrome.BrowserInfo{Status: string(chrome.StatusDisconnected)}
	}
	info := a.browser.GetInfo()
	return &info
}

// ============ Task Bindings ============

func (a *App) GetAllTasks() ([]storage.Task, error) {
	if a.repo == nil {
		return nil, fmt.Errorf("database not initialized")
	}
	tasks, err := a.repo.GetTasks(storage.TaskFilter{})
	if err != nil {
		return nil, err
	}
	if tasks == nil {
		return []storage.Task{}, nil
	}
	return tasks, nil
}

func (a *App) GetTasksByStatus(status string) ([]storage.Task, error) {
	if a.repo == nil {
		return nil, fmt.Errorf("database not initialized")
	}
	tasks, err := a.repo.GetTasks(storage.TaskFilter{Status: status})
	if err != nil {
		return nil, err
	}
	if tasks == nil {
		return []storage.Task{}, nil
	}
	return tasks, nil
}

func (a *App) CreateTask(prompt string) (*storage.Task, error) {
	if a.repo == nil {
		return nil, fmt.Errorf("database not initialized")
	}
	if prompt == "" {
		return nil, fmt.Errorf("prompt cannot be empty")
	}
	task, err := a.repo.CreateTask(prompt)
	if err != nil {
		return nil, err
	}
	runtime.EventsEmit(a.ctx, "task:updated", task)
	return task, nil
}

func (a *App) DeleteTask(id int64) error {
	if a.repo == nil {
		return fmt.Errorf("database not initialized")
	}
	err := a.repo.DeleteTask(id)
	if err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, "task:deleted", id)
	return nil
}

func (a *App) GetDashboardStats() (*storage.Stats, error) {
	if a.repo == nil {
		return nil, fmt.Errorf("database not initialized")
	}
	return a.repo.GetStats()
}

// ============ Config Bindings ============

func (a *App) GetAppConfig() *config.AppConfig {
	return a.config
}

func (a *App) UpdateAppConfig(cfg config.AppConfig) error {
	a.config = &cfg
	// Recreate browser manager with new config
	if a.browser != nil {
		a.browser = chrome.NewBrowserManager(&cfg, func(status chrome.BrowserStatus) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "browser:status", string(status))
			}
		})
	}
	// Update queue manager's config reference
	if a.queue != nil {
		a.queue.UpdateConfig(a.config)
	}
	return a.config.Save(a.configPath)
}

func (a *App) SelectDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Directory",
	})
}

// ============ Queue Bindings ============

func (a *App) StartQueue() error {
	if a.queue == nil {
		return fmt.Errorf("queue not initialized")
	}
	// Auto-launch Chrome if not connected
	if a.browser != nil && !a.browser.IsConnected() {
		log.Println("Auto-launching Chrome for queue...")
		if err := a.browser.Launch(); err != nil {
			return fmt.Errorf("auto-launch Chrome failed: %w", err)
		}
	}
	return a.queue.Start()
}

func (a *App) PauseQueue() {
	if a.queue != nil {
		a.queue.Pause()
	}
}

func (a *App) ResumeQueue() {
	if a.queue != nil {
		a.queue.Resume()
	}
}

func (a *App) StopQueue() {
	if a.queue != nil {
		a.queue.Stop()
	}
}

func (a *App) GetQueueStatus() string {
	if a.queue == nil {
		return string(queue.QueueIdle)
	}
	return string(a.queue.GetStatus())
}

func (a *App) AddPrompt(prompt string) (*storage.Task, error) {
	if a.queue == nil {
		return nil, fmt.Errorf("queue not initialized")
	}
	return a.queue.AddTask(prompt)
}

func (a *App) AddPromptBatch(prompts []string) (int, error) {
	if a.queue == nil {
		return 0, fmt.Errorf("queue not initialized")
	}
	tasks, err := a.queue.AddBatch(prompts)
	return len(tasks), err
}

func (a *App) ImportPromptsFromFile() (int, error) {
	if a.queue == nil {
		return 0, fmt.Errorf("queue not initialized")
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Import Prompts",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt)", Pattern: "*.txt"},
			{DisplayName: "CSV Files (*.csv)", Pattern: "*.csv"},
		},
	})
	if err != nil {
		return 0, err
	}
	if path == "" {
		return 0, nil
	}
	return a.queue.ImportFromFile(path)
}

func (a *App) RequeueTask(id int64) error {
	if a.queue == nil {
		return fmt.Errorf("queue not initialized")
	}
	return a.queue.RequeueTask(id)
}

// ============ Utility Bindings ============

func (a *App) DetectChromePath() string {
	if a.browser != nil {
		info := a.browser.GetInfo()
		if info.ChromePath != "" {
			return info.ChromePath
		}
	}
	return chrome.DetectChromePath()
}

// ============ Selector Bindings ============

func (a *App) GetSelectors() map[string]string {
	if a.selectors == nil {
		return map[string]string{}
	}
	return a.selectors.GetAll()
}

func (a *App) UpdateSelector(name, selector string) error {
	if a.selectors == nil {
		return fmt.Errorf("selectors not initialized")
	}
	return a.selectors.Set(name, selector)
}

// ============ API Bindings ============

func (a *App) GetCredits() (*api.CreditsResponse, error) {
	if a.apiClient == nil {
		return nil, fmt.Errorf("API client not initialized")
	}
	return a.apiClient.GetCredits()
}

func (a *App) RefreshAPIToken() error {
	if a.apiClient == nil {
		return fmt.Errorf("API client not initialized")
	}
	return a.apiClient.RefreshToken()
}
