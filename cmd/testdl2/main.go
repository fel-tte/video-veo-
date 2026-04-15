package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"veo3/internal/api"
)

// Quick test of the fixed DownloadVideo (redirect via new tab + HTTP download)
// Usage: go run ./cmd/testdl2 <mediaID>

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Usage: go run ./cmd/testdl2 <mediaID>")
	}
	mediaID := os.Args[1]
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	// Connect to Chrome on 9222
	u, err := launcher.ResolveURL("127.0.0.1:9222")
	if err != nil {
		log.Fatalf("Chrome not on 9222: %v", err)
	}
	browser := rod.New().ControlURL(u)
	if err := browser.Connect(); err != nil {
		log.Fatalf("Connect: %v", err)
	}

	// Find Flow page
	pages, _ := browser.Pages()
	var page *rod.Page
	for _, p := range pages {
		info, _ := p.Info()
		if info != nil && strings.Contains(info.URL, "labs.google") {
			page = p
			break
		}
	}
	if page == nil {
		log.Fatal("No labs.google page found")
	}

	// Setup API client
	client := api.NewClient()
	client.SetPage(page)
	if err := client.RefreshToken(); err != nil {
		log.Fatalf("Token: %v", err)
	}

	outputPath := fmt.Sprintf("C:/Users/Admin/Videos/Veo3/test_%s.mp4", time.Now().Format("20060102_150405"))
	os.MkdirAll("C:/Users/Admin/Videos/Veo3", 0755)

	log.Printf("Downloading media %s -> %s", mediaID, outputPath)

	if err := client.DownloadVideo(mediaID, outputPath); err != nil {
		log.Fatalf("Download FAILED: %v", err)
	}

	fi, _ := os.Stat(outputPath)
	log.Printf("SUCCESS: %s (%d bytes)", outputPath, fi.Size())
}
