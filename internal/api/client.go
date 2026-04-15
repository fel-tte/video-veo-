package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/google/uuid"
)

const (
	baseURL        = "https://aisandbox-pa.googleapis.com/v1"
	creditsAPIKey  = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
	recaptchaSiteKey = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
)

// Client makes direct HTTP requests to the Google AI Sandbox API.
// Uses the browser only for: (1) login, (2) access_token extraction, (3) reCAPTCHA tokens.
type Client struct {
	httpClient  *http.Client
	accessToken string
	tokenExpiry time.Time
	page        *rod.Page // browser page for token/recaptcha
	mu          sync.RWMutex
}

func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// SetPage sets the browser page used for token extraction and reCAPTCHA.
func (c *Client) SetPage(page *rod.Page) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.page = page
}

// RefreshToken extracts access_token from the browser page's __NEXT_DATA__.
func (c *Client) RefreshToken() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.page == nil {
		return fmt.Errorf("no browser page set")
	}

	result, err := c.page.Eval(`() => {
		if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps) {
			var s = window.__NEXT_DATA__.props.pageProps.session;
			if (s) return JSON.stringify({ access_token: s.access_token, expires: s.expires });
		}
		return '{}';
	}`)
	if err != nil {
		return fmt.Errorf("eval token: %w", err)
	}

	var tokenData struct {
		AccessToken string `json:"access_token"`
		Expires     string `json:"expires"`
	}
	if err := json.Unmarshal([]byte(result.Value.Str()), &tokenData); err != nil {
		return fmt.Errorf("parse token: %w", err)
	}
	if tokenData.AccessToken == "" {
		return fmt.Errorf("no access_token in __NEXT_DATA__")
	}

	c.accessToken = tokenData.AccessToken
	if tokenData.Expires != "" {
		c.tokenExpiry, _ = time.Parse(time.RFC3339, tokenData.Expires)
	}

	log.Printf("API token refreshed, expires: %s", c.tokenExpiry.Format(time.RFC3339))
	return nil
}

// GetAccessToken returns the current token, refreshing if needed.
func (c *Client) GetAccessToken() (string, error) {
	c.mu.RLock()
	token := c.accessToken
	expiry := c.tokenExpiry
	c.mu.RUnlock()

	if token != "" && (expiry.IsZero() || time.Now().Before(expiry.Add(-5*time.Minute))) {
		return token, nil
	}

	if err := c.RefreshToken(); err != nil {
		if token != "" {
			return token, nil // use stale token as fallback
		}
		return "", err
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken, nil
}

// getRecaptchaToken executes grecaptcha.enterprise.execute in the browser.
func (c *Client) getRecaptchaToken() (string, error) {
	c.mu.RLock()
	page := c.page
	c.mu.RUnlock()

	if page == nil {
		return "", fmt.Errorf("no browser page for reCAPTCHA")
	}

	result, err := page.Eval(`() => {
		if (window.grecaptcha && window.grecaptcha.enterprise) {
			return window.grecaptcha.enterprise.execute('` + recaptchaSiteKey + `', { action: 'generate' });
		}
		return Promise.reject('grecaptcha not available');
	}`)
	if err != nil {
		return "", fmt.Errorf("recaptcha execute: %w", err)
	}

	token := result.Value.Str()
	if token == "" {
		return "", fmt.Errorf("empty recaptcha token")
	}
	return token, nil
}

// doRequest makes an authenticated request to the API.
func (c *Client) doRequest(method, path string, body interface{}) ([]byte, int, error) {
	token, err := c.GetAccessToken()
	if err != nil {
		return nil, 0, fmt.Errorf("get token: %w", err)
	}

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	req.Header.Set("Origin", "https://labs.google")
	req.Header.Set("Referer", "https://labs.google/")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response: %w", err)
	}

	return respBody, resp.StatusCode, nil
}

// GenerateVideo submits a video generation request with outputCount outputs (1-4).
func (c *Client) GenerateVideo(projectID, prompt, model, aspectRatio string, outputCount int) (*GenerateResponse, error) {
	// reCAPTCHA is optional (API works without it) but we try to get one for safety
	recaptchaToken, err := c.getRecaptchaToken()
	if err != nil {
		log.Printf("Warning: reCAPTCHA failed (continuing without): %v", err)
		recaptchaToken = ""
	}

	batchID := uuid.New().String()
	sessionID := fmt.Sprintf(";%d", time.Now().UnixMilli())

	// Map aspect ratio
	apiAspectRatio := AspectLandscape
	if aspectRatio == "9:16" {
		apiAspectRatio = AspectPortrait
	}

	// Build N requests (each with unique seed) for outputCount
	if outputCount < 1 {
		outputCount = 1
	}
	if outputCount > 4 {
		outputCount = 4
	}
	requests := make([]VideoRequest, outputCount)
	for i := 0; i < outputCount; i++ {
		requests[i] = VideoRequest{
			AspectRatio:   apiAspectRatio,
			Seed:          rand.Intn(10000),
			TextInput:     TextInput{StructuredPrompt: StructuredPrompt{Parts: []PromptPart{{Text: prompt}}}},
			VideoModelKey: model,
			Metadata:      map[string]interface{}{},
		}
	}

	body := GenerateRequest{
		MediaGenerationContext: MediaGenContext{BatchID: batchID},
		ClientContext: ClientContext{
			ProjectID:       projectID,
			Tool:            "PINHOLE",
			UserPaygateTier: "PAYGATE_TIER_TWO",
			SessionID:       sessionID,
			RecaptchaContext: RecaptchaContext{
				Token:           recaptchaToken,
				ApplicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
			},
		},
		Requests:         requests,
		UseV2ModelConfig: true,
	}

	respBody, status, err := c.doRequest("POST", "/video:batchAsyncGenerateVideoText", body)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("generate API returned %d: %s", status, string(respBody))
	}

	var result GenerateResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	return &result, nil
}

