package storage

import "database/sql"

type TaskStatus string

const (
	StatusPending     TaskStatus = "pending"
	StatusQueued      TaskStatus = "queued"
	StatusGenerating  TaskStatus = "generating"
	StatusDownloading TaskStatus = "downloading"
	StatusCompleted   TaskStatus = "completed"
	StatusFailed      TaskStatus = "failed"
)

type Task struct {
	ID             int64          `json:"id"`
	Prompt         string         `json:"prompt"`
	Status         TaskStatus     `json:"status"`
	VideoPath      sql.NullString `json:"-"`
	VideoPathStr   string         `json:"video_path"`
	ThumbnailPath  sql.NullString `json:"-"`
	ThumbnailStr   string         `json:"thumbnail_path"`
	ErrorMessage   sql.NullString `json:"-"`
	ErrorStr       string         `json:"error_message"`
	ScreenshotPath sql.NullString `json:"-"`
	ScreenshotStr  string         `json:"screenshot_path"`
	RetryCount     int            `json:"retry_count"`
	MaxRetries     int            `json:"max_retries"`
	CreatedAt      string         `json:"created_at"`
	StartedAt      sql.NullString `json:"-"`
	StartedAtStr   string         `json:"started_at"`
	CompletedAt    sql.NullString `json:"-"`
	CompletedAtStr string         `json:"completed_at"`
	Metadata       sql.NullString `json:"-"`
	MetadataStr    string         `json:"metadata"`
}

// FillStrings populates the JSON-exported string fields from sql.NullString fields.
func (t *Task) FillStrings() {
	t.VideoPathStr = nullStr(t.VideoPath)
	t.ThumbnailStr = nullStr(t.ThumbnailPath)
	t.ErrorStr = nullStr(t.ErrorMessage)
	t.ScreenshotStr = nullStr(t.ScreenshotPath)
	t.StartedAtStr = nullStr(t.StartedAt)
	t.CompletedAtStr = nullStr(t.CompletedAt)
	t.MetadataStr = nullStr(t.Metadata)
}

func nullStr(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}

type TaskFilter struct {
	Status string `json:"status"`
	Search string `json:"search"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

type Stats struct {
	Total      int `json:"total"`
	Pending    int `json:"pending"`
	Generating int `json:"generating"`
	Completed  int `json:"completed"`
	Failed     int `json:"failed"`
}
