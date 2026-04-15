# Phase 1: Foundation & Chrome Core

## Context Links

- [Research: Wails, Rod, SQLite](research/researcher-01-report.md)
- [Research: Google Labs UI](research/researcher-02-report.md)
- [Plan Overview](plan.md)

## Overview

- **Date:** 2026-03-07
- **Priority:** Critical (blocks all other phases)
- **Status:** Not started
- **Description:** Scaffold Wails v2 project, set up SQLite with migrations, implement Rod browser manager with session persistence and stealth mode, establish Go backend structure and basic Wails bindings.

## Key Insights

- Wails v2 `react-ts` template provides React+Vite+TS out of the box
- `modernc.org/sqlite` eliminates CGO requirement; critical for clean Windows builds
- Rod's `stealth.MustPage()` must replace `browser.MustPage()` everywhere
- Chrome user-data-dir persistence avoids re-authentication; user logs in once manually
- WAL mode for SQLite enables better concurrent read/write patterns

## Requirements

### Functional
- F1: Initialize Wails v2 project with React+TS template
- F2: Go backend organized in `internal/` packages (chrome, queue, storage, downloader, config)
- F3: SQLite database with `tasks` and `config` tables, auto-migration on startup
- F4: Rod browser manager: launch Chrome, attach to existing session, detect login state
- F5: Stealth mode applied to all page creation
- F6: Basic Wails bindings: `GetTasks()`, `GetConfig()`, `LaunchBrowser()`, `GetBrowserStatus()`
- F7: Wails events: `browser:status`, `task:updated`

### Non-Functional
- NF1: Single binary output (no external dependencies except Chrome)
- NF2: Database stored in `%APPDATA%/veo3-manager/data.db`
- NF3: Config file at `%APPDATA%/veo3-manager/config.json`
- NF4: Startup time under 3 seconds (excluding browser launch)

## Architecture

### Go Package Structure

```
internal/
  chrome/
    browser.go      -- Browser lifecycle (launch, close, status)
    stealth.go      -- Stealth config wrapper
  storage/
    db.go           -- SQLite init, migrations, connection
    models.go       -- Task, Config Go structs
    repository.go   -- CRUD: CreateTask, GetTasks, UpdateTask, GetConfig, SetConfig
  queue/
    manager.go      -- Queue operations (add, remove, reorder, batch import)
    worker.go       -- Sequential task processor (Phase 2)
  downloader/
    downloader.go   -- Video download logic (Phase 2)
  config/
    config.go       -- App config struct, load/save JSON
```

### Data Flow (this phase)

```
[App Startup]
    |
    +--> config.Load() --> read/create config.json
    +--> storage.Init() --> open/create SQLite, run migrations
    +--> chrome.NewManager(config) --> ready (not launched yet)
    |
[User clicks "Launch Browser"]
    |
    +--> chrome.Launch() --> Rod + stealth, user-data-dir
    +--> emit "browser:status" event --> frontend updates
```

### SQLite Schema

```sql
-- Migration 001: Initial schema
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    video_path TEXT,
    thumbnail_path TEXT,
    error_message TEXT,
    screenshot_path TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Migration 002: Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Config Struct

```go
type AppConfig struct {
    ChromePath       string `json:"chrome_path"`        // auto-detect or user-specified
    UserDataDir      string `json:"user_data_dir"`      // Chrome profile path
    DownloadDir      string `json:"download_dir"`       // video output folder
    MinDelay         int    `json:"min_delay_seconds"`   // min delay between tasks (default 30)
    MaxDelay         int    `json:"max_delay_seconds"`   // max delay between tasks (default 120)
    MaxRetries       int    `json:"max_retries"`         // default 3
    ShowBrowser      bool   `json:"show_browser"`        // headed mode (default true)
}
```

## Related Code Files

### Files to Create

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/main.go` | Create | Wails app entry point |
| `c:/Users/Admin/Desktop/veo3/app.go` | Create | App struct, Wails bindings, event emitters |
| `c:/Users/Admin/Desktop/veo3/internal/chrome/browser.go` | Create | Rod browser lifecycle management |
| `c:/Users/Admin/Desktop/veo3/internal/chrome/stealth.go` | Create | Stealth wrapper for page creation |
| `c:/Users/Admin/Desktop/veo3/internal/storage/db.go` | Create | SQLite initialization and migrations |
| `c:/Users/Admin/Desktop/veo3/internal/storage/models.go` | Create | Task and Config data models |
| `c:/Users/Admin/Desktop/veo3/internal/storage/repository.go` | Create | CRUD operations for tasks and config |
| `c:/Users/Admin/Desktop/veo3/internal/config/config.go` | Create | App config load/save from JSON |
| `c:/Users/Admin/Desktop/veo3/go.mod` | Create | Go module definition |
| `c:/Users/Admin/Desktop/veo3/wails.json` | Create | Wails project configuration |
| `c:/Users/Admin/Desktop/veo3/frontend/` | Create | Generated by `wails init` template |

