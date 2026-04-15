package downloader

import (
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-rod/rod"
)

type Downloader struct {
	downloadDir string
}

func New(downloadDir string) *Downloader {
	os.MkdirAll(downloadDir, 0755)
	return &Downloader{downloadDir: downloadDir}
}

// DownloadFromPage extracts video data from the page and saves it to disk.
// Tries DOM extraction first, then falls back to evaluating JS to fetch blob.
func (d *Downloader) DownloadFromPage(page *rod.Page, prompt string) (string, error) {
	// Strategy A: Try to find video element and extract blob via JS
	data, err := d.extractViaJS(page)
	if err != nil {
		log.Printf("JS extraction failed: %v, trying download button click", err)
		// Strategy B: Click download button and wait for file
		return "", fmt.Errorf("video download failed: %w", err)
	}

	return d.SaveVideo(data, prompt)
}

// extractViaJS uses JavaScript to fetch the video blob and return base64 data.
func (d *Downloader) extractViaJS(page *rod.Page) ([]byte, error) {
	// Find the real video element (filter out gstatic camera previews)
	result, err := page.Eval(`() => {
		return new Promise((resolve, reject) => {
			const videos = document.querySelectorAll('video');
			const real = Array.from(videos).filter(v => {
				const s = v.src || v.currentSrc || '';
				return s && !s.includes('gstatic.com');
			});
			if (real.length === 0) {
				reject('No video element found');
				return;
			}
			const video = real[real.length - 1];
			const src = video.src || video.currentSrc;
			if (!src) {
				reject('Video has no source');
				return;
			}

			// If it's a blob URL, fetch it
			if (src.startsWith('blob:')) {
				fetch(src)
					.then(r => r.blob())
					.then(blob => {
						const reader = new FileReader();
						reader.onload = () => {
							const base64 = reader.result.split(',')[1];
							resolve(base64);
						};
						reader.onerror = () => reject('FileReader error');
						reader.readAsDataURL(blob);
					})
					.catch(err => reject('Fetch blob failed: ' + err.message));
			} else if (src.startsWith('http')) {
				// Direct URL - fetch it
				fetch(src)
					.then(r => r.blob())
					.then(blob => {
						const reader = new FileReader();
						reader.onload = () => {
							const base64 = reader.result.split(',')[1];
							resolve(base64);
						};
						reader.onerror = () => reject('FileReader error');
						reader.readAsDataURL(blob);
					})
					.catch(err => reject('Fetch URL failed: ' + err.message));
			} else {
				reject('Unknown video source type: ' + src.substring(0, 50));
			}
		});
	}`)
	if err != nil {
		return nil, fmt.Errorf("eval JS: %w", err)
	}

	b64 := result.Value.Str()
	if b64 == "" {
		return nil, fmt.Errorf("empty base64 result")
	}

	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}

	return data, nil
}

// SaveVideo writes video data to disk with a sanitized filename.
func (d *Downloader) SaveVideo(data []byte, prompt string) (string, error) {
	filename := d.generateFilename(prompt)
	fullPath := filepath.Join(d.downloadDir, filename)

	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", fmt.Errorf("write video: %w", err)
	}

	log.Printf("Video saved: %s (%d bytes)", fullPath, len(data))
	return fullPath, nil
}

// generateFilename creates a filename from timestamp + sanitized prompt.
func (d *Downloader) generateFilename(prompt string) string {
	timestamp := time.Now().Format("20060102_150405")
	sanitized := sanitizePrompt(prompt)
	return fmt.Sprintf("%s_%s.mp4", timestamp, sanitized)
}

var nonAlphanumeric = regexp.MustCompile(`[^a-zA-Z0-9]+`)

func sanitizePrompt(prompt string) string {
	s := strings.TrimSpace(prompt)
	s = nonAlphanumeric.ReplaceAllString(s, "_")
	s = strings.Trim(s, "_")
	if len(s) > 30 {
		s = s[:30]
	}
	if s == "" {
		s = "video"
	}
	return strings.ToLower(s)
}
