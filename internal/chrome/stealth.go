package chrome

import (
	"fmt"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/go-rod/stealth"
)

// CreateStealthPage creates a new page with anti-detection evasions applied.
func CreateStealthPage(browser *rod.Browser) (*rod.Page, error) {
	page, err := stealth.Page(browser)
	if err != nil {
		return nil, fmt.Errorf("create stealth page: %w", err)
	}

	// Set a realistic viewport
	page.MustSetViewport(1280, 800, 1, false)

	return page, nil
}

// NavigateStealthPage creates a stealth page and navigates to the given URL.
func NavigateStealthPage(browser *rod.Browser, url string) (*rod.Page, error) {
	page, err := CreateStealthPage(browser)
	if err != nil {
		return nil, err
	}

	// Set extra headers to look more human
	_, _ = page.SetExtraHeaders([]string{"Accept-Language", "en-US,en;q=0.9"})

	// Emulate timezone
	_ = proto.EmulationSetTimezoneOverride{TimezoneID: "Asia/Ho_Chi_Minh"}.Call(page)

	if err := page.Navigate(url); err != nil {
		return nil, fmt.Errorf("navigate to %s: %w", url, err)
	}

	if err := page.WaitLoad(); err != nil {
		return nil, fmt.Errorf("wait load %s: %w", url, err)
	}

	return page, nil
}
