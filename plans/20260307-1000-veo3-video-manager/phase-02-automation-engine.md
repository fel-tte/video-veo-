# Phase 2: Automation Engine

## Context Links

- [Research: Rod automation](research/researcher-01-report.md)
- [Research: Flow UI, blob URLs, CDP](research/researcher-02-report.md)
- [Phase 1: Foundation](phase-01-foundation-chrome-core.md)
- [Plan Overview](plan.md)

## Overview

- **Date:** 2026-03-07
- **Priority:** Critical
- **Status:** Not started
- **Depends on:** Phase 1 complete
- **Description:** Implement Flow page automation (navigate, input prompt, generate, wait), video blob URL interception via CDP, video download to disk, task queue worker with sequential processing and random delays, error handling with screenshot capture.

## Key Insights

- Flow URL: `labs.google/fx/tools/flow`
- Videos served via blob URLs (`blob:https://labs.google/[uuid]`) - no direct download links
- CDP `Network.responseReceived` can intercept video responses by MIME type (`video/mp4`, `video/webm`)
- Alternative: inspect `<video>` element `src` attribute after generation completes
- `WaitRequestIdle()` better than fixed waits for network stabilization
- Random delays between 30-120s between tasks to mimic human behavior
- Rate limit: ~3 videos/day on consumer tier; queue must handle daily limits gracefully
- Screenshots on error essential for debugging selector breakage

## Requirements

### Functional
- F1: Navigate to Flow page, detect if logged in or needs login
- F2: Input prompt text into Flow's prompt field
- F3: Click generate button and wait for video completion
- F4: Detect generation completion (video element appears or progress indicator disappears)
- F5: Intercept video blob URL via CDP or extract from DOM
- F6: Download video binary data and save to disk with meaningful filename
- F7: Sequential task queue worker (process one task at a time)
- F8: Random delay between tasks (configurable min/max)
- F9: Auto-retry failed tasks up to configurable max attempts
- F10: Screenshot capture on any automation error
- F11: Pause/resume/stop queue processing

### Non-Functional
- NF1: Graceful handling of Chrome crashes (detect disconnection, update status)
- NF2: No hardcoded selectors; store in configurable map
- NF3: Timeout for generation wait (configurable, default 5 minutes)
- NF4: Video files named: `{timestamp}_{first-20-chars-of-prompt}.mp4`

## Architecture

### Automation Flow (per task)

```
[Worker picks task from queue]
    |
    v
[Update task status -> "generating"]
[Emit "task:updated" event]
    |
    v
[Navigate to Flow page]
    |
    v
[Check login state] --NOT LOGGED IN--> [Emit "browser:login-required", pause queue]
    |
    v (logged in)
[Clear previous prompt if any]
    |
    v
[Type prompt into text field]
    |
    v
[Click Generate button]
    |
    v
[Wait for generation complete]
    | (poll: check for video element or completion indicator)
    | (timeout: 5 min default)
    |
    v
[Update task status -> "downloading"]
    |
    v
[Extract video URL from DOM or CDP interception]
    |
    v
[Download video binary -> save to disk]
    |
    v
[Update task: status="completed", video_path, completed_at]
[Emit "task:updated" event]
    |
    v
[Random delay before next task]
```

### Error Flow

```
[Any step fails]
    |
    v
[Capture screenshot -> save to error_screenshots/]
    |
    v
[Increment retry_count]
    |
    v
[retry_count < max_retries?]
    |-- YES --> [Set status="pending", re-queue]
    |-- NO  --> [Set status="failed", error_message, screenshot_path]
    |
    v
[Emit "task:updated" event]
[Continue to next task]
```

### Component Interaction

```
app.go
  |
  +--> queue.Manager
  |      |
  |      +--> queue.Worker (goroutine)
  |             |
  |             +--> chrome.FlowAutomator
  |             |       |
  |             |       +--> chrome.BrowserManager (page creation)
  |             |       +--> Navigate, type, click, wait
  |             |
  |             +--> downloader.Downloader
  |             |       |
  |             |       +--> CDP interception OR DOM extraction
  |             |       +--> Save file to disk
  |             |
  |             +--> storage.Repository (status updates)
  |
  +--> Wails Events (real-time UI updates)
```