// CheckStatus polls the generation status.
func (c *Client) CheckStatus(mediaIDs []MediaRef) (*StatusResponse, error) {
	body := StatusRequest{Media: mediaIDs}

	respBody, status, err := c.doRequest("POST", "/video:batchCheckAsyncVideoGenerationStatus", body)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("status API returned %d: %s", status, string(respBody))
	}

	var result StatusResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse status: %w", err)
	}
	return &result, nil
}

// GetCredits returns the remaining credits.
func (c *Client) GetCredits() (*CreditsResponse, error) {
	token, err := c.GetAccessToken()
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("GET", baseURL+"/credits?key="+creditsAPIKey, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://labs.google")
	req.Header.Set("Referer", "https://labs.google/")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result CreditsResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DownloadVideo downloads a video by media ID.
// Uses the browser to resolve the tRPC redirect URL (requires cookies),
// then downloads the signed GCS URL via plain HTTP.
func (c *Client) DownloadVideo(mediaID, outputPath string) error {
	c.mu.RLock()
	page := c.page
	c.mu.RUnlock()

	if page == nil {
		return fmt.Errorf("no browser page for download")
	}

	// Step 1: Open a new tab to the redirect URL — browser cookies handle auth,
	// then it redirects to a signed GCS URL
	redirectURL := fmt.Sprintf("https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=%s&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED", mediaID)

	browser := page.Browser()
	newPage, err := browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return fmt.Errorf("create download page: %w", err)
	}
	defer newPage.Close()

	if err := newPage.Navigate(redirectURL); err != nil {
		return fmt.Errorf("navigate to redirect: %w", err)
	}

	// Wait for redirect to complete
	time.Sleep(5 * time.Second)

	info, err := newPage.Info()
	if err != nil {
		return fmt.Errorf("get page info: %w", err)
	}

	finalURL := info.URL
	if finalURL == "" || finalURL == "about:blank" || !isVideoURL(finalURL) {
		return fmt.Errorf("redirect did not produce video URL, got: %s", finalURL)
	}

	log.Printf("Video URL resolved: %s...%s", finalURL[:60], finalURL[len(finalURL)-20:])

	// Step 2: Download from the signed GCS URL (no auth needed)
	resp, err := c.httpClient.Get(finalURL)
	if err != nil {
		return fmt.Errorf("download video: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download returned %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read video: %w", err)
	}

	if len(data) < 1000 {
		return fmt.Errorf("downloaded data too small (%d bytes), likely not a video", len(data))
	}

	if err := writeFile(outputPath, data); err != nil {
		return fmt.Errorf("write file: %w", err)
	}

	log.Printf("Video downloaded: %s (%d bytes)", outputPath, len(data))
	return nil
}

func isVideoURL(u string) bool {
	return strings.Contains(u, "storage.googleapis.com") ||
		strings.Contains(u, "video") ||
		strings.Contains(u, ".mp4")
}

func writeFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0644)
}

// WaitForCompletion polls until all media are done or timeout.
func (c *Client) WaitForCompletion(projectID string, mediaIDs []string, timeout time.Duration) ([]MediaResult, error) {
	refs := make([]MediaRef, len(mediaIDs))
	for i, id := range mediaIDs {
		refs[i] = MediaRef{Name: id, ProjectID: projectID}
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 10 * time.Second

	for time.Now().Before(deadline) {
		status, err := c.CheckStatus(refs)
		if err != nil {
			log.Printf("Status check error: %v", err)
			time.Sleep(pollInterval)
			continue
		}

		allDone := true
		for _, m := range status.Media {
			s := m.MediaMetadata.MediaStatus.MediaGenerationStatus
			if s != StatusCompleted && s != StatusFailed {
				allDone = false
				break
			}
		}

		if allDone {
			return status.Media, nil
		}

		time.Sleep(pollInterval)
	}

	return nil, fmt.Errorf("timeout waiting for generation")
}
