package logging

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

var logFile *os.File

// Setup initializes the global slog logger with file and stdout output.
func Setup(logDir string) error {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return err
	}

	// Clean old logs (>7 days)
	cleanOldLogs(logDir, 7)

	// Open log file
	filename := time.Now().Format("2006-01-02") + ".log"
	path := filepath.Join(logDir, filename)

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	logFile = f

	// Multi-writer: file (JSON) + stdout (text)
	multiWriter := io.MultiWriter(os.Stdout, f)
	handler := slog.NewTextHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	slog.SetDefault(slog.New(handler))

	slog.Info("Logger initialized", "logFile", path)
	return nil
}

// Close flushes and closes the log file.
func Close() {
	if logFile != nil {
		logFile.Close()
	}
}

func cleanOldLogs(dir string, maxAgeDays int) {
	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
