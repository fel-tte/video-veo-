package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type AppConfig struct {
	ChromePath  string `json:"chrome_path"`
	UserDataDir string `json:"user_data_dir"`
	DownloadDir string `json:"download_dir"`
	MinDelay    int    `json:"min_delay_seconds"`
	MaxDelay    int    `json:"max_delay_seconds"`
	MaxRetries  int    `json:"max_retries"`
	ShowBrowser bool   `json:"show_browser"`
	DebugPort   int    `json:"debug_port"`
	// Generation settings
	Model       string `json:"model"`
	AspectRatio string `json:"aspect_ratio"` // "16:9" or "9:16"
	OutputCount int    `json:"output_count"` // 1-4
}

func GetAppDataDir() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		home, _ := os.UserHomeDir()
		appData = filepath.Join(home, ".config")
	}
	dir := filepath.Join(appData, "veo3-manager")
	os.MkdirAll(dir, 0755)
	return dir
}

func DefaultConfig() *AppConfig {
	home, _ := os.UserHomeDir()
	return &AppConfig{
		ChromePath:  "",
		UserDataDir: filepath.Join(GetAppDataDir(), "chrome-profile"),
		DownloadDir: filepath.Join(home, "Videos", "Veo3"),
		MinDelay:    5,
		MaxDelay:    15,
		MaxRetries:  3,
		ShowBrowser: true,
		DebugPort:   9222,
		Model:       "veo_3_1_fast",
		AspectRatio: "16:9",
		OutputCount: 2,
	}
}

func Load(path string) (*AppConfig, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			if saveErr := cfg.Save(path); saveErr != nil {
				return nil, saveErr
			}
			return cfg, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *AppConfig) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func ConfigPath() string {
	return filepath.Join(GetAppDataDir(), "config.json")
}
