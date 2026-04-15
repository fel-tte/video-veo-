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
	"veo3/internal/api"
)

// Standalone CLI to test video generation end-to-end.
// Usage: go run ./cmd/testgen "your prompt here"
//
// Steps:
// 1. Launch/connect Chrome on port 9222
// 2. Navigate to labs.google Flow
// 3. Extract access_token from __NEXT_DATA__
// 4. Call generate API
// 5. Poll for completion
// 6. Download video via browser fetch

func main() {
	prompt := "A cat walking on a rainbow bridge in space, cinematic lighting"
	if len(os.Args) > 1 {
		prompt = strings.Join(os.Args[1:], " ")
	}

	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.Printf("=== Veo3 Test Generator ===")
	log.Printf("Prompt: %s", prompt)

	// Step 1: Connect to existing Chrome or launch new
	browser, needsCleanup := connectOrLaunch()
	if needsCleanup {
		defer browser.Close()
	}
	log.Println("[OK] Chrome connected")

	// Step 2: Find or navigate to Flow project page
	page := navigateToFlow(browser)
	log.Println("[OK] On Flow project page")

	// Step 3: Extract access_token
	client := api.NewClient()
	client.SetPage(page)
	if err := client.RefreshToken(); err != nil {
		log.Fatalf("[FAIL] Token extraction: %v", err)
	}
	log.Println("[OK] Access token extracted")

	// Step 4: Get credits
	credits, err := client.GetCredits()
	if err != nil {
		log.Printf("[WARN] Credits check failed: %v", err)
	} else {
		log.Printf("[OK] Credits: %d (tier: %s)", credits.Credits, credits.UserPaygateTier)
	}

	// Step 5: Extract project ID
	projectID := extractProjectID(browser)
	if projectID == "" {
		log.Fatal("[FAIL] Could not find project ID in browser URL")
	}
	log.Printf("[OK] Project ID: %s", projectID)

	// Step 6: Generate video (1 output for testing)
	log.Println("[...] Submitting generation request...")
	genResp, err := client.GenerateVideo(projectID, prompt, api.ModelVeo31Fast, "16:9", 1)
	if err != nil {
		log.Fatalf("[FAIL] Generate: %v", err)
	}

	// Print full response for debugging
	respJSON, _ := json.MarshalIndent(genResp, "", "  ")
	log.Printf("[OK] Generate response:\n%s", string(respJSON))

	var mediaIDs []string
	for _, m := range genResp.Media {
		mediaIDs = append(mediaIDs, m.Name)
		log.Printf("[OK] Media ID: %s", m.Name)
	}
	if len(mediaIDs) == 0 {
		log.Fatal("[FAIL] No media IDs in response")
	}
	log.Printf("[OK] Credits remaining: %d", genResp.RemainingCredits)

	// Step 7: Poll for completion
	log.Println("[...] Polling for completion (timeout: 5 min)...")
	results, err := client.WaitForCompletion(projectID, mediaIDs, 5*time.Minute)
	if err != nil {
		log.Fatalf("[FAIL] Wait: %v", err)
	}

	for i, m := range results {
		status := m.MediaMetadata.MediaStatus.MediaGenerationStatus
		log.Printf("[OK] Result %d: %s (status: %s)", i+1, m.Name, status)
		resultJSON, _ := json.MarshalIndent(m, "", "  ")
		log.Printf("  Detail:\n%s", string(resultJSON))
	}

	// Step 8: Download completed videos
	var completedIDs []string
	for _, m := range results {
		if m.MediaMetadata.MediaStatus.MediaGenerationStatus == api.StatusCompleted {
			completedIDs = append(completedIDs, m.Name)
		}
	}

	if len(completedIDs) == 0 {
		log.Fatal("[FAIL] No completed videos to download")
	}

	outputDir := "."
	if home, err := os.UserHomeDir(); err == nil {
		outputDir = home + "/Videos/Veo3"
	}
	os.MkdirAll(outputDir, 0755)

	for i, mediaID := range completedIDs {
		outputPath := fmt.Sprintf("%s/test_%s_%d.mp4", outputDir, time.Now().Format("20060102_150405"), i+1)
		log.Printf("[...] Downloading %d/%d: %s -> %s", i+1, len(completedIDs), mediaID, outputPath)

		if err := client.DownloadVideo(mediaID, outputPath); err != nil {
			log.Printf("[WARN] Browser download failed: %v", err)

			// Fallback: try HTTP download with Bearer token
			log.Println("[...] Trying HTTP download with token...")
			if err2 := httpDownloadWithToken(client, mediaID, outputPath); err2 != nil {
				log.Printf("[WARN] HTTP download failed: %v", err2)

				// Fallback 2: try XHR in browser
				log.Println("[...] Trying XHR in browser...")
				debugDownload(page, mediaID)
				continue
			}
		}

		fi, _ := os.Stat(outputPath)
		if fi != nil {
			log.Printf("[OK] Downloaded: %s (%d bytes)", outputPath, fi.Size())
		}
	}

	log.Println("=== Done ===")
}