## Related Code Files

### Files to Create

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/internal/chrome/veo3.go` | Create | Flow page automation: navigate, prompt, generate, wait |
| `c:/Users/Admin/Desktop/veo3/internal/chrome/selectors.go` | Create | CSS selector map, configurable |
| `c:/Users/Admin/Desktop/veo3/internal/downloader/downloader.go` | Create | Blob URL interception, video file save |
| `c:/Users/Admin/Desktop/veo3/internal/queue/manager.go` | Create | Queue CRUD, start/pause/stop |
| `c:/Users/Admin/Desktop/veo3/internal/queue/worker.go` | Create | Sequential task processing goroutine |

### Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/app.go` | Modify | Add queue/automation bindings and events |
| `c:/Users/Admin/Desktop/veo3/internal/storage/repository.go` | Modify | Add queue-specific queries (next pending, batch update) |

## Implementation Steps

### Step 1: CSS Selector Map

1. Create `internal/chrome/selectors.go`
2. Define selector constants as a map:
   ```go
   var DefaultSelectors = map[string]string{
       "prompt_input":       "textarea[aria-label='Describe your video']", // DISCOVER ACTUAL
       "generate_button":    "button[aria-label='Generate']",              // DISCOVER ACTUAL
       "video_element":      "video",
       "loading_indicator":  "[data-loading='true']",                      // DISCOVER ACTUAL
       "login_indicator":    "[data-user-signed-in]",                      // DISCOVER ACTUAL
       "download_button":    "button[aria-label='Download']",              // DISCOVER ACTUAL
   }
   ```
3. Allow overrides from `config` table in SQLite (key: `selector.{name}`, value: CSS selector)
4. Provide `GetSelector(name string) string` that checks DB override first, falls back to defaults
5. **IMPORTANT:** All selectors above are placeholders. Must be discovered by inspecting actual Flow UI during implementation. This is the first implementation task.

### Step 2: Flow Page Automator

1. Create `internal/chrome/veo3.go`
2. Define `FlowAutomator` struct:
   ```go
   type FlowAutomator struct {
       browser   *BrowserManager
       selectors map[string]string
       timeout   time.Duration
   }
   ```
3. Implement `NavigateToFlow(page *rod.Page) error`:
   - Navigate to `https://labs.google/fx/tools/flow`
   - `page.WaitLoad()` then `WaitRequestIdle(2*time.Second)()`
   - Return error on timeout
4. Implement `IsLoggedIn(page *rod.Page) bool`:
   - Check for login indicator element presence (use `page.Has()`)
   - Alternative: check for prompt input field existence as login proxy
5. Implement `SubmitPrompt(page *rod.Page, prompt string) error`:
   - Find prompt textarea via selector
   - Clear existing text: triple-click to select all, then type
   - `element.Input(prompt)` with human-like approach (Rod handles focus/scroll)
   - Small random delay (500-1500ms)
   - Find and click generate button
   - Wait for button state change (disabled/loading) as confirmation
6. Implement `WaitForGeneration(page *rod.Page) error`:
   - Poll loop with configurable timeout (default 5min)
   - Check for: video element appearance, loading indicator disappearance, error message
   - Use `page.Timeout(timeout).Element(selector)` pattern
   - On timeout: return descriptive error
   - On error message in UI: extract text, return as error
7. Implement `CaptureScreenshot(page *rod.Page, taskID int64) (string, error)`:
   - `page.Screenshot(true, nil)` for full page
   - Save to `{download_dir}/error_screenshots/{taskID}_{timestamp}.png`
   - Return saved path

### Step 3: Video Downloader

1. Create `internal/downloader/downloader.go`
2. Define `Downloader` struct with `downloadDir` config
3. Implement two download strategies (try in order):

