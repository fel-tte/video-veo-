# Ma Trận Chức Năng -> API Hàm Cụ Thể (app.go)

Tài liệu này map toàn bộ hàm trong `app.go` sang nơi gọi từ UI (frontend).

- Cột `UI gọi hàm` liệt kê call-site trực tiếp từ code trong `frontend/src`.
- Nếu hàm không được UI gọi trực tiếp, cột này ghi rõ cơ chế gọi khác (lifecycle Wails / chưa dùng).

## 1) Ma trận đầy đủ từng hàm trong app.go

| STT | Hàm trong app.go | Dòng định nghĩa | UI gọi hàm | Ghi chú |
|---|---|---|---|---|
| 1 | `startup(ctx)` | `app.go:35` | Không gọi trực tiếp từ UI | Được Wails gọi lúc app khởi động qua `OnStartup` ở `main.go:63`. |
| 2 | `shutdown(ctx)` | `app.go:80` | Không gọi trực tiếp từ UI | Được Wails gọi lúc app đóng qua `OnShutdown` ở `main.go:64`. |
| 3 | `LaunchBrowser()` | `app.go:96` | `frontend/src/pages/SettingsPage.tsx:69` | Nút khởi động Chrome trong trang Cài đặt. |
| 4 | `CloseBrowser()` | `app.go:103` | `frontend/src/pages/SettingsPage.tsx:77` | Nút đóng Chrome trong trang Cài đặt. |
| 5 | `GetBrowserStatus()` | `app.go:110` | Không có call trực tiếp trong `frontend/src` | UI nhận trạng thái qua event `browser:status` trong `useWailsEvents`. |
| 6 | `GetBrowserInfo()` | `app.go:117` | `frontend/src/pages/SettingsPage.tsx:35` | Hiển thị CDP URL, debug port, profile dir. |
| 7 | `GetAllTasks()` | `app.go:127` | `frontend/src/pages/DashboardPage.tsx:15`, `frontend/src/pages/QueuePage.tsx:60`, `frontend/src/pages/QueuePage.tsx:73`, `frontend/src/pages/QueuePage.tsx:108`, `frontend/src/pages/HistoryPage.tsx:25` | Tải danh sách task cho dashboard/queue/history. |
| 8 | `GetTasksByStatus(status)` | `app.go:141` | Không có call trực tiếp | Có thể mở rộng cho filter server-side trong tương lai. |
| 9 | `CreateTask(prompt)` | `app.go:155` | Không có call trực tiếp | UI hiện dùng `AddPrompt` thay vì tạo task thuần. |
| 10 | `DeleteTask(id)` | `app.go:170` | `frontend/src/pages/QueuePage.tsx:107` | Xóa task khỏi hàng đợi. |
| 11 | `GetDashboardStats()` | `app.go:182` | `frontend/src/pages/DashboardPage.tsx:13`, `frontend/src/hooks/useWailsEvents.ts:18` | Tải thống kê ban đầu + refresh sau mỗi `task:updated`. |
| 12 | `GetAppConfig()` | `app.go:191` | `frontend/src/pages/QueuePage.tsx:19`, `frontend/src/pages/SettingsPage.tsx:14` | Tải config hiện tại để render form. |
| 13 | `UpdateAppConfig(cfg)` | `app.go:195` | `frontend/src/pages/QueuePage.tsx:38`, `frontend/src/pages/SettingsPage.tsx:52` | Lưu config và cập nhật queue/browser manager. |
| 14 | `SelectDirectory()` | `app.go:212` | `frontend/src/pages/QueuePage.tsx:49`, `frontend/src/pages/SettingsPage.tsx:62` | Mở dialog chọn thư mục. |
| 15 | `StartQueue()` | `app.go:220` | `frontend/src/pages/QueuePage.tsx:86`, `frontend/src/pages/QueuePage.tsx:95` | Auto-start sau khi thêm/import prompt và khi bấm nút Bắt đầu. |
| 16 | `PauseQueue()` | `app.go:234` | `frontend/src/pages/QueuePage.tsx:101` | Tạm dừng hàng đợi. |
| 17 | `ResumeQueue()` | `app.go:240` | `frontend/src/pages/QueuePage.tsx:102` | Tiếp tục hàng đợi. |
| 18 | `StopQueue()` | `app.go:246` | `frontend/src/pages/QueuePage.tsx:103` | Dừng hàng đợi. |
| 19 | `GetQueueStatus()` | `app.go:252` | `frontend/src/pages/QueuePage.tsx:84` | Dùng để auto-start chỉ khi queue đang idle. |
| 20 | `AddPrompt(prompt)` | `app.go:259` | `frontend/src/pages/QueuePage.tsx:58` | Thêm 1 prompt từ textarea. |
| 21 | `AddPromptBatch(prompts)` | `app.go:266` | Không có call trực tiếp từ UI hiện tại | UI batch hiện đi qua `ImportPromptsFromFile`. |
| 22 | `ImportPromptsFromFile()` | `app.go:274` | `frontend/src/pages/QueuePage.tsx:70` | Import hàng loạt prompt từ `.txt`/`.csv`. |
| 23 | `RequeueTask(id)` | `app.go:294` | `frontend/src/pages/HistoryPage.tsx:23`, `frontend/src/components/VideoPreview.tsx:25` | Đưa task failed về pending để chạy lại. |
| 24 | `DetectChromePath()` | `app.go:303` | `frontend/src/pages/SettingsPage.tsx:28` | Tự phát hiện đường dẫn Chrome. |
| 25 | `GetSelectors()` | `app.go:315` | Không có call trực tiếp | API sẵn cho màn hình debug/selectors (chưa expose ở UI hiện tại). |
| 26 | `UpdateSelector(name, selector)` | `app.go:322` | Không có call trực tiếp | API sẵn cho chỉnh selector runtime (chưa expose UI). |
| 27 | `GetCredits()` | `app.go:331` | Không có call trực tiếp | API credits đã có backend, chưa có giao diện hiển thị. |
| 28 | `RefreshAPIToken()` | `app.go:338` | Không có call trực tiếp | Token chủ yếu tự refresh trong worker/API client. |