## Implementation Steps

### Step 1: Project Scaffolding

1. Install Wails CLI: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
2. Run `wails init -n veo3 -t react-ts` in a temp directory
3. Move generated files into `c:/Users/Admin/Desktop/veo3/` (preserve existing plans/)
4. Verify `wails dev` launches successfully with default template
5. Add Go dependencies:
   ```
   go get github.com/go-rod/rod
   go get github.com/go-rod/stealth
   go get modernc.org/sqlite
   ```

### Step 2: App Config Module

1. Create `internal/config/config.go`
2. Define `AppConfig` struct with JSON tags
3. Implement `Load(path string) (*AppConfig, error)` - reads JSON, creates default if missing
4. Implement `Save(path string) error` - writes JSON with indentation
5. Default config: auto-detect Chrome path, `%APPDATA%/veo3-manager/` for data, `~/Videos/Veo3/` for downloads
6. Helper: `GetAppDataDir() string` - returns `%APPDATA%/veo3-manager/`, creates dir if needed

### Step 3: SQLite Storage Layer

1. Create `internal/storage/db.go`
2. Import `modernc.org/sqlite` via `database/sql` driver registration
3. Implement `NewDB(dbPath string) (*sql.DB, error)`:
   - Open connection with `?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)`
   - Set `MaxOpenConns(1)` (SQLite single-writer)
   - Run migrations
4. Implement `runMigrations(db *sql.DB)`:
   - Check `schema_version` table existence
   - Apply pending migrations in order
   - Embed SQL via `//go:embed migrations/*.sql`
5. Create `internal/storage/models.go`:
   - `Task` struct with all DB fields + JSON metadata parsing helper
   - `TaskStatus` type alias with constants: `StatusPending`, `StatusQueued`, `StatusGenerating`, `StatusDownloading`, `StatusCompleted`, `StatusFailed`
6. Create `internal/storage/repository.go`:
   - `Repository` struct holding `*sql.DB`
   - Methods: `CreateTask(prompt string) (*Task, error)`
   - `GetTasks(filter TaskFilter) ([]Task, error)` - supports status filter, pagination
   - `GetTaskByID(id int64) (*Task, error)`
   - `UpdateTaskStatus(id int64, status TaskStatus, fields map[string]interface{}) error`
   - `GetConfig(key string) (string, error)`
   - `SetConfig(key, value string) error`
   - `GetStats() (*Stats, error)` - counts by status for dashboard

### Step 4: Chrome Browser Manager

1. Create `internal/chrome/browser.go`
2. Define `BrowserManager` struct:
   ```go
   type BrowserManager struct {
       browser  *rod.Browser
       config   *config.AppConfig
       mu       sync.Mutex
       status   BrowserStatus // "disconnected", "launching", "connected", "error"
       onStatus func(BrowserStatus)
   }
   ```
3. Implement `NewBrowserManager(cfg *config.AppConfig, onStatus func(BrowserStatus)) *BrowserManager`
4. Implement `Launch() error`:
   - Find Chrome binary (config path or auto-detect via registry/common paths)
   - Build launcher with: `--user-data-dir`, `--disable-blink-features=AutomationControlled`, window size 1280x900
   - If `ShowBrowser=true`, set `Headless(false)`
   - Connect Rod to launched browser
   - Update status to "connected"
