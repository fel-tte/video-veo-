export type TaskStatus = 'pending' | 'queued' | 'generating' | 'downloading' | 'completed' | 'failed';

export interface Task {
  id: number;
  prompt: string;
  status: TaskStatus;
  video_path: string;
  thumbnail_path: string;
  error_message: string;
  screenshot_path: string;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string;
  completed_at: string;
  metadata: string;
}

export interface DashboardStats {
  total: number;
  pending: number;
  generating: number;
  completed: number;
  failed: number;
}

export interface AppConfig {
  chrome_path: string;
  user_data_dir: string;
  download_dir: string;
  min_delay_seconds: number;
  max_delay_seconds: number;
  max_retries: number;
  show_browser: boolean;
  debug_port: number;
  // Generation settings
  model: string;
  aspect_ratio: string;
  output_count: number;
}

export interface BrowserInfo {
  status: string;
  control_url: string;
  debug_port: number;
  profile_dir: string;
  chrome_path: string;
}

export type QueueStatus = 'idle' | 'running' | 'paused' | 'stopping';
export type BrowserStatus = 'disconnected' | 'launching' | 'connected' | 'error';
export type Page = 'dashboard' | 'queue' | 'history' | 'settings';
