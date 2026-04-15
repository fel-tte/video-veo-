package chrome

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

const (
	FlowURL       = "https://labs.google/fx/tools/flow"
	FlowCreateURL = "https://labs.google/fx/tools/flow/create"
)

// FlowAutomator handles automation of the Google Labs Flow page.
type FlowAutomator struct {
	browser   *BrowserManager
	selectors *SelectorManager
	timeout   time.Duration
}

func NewFlowAutomator(browser *BrowserManager, selectors *SelectorManager) *FlowAutomator {
	return &FlowAutomator{
		browser:   browser,
		selectors: selectors,
		timeout:   5 * time.Minute,
	}
}

func (fa *FlowAutomator) SetTimeout(d time.Duration) {
	fa.timeout = d
}

func (fa *FlowAutomator) GetBrowser() *rod.Browser {
	return fa.browser.GetBrowser()
}

// NavigateToFlow opens the Flow page. Reuses existing project page or navigates to one.
func (fa *FlowAutomator) NavigateToFlow() (*rod.Page, error) {
	browser := fa.browser.GetBrowser()
	if browser == nil {
		return nil, fmt.Errorf("browser not connected")
	}

	// Try to find an existing Flow project page (not edit page, not landing)
	pages, err := browser.Pages()
	if err == nil {
		for _, p := range pages {
			info, err := p.Info()
			if err != nil {
				continue
			}
			if strings.Contains(info.URL, "flow/project") && !strings.Contains(info.URL, "/edit/") {
				slog.Info("Reusing existing Flow project page", "url", info.URL)
				p.MustActivate()
				randomDelay(1000, 2000)
				return p, nil
			}
		}
		// Check for edit page — navigate back to project
		for _, p := range pages {
			info, err := p.Info()
			if err != nil {
				continue
			}
			if strings.Contains(info.URL, "flow/project") && strings.Contains(info.URL, "/edit/") {
				slog.Info("Found edit page, navigating back to project")
				parts := strings.Split(info.URL, "/edit/")
				projectURL := parts[0]
				if err := p.Navigate(projectURL); err == nil {
					p.MustWaitLoad()
					randomDelay(2000, 3000)
					return p, nil
				}
			}
		}
	}

	// No existing Flow project page — go to Flow main and find/create a project
	slog.Info("No Flow project page found, navigating to Flow main")
	page, err := NavigateStealthPage(browser, FlowURL)
	if err != nil {
		return nil, fmt.Errorf("navigate to flow: %w", err)
	}

	page.MustWaitRequestIdle()
	randomDelay(2000, 3000)

	// Look for existing project link
	projectURL, _ := page.Eval(`() => {
		const links = document.querySelectorAll('a[href*="flow/project"]');
		for (const a of links) {
			if (a.href && !a.href.includes('/edit/')) return a.href;
		}
		return '';
	}`)

	if projectURL != nil && projectURL.Value.Str() != "" {
		slog.Info("Found existing project, navigating", "url", projectURL.Value.Str())
		if err := page.Navigate(projectURL.Value.Str()); err != nil {
			return nil, fmt.Errorf("navigate to project: %w", err)
		}
		page.MustWaitLoad()
		randomDelay(2000, 3000)
		return page, nil
	}

	// No project found — click "New project" button
	slog.Info("No project found, creating new project")
	result, err := page.Eval(`() => {
		const btns = document.querySelectorAll('button');
		for (const b of btns) {
			if (b.textContent?.includes('New project')) { b.click(); return true; }
		}
		return false;
	}`)
	if err != nil || !result.Value.Bool() {
		return nil, fmt.Errorf("could not find 'New project' button")
	}

	randomDelay(3000, 5000)
	page.MustWaitRequestIdle()

	return page, nil
}

// IsLoggedIn checks if the user is logged into Google on the Flow page.
func (fa *FlowAutomator) IsLoggedIn(page *rod.Page) bool {
	has, _, _ := page.Has("div[contenteditable='true']")
	if has {
		return true
	}
	result, err := page.Eval(`() => {
		return document.body.innerText.includes('What do you want to create');
	}`)
	if err == nil && result.Value.Bool() {
		return true
	}
	return false
}

