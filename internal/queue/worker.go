package queue

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"time"

	"veo3/internal/api"
	"veo3/internal/chrome"
	"veo3/internal/config"
	"veo3/internal/storage"
)

type Worker struct {
	repo      *storage.Repository
	apiClient *api.Client
	automator *chrome.FlowAutomator
	getConfig func() *config.AppConfig

	stopCh   chan struct{}
	pauseCh  chan struct{}
	resumeCh chan struct{}

	projectID string // cached project ID from browser

	OnTaskUpdate    func(task *storage.Task)
	OnLoginRequired func()
	OnProgress      func(step string, detail string) // granular step progress
}

func NewWorker(
	repo *storage.Repository,
	apiClient *api.Client,
	automator *chrome.FlowAutomator,
	getConfig func() *config.AppConfig,
) *Worker {
	return &Worker{
		repo:      repo,
		apiClient: apiClient,
		automator: automator,
		getConfig: getConfig,
		stopCh:    make(chan struct{}),
		pauseCh:   make(chan struct{}, 1),
		resumeCh:  make(chan struct{}, 1),
	}
}

func (w *Worker) Run() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Worker panic recovered: %v", r)
		}
	}()

	log.Println("Queue worker started")

	// Initialize: get tokens from browser
	w.emitProgress("init", "Đang kết nối Chrome và lấy token...")
	if err := w.initSession(); err != nil {
		log.Printf("Session init failed: %v — need login", err)
		w.emitProgress("error", "Cần đăng nhập Google")
		if w.OnLoginRequired != nil {
			w.OnLoginRequired()
		}
		return
	}
	w.emitProgress("ready", "Sẵn sàng xử lý hàng đợi")

	for {
		select {
		case <-w.stopCh:
			log.Println("Queue worker stopped")
			return
		case <-w.pauseCh:
			log.Println("Queue worker paused")
			select {
			case <-w.resumeCh:
				log.Println("Queue worker resumed")
			case <-w.stopCh:
				log.Println("Queue worker stopped while paused")
				return
			}
		default:
		}

		task, err := w.repo.GetNextPending()
		if err != nil {
			log.Printf("Error getting next task: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}
		if task == nil {
			time.Sleep(5 * time.Second)
			continue
		}

		w.processTask(task)

		// Only delay if there are more pending tasks
		nextTask, _ := w.repo.GetNextPending()
		if nextTask == nil {
			log.Println("No more pending tasks, queue idle")
			w.emitProgress("completed", "Hàng đợi đã xử lý xong!")
			continue
		}

		// Random delay between tasks to avoid rate limiting
		cfg := w.getConfig()
		delay := cfg.MinDelay + rand.Intn(cfg.MaxDelay-cfg.MinDelay+1)
		log.Printf("Waiting %d seconds before next task", delay)
		w.emitProgress("waiting", fmt.Sprintf("Chờ %d giây trước task tiếp theo...", delay))

		select {
		case <-w.stopCh:
			return
		case <-time.After(time.Duration(delay) * time.Second):
		}
	}
}

// initSession navigates to Flow, extracts tokens and projectID from the browser.
func (w *Worker) initSession() error {
	page, err := w.automator.NavigateToFlow()
	if err != nil {
		return fmt.Errorf("navigate to flow: %w", err)
	}

	if !w.automator.IsLoggedIn(page) {
		return fmt.Errorf("not logged in")
	}

	// Set page for API client (token + reCAPTCHA extraction)
	w.apiClient.SetPage(page)

	// Refresh access token
	if err := w.apiClient.RefreshToken(); err != nil {
		return fmt.Errorf("refresh token: %w", err)
	}

	// Extract project ID from URL
	w.projectID = w.extractProjectID()

	if w.projectID == "" {
		return fmt.Errorf("no project ID found in browser")
	}

	log.Printf("Session initialized: project=%s", w.projectID)
	return nil
}

func (w *Worker) extractProjectID() string {
	browser := w.automator.GetBrowser()
	if browser == nil {
		return ""
	}
	pages, err := browser.Pages()
	if err != nil {
		return ""
	}
	for _, p := range pages {
		info := p.MustInfo()
		url := info.URL
		if idx := indexOf(url, "flow/project/"); idx >= 0 {
			rest := url[idx+len("flow/project/"):]
			end := len(rest)
			for i, c := range rest {
				if c == '/' || c == '?' {
					end = i
					break
				}
			}
			pid := rest[:end]
			if len(pid) > 10 {
				return pid
			}
		}
	}
	return ""
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func (w *Worker) processTask(task *storage.Task) {
	log.Printf("Processing task %d: %.50s...", task.ID, task.Prompt)
	promptShort := task.Prompt
	if len(promptShort) > 40 {
		promptShort = promptShort[:40] + "..."
	}

	// Update status to generating
	w.emitProgress("generating", fmt.Sprintf("Đang gửi prompt: %s", promptShort))
	w.updateTask(task.ID, storage.StatusGenerating, map[string]interface{}{
		"started_at": time.Now().Format(time.RFC3339),
	})

	// Read latest config at task processing time
	cfg := w.getConfig()
	model := mapModelKey(cfg.Model)
	aspectRatio := cfg.AspectRatio
	outputCount := cfg.OutputCount
	if outputCount < 1 {
		outputCount = 1
	}
	if outputCount > 4 {
		outputCount = 4
	}

	// Generate via HTTP API (supports multiple outputs per prompt)
	genResp, err := w.apiClient.GenerateVideo(w.projectID, task.Prompt, model, aspectRatio, outputCount)
	if err != nil {
		// Check if token expired
		if isAuthError(err) {
			w.emitProgress("auth", "Token hết hạn, đang làm mới...")
			log.Println("Auth error — refreshing token...")
			if refreshErr := w.apiClient.RefreshToken(); refreshErr != nil {
				log.Printf("Token refresh failed: %v — need re-login", refreshErr)
				w.emitProgress("error", "Cần đăng nhập lại Google")
				w.updateTask(task.ID, storage.StatusPending, nil)
				if w.OnLoginRequired != nil {
					w.OnLoginRequired()
				}
				w.Pause()
				return
			}
			// Retry once
			genResp, err = w.apiClient.GenerateVideo(w.projectID, task.Prompt, model, aspectRatio, outputCount)
		}
		if err != nil {
			w.emitProgress("error", fmt.Sprintf("Lỗi tạo video: %s", err.Error()))
			w.handleError(task, "generate failed: "+err.Error())
			return
		}
	}

	// Extract media IDs
	var mediaIDs []string
	for _, m := range genResp.Media {
		mediaIDs = append(mediaIDs, m.Name)
	}
	if len(mediaIDs) == 0 {
		w.emitProgress("error", "Không nhận được media ID từ API")
		w.handleError(task, "no media IDs in response")
		return
	}

	log.Printf("Task %d: generation started, mediaIDs=%v, credits=%d", task.ID, mediaIDs, genResp.RemainingCredits)
	w.emitProgress("polling", fmt.Sprintf("Đang chờ AI tạo video (%d output)... Credits: %d", len(mediaIDs), genResp.RemainingCredits))

	// Poll for completion
	results, err := w.apiClient.WaitForCompletion(w.projectID, mediaIDs, 5*time.Minute)
	if err != nil {
		w.emitProgress("error", "Timeout chờ video: "+err.Error())
		w.handleError(task, "generation timeout: "+err.Error())
		return
	}

	// Collect all successful media IDs
	var completedMediaIDs []string
	for _, m := range results {
		if m.MediaMetadata.MediaStatus.MediaGenerationStatus == api.StatusCompleted {
			completedMediaIDs = append(completedMediaIDs, m.Name)
		}
	}
	if len(completedMediaIDs) == 0 {
		w.emitProgress("error", "Tất cả video tạo thất bại")
		w.handleError(task, "all media failed generation")
		return
	}

	// Download all successful videos
	w.emitProgress("downloading", fmt.Sprintf("Đang tải %d video...", len(completedMediaIDs)))
	w.updateTask(task.ID, storage.StatusDownloading, nil)
	os.MkdirAll(cfg.DownloadDir, 0755)

	var downloadedPaths []string
	for i, mediaID := range completedMediaIDs {
		w.emitProgress("downloading", fmt.Sprintf("Tải video %d/%d...", i+1, len(completedMediaIDs)))
		filename := generateFilename(task.Prompt)
		if len(completedMediaIDs) > 1 {
			// Append index for multiple outputs: prompt_001.mp4, prompt_002.mp4
			ext := filepath.Ext(filename)
			base := filename[:len(filename)-len(ext)]
			filename = fmt.Sprintf("%s_%03d%s", base, i+1, ext)
		}
		outputPath := filepath.Join(cfg.DownloadDir, filename)

		if err := w.apiClient.DownloadVideo(mediaID, outputPath); err != nil {
			log.Printf("Task %d: download %d/%d failed: %v", task.ID, i+1, len(completedMediaIDs), err)
			continue
		}
		downloadedPaths = append(downloadedPaths, outputPath)
	}

	if len(downloadedPaths) == 0 {
		w.emitProgress("error", "Tất cả video tải thất bại")
		w.handleError(task, "all downloads failed")
		return
	}

	// Success — store all video paths as JSON array
	pathsJSON, _ := json.Marshal(downloadedPaths)
	w.updateTask(task.ID, storage.StatusCompleted, map[string]interface{}{
		"video_path":   string(pathsJSON),
		"completed_at": time.Now().Format(time.RFC3339),
	})

	w.emitProgress("completed", fmt.Sprintf("Hoàn thành! %d/%d video đã tải", len(downloadedPaths), len(completedMediaIDs)))
	log.Printf("Task %d completed: %d/%d videos downloaded", task.ID, len(downloadedPaths), len(completedMediaIDs))
}

func (w *Worker) handleError(task *storage.Task, errMsg string) {
	log.Printf("Task %d error: %s", task.ID, errMsg)

	fields := map[string]interface{}{
		"error_message": errMsg,
		"retry_count":   task.RetryCount + 1,
	}

	if task.RetryCount+1 >= task.MaxRetries {
		w.updateTask(task.ID, storage.StatusFailed, fields)
	} else {
		w.updateTask(task.ID, storage.StatusPending, fields)
	}
}

func (w *Worker) updateTask(id int64, status storage.TaskStatus, fields map[string]interface{}) {
	if fields == nil {
		fields = map[string]interface{}{}
	}
	if err := w.repo.UpdateTaskStatus(id, status, fields); err != nil {
		log.Printf("Failed to update task %d: %v", id, err)
		return
	}
	task, err := w.repo.GetTaskByID(id)
	if err != nil {
		return
	}
	if w.OnTaskUpdate != nil {
		w.OnTaskUpdate(task)
	}
}

func (w *Worker) emitProgress(step, detail string) {
	if w.OnProgress != nil {
		w.OnProgress(step, detail)
	}
}

func (w *Worker) Pause() {
	select {
	case w.pauseCh <- struct{}{}:
	default:
	}
}

func (w *Worker) Resume() {
	select {
	case w.resumeCh <- struct{}{}:
	default:
	}
}

func (w *Worker) Stop() {
	close(w.stopCh)
}

// mapModelKey maps config model names to API model keys.
func mapModelKey(configModel string) string {
	switch configModel {
	case "veo_3_1_fast", "veo_3_1_t2v_fast_ultra":
		return api.ModelVeo31Fast
	case "veo_3_1_fast_low", "veo_3_1_t2v_fast":
		return api.ModelVeo31FastLow
	case "veo_3_1_quality", "veo_3_1_t2v_quality":
		return api.ModelVeo31Quality
	case "veo_2_fast", "veo_2_t2v_fast":
		return api.ModelVeo2Fast
	case "veo_2_quality", "veo_2_t2v_quality":
		return api.ModelVeo2Quality
	default:
		return api.ModelVeo31Fast
	}
}

func isAuthError(err error) bool {
	s := err.Error()
	return indexOf(s, "401") >= 0 || indexOf(s, "403") >= 0 || indexOf(s, "unauthorized") >= 0
}

func generateFilename(prompt string) string {
	ts := time.Now().Format("20060102_150405")
	safe := sanitize(prompt)
	return fmt.Sprintf("%s_%s.mp4", ts, safe)
}

func sanitize(s string) string {
	var b []byte
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			b = append(b, byte(c))
		} else if len(b) > 0 && b[len(b)-1] != '_' {
			b = append(b, '_')
		}
	}
	if len(b) > 30 {
		b = b[:30]
	}
	for len(b) > 0 && b[len(b)-1] == '_' {
		b = b[:len(b)-1]
	}
	if len(b) == 0 {
		return "video"
	}
	return string(b)
}