**Strategy A: DOM Video Element Extraction**
```go
func (d *Downloader) ExtractFromDOM(page *rod.Page) (string, error) {
    // Find <video> element
    // Get src attribute
    // If blob URL, use page.Evaluate() to:
    //   - fetch blob URL via XMLHttpRequest
    //   - convert to base64
    //   - return base64 string
    // Decode base64 and save to file
}
```

**Strategy B: CDP Network Interception**
```go
func (d *Downloader) InterceptViaCDP(page *rod.Page) ([]byte, error) {
    // Enable Network domain
    // Listen for Network.responseReceived
    // Filter by MIME type (video/mp4, video/webm)
    // Get response body via Network.getResponseBody
    // Return raw bytes
}
```

4. Implement `SaveVideo(data []byte, prompt string) (string, error)`:
   - Generate filename: `{YYYYMMDD_HHmmss}_{sanitized_prompt_20chars}.mp4`
   - Sanitize prompt: remove special chars, truncate, replace spaces with underscores
   - Write to `{download_dir}/{filename}`
   - Return full path
5. Implement `GenerateThumbnail(videoPath string) (string, error)`:
   - DEFER to Phase 4 (optional); for now return empty string
   - Could use first frame extraction later

### Step 4: Queue Manager

1. Create `internal/queue/manager.go`
2. Define:
   ```go
   type Manager struct {
       repo     *storage.Repository
       worker   *Worker
       mu       sync.Mutex
       status   QueueStatus // "idle", "running", "paused", "stopping"
       onEvent  func(event string, data interface{})
   }

   type QueueStatus string
   const (
       QueueIdle     QueueStatus = "idle"
       QueueRunning  QueueStatus = "running"
       QueuePaused   QueueStatus = "paused"
       QueueStopping QueueStatus = "stopping"
   )
   ```
3. Implement `AddTask(prompt string) (*storage.Task, error)`:
   - Validate prompt (non-empty, reasonable length)
   - `repo.CreateTask(prompt)` with status "pending"
   - Emit "task:updated" event
4. Implement `AddBatch(prompts []string) ([]storage.Task, error)`:
   - Loop through prompts, create each
   - Return created tasks
5. Implement `ImportFromFile(filePath string) ([]storage.Task, error)`:
   - Detect file type by extension (.txt or .csv)
   - TXT: one prompt per line, skip empty lines
   - CSV: first column is prompt, skip header row
   - Call `AddBatch` with parsed prompts
6. Implement `Start()`, `Pause()`, `Resume()`, `Stop()`:
   - `Start()`: create Worker goroutine if not running
   - `Pause()`: signal worker to pause after current task
   - `Resume()`: signal worker to continue
   - `Stop()`: signal worker to stop, wait for current task to finish
7. Implement `RemoveTask(id int64) error`, `RequeueTask(id int64) error`
8. Implement `GetQueueStatus() QueueStatus`

### Step 5: Queue Worker

1. Create `internal/queue/worker.go`
2. Define:
   ```go
   type Worker struct {
       repo      *storage.Repository
       automator *chrome.FlowAutomator
       dl        *downloader.Downloader
       config    *config.AppConfig

       stopCh    chan struct{}
       pauseCh   chan struct{}
       resumeCh  chan struct{}
       doneCh    chan struct{}
   }
   ```
3. Implement `Run()` (main goroutine loop):
   ```
   loop:
       check stop signal -> break
       check pause signal -> wait for resume
       get next pending task from DB (ORDER BY created_at ASC LIMIT 1)
       if no task -> sleep 5s, continue
       process task
       random delay (min_delay to max_delay seconds)
   ```
4. Implement `processTask(task *storage.Task) error`:
   - Update status to "generating"
   - Get or create stealth page
   - Navigate to Flow
   - Check login -> if not logged in, emit event, pause queue
   - Submit prompt
   - Wait for generation
   - Update status to "downloading"
   - Download video (try DOM extraction, fallback to CDP)
   - Update task with video_path, status "completed"
   - On error: screenshot, increment retry, requeue or fail
5. Random delay implementation:
   ```go
   delay := rand.Intn(cfg.MaxDelay-cfg.MinDelay) + cfg.MinDelay
   time.Sleep(time.Duration(delay) * time.Second)
   ```