// ApplyGenerationSettings opens the settings dropdown and clicks the correct tabs.
// Validated: settings items use role="tab" with data-state="active"/"inactive".
// Model sub-dropdown items use role="menuitem".
func (fa *FlowAutomator) ApplyGenerationSettings(page *rod.Page, model, aspectRatio string, outputCount int) error {
	slog.Info("Applying generation settings", "model", model, "aspect_ratio", aspectRatio, "output_count", outputCount)

	aspectMap := map[string]string{
		"16:9": "Landscape",
		"9:16": "Portrait",
	}
	countText := fmt.Sprintf("x%d", outputCount)
	aspectText := aspectMap[aspectRatio]
	if aspectText == "" {
		aspectText = "Landscape"
	}

	// Step 1: Ensure Video mode (always)
	if err := fa.clickSettingsTab(page, "Video"); err != nil {
		slog.Warn("Could not set Video mode", "error", err)
	}
	randomDelay(500, 800)

	// Step 2: Set aspect ratio (Landscape/Portrait)
	if err := fa.clickSettingsTab(page, aspectText); err != nil {
		slog.Warn("Could not set aspect ratio", "error", err)
	}
	randomDelay(500, 800)

	// Step 3: Set output count (x1/x2/x3/x4)
	if err := fa.clickSettingsTab(page, countText); err != nil {
		slog.Warn("Could not set output count", "error", err)
	}
	randomDelay(500, 800)

	// Step 4: Set model via sub-dropdown (uses role="menuitem")
	if model != "" {
		if err := fa.clickModelMenuItem(page, model); err != nil {
			slog.Warn("Could not set model", "error", err)
		}
	}

	slog.Info("Generation settings applied")
	return nil
}

// clickSettingsTab opens the settings dropdown, finds a tab by text, clicks it, then closes.
func (fa *FlowAutomator) clickSettingsTab(page *rod.Page, tabText string) error {
	// Open settings dropdown
	settingsBtn, err := fa.findSettingsButton(page, 5*time.Second)
	if err != nil {
		return fmt.Errorf("settings button not found: %w", err)
	}
	if err := settingsBtn.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("click settings button: %w", err)
	}
	randomDelay(1500, 2000)

	// Find the tab with matching text (role="tab" inside radix popper)
	result, err := page.Eval(fmt.Sprintf(`() => {
		const tabs = document.querySelectorAll('[data-radix-popper-content-wrapper] [role="tab"]');
		for (const tab of tabs) {
			const t = tab.textContent?.trim() || '';
			if (t.includes('%s') && tab.getBoundingClientRect().width > 0) {
				if (tab.getAttribute('data-state') === 'active' || tab.getAttribute('aria-selected') === 'true') {
					return 'already_active';
				}
				tab.setAttribute('data-flow-target', 'true');
				return 'found';
			}
		}
		return 'not_found';
	}`, tabText))

	if err != nil || result.Value.Str() == "not_found" {
		fa.pressEscape(page)
		return fmt.Errorf("tab '%s' not found", tabText)
	}

	if result.Value.Str() == "already_active" {
		slog.Info("Tab already active", "tab", tabText)
		fa.pressEscape(page)
		return nil
	}

	// Click the tab via Rod native click (CDP mouse events)
	el, err := page.Element("[data-flow-target='true']")
	if err != nil {
		fa.pressEscape(page)
		return fmt.Errorf("get tab element: %w", err)
	}
	page.Eval(`() => {
		const el = document.querySelector("[data-flow-target='true']");
		if (el) el.removeAttribute('data-flow-target');
	}`)

	if err := el.Click(proto.InputMouseButtonLeft, 1); err != nil {
		fa.pressEscape(page)
		return fmt.Errorf("click tab: %w", err)
	}
	randomDelay(500, 800)

	// Close dropdown
	fa.pressEscape(page)
	randomDelay(300, 500)

	slog.Info("Tab clicked", "tab", tabText)
	return nil
}