## 2) Bản đồ UI -> API nhanh

### Dashboard
- `GetDashboardStats()` -> `frontend/src/pages/DashboardPage.tsx:13`
- `GetAllTasks()` -> `frontend/src/pages/DashboardPage.tsx:15`

### Queue
- `GetAppConfig()` -> `frontend/src/pages/QueuePage.tsx:19`
- `UpdateAppConfig()` -> `frontend/src/pages/QueuePage.tsx:38`
- `SelectDirectory()` -> `frontend/src/pages/QueuePage.tsx:49`
- `AddPrompt()` -> `frontend/src/pages/QueuePage.tsx:58`
- `GetAllTasks()` -> `frontend/src/pages/QueuePage.tsx:60`, `frontend/src/pages/QueuePage.tsx:73`, `frontend/src/pages/QueuePage.tsx:108`
- `ImportPromptsFromFile()` -> `frontend/src/pages/QueuePage.tsx:70`
- `GetQueueStatus()` -> `frontend/src/pages/QueuePage.tsx:84`
- `StartQueue()` -> `frontend/src/pages/QueuePage.tsx:86`, `frontend/src/pages/QueuePage.tsx:95`
- `PauseQueue()` -> `frontend/src/pages/QueuePage.tsx:101`
- `ResumeQueue()` -> `frontend/src/pages/QueuePage.tsx:102`
- `StopQueue()` -> `frontend/src/pages/QueuePage.tsx:103`
- `DeleteTask()` -> `frontend/src/pages/QueuePage.tsx:107`

### History
- `RequeueTask()` -> `frontend/src/pages/HistoryPage.tsx:23`
- `GetAllTasks()` -> `frontend/src/pages/HistoryPage.tsx:25`

### Settings
- `GetAppConfig()` -> `frontend/src/pages/SettingsPage.tsx:14`
- `DetectChromePath()` -> `frontend/src/pages/SettingsPage.tsx:28`
- `GetBrowserInfo()` -> `frontend/src/pages/SettingsPage.tsx:35`
- `UpdateAppConfig()` -> `frontend/src/pages/SettingsPage.tsx:52`
- `SelectDirectory()` -> `frontend/src/pages/SettingsPage.tsx:62`
- `LaunchBrowser()` -> `frontend/src/pages/SettingsPage.tsx:69`
- `CloseBrowser()` -> `frontend/src/pages/SettingsPage.tsx:77`

### Component/Hooks dùng API
- `RequeueTask()` -> `frontend/src/components/VideoPreview.tsx:25`
- `GetDashboardStats()` -> `frontend/src/hooks/useWailsEvents.ts:18`

## 3) Event-driven (UI không gọi hàm poll trực tiếp)

UI nhận trạng thái realtime qua event Wails trong `frontend/src/hooks/useWailsEvents.ts`:
- `task:updated`
- `task:deleted`
- `queue:status`
- `queue:progress`
- `browser:status`
- `browser:login-required`
- `tasks:batch-added`

Backend phát các event này chủ yếu từ `app.go` (bridge) + `internal/queue/manager.go`/`internal/queue/worker.go`.