5. Implement `Close() error` - graceful browser shutdown
6. Implement `IsConnected() bool`, `GetStatus() BrowserStatus`
7. Implement `NewStealthPage() (*rod.Page, error)` - uses stealth package

8. Create `internal/chrome/stealth.go`:
   - Wrapper function `CreateStealthPage(browser *rod.Browser, url string) (*rod.Page, error)`
   - Uses `stealth.MustPage(browser)` then navigates
   - Sets viewport, timezone, language to match system

### Step 5: Wails App Bindings

1. Modify `app.go` to hold references to all managers:
   ```go
   type App struct {
       ctx     context.Context
       config  *config.AppConfig
       db      *storage.Repository
       browser *chrome.BrowserManager
   }
   ```
2. Implement `startup(ctx context.Context)`:
   - Load config
   - Initialize SQLite
   - Create browser manager (not launched)
3. Implement bound methods (exported, auto-available to frontend):
   - `GetAllTasks() ([]storage.Task, error)`
   - `GetTasksByStatus(status string) ([]storage.Task, error)`
   - `CreateTask(prompt string) (*storage.Task, error)`
   - `GetDashboardStats() (*storage.Stats, error)`
   - `LaunchBrowser() error`
   - `CloseBrowser() error`
   - `GetBrowserStatus() string`
   - `GetAppConfig() (*config.AppConfig, error)`
   - `UpdateAppConfig(cfg config.AppConfig) error`
   - `SelectDirectory() (string, error)` - native file dialog
4. Set browser status callback to emit Wails events:
   ```go
   browser.OnStatus = func(s BrowserStatus) {
       runtime.EventsEmit(a.ctx, "browser:status", string(s))
   }
   ```

### Step 6: Verify End-to-End

1. Run `wails dev`
2. Frontend should load default React template
3. Open browser DevTools, call `window.go.main.App.GetBrowserStatus()` - should return "disconnected"
4. Call `window.go.main.App.LaunchBrowser()` - Chrome should open with stealth mode
5. Manually log into Google account in launched Chrome
6. Close and re-launch - session should persist (no re-login needed)
7. Create a test task via `window.go.main.App.CreateTask("test prompt")`
8. Verify task appears in SQLite database

## Todo List

- [ ] Install Wails CLI and verify `wails doctor` passes
- [ ] Scaffold project with `wails init -n veo3 -t react-ts`
- [ ] Add Go dependencies (rod, stealth, sqlite)
- [ ] Implement config module (load/save JSON)
- [ ] Implement SQLite storage (init, migrations, repository)
- [ ] Implement Chrome browser manager (launch, stealth, session persistence)
- [ ] Wire up App struct with all bindings
- [ ] Test browser launch with stealth mode
- [ ] Test session persistence (login survives restart)
- [ ] Verify Wails events emit correctly
- [ ] Run `wails build` to confirm clean compilation

## Success Criteria

1. `wails dev` starts app with React frontend visible
2. SQLite database created at `%APPDATA%/veo3-manager/data.db` with correct schema
3. Browser launches in headed mode with stealth evasions active
4. Google session persists across app restarts (no re-login)
5. All bound methods callable from frontend JS console
6. `wails build` produces single Windows executable

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Wails v2 incompatibility with latest Go | Low | High | Pin Go version, check wails compatibility matrix |
| Chrome auto-update breaks Rod | Medium | Medium | Pin launcher to specific Chrome version via Rod's built-in manager |
| SQLite modernc build slow | Low | Low | Only affects first build; subsequent builds cached |
| Chrome path detection fails | Medium | Low | Allow manual path config in settings; fallback to Rod's auto-download |

## Security Considerations

- Chrome user-data-dir contains cookies/sessions; store in user-specific `%APPDATA%` directory
- Config file may contain file paths; no secrets stored in config
- SQLite database contains prompts only; no sensitive PII
- No network calls from app itself (all via Chrome); no API keys needed
- Browser runs with user's own Google account; app does not handle credentials

## Next Steps

- Phase 2 depends on: browser manager working, SQLite CRUD functional
- Before Phase 2: manually explore Flow UI in launched browser to identify CSS selectors
- Document discovered selectors in a config/selectors map for Phase 2