// clickModelMenuItem opens the settings dropdown, clicks the model sub-dropdown,
// then clicks the matching model menuitem.
func (fa *FlowAutomator) clickModelMenuItem(page *rod.Page, modelText string) error {
	// Map config values to display text
	modelMap := map[string]string{
		"veo_3_1_fast":    "Veo 3.1 - Fast",
		"veo_3_1_quality": "Veo 3.1 - Quality",
		"veo_2_fast":      "Veo 2 - Fast",
		"veo_2_quality":   "Veo 2 - Quality",
		"nano_banana_2":   "Nano Banana 2",
		"nano_banana_pro": "Nano Banana Pro",
		"imagen_4":        "Imagen 4",
	}
	displayText := modelMap[modelText]
	if displayText == "" {
		displayText = modelText // Use as-is if not in map
	}

	// Open settings dropdown
	settingsBtn, err := fa.findSettingsButton(page, 5*time.Second)
	if err != nil {
		return fmt.Errorf("settings button not found: %w", err)
	}
	if err := settingsBtn.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("click settings button: %w", err)
	}
	randomDelay(1500, 2000)

	// Find and click the model sub-dropdown button (has "arrow_drop_down" text)
	result, err := page.Eval(`() => {
		const btns = document.querySelectorAll('[data-radix-popper-content-wrapper] button');
		for (const b of btns) {
			const t = b.textContent?.trim() || '';
			if (t.includes('arrow_drop_down') && b.getBoundingClientRect().width > 0) {
				b.setAttribute('data-flow-model-btn', 'true');
				return 'found';
			}
		}
		return 'not_found';
	}`)

	if err != nil || result.Value.Str() == "not_found" {
		fa.pressEscape(page)
		return fmt.Errorf("model sub-dropdown button not found")
	}

	modelBtn, err := page.Element("[data-flow-model-btn='true']")
	if err != nil {
		fa.pressEscape(page)
		return fmt.Errorf("get model button: %w", err)
	}
	page.Eval(`() => {
		const el = document.querySelector("[data-flow-model-btn='true']");
		if (el) el.removeAttribute('data-flow-model-btn');
	}`)

	if err := modelBtn.Click(proto.InputMouseButtonLeft, 1); err != nil {
		fa.pressEscape(page)
		return fmt.Errorf("click model button: %w", err)
	}
	randomDelay(1500, 2000)

	// Find and click the target model menuitem
	menuResult, err := page.Eval(fmt.Sprintf(`() => {
		const items = document.querySelectorAll('[role="menuitem"]');
		for (const item of items) {
			const t = item.textContent?.trim() || '';
			if (t.includes('%s') && item.getBoundingClientRect().width > 0) {
				item.setAttribute('data-flow-model-item', 'true');
				return 'found';
			}
		}
		return 'not_found';
	}`, displayText))

	if err != nil || menuResult.Value.Str() == "not_found" {
		fa.pressEscape(page)
		fa.pressEscape(page)
		return fmt.Errorf("model '%s' not found in menu", displayText)
	}

	modelItem, err := page.Element("[data-flow-model-item='true']")
	if err != nil {
		fa.pressEscape(page)
		fa.pressEscape(page)
		return fmt.Errorf("get model item: %w", err)
	}
	page.Eval(`() => {
		const el = document.querySelector("[data-flow-model-item='true']");
		if (el) el.removeAttribute('data-flow-model-item');
	}`)

	if err := modelItem.Click(proto.InputMouseButtonLeft, 1); err != nil {
		fa.pressEscape(page)
		return fmt.Errorf("click model item: %w", err)
	}
	randomDelay(500, 800)

	// Close dropdowns
	fa.pressEscape(page)
	randomDelay(300, 500)

	slog.Info("Model selected", "model", displayText)
	return nil
}

// SubmitPrompt types a prompt into the Slate.js editor and clicks the Create button.
// Validated: Slate.js needs CDP click to focus + page.InsertText for typing.
func (fa *FlowAutomator) SubmitPrompt(page *rod.Page, prompt string) error {
	slog.Info("Submitting prompt", "prompt", truncate(prompt, 60))

	// Find the contenteditable prompt input (Slate.js editor)
	el, err := page.Timeout(15 * time.Second).Element("div[contenteditable='true']")
	if err != nil {
		return fmt.Errorf("find prompt input: %w", err)
	}

	// Click to focus the Slate editor
	if err := el.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("click prompt input: %w", err)
	}
	randomDelay(300, 600)

	// Select all and delete existing text via keyboard
	page.KeyActions().Press(input.ControlLeft).Type(input.KeyA).MustDo()
	randomDelay(100, 200)
	page.KeyActions().Press(input.Backspace).MustDo()
	randomDelay(300, 500)

	// Type using page.InsertText — sends CDP Input.insertText
	// which properly interacts with Slate.js editor
	if err := page.InsertText(prompt); err != nil {
		return fmt.Errorf("insert text: %w", err)
	}

	slog.Info("Prompt typed, looking for Create button")
	randomDelay(800, 1500)

	// Find and click the submit Create button (arrow_forward + Create, near bottom y > 680)
	createBtn, err := fa.findSubmitButton(page, 10*time.Second)
	if err != nil {
		return fmt.Errorf("find Create button: %w", err)
	}

	if err := createBtn.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("click Create button: %w", err)
	}
	randomDelay(2000, 3000)

	// Verify submission: Slate placeholder should reappear after prompt is consumed
	submitted, _ := page.Eval(`() => {
		const ce = document.querySelector("div[contenteditable='true']");
		if (!ce) return false;
		return !!ce.querySelector('[data-slate-placeholder]');
	}`)
	if submitted != nil && submitted.Value.Bool() {
		slog.Info("Create button clicked, prompt submitted (placeholder visible)")
	} else {
		slog.Warn("Create clicked but prompt may not have submitted — placeholder not visible")
	}

	return nil
}