func connectOrLaunch() (*rod.Browser, bool) {
	// Try existing Chrome on 9222
	u, err := launcher.ResolveURL("127.0.0.1:9222")
	if err == nil && u != "" {
		log.Printf("[...] Found existing Chrome, connecting: %s", u)
		browser := rod.New().ControlURL(u)
		if err := browser.Connect(); err == nil {
			return browser, false
		}
		log.Printf("[WARN] Connect failed: %v", err)
	}

	// Launch new Chrome
	log.Println("[...] Launching new Chrome...")
	chromePath := detectChrome()
	l := launcher.New()
	if chromePath != "" {
		l = l.Bin(chromePath)
	}

	l = l.
		Headless(false).
		Set("remote-debugging-port", "9222").
		Set("no-first-run").
		Set("no-default-browser-check").
		Delete("disable-default-apps")

	controlURL, err := l.Launch()
	if err != nil {
		log.Fatalf("[FAIL] Chrome launch: %v", err)
	}

	browser := rod.New().ControlURL(controlURL)
	if err := browser.Connect(); err != nil {
		log.Fatalf("[FAIL] Chrome connect: %v", err)
	}

	return browser, true
}

func detectChrome() string {
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
	return ""
}

func navigateToFlow(browser *rod.Browser) *rod.Page {
	// Check existing pages for Flow project
	pages, err := browser.Pages()
	if err == nil {
		for _, p := range pages {
			info, _ := p.Info()
			if info != nil && strings.Contains(info.URL, "flow/project") {
				log.Printf("[OK] Found existing Flow page: %s", info.URL)
				return p
			}
		}
	}

	// Navigate to Flow
	log.Println("[...] Navigating to labs.google/fx/tools/flow")
	page := browser.MustPage("https://labs.google/fx/tools/flow")
	page.MustWaitLoad()
	time.Sleep(3 * time.Second)

	// Find project link
	result, _ := page.Eval(`() => {
		const links = document.querySelectorAll('a[href*="flow/project"]');
		for (const a of links) {
			if (a.href && !a.href.includes('/edit/')) return a.href;
		}
		return '';
	}`)

	if result != nil && result.Value.Str() != "" {
		log.Printf("[OK] Found project: %s", result.Value.Str())
		page.MustNavigate(result.Value.Str())
		page.MustWaitLoad()
		time.Sleep(3 * time.Second)
	}

	return page
}

