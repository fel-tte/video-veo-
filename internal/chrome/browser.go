package chrome

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"veo3/internal/config"
)

type BrowserStatus string

const (
	StatusDisconnected BrowserStatus = "disconnected"
	StatusLaunching    BrowserStatus = "launching"
	StatusConnected    BrowserStatus = "connected"
	StatusError        BrowserStatus = "error"
)

// BrowserInfo contains debug connection info for external tools (AI, DevTools).
type BrowserInfo struct {
	Status     string `json:"status"`
	ControlURL string `json:"control_url"`
	DebugPort  int    `json:"debug_port"`
	ProfileDir string `json:"profile_dir"`
	ChromePath string `json:"chrome_path"`
}

type BrowserManager struct {
	browser    *rod.Browser
	launcher   *launcher.Launcher
	config     *config.AppConfig
	mu         sync.Mutex
	status     BrowserStatus
	controlURL string
	debugPort  int
	chromeBin  string
	OnStatus   func(BrowserStatus)
}

func NewBrowserManager(cfg *config.AppConfig, onStatus func(BrowserStatus)) *BrowserManager {
	return &BrowserManager{
		config:   cfg,
		status:   StatusDisconnected,
		OnStatus: onStatus,
	}
}

func (bm *BrowserManager) Launch() error {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if bm.browser != nil {
		return nil // already connected
	}

	bm.setStatus(StatusLaunching)

	debugPort := bm.config.DebugPort
	if debugPort == 0 {
		debugPort = 9222
	}

	chromePath := bm.findChromePath()
	slog.Info("Chrome launch", "chromePath", chromePath, "userDataDir", bm.config.UserDataDir, "debugPort", debugPort)

	// Step 1: Try connecting to existing Chrome on debugPort
	if bm.tryConnectExisting(debugPort) {
		bm.debugPort = debugPort
		bm.chromeBin = chromePath
		bm.setStatus(StatusConnected)
		slog.Info("Connected to existing Chrome", "debugPort", debugPort)
		return nil
	}

	// Step 2: Launch new Chrome instance
	os.MkdirAll(bm.config.UserDataDir, 0755)

	l := launcher.New()
	if chromePath != "" {
		l = l.Bin(chromePath)
	} else {
		slog.Warn("Chrome not found, Rod will download Chromium")
	}

	l = l.
		Headless(false).
		UserDataDir(bm.config.UserDataDir).
		Set("disable-blink-features", "AutomationControlled").
		Set("window-size", "1280,900").
		Set("remote-debugging-port", fmt.Sprintf("%d", debugPort)).
		Set("no-first-run").
		Set("no-default-browser-check").
		Set("enable-features", "NetworkService,NetworkServiceInProcess").
		Set("disable-features", "IsolateOrigins,site-per-process").
		Delete("disable-default-apps")

	if !bm.config.ShowBrowser {
		l = l.Headless(true)
	}

	slog.Info("Launching new browser...", "headless", !bm.config.ShowBrowser)

	controlURL, err := l.Launch()
	if err != nil {
		bm.setStatus(StatusError)
		slog.Error("Chrome launch failed", "error", err)
		return fmt.Errorf("khởi chạy Chrome thất bại: %w", err)
	}

	slog.Info("Chrome launched", "controlURL", controlURL)

	browser := rod.New().ControlURL(controlURL)
	if err := browser.Connect(); err != nil {
		bm.setStatus(StatusError)
		slog.Error("Chrome connect failed", "error", err)
		return fmt.Errorf("kết nối browser thất bại: %w", err)
	}

	// Open labs.google so user can see the browser window
	go func() {
		defer func() { recover() }()
		page := browser.MustPage("https://labs.google/")
		page.MustWaitLoad()
		slog.Info("Opened https://labs.google/ in browser")
	}()

	bm.browser = browser
	bm.launcher = l
	bm.controlURL = controlURL
	bm.debugPort = debugPort
	bm.chromeBin = chromePath
	bm.setStatus(StatusConnected)

	slog.Info("Chrome connected successfully", "debugPort", debugPort)
	return nil
}

// tryConnectExisting attempts to connect to a Chrome already running on the given port.
func (bm *BrowserManager) tryConnectExisting(port int) bool {
	debugURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	// Quick HTTP check if port is alive
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(debugURL + "/json/version")
	if err != nil || resp.StatusCode != 200 {
		return false
	}
	defer resp.Body.Close()

	// Extract webSocketDebuggerUrl from /json/version response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false
	}
	var versionInfo struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(body, &versionInfo); err != nil || versionInfo.WebSocketDebuggerURL == "" {
		slog.Warn("Could not extract webSocketDebuggerUrl", "body", string(body))
		return false
	}

	controlURL := versionInfo.WebSocketDebuggerURL
	slog.Info("Found existing Chrome, connecting...", "port", port, "controlURL", controlURL)

	browser := rod.New().ControlURL(controlURL)
	if err := browser.Connect(); err != nil {
		slog.Warn("Connect to existing Chrome failed", "error", err)
		return false
	}

	bm.browser = browser
	bm.launcher = nil // not our launcher
	bm.controlURL = controlURL
	return true
}

func (bm *BrowserManager) Close() error {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if bm.browser != nil {
		bm.browser.Close()
		bm.browser = nil
	}
	if bm.launcher != nil {
		bm.launcher.Kill() // only kills Chrome we launched ourselves
		bm.launcher = nil
	}
	bm.setStatus(StatusDisconnected)
	return nil
}

func (bm *BrowserManager) GetBrowser() *rod.Browser {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.browser
}

func (bm *BrowserManager) IsConnected() bool {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.status == StatusConnected
}

func (bm *BrowserManager) GetStatus() BrowserStatus {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return bm.status
}

// GetInfo returns debug connection info for external tools.
func (bm *BrowserManager) GetInfo() BrowserInfo {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	return BrowserInfo{
		Status:     string(bm.status),
		ControlURL: bm.controlURL,
		DebugPort:  bm.debugPort,
		ProfileDir: bm.config.UserDataDir,
		ChromePath: bm.chromeBin,
	}
}

func (bm *BrowserManager) setStatus(s BrowserStatus) {
	bm.status = s
	if bm.OnStatus != nil {
		bm.OnStatus(s)
	}
}

func (bm *BrowserManager) findChromePath() string {
	if bm.config.ChromePath != "" {
		if _, err := os.Stat(bm.config.ChromePath); err == nil {
			return bm.config.ChromePath
		}
	}
	return DetectChromePath()
}

// DetectChromePath attempts to find Chrome executable on the system.
func DetectChromePath() string {
	if runtime.GOOS == "windows" {
		paths := []string{
			os.Getenv("PROGRAMFILES") + `\Google\Chrome\Application\chrome.exe`,
			os.Getenv("PROGRAMFILES(X86)") + `\Google\Chrome\Application\chrome.exe`,
			os.Getenv("LOCALAPPDATA") + `\Google\Chrome\Application\chrome.exe`,
		}
		for _, p := range paths {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}