// WaitForGeneration waits for new media items to appear after submission.
// Validated: track media count increase only (video presence gives false positives).
func (fa *FlowAutomator) WaitForGeneration(page *rod.Page) error {
	slog.Info("Waiting for video generation", "timeout", fa.timeout)
	deadline := time.Now().Add(fa.timeout)

	initialCount, _ := fa.countMediaItems(page)
	slog.Info("Initial media count", "count", initialCount)
	startTime := time.Now()

	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Second)

		currentCount, _ := fa.countMediaItems(page)
		if currentCount > initialCount {
			slog.Info("New media item detected", "before", initialCount, "after", currentCount)
			randomDelay(2000, 3000)
			return nil
		}

		// Check for error messages
		errResult, _ := page.Eval(`() => {
			const els = document.querySelectorAll('[role="alert"]');
			for (const el of els) {
				const t = el.textContent?.trim();
				if (t && t.length > 5) return t.substring(0, 200);
			}
			return '';
		}`)
		if errResult != nil {
			errText := errResult.Value.Str()
			if errText != "" && !strings.Contains(errText, "doesn't seem") {
				return fmt.Errorf("generation error: %s", errText)
			}
		}

		elapsed := time.Since(startTime).Round(time.Second)
		slog.Info("Waiting for generation", "elapsed", elapsed, "media_count", currentCount)
	}

	return fmt.Errorf("generation timeout after %v", fa.timeout)
}

// ExtractVideoSrc extracts the video source URL from the detail/edit page.
// Validated: filter out gstatic camera previews, look for media.getMediaUrlRedirect URLs.
func (fa *FlowAutomator) ExtractVideoSrc(page *rod.Page) (string, error) {
	for i := 0; i < 5; i++ {
		result, err := page.Eval(`() => {
			const videos = document.querySelectorAll('video');
			const real = Array.from(videos).filter(v => {
				const src = v.src || v.currentSrc || '';
				return src && !src.includes('gstatic.com');
			});
			if (real.length === 0) return '';
			return real[real.length - 1].src || real[real.length - 1].currentSrc || '';
		}`)
		if err == nil {
			src := result.Value.Str()
			if src != "" {
				return src, nil
			}
		}
		if i < 4 {
			slog.Info("Waiting for video element to load", "attempt", i+1)
			time.Sleep(3 * time.Second)
		}
	}
	return "", fmt.Errorf("no video source found after 5 attempts")
}

// OpenLatestMediaDetail clicks the latest generated media item to open its detail/edit page.
func (fa *FlowAutomator) OpenLatestMediaDetail(page *rod.Page) error {
	slog.Info("Opening latest media detail")
	result, err := page.Eval(`() => {
		const items = document.querySelectorAll('[id^="fe_id_"]');
		if (items.length === 0) return '';
		const lastItem = items[items.length - 1];
		const link = lastItem.querySelector('a');
		if (link) { link.click(); return link.href; }
		lastItem.click();
		return 'clicked';
	}`)
	if err != nil {
		return fmt.Errorf("click latest media item: %w", err)
	}
	if result.Value.Str() == "" {
		return fmt.Errorf("no media items found")
	}
	slog.Info("Opened media detail", "result", result.Value.Str())
	randomDelay(3000, 5000)
	page.MustWaitRequestIdle()
	return nil
}

