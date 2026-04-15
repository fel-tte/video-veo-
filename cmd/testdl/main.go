package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"veo3/internal/api"
)

// Test download only — uses an existing media ID
// Usage: go run ./cmd/testdl <mediaID>

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Usage: go run ./cmd/testdl <mediaID>")
	}
	mediaID := os.Args[1]
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	log.Printf("=== Download Test for media: %s ===", mediaID)

	// Connect to Chrome
	u, err := launcher.ResolveURL("127.0.0.1:9222")
	if err != nil {
		log.Fatalf("Chrome not on 9222: %v", err)
	}
	browser := rod.New().ControlURL(u)
	if err := browser.Connect(); err != nil {
		log.Fatalf("Connect: %v", err)
	}
	log.Println("[OK] Chrome connected")

	// Find Flow page
	page := findFlowPage(browser)
	if page == nil {
		log.Fatal("[FAIL] No Flow page found")
	}
	log.Println("[OK] Flow page found")

	// Extract token
	client := api.NewClient()
	client.SetPage(page)
	if err := client.RefreshToken(); err != nil {
		log.Fatalf("[FAIL] Token: %v", err)
	}
	log.Println("[OK] Token extracted")

	outputPath := fmt.Sprintf("C:/Users/Admin/Videos/Veo3/testdl_%s.mp4", time.Now().Format("150405"))
	os.MkdirAll("C:/Users/Admin/Videos/Veo3", 0755)

	// Test 1: Browser fetch (current method)
	log.Println("\n=== Test 1: Browser fetch (current DownloadVideo) ===")
	err = client.DownloadVideo(mediaID, outputPath)
	if err != nil {
		log.Printf("[FAIL] %v", err)
	} else {
		fi, _ := os.Stat(outputPath)
		log.Printf("[OK] Downloaded %d bytes to %s", fi.Size(), outputPath)
	}

	// Test 2: HTTP with Bearer token — try various URL patterns
	log.Println("\n=== Test 2: HTTP Bearer token ===")
	token, _ := client.GetAccessToken()
	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			log.Printf("[DEBUG] Redirect: %s", req.URL)
			return nil // follow
		},
	}

	urls := []string{
		fmt.Sprintf("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=%s&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED", mediaID),
		fmt.Sprintf("https://aisandbox-pa.googleapis.com/v1/media/%s:download", mediaID),
		fmt.Sprintf("https://aisandbox-pa.googleapis.com/v1/media/%s/video", mediaID),
	}

	for i, url := range urls {
		log.Printf("[...] URL %d: %s", i+1, url)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Origin", "https://labs.google")
		req.Header.Set("Referer", "https://labs.google/")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		resp, err := httpClient.Do(req)
		if err != nil {
			log.Printf("[FAIL] %v", err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		ct := resp.Header.Get("Content-Type")
		log.Printf("  Status: %d, Content-Type: %s, Size: %d", resp.StatusCode, ct, len(body))
		if len(body) < 2000 && !strings.Contains(ct, "video") {
			log.Printf("  Body: %s", string(body))
		}
		if resp.StatusCode == 200 && (strings.Contains(ct, "video") || len(body) > 100000) {
			path := fmt.Sprintf("C:/Users/Admin/Videos/Veo3/testdl_http%d_%s.mp4", i+1, time.Now().Format("150405"))
			os.WriteFile(path, body, 0644)
			log.Printf("[OK] Saved to %s", path)
		}
	}

	// Test 3: XHR from browser page
	log.Println("\n=== Test 3: XHR from browser ===")
	downloadURL := fmt.Sprintf("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=%s&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED", mediaID)
	xhrResult, err := page.Timeout(30 * time.Second).Eval(`(url) => {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.withCredentials = true;
			xhr.responseType = 'blob';
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					const reader = new FileReader();
					reader.onloadend = () => resolve(JSON.stringify({
						ok: true, size: xhr.response.size, type: xhr.response.type,
						b64: reader.result.split(',')[1]
					}));
					reader.readAsDataURL(xhr.response);
				} else {
					resolve(JSON.stringify({ ok: false, status: xhr.status, url: xhr.responseURL }));
				}
			};
			xhr.onerror = () => resolve(JSON.stringify({ ok: false, error: 'XHR error' }));
			xhr.send();
		});
	}`, downloadURL)
	if err != nil {
		log.Printf("[FAIL] XHR: %v", err)
	} else {
		var r struct {
			OK   bool   `json:"ok"`
			Size int    `json:"size"`
			Type string `json:"type"`
			B64  string `json:"b64"`
		}
		json.Unmarshal([]byte(xhrResult.Value.Str()), &r)
		if r.OK && r.B64 != "" {
			data, _ := base64.StdEncoding.DecodeString(r.B64)
			path := fmt.Sprintf("C:/Users/Admin/Videos/Veo3/testdl_xhr_%s.mp4", time.Now().Format("150405"))
			os.WriteFile(path, data, 0644)
			log.Printf("[OK] XHR downloaded %d bytes -> %s", len(data), path)
		} else {
			log.Printf("[FAIL] XHR result: %s", xhrResult.Value.Str())
		}
	}

	// Test 4: Open new page to download URL and capture response via CDP
	log.Println("\n=== Test 4: CDP network intercept ===")
	testCDPDownload(browser, page, mediaID, token)

	log.Println("\n=== Done ===")
}

func findFlowPage(browser *rod.Browser) *rod.Page {
	pages, _ := browser.Pages()
	for _, p := range pages {
		info, _ := p.Info()
		if info != nil && strings.Contains(info.URL, "labs.google") {
			return p
		}
	}
	return nil
}

func testCDPDownload(browser *rod.Browser, page *rod.Page, mediaID, token string) {
	// Use a new page to navigate to the download URL
	downloadURL := fmt.Sprintf("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=%s&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED", mediaID)

	log.Printf("[...] Creating new page for download: %s", downloadURL)
	newPage, err := browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		log.Printf("[FAIL] Create page: %v", err)
		return
	}
	defer newPage.Close()

	// Navigate to download URL
	err = newPage.Navigate(downloadURL)
	if err != nil {
		log.Printf("[FAIL] Navigate: %v", err)
		return
	}
	time.Sleep(5 * time.Second)

	info, _ := newPage.Info()
	if info != nil {
		log.Printf("[DEBUG] Final URL: %s", info.URL)
	}

	// Check if it's a video page or has content
	body, err := newPage.Eval(`() => document.body.innerText.substring(0, 500)`)
	if err == nil {
		log.Printf("[DEBUG] Body: %s", body.Value.Str())
	}
}

