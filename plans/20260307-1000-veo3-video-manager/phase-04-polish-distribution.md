# Phase 4: Polish & Distribution

## Context Links

- [Phase 1: Foundation](phase-01-foundation-chrome-core.md)
- [Phase 2: Automation](phase-02-automation-engine.md)
- [Phase 3: Frontend UI](phase-03-frontend-ui.md)
- [Plan Overview](plan.md)

## Overview

- **Date:** 2026-03-07
- **Priority:** Medium
- **Status:** Not started
- **Depends on:** Phases 1-3 complete
- **Description:** Add structured logging, system tray integration, batch completion notifications, finalize error handling, build configuration for Windows distribution, and testing strategy.

## Key Insights

- Wails v2 produces single .exe on Windows (no installer needed for basic distribution)
- System tray support built into Wails v2 runtime
- Go `log/slog` provides structured logging (stdlib, no external dep)
- Windows notifications via Wails runtime `Notification` API or `toast` package
- NSIS installer optional; single .exe sufficient for initial release

## Requirements

### Functional
- F1: Structured logging to file (rotated, configurable level)
- F2: System tray icon with context menu (show/hide window, quit)
- F3: Minimize to tray instead of closing
- F4: Desktop notification on batch completion or critical error
- F5: Graceful shutdown (stop queue, close browser, close DB)
- F6: App icon and window title branding

### Non-Functional
- NF1: Single .exe output under 50MB
- NF2: Log files at `%APPDATA%/veo3-manager/logs/`
- NF3: Log rotation: max 10MB per file, keep 5 files
- NF4: Startup time under 5 seconds total

## Architecture

### Logging Architecture

```
[Any Go module]
    |
    +--> slog.Info/Warn/Error(msg, attrs...)
            |
            +--> MultiHandler
                    |
                    +--> FileHandler (JSON format, rotated)
                    +--> StdoutHandler (text format, dev mode only)
```

### Shutdown Sequence

```
[User clicks Quit / window close]
    |
    v
[beforeClose callback]
    |
    +--> queue.Stop() (waits for current task to finish)
    +--> browser.Close() (graceful Chrome shutdown)
    +--> db.Close() (SQLite connection close)
    +--> logger.Close() (flush log file)
    |
    v
[App exits]
```

## Related Code Files

### Files to Create

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/internal/logging/logger.go` | Create | Structured logger setup, rotation |
| `c:/Users/Admin/Desktop/veo3/build/appicon.png` | Create | App icon (256x256) |
| `c:/Users/Admin/Desktop/veo3/build/windows/icon.ico` | Create | Windows icon |
| `c:/Users/Admin/Desktop/veo3/build/windows/info.json` | Create | Windows exe metadata |

### Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/main.go` | Modify | Add system tray, window options |
| `c:/Users/Admin/Desktop/veo3/app.go` | Modify | Add shutdown hooks, tray menu, notifications |
| `c:/Users/Admin/Desktop/veo3/wails.json` | Modify | Build config, icon, metadata |
| `c:/Users/Admin/Desktop/veo3/internal/queue/worker.go` | Modify | Add logging, batch completion notification |
| `c:/Users/Admin/Desktop/veo3/internal/chrome/browser.go` | Modify | Add logging |
| `c:/Users/Admin/Desktop/veo3/internal/chrome/veo3.go` | Modify | Add logging |
| `c:/Users/Admin/Desktop/veo3/internal/storage/db.go` | Modify | Add logging |

## Implementation Steps

### Step 1: Structured Logging

1. Create `internal/logging/logger.go`
2. Use Go 1.22+ `log/slog` package (stdlib)
3. Implement `SetupLogger(logDir string, level slog.Level) (*slog.Logger, error)`:
   - Create log directory if not exists
   - Open log file with date-based name: `veo3-manager-2026-03-07.log`
   - JSON format handler for file output
   - Text format handler for stdout (dev mode)
   - Use `slog.SetDefault()` for global access