// ClickDownloadButton finds and clicks the download button on the detail page.
func (fa *FlowAutomator) ClickDownloadButton(page *rod.Page) error {
	btn, err := fa.findButtonByText(page, "Download", 5*time.Second)
	if err != nil {
		return fmt.Errorf("find download button: %w", err)
	}
	return btn.Click(proto.InputMouseButtonLeft, 1)
}

// CaptureScreenshot takes a screenshot of the current page state.
func (fa *FlowAutomator) CaptureScreenshot(page *rod.Page, taskID int64, downloadDir string) (string, error) {
	screenshotDir := filepath.Join(downloadDir, "error_screenshots")
	os.MkdirAll(screenshotDir, 0755)

	filename := fmt.Sprintf("%d_%s.png", taskID, time.Now().Format("20060102_150405"))
	fullPath := filepath.Join(screenshotDir, filename)

	data, err := page.Screenshot(true, nil)
	if err != nil {
		return "", fmt.Errorf("take screenshot: %w", err)
	}

	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", fmt.Errorf("save screenshot: %w", err)
	}

	slog.Info("Screenshot saved", "path", fullPath)
	return fullPath, nil
}

// findSettingsButton finds the combined settings button (contains "crop_" and has aria-haspopup="menu").
func (fa *FlowAutomator) findSettingsButton(page *rod.Page, timeout time.Duration) (*rod.Element, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, err := page.Eval(`() => {
			const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
			for (const b of btns) {
				const t = b.textContent?.trim() || '';
				if (t.includes('crop_') && b.getBoundingClientRect().width > 0) {
					b.setAttribute('data-flow-settings', 'true');
					return true;
				}
			}
			return false;
		}`)
		if err == nil && result.Value.Bool() {
			el, err := page.Element("[data-flow-settings='true']")
			if err == nil {
				page.Eval(`() => {
					const el = document.querySelector("[data-flow-settings='true']");
					if (el) el.removeAttribute('data-flow-settings');
				}`)
				return el, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("settings button not found")
}

// findSubmitButton finds the prompt submit button (arrow_forward + Create near bottom).
func (fa *FlowAutomator) findSubmitButton(page *rod.Page, timeout time.Duration) (*rod.Element, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, err := page.Eval(`() => {
			const buttons = document.querySelectorAll('button');
			for (const btn of buttons) {
				const text = btn.textContent?.trim() || '';
				const r = btn.getBoundingClientRect();
				if (text.includes('Create') && text.includes('arrow_forward') && r.width > 0 && r.y > 680) {
					btn.setAttribute('data-flow-submit', 'true');
					return true;
				}
			}
			return false;
		}`)
		if err == nil && result.Value.Bool() {
			el, err := page.Element("[data-flow-submit='true']")
			if err == nil {
				page.Eval(`() => {
					const el = document.querySelector("[data-flow-submit='true']");
					if (el) el.removeAttribute('data-flow-submit');
				}`)
				return el, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("submit Create button not found")
}

// findButtonByText finds a visible button containing the specified text.
func (fa *FlowAutomator) findButtonByText(page *rod.Page, text string, timeout time.Duration) (*rod.Element, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, err := page.Eval(fmt.Sprintf(`() => {
			const buttons = document.querySelectorAll('button, [role="button"]');
			for (const btn of buttons) {
				const btnText = btn.textContent?.trim() || '';
				if (btnText.includes('%s') && btn.getBoundingClientRect().width > 0) {
					btn.setAttribute('data-flow-match', 'true');
					return true;
				}
			}
			return false;
		}`, text))
		if err == nil && result.Value.Bool() {
			el, err := page.Element("[data-flow-match='true']")
			if err == nil {
				page.Eval(`() => {
					const el = document.querySelector("[data-flow-match='true']");
					if (el) el.removeAttribute('data-flow-match');
				}`)
				return el, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("button with text '%s' not found", text)
}

// pressEscape sends an Escape key press to close dropdowns/menus.
func (fa *FlowAutomator) pressEscape(page *rod.Page) {
	page.KeyActions().Press(input.Escape).MustDo()
}

// countMediaItems counts the number of media items in the project gallery.
func (fa *FlowAutomator) countMediaItems(page *rod.Page) (int, error) {
	result, err := page.Eval(`() => {
		return document.querySelectorAll('[id^="fe_id_"]').length;
	}`)
	if err != nil {
		return 0, err
	}
	return result.Value.Int(), nil
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
