package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func NewDB(dbPath string) (*sql.DB, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	db.SetMaxOpenConns(1)

	if err := runMigrations(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	return db, nil
}

func runMigrations(db *sql.DB) error {
	migrations := []string{
		// Migration 001: schema_version table
		`CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,

		// Migration 002: tasks table
		`CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			video_path TEXT,
			thumbnail_path TEXT,
			error_message TEXT,
			screenshot_path TEXT,
			retry_count INTEGER DEFAULT 0,
			max_retries INTEGER DEFAULT 3,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			started_at DATETIME,
			completed_at DATETIME,
			metadata TEXT
		)`,

		// Migration 003: indexes
		`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`,

		// Migration 004: config table
		`CREATE TABLE IF NOT EXISTS config (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	}

	for i, m := range migrations {
		version := i + 1
		var count int
		err := db.QueryRow("SELECT COUNT(*) FROM schema_version WHERE version = ?", version).Scan(&count)
		if err != nil {
			// schema_version table might not exist yet for the first migration
			if version == 1 {
				if _, execErr := db.Exec(m); execErr != nil {
					return fmt.Errorf("migration %d: %w", version, execErr)
				}
				db.Exec("INSERT INTO schema_version (version) VALUES (?)", version)
				continue
			}
			return fmt.Errorf("check migration %d: %w", version, err)
		}
		if count > 0 {
			continue
		}
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("migration %d: %w", version, err)
		}
		if _, err := db.Exec("INSERT INTO schema_version (version) VALUES (?)", version); err != nil {
			return fmt.Errorf("record migration %d: %w", version, err)
		}
	}
	return nil
}