4. Log rotation strategy (simple, no external deps):
   - On startup: check log files in directory
   - Delete files older than 7 days
   - If current file > 10MB, rotate (rename with timestamp suffix)
5. Add logging calls throughout existing code:
   - `chrome/browser.go`: browser launch/close, connection status
   - `chrome/veo3.go`: each automation step (navigate, prompt, generate, download)
   - `queue/worker.go`: task start/complete/fail, delays
   - `storage/db.go`: migration execution
   - `app.go`: startup, shutdown, binding calls
6. Log format: `{"time":"...","level":"INFO","msg":"task started","task_id":1,"prompt":"..."}`

### Step 2: Error Handling Review

1. Audit all Go functions for proper error wrapping:
   - Use `fmt.Errorf("context: %w", err)` pattern consistently
   - Never swallow errors silently
2. Ensure all Rod operations wrapped in timeout contexts
3. Verify all DB operations check and return errors
4. Add panic recovery in worker goroutine:
   ```go
   defer func() {
       if r := recover(); r != nil {
           slog.Error("worker panic recovered", "panic", r)
       }
   }()
   ```
5. Chrome disconnect detection:
   - Rod provides `browser.HandleCrash()` callback
   - On crash: update browser status, pause queue, log error, notify frontend

### Step 3: System Tray Integration

1. Modify `main.go` Wails options:
   ```go
   &options.App{
       Title:            "Veo3 Video Manager",
       Width:            1200,
       Height:           800,
       MinWidth:         800,
       MinHeight:        600,
       StartHidden:      false,
       HideWindowOnClose: true, // minimize to tray instead of quit
       // ... system tray config
   }
   ```
2. Implement system tray menu:
   - "Show Window" - brings app to front
   - "Start Queue" / "Pause Queue" - toggles queue state
   - Separator
   - "Quit" - triggers full shutdown
3. Tray icon states:
   - Default icon: idle
   - Animated/different icon: queue processing (optional, can be same icon)
4. Double-click tray icon: show window

### Step 4: Notifications

1. Implement notification triggers in `queue/worker.go`:
   - When all pending tasks complete (batch done): "All videos generated! {count} completed, {failed} failed"
   - When task fails after max retries: "Task failed: {truncated_prompt}"
2. Use Wails runtime notification or Windows-specific toast:
   ```go
   runtime.SendNotification(a.ctx, runtime.Notification{
       Title:   "Veo3 Manager",
       Message: "All 5 videos generated successfully!",
   })
   ```
