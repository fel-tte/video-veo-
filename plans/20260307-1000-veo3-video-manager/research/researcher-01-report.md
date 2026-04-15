# VEO3 Video Manager - Research Report
**Date:** March 7, 2026 | **Topics:** Wails v2, go-rod/rod, SQLite

---

## 1. Wails v2 Project Structure & Best Practices

### Initialization & Structure
- **Init:** `wails init -n myproject -t react-ts` (standard React+TypeScript template)
- **Layout:** Backend (Go, cmd/ structure) + Frontend (React in frontend/ with Vite bundler)
- **Config:** wails.json controls build, bindings, asset handling
- **Dev Mode:** `wails dev` hot-reloads both Go and React via Vite dev server

### Go-Frontend Bindings
- **Binding Mechanism:** Struct methods (public functions, uppercase) are auto-exposed to frontend
- **Output:** Wails generates JS/TS bindings automatically with zero boilerplate
- **Runtime Access:** Frontend accesses Go methods via `window.runtime` JavaScript object
- **Type Safety:** Generated TypeScript definitions keep frontend in sync with backend

### Events System (Real-time Push)
- **Unified Pattern:** Both Go and frontend emit/listen to events (similar to DOM events)
- **Bidirectional:** Events originate from either Go or JS and reach the other
- **Data Flow:** Events carry data seamlessly across IPC boundary
- **Implementation:** Use `runtime.EventsEmit()` (Go) and `window.runtime.EventsOn()` (JS)

### File Dialogs & System Tray
- **Dialogs:** Wails runtime provides native file open/save dialogs (no third-party deps)
- **System Tray:** Integrates OS-native system tray with menu support
- **Build:** Wails handles cross-platform compilation (Windows, macOS, Linux)

### Distribution
- **Build Output:** Produces installer on Windows (.msi), app bundle on macOS, .deb on Linux
- **Code Signing:** wails.json supports signing configuration for distribution
- **Cross-Compilation:** No CGO-related issues since Go backend is self-contained

---

## 2. go-rod/rod Chrome Automation

### Setup & Basic Usage
- **Import:** `github.com/go-rod/rod` with optional `github.com/go-rod/stealth`
- **Launch:** `rod.New().Connect()` or `rod.New().MustLaunch()` for headless browser
- **Session Persistence:** Use `BrowserContextOption.UserDataDir` to preserve session/cookies across runs
- **High-Level API:** Focus on human actions (Click, Input) rather than low-level CDP commands

### Stealth Mode & Anti-Detection
- **Essential Package:** `go-rod/stealth` removes headless detection signals (navigator.webdriver = false)
- **Canvas/Font Spoofing:** Patches WebGL vendor/renderer, language, permissions, image dimensions
- **Use Pattern:** Always use `stealth.MustPage()` instead of `browser.MustPage()` in production
- **Recommended:** Combine stealth with proxy rotation, random user-agents, realistic delays
- **Why It Works:** Evasions based on puppeteer-extra proven detection bypass techniques

### Human-Like Interaction Patterns
- **Click:** Auto-scrolls to element, hovers, waits until enabled/interactable—matches human behavior
- **Input:** Focuses element, scrolls into view, validates writable state before typing
- **Delays:** Wails SDK naturally supports throttling; inject randomized `time.Sleep()` between actions
- **Mouse Movements:** Rod's click/input implicitly move mouse; no explicit mouse trajectory needed for basic scripts
- **Waiting:** Use `WaitRequestIdle()` for network stabilization instead of fixed waits

### File Handling via Rod
- **Downloads:** `page.GetDownloadFile(selector)` or `hijackRequests()` to intercept file streams
- **Screenshots on Error:** Wrap operations in error handlers that capture `page.Screenshot()` for debugging
- **Navigation:** `page.Navigate(url)` with timeout; use `WaitLoad()` to ensure page ready

### Rod vs chromedp
- **Simpler API:** Rod avoids verbose DSL-like tasks; direct method calls on page object
- **Performance:** Rod uses decode-on-demand vs Puppeteer's decode-all approach; lighter resource footprint
- **Reliability:** Rod properly cleans browser processes on crash (chromedp leaves zombies on Windows/macOS)
- **Features:** Rod has built-in chrome version management, network hijacking, iframe handling
- **Verdict:** Rod preferred for production scraping/automation; chromedp adds unnecessary complexity

---

## 3. SQLite in Go (CGO-Free Options)

### Main Options Compared
| Feature | go-sqlite3 | modernc.org/sqlite | ncruces/go-sqlite3 |
|---------|-----------|-------------------|-------------------|
| CGO Req. | Yes (requires C compiler) | No (pure Go port) | No (wasm+wazero) |
| Performance | 2x+ faster | Slower on large datasets | Similar to modernc |
| Cross-Compile | Hard (CGO limits) | Easy (pure Go) | Easy (Go+wasm) |
| Maturity | Stable, widely used | Stable, growing adoption | Newer, less proven |

### When to Use What
- **go-sqlite3:** Performance-critical apps with C toolchain available (servers, CI/CD with Docker)
- **modernc.org/sqlite:** Desktop apps, cross-platform distribution, environments without C compiler
- **ncruces/go-sqlite3:** Wasm/edge computing scenarios; alternative to modernc with potential perf gains

### Best Practices for Desktop Apps
- **Choice:** modernc.org/sqlite ideal for Wails because:
  - Single executable (no .dll/.so dependencies)
  - Cross-platform builds without CGO complications
  - Acceptable perf for typical desktop workloads (small-medium datasets)
- **Connection Pooling:** Use `sql.Open()` with `SetMaxOpenConns()` to manage resource usage
- **Migrations:** Use `migrate` package (golang-migrate/migrate) or embed .sql files with `//go:embed`
- **Schema Versioning:** Store `schema_version` in separate table; run migrations on startup

### Embedded Database Pattern
- Store database file in `$HOME/.config/appname/` (Linux), `~/Library/Application Support/` (macOS), `%APPDATA%` (Windows)
- Use WAL mode (`.pragma journal_mode=wal`) for better concurrent access
- Backup strategy: periodic database file copy to user's cloud storage or backup directory

---

## Sources

**Wails v2:**
- [Wails Official Docs - Project Structure](https://wails.io/docs/gettingstarted/firstproject/)
- [Wails Application Development](https://wails.io/docs/guides/application-development/)
- [Wails v3 Events Reference](https://v3alpha.wails.io/guides/events-reference/)

**go-rod/rod:**
- [GitHub - go-rod/rod](https://github.com/go-rod/rod)
- [Rod Official Site](https://go-rod.github.io/)
- [go-rod/stealth Package](https://pkg.go.dev/github.com/go-rod/stealth)
- [ZenRows: Puppeteer in Golang 2026](https://www.zenrows.com/blog/puppeteer-golang)
- [Rod vs chromedp Comparison](https://github.com/go-rod/go-rod.github.io/blob/main/why-rod.md)

**SQLite:**
- [modernc.org/sqlite Package](https://pkg.go.dev/modernc.org/sqlite)
- [DataStation: SQLite in Go with/without cgo](https://datastation.multiprocess.io/blog/2022-05-12-sqlite-in-go-with-and-without-cgo.html)
- [GitHub: Benchmarking go-sqlite3 vs modernc.org/sqlite](https://github.com/multiprocessio/sqlite-cgo-no-cgo)
- [ncruces/go-sqlite3 (wasm-based)](https://github.com/ncruces/go-sqlite3)
