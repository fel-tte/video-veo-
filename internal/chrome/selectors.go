package chrome

import "veo3/internal/storage"

// Default CSS selectors for Google Labs Flow UI.
// Updated from actual DOM inspection of https://labs.google/fx/tools/flow/project/
var DefaultSelectors = map[string]string{
	"prompt_input":      "div[contenteditable='true']",
	"video_element":     "video",
	"loading_indicator": "[class*='loading'], [class*='spinner'], [class*='progress']",
	"login_indicator":   "div[contenteditable='true']",
	"error_indicator":   "[class*='error'], [role='alert']",
	"download_button":   "button",
}

// SelectorManager manages CSS selectors with DB override support.
type SelectorManager struct {
	repo     *storage.Repository
	defaults map[string]string
}

func NewSelectorManager(repo *storage.Repository) *SelectorManager {
	return &SelectorManager{
		repo:     repo,
		defaults: DefaultSelectors,
	}
}

// Get returns the selector for the given name, checking DB override first.
func (sm *SelectorManager) Get(name string) string {
	if sm.repo != nil {
		val, err := sm.repo.GetConfig("selector." + name)
		if err == nil && val != "" {
			return val
		}
	}
	if sel, ok := sm.defaults[name]; ok {
		return sel
	}
	return ""
}

// Set stores a selector override in the database.
func (sm *SelectorManager) Set(name, selector string) error {
	if sm.repo == nil {
		return nil
	}
	return sm.repo.SetConfig("selector."+name, selector)
}

// GetAll returns all current selectors (defaults + overrides).
func (sm *SelectorManager) GetAll() map[string]string {
	result := make(map[string]string)
	for k, v := range sm.defaults {
		result[k] = v
	}
	if sm.repo != nil {
		for k := range sm.defaults {
			val, err := sm.repo.GetConfig("selector." + k)
			if err == nil && val != "" {
				result[k] = val
			}
		}
	}
	return result
}
