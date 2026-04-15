package queue

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"veo3/internal/api"
	"veo3/internal/chrome"
	"veo3/internal/config"
	"veo3/internal/storage"
)

type QueueStatus string

const (
	QueueIdle     QueueStatus = "idle"
	QueueRunning  QueueStatus = "running"
	QueuePaused   QueueStatus = "paused"
	QueueStopping QueueStatus = "stopping"
)

type Manager struct {
	repo      *storage.Repository
	apiClient *api.Client
	automator *chrome.FlowAutomator
	config    *config.AppConfig
	worker    *Worker
	mu        sync.Mutex
	status    QueueStatus
	OnEvent   func(event string, data interface{})
}

func NewManager(
	repo *storage.Repository,
	apiClient *api.Client,
	automator *chrome.FlowAutomator,
	cfg *config.AppConfig,
	onEvent func(event string, data interface{}),
) *Manager {
	return &Manager{
		repo:      repo,
		apiClient: apiClient,
		automator: automator,
		config:    cfg,
		status:    QueueIdle,
		OnEvent:   onEvent,
	}
}

func (m *Manager) AddTask(prompt string) (*storage.Task, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt cannot be empty")
	}
	task, err := m.repo.CreateTask(prompt)
	if err != nil {
		return nil, err
	}
	m.emitEvent("task:updated", task)
	return task, nil
}

func (m *Manager) AddBatch(prompts []string) ([]storage.Task, error) {
	var tasks []storage.Task
	for _, p := range prompts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		task, err := m.repo.CreateTask(p)
		if err != nil {
			return tasks, fmt.Errorf("create task: %w", err)
		}
		tasks = append(tasks, *task)
	}
	m.emitEvent("tasks:batch-added", len(tasks))
	return tasks, nil
}

func (m *Manager) ImportFromFile(filePath string) (int, error) {
	ext := strings.ToLower(filepath.Ext(filePath))
	var prompts []string
	var err error

	switch ext {
	case ".txt":
		prompts, err = readTxtFile(filePath)
	case ".csv":
		prompts, err = readCsvFile(filePath)
	default:
		return 0, fmt.Errorf("unsupported file type: %s (use .txt or .csv)", ext)
	}
	if err != nil {
		return 0, err
	}

	tasks, err := m.AddBatch(prompts)
	return len(tasks), err
}

func (m *Manager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.status == QueueRunning {
		return nil
	}

	m.worker = NewWorker(m.repo, m.apiClient, m.automator, func() *config.AppConfig {
		return m.config
	})
	m.worker.OnTaskUpdate = func(task *storage.Task) {
		m.emitEvent("task:updated", task)
	}
	m.worker.OnLoginRequired = func() {
		m.emitEvent("browser:login-required", nil)
	}
	m.worker.OnProgress = func(step, detail string) {
		m.emitEvent("queue:progress", map[string]string{"step": step, "detail": detail})
	}

	m.status = QueueRunning
	m.emitEvent("queue:status", string(m.status))
	go func() {
		m.worker.Run()
		m.mu.Lock()
		m.status = QueueIdle
		m.mu.Unlock()
		m.emitEvent("queue:status", string(QueueIdle))
	}()

	return nil
}

func (m *Manager) Pause() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.worker != nil && m.status == QueueRunning {
		m.worker.Pause()
		m.status = QueuePaused
		m.emitEvent("queue:status", string(m.status))
	}
}

func (m *Manager) Resume() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.worker != nil && m.status == QueuePaused {
		m.worker.Resume()
		m.status = QueueRunning
		m.emitEvent("queue:status", string(m.status))
	}
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.worker != nil {
		m.status = QueueStopping
		m.emitEvent("queue:status", string(m.status))
		m.worker.Stop()
		m.worker = nil
	}
}

func (m *Manager) RemoveTask(id int64) error {
	return m.repo.DeleteTask(id)
}

func (m *Manager) RequeueTask(id int64) error {
	return m.repo.UpdateTaskStatus(id, storage.StatusPending, map[string]interface{}{
		"retry_count":   0,
		"error_message": nil,
		"started_at":    nil,
		"completed_at":  nil,
	})
}

func (m *Manager) UpdateConfig(cfg *config.AppConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cfg
}

func (m *Manager) GetStatus() QueueStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) emitEvent(event string, data interface{}) {
	if m.OnEvent != nil {
		m.OnEvent(event, data)
	}
}

// File reading helpers

func readTxtFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines, scanner.Err()
}

func readCsvFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	var prompts []string
	isHeader := true
	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if isHeader {
			isHeader = false
			continue
		}
		if len(record) > 0 {
			p := strings.TrimSpace(record[0])
			if p != "" {
				prompts = append(prompts, p)
			}
		}
	}
	return prompts, nil
}