3. Only notify when window is minimized/hidden (don't spam when user is looking at app)

### Step 5: Graceful Shutdown

1. Modify `app.go` `beforeClose` callback:
   ```go
   func (a *App) beforeClose(ctx context.Context) (prevent bool) {
       slog.Info("app shutting down")
       if a.queue.GetStatus() == queue.QueueRunning {
           a.queue.Stop() // waits for current task
       }
       a.browser.Close()
       a.db.Close()
       return false // allow close
   }
   ```
2. Handle force-quit (Ctrl+C / task manager):
   - Go signal handling: `signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)`
   - Trigger same cleanup sequence
3. Ensure no zombie Chrome processes on crash:
   - Rod's launcher tracks Chrome PID
   - `defer launcher.Kill()` in browser manager

### Step 6: Build Configuration

1. Update `wails.json`:
   ```json
   {
     "name": "Veo3 Video Manager",
     "outputfilename": "veo3-manager",
     "frontend:install": "npm install",
     "frontend:build": "npm run build",
     "author": {
       "name": "Veo3 Manager"
     }
   }
   ```
2. Create `build/windows/info.json` for exe metadata:
   ```json
   {
     "fixed": {
       "file_version": "1.0.0"
     },
     "info": {
       "0000": {
         "ProductVersion": "1.0.0",
         "ProductName": "Veo3 Video Manager",
         "FileDescription": "Automated video generation manager for Google Flow"
       }
     }
   }
   ```
3. App icon:
   - Create/obtain 256x256 PNG icon
   - Convert to ICO for Windows: `build/windows/icon.ico`
4. Build command: `wails build -platform windows/amd64`
5. Output: single `veo3-manager.exe` in `build/bin/`

### Step 7: Testing Strategy

**Unit Tests (Go):**
- `internal/storage/repository_test.go`: CRUD operations with in-memory SQLite
- `internal/config/config_test.go`: load/save/defaults
- `internal/queue/manager_test.go`: queue state transitions
- `internal/chrome/selectors_test.go`: selector override logic

**Integration Tests (Go, requires Chrome):**
- `internal/chrome/browser_test.go`: launch/close lifecycle
- `internal/chrome/stealth_test.go`: stealth mode verification (check navigator.webdriver)

**Manual Test Plan:**
1. Fresh install: app creates config + DB on first launch
2. Browser session: login persists across restarts
3. Single video: prompt -> generate -> download -> file on disk
4. Batch queue: 3+ prompts processed sequentially with delays
5. Error recovery: disconnect Chrome mid-task, verify retry
6. Tray: minimize to tray, notification received, restore from tray
7. Settings: change download folder, verify next video saves there
8. History: search, filter, re-queue failed task
9. Build: clean `wails build`, run .exe on fresh Windows machine

**No E2E browser tests planned** (Flow UI automation inherently fragile; manual testing more reliable).

### Step 8: README and Usage Documentation

1. Create `c:/Users/Admin/Desktop/veo3/README.md`:
   - Project description
   - Prerequisites (Go 1.22+, Node.js 18+, Chrome)
   - Build instructions (`wails build`)
   - Usage guide (first launch, login, adding prompts, starting queue)
   - Configuration reference
   - Troubleshooting (common issues)

## Todo List

- [ ] Set up structured logging with slog
- [ ] Add logging throughout all modules
- [ ] Implement log rotation (delete files >7 days)
- [ ] Audit and fix error handling across codebase
- [ ] Add panic recovery in worker goroutine
- [ ] Implement system tray with context menu
- [ ] Implement minimize-to-tray behavior
- [ ] Add desktop notifications for batch completion
- [ ] Implement graceful shutdown sequence
- [ ] Handle Chrome zombie process cleanup
- [ ] Create app icon (PNG + ICO)
- [ ] Configure wails.json for Windows build
- [ ] Create build/windows/info.json
- [ ] Run `wails build` and verify output
- [ ] Write unit tests for storage, config, queue
- [ ] Execute manual test plan
- [ ] Write README.md

## Success Criteria

1. Logs written to `%APPDATA%/veo3-manager/logs/` in JSON format
2. App minimizes to system tray; restores on double-click
3. Desktop notification appears on batch completion (when minimized)
4. Clean shutdown: no zombie Chrome processes, DB closed properly
5. `wails build` produces single .exe under 50MB
6. .exe runs on fresh Windows 11 machine (no Go/Node required)
7. All unit tests pass
8. Manual test plan fully executed with no blockers

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| System tray API differences across Windows versions | Low | Low | Wails handles abstraction; test on Win 10/11 |
| Large .exe size (Wails + React + Rod) | Medium | Low | Acceptable up to 50MB; strip debug symbols |
| Log files consume disk space | Low | Low | Rotation deletes old files; 7-day retention |
| Chrome zombie on crash | Medium | Medium | Rod PID tracking + defer Kill; OS process cleanup |

## Security Considerations

- Log files may contain prompts; stored in user-specific %APPDATA% (OS-protected)
- No secrets in logs (no API keys, no passwords)
- .exe distribution: consider code signing for trust (deferred, not MVP)
- No auto-update mechanism (manual download for now; avoids supply chain risk)

## Unresolved Questions

- Whether Wails v2 `HideWindowOnClose` works reliably on all Windows versions
- Optimal exe size after build (depends on React bundle + Go binary)
- Whether Windows Defender flags unsigned .exe (likely yes; code signing addresses this later)
- Log format preference: JSON vs structured text (JSON recommended for parseability)