### Step 6: Wire Into App Bindings

1. Modify `app.go`:
   - Add `queue *queue.Manager` field
   - Initialize in `startup()`
   - Add bound methods:
     - `StartQueue() error`
     - `PauseQueue() error`
     - `ResumeQueue() error`
     - `StopQueue() error`
     - `GetQueueStatus() string`
     - `AddPrompt(prompt string) (*storage.Task, error)`
     - `AddPromptBatch(prompts []string) (int, error)` - returns count added
     - `ImportPromptsFromFile() (int, error)` - opens file dialog, imports
     - `RemoveTask(id int64) error`
     - `RequeueTask(id int64) error`
2. Wire events:
   - `task:updated` - emitted on every task status change, carries full Task object
   - `queue:status` - emitted on queue state change
   - `browser:login-required` - emitted when login needed, frontend shows alert

### Step 7: Integration Testing (Manual)

1. Start app, launch browser, log into Google
2. Add a single prompt via JS console
3. Start queue, observe:
   - Browser navigates to Flow
   - Prompt is entered
   - Generate button clicked
   - Video generation completes
   - Video downloaded to disk
4. Verify task status updates in real-time
5. Test error handling: use invalid prompt, verify screenshot captured
6. Test pause/resume: pause mid-queue, verify current task completes, queue stops
7. Test retry: simulate failure, verify retry count increments

## Todo List

- [ ] Discover actual CSS selectors from Flow UI (manual inspection)
- [ ] Implement selector map with DB override support
- [ ] Implement FlowAutomator (navigate, login check, prompt, generate, wait)
- [ ] Implement screenshot capture on error
- [ ] Implement Downloader (DOM extraction strategy)
- [ ] Implement Downloader (CDP interception fallback)
- [ ] Implement video file save with sanitized naming
- [ ] Implement Queue Manager (add, batch, import, start/pause/stop)
- [ ] Implement Queue Worker (sequential processing, delays, retry)
- [ ] Wire all bindings and events into app.go
- [ ] Manual end-to-end test: single video generation
- [ ] Manual test: batch queue processing
- [ ] Manual test: error handling and retry

## Success Criteria

1. Single prompt submitted via app produces downloaded video on disk
2. Queue processes multiple tasks sequentially with random delays
3. Failed tasks auto-retry up to configured max
4. Screenshots captured on automation errors
5. Frontend receives real-time task status updates via events
6. Pause/resume/stop controls work correctly
7. Login detection pauses queue and notifies user

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Flow UI selectors change | High | High | Configurable selector map; store in DB for hot-update |
| Blob URL extraction fails | Medium | Critical | Two strategies (DOM + CDP); manual download button click as third fallback |
| Generation timeout (>5min) | Medium | Medium | Configurable timeout; mark as failed, auto-retry |
| Chrome crashes mid-task | Low | Medium | Detect disconnection, mark task as failed, allow retry |
| Rate limiting by Google | Medium | High | Configurable delays; respect daily limits; pause on detection |
| reCAPTCHA triggered | Low (with session) | High | Session persistence primary defense; pause queue, notify user |

## Security Considerations

- Prompts stored in SQLite; no encryption needed (local desktop app)
- Video files saved locally; no upload or cloud sync
- Chrome session contains Google credentials; user-data-dir must be in user-protected directory
- No external API calls from app backend; all interaction via Chrome UI
- Import file parsing: validate input, prevent path traversal in filenames

## Unresolved Questions

- Exact Flow UI selectors (must be discovered during implementation)
- Whether Flow preserves prompt input across page reloads
- Blob URL lifetime: does it expire if page navigates away?
- Whether "Download" button in Flow UI triggers a direct file download (could be simpler than interception)
- Whether Flow shows an error message element for failed generations or just times out

## Next Steps

- Phase 3 depends on: all bindings and events working, task lifecycle complete
- Consider adding a "Download" button click strategy as simplest video retrieval method
- Monitor for Flow UI updates that may break selectors
