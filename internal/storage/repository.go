package storage

import (
	"database/sql"
	"fmt"
	"strings"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) Close() error {
	return r.db.Close()
}

func (r *Repository) CreateTask(prompt string) (*Task, error) {
	result, err := r.db.Exec(
		"INSERT INTO tasks (prompt, status) VALUES (?, ?)",
		prompt, StatusPending,
	)
	if err != nil {
		return nil, fmt.Errorf("create task: %w", err)
	}
	id, _ := result.LastInsertId()
	return r.GetTaskByID(id)
}

func (r *Repository) GetTaskByID(id int64) (*Task, error) {
	t := &Task{}
	err := r.db.QueryRow(
		`SELECT id, prompt, status, video_path, thumbnail_path, error_message,
		        screenshot_path, retry_count, max_retries, created_at, started_at,
		        completed_at, metadata
		 FROM tasks WHERE id = ?`, id,
	).Scan(
		&t.ID, &t.Prompt, &t.Status, &t.VideoPath, &t.ThumbnailPath,
		&t.ErrorMessage, &t.ScreenshotPath, &t.RetryCount, &t.MaxRetries,
		&t.CreatedAt, &t.StartedAt, &t.CompletedAt, &t.Metadata,
	)
	if err != nil {
		return nil, fmt.Errorf("get task %d: %w", id, err)
	}
	t.FillStrings()
	return t, nil
}

func (r *Repository) GetTasks(filter TaskFilter) ([]Task, error) {
	query := `SELECT id, prompt, status, video_path, thumbnail_path, error_message,
	                  screenshot_path, retry_count, max_retries, created_at, started_at,
	                  completed_at, metadata
	           FROM tasks`
	var conditions []string
	var args []interface{}

	if filter.Status != "" && filter.Status != "all" {
		conditions = append(conditions, "status = ?")
		args = append(args, filter.Status)
	}
	if filter.Search != "" {
		conditions = append(conditions, "prompt LIKE ?")
		args = append(args, "%"+filter.Search+"%")
	}

	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY created_at DESC"

	if filter.Limit > 0 {
		query += fmt.Sprintf(" LIMIT %d", filter.Limit)
		if filter.Offset > 0 {
			query += fmt.Sprintf(" OFFSET %d", filter.Offset)
		}
	}

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("get tasks: %w", err)
	}
	defer rows.Close()

	var tasks []Task
	for rows.Next() {
		var t Task
		if err := rows.Scan(
			&t.ID, &t.Prompt, &t.Status, &t.VideoPath, &t.ThumbnailPath,
			&t.ErrorMessage, &t.ScreenshotPath, &t.RetryCount, &t.MaxRetries,
			&t.CreatedAt, &t.StartedAt, &t.CompletedAt, &t.Metadata,
		); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		t.FillStrings()
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

func (r *Repository) UpdateTaskStatus(id int64, status TaskStatus, fields map[string]interface{}) error {
	setClauses := []string{"status = ?"}
	args := []interface{}{string(status)}

	for k, v := range fields {
		setClauses = append(setClauses, k+" = ?")
		args = append(args, v)
	}
	args = append(args, id)

	query := fmt.Sprintf("UPDATE tasks SET %s WHERE id = ?", strings.Join(setClauses, ", "))
	_, err := r.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("update task %d: %w", id, err)
	}
	return nil
}

func (r *Repository) DeleteTask(id int64) error {
	_, err := r.db.Exec("DELETE FROM tasks WHERE id = ?", id)
	return err
}

func (r *Repository) GetNextPending() (*Task, error) {
	t := &Task{}
	err := r.db.QueryRow(
		`SELECT id, prompt, status, video_path, thumbnail_path, error_message,
		        screenshot_path, retry_count, max_retries, created_at, started_at,
		        completed_at, metadata
		 FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT 1`, StatusPending,
	).Scan(
		&t.ID, &t.Prompt, &t.Status, &t.VideoPath, &t.ThumbnailPath,
		&t.ErrorMessage, &t.ScreenshotPath, &t.RetryCount, &t.MaxRetries,
		&t.CreatedAt, &t.StartedAt, &t.CompletedAt, &t.Metadata,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get next pending: %w", err)
	}
	t.FillStrings()
	return t, nil
}

func (r *Repository) GetStats() (*Stats, error) {
	s := &Stats{}
	err := r.db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&s.Total)
	if err != nil {
		return nil, err
	}
	r.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE status IN ('pending', 'queued')").Scan(&s.Pending)
	r.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE status IN ('generating', 'downloading')").Scan(&s.Generating)
	r.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE status = 'completed'").Scan(&s.Completed)
	r.db.QueryRow("SELECT COUNT(*) FROM tasks WHERE status = 'failed'").Scan(&s.Failed)
	return s, nil
}

func (r *Repository) GetConfig(key string) (string, error) {
	var value string
	err := r.db.QueryRow("SELECT value FROM config WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

func (r *Repository) SetConfig(key, value string) error {
	_, err := r.db.Exec(
		"INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
		key, value, value,
	)
	return err
}
