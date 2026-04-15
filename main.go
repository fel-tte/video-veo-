package main

import (
	"embed"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// videoHandler serves local video files from disk.
// Requests to /localfile/<absolute-path> are served directly.
type videoHandler struct{}

func (h *videoHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Expect path like /localfile/C:/Users/.../video.mp4
	path := r.URL.Path
	if !strings.HasPrefix(path, "/localfile/") {
		http.NotFound(w, r)
		return
	}
	filePath := strings.TrimPrefix(path, "/localfile/")
	// URL-decode is handled by net/http already

	// Security: only serve .mp4 files
	if !strings.HasSuffix(strings.ToLower(filePath), ".mp4") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, fmt.Sprintf("file not found: %s", filePath), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "video/mp4")
	http.ServeFile(w, r, filePath)
}

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "Veo3 Video Manager",
		Width:            1200,
		Height:           800,
		MinWidth:         800,
		MinHeight:        600,
		Frameless:        true,
		WindowStartState: options.Maximised,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: &videoHandler{},
		},
		BackgroundColour: &options.RGBA{R: 15, G: 15, B: 20, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