func extractProjectID(browser *rod.Browser) string {
	pages, err := browser.Pages()
	if err != nil {
		return ""
	}
	for _, p := range pages {
		info, _ := p.Info()
		if info == nil {
			continue
		}
		url := info.URL
		idx := strings.Index(url, "flow/project/")
		if idx < 0 {
			continue
		}
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
	return ""
}

func debugDownload(page *rod.Page, mediaID string) {
	// Try multiple download approaches

	// Approach 1: Navigate to the redirect URL directly (browser follows redirect with cookies)
	downloadURL := fmt.Sprintf("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=%s&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED", mediaID)
	log.Printf("[DEBUG] Approach 1: XMLHttpRequest with cookies...")
	result, err := page.Timeout(30 * time.Second).Eval(`(url) => {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.withCredentials = true;
			xhr.responseType = 'blob';
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					const reader = new FileReader();
					reader.onloadend = () => resolve(JSON.stringify({
						ok: true,
						size: xhr.response.size,
						type: xhr.response.type,
						b64: reader.result.split(',')[1]
					}));
					reader.readAsDataURL(xhr.response);
				} else {
					resolve(JSON.stringify({ ok: false, status: xhr.status, response: xhr.responseURL }));
				}
			};
			xhr.onerror = () => resolve(JSON.stringify({ ok: false, error: 'XHR error' }));
			xhr.send();
		});
	}`, downloadURL)
	if err != nil {
		log.Printf("[DEBUG] XHR failed: %v", err)
	} else {
		var xhrResult struct {
			OK     bool   `json:"ok"`
			Size   int    `json:"size"`
			Type   string `json:"type"`
			B64    string `json:"b64"`
			Status int    `json:"status"`
			Error  string `json:"error"`
		}
		json.Unmarshal([]byte(result.Value.Str()), &xhrResult)
		if xhrResult.OK && xhrResult.Size > 0 {
			log.Printf("[DEBUG] XHR success! size=%d type=%s", xhrResult.Size, xhrResult.Type)
			data, err := b64decode(xhrResult.B64)
			if err == nil {
				path := fmt.Sprintf("C:/Users/Admin/Videos/Veo3/debug_%s.mp4", time.Now().Format("20060102_150405"))
				os.WriteFile(path, data, 0644)
				log.Printf("[DEBUG] Saved to: %s (%d bytes)", path, len(data))
				return
			}
		} else {
			log.Printf("[DEBUG] XHR result: %s", result.Value.Str())
		}
	}

	// Approach 2: Open a new tab to the download URL (follows redirect)
	log.Printf("[DEBUG] Approach 2: Open new tab to download URL...")
	result2, err := page.Eval(`(url) => {
		return new Promise((resolve) => {
			const w = window.open(url, '_blank');
			setTimeout(() => {
				try {
					resolve(JSON.stringify({ url: w.location.href }));
				} catch(e) {
					resolve(JSON.stringify({ error: e.message }));
				}
			}, 5000);
		});
	}`, downloadURL)
	if err != nil {
		log.Printf("[DEBUG] New tab failed: %v", err)
	} else {
		log.Printf("[DEBUG] New tab result: %s", result2.Value.Str())
	}

	// Approach 3: Use CDP to get cookies and do HTTP download
	log.Printf("[DEBUG] Approach 3: Checking session info...")
	sessionResult, err := page.Eval(`() => {
		if (window.__NEXT_DATA__?.props?.pageProps?.session) {
			const s = window.__NEXT_DATA__.props.pageProps.session;
			return JSON.stringify({ has_token: !!s.access_token, expires: s.expires, token_prefix: s.access_token?.substring(0, 20) });
		}
		return 'no session';
	}`)
	if err == nil {
		log.Printf("[DEBUG] Session: %s", sessionResult.Value.Str())
	}
}

func b64decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// httpDownloadWithToken tries downloading via HTTP with Bearer token
func httpDownloadWithToken(client *api.Client, mediaID, outputPath string) error {
	token, err := client.GetAccessToken()
	if err != nil {
		return err
	}

	// Try the sandbox API download URL pattern
	urls := []string{
		fmt.Sprintf("https://aisandbox-pa.googleapis.com/v1/media/%s:download", mediaID),
		fmt.Sprintf("https://aisandbox-pa.googleapis.com/v1/media/%s", mediaID),
	}

	httpClient := &http.Client{Timeout: 60 * time.Second}

	for _, url := range urls {
		log.Printf("[DEBUG] Trying HTTP: %s", url)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Origin", "https://labs.google")
		req.Header.Set("Referer", "https://labs.google/")

		resp, err := httpClient.Do(req)
		if err != nil {
			log.Printf("[DEBUG] HTTP error: %v", err)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		log.Printf("[DEBUG] HTTP %d, content-type: %s, size: %d", resp.StatusCode, resp.Header.Get("Content-Type"), len(body))

		if resp.StatusCode == 200 && len(body) > 1000 {
			ct := resp.Header.Get("Content-Type")
			if strings.Contains(ct, "video") || strings.Contains(ct, "octet") || len(body) > 100000 {
				os.WriteFile(outputPath, body, 0644)
				log.Printf("[OK] Downloaded via HTTP: %s (%d bytes)", outputPath, len(body))
				return nil
			}
		}

		if len(body) < 2000 {
			log.Printf("[DEBUG] Response body: %s", string(body))
		}
	}

	return fmt.Errorf("all HTTP download attempts failed")
}
