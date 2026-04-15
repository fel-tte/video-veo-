# Veo3 Video Manager

Xây dựng desktop app Windows tự động tạo video AI hàng loạt từ Google Labs (labs.google). User nhập danh sách prompt, bấm Start, app tự lần lượt gửi prompt, chờ video tạo xong, tải về máy — hoàn toàn tự động sau khi đăng nhập Google lần đầu.

## Tech stack
Go + Wails v2 (desktop framework Go + WebView2). go-rod/rod + go-rod/stealth cho Chrome automation qua CDP. SQLite local (modernc.org/sqlite pure Go). Frontend React + TypeScript + Vite + Tailwind CSS dark theme + Zustand + Lucide React.

## Yêu cầu chính
App quản lý hàng đợi prompt. Mỗi prompt gửi lên Google Labs API tạo 1-4 video tùy cấu hình. Sau khi video tạo xong thì tải về thư mục local. Có giao diện xem lại video, quản lý lịch sử, cấu hình settings. Queue chạy nền, có thể pause/resume/stop. Config thay đổi trên UI phải có hiệu lực ngay task tiếp theo mà không cần restart queue.

## Những điều quan trọng phải biết

Google Labs không có public API. Phải điều khiển Chrome thật để đăng nhập Google, lấy token, và download video. Token không phải API key mà phải trích xuất từ biến `__NEXT_DATA__` Google nhúng trong page bằng cách evaluate JavaScript trên browser.

Google detect bot automation. Bắt buộc dùng go-rod/stealth để bypass: override navigator.webdriver, giả lập plugins/languages/platform. Chrome phải launch với flag `disable-blink-features=AutomationControlled`. Không có stealth thì bị block.

Chrome phải launch với `--user-data-dir` riêng để lưu session login persist giữa các lần chạy. Trước khi launch Chrome mới, thử connect vào Chrome đang chạy trên debug port bằng cách GET `/json/version` lấy WebSocket URL.

Prompt editor của Google Labs dùng Slate.js — không thể type bằng keyboard events, phải dùng CDP `Input.insertText`. Nút submit (Create) phải filter theo vị trí y > 680 pixel vì trang có nhiều button giống nhau.

Settings UI của Google Labs: dropdown mở bằng button `aria-haspopup="menu"` chứa text `crop_`. Aspect ratio và output count dùng `role="tab"` với `data-state`. Model selection dùng `role="menuitem"` trong sub-dropdown — hai cái này khác nhau.

Video download không có endpoint trực tiếp. Phải mở URL redirect trong tab Chrome mới (cần cookies), browser tự redirect tới signed GCS URL, lấy URL đó download bằng HTTP. Dùng Bearer token hay JS fetch đều fail.

Status thành công Google trả về là `MEDIA_GENERATION_STATUS_SUCCESSFUL` — không phải `COMPLETED`. reCAPTCHA optional, API hoạt động bình thường không cần.

API base: `aisandbox-pa.googleapis.com/v1`. Hai endpoint: một submit generation (trả media IDs), một poll status (mỗi 10s, timeout 5 phút). Mỗi prompt tạo 1-4 video với seed random khác nhau. Hiện chỉ model `veo_3_1_t2v_fast_ultra` hoạt động, các model khác unavailable.

WebView không đọc file system trực tiếp. Cần HTTP handler serve file .mp4 local qua URL pattern `/localfile/{path}`. Video paths lưu dạng JSON array trong database.

## Giao diện
Window frameless, custom title bar. 4 trang: Dashboard (thống kê), Queue (settings + nhập prompt + task list + điều khiển queue + live progress), History (bảng lịch sử tìm kiếm/lọc + preview video + requeue), Settings (cấu hình Chrome + debug info). Multi-video carousel khi task có nhiều output. Toast notifications. Sidebar có browser status indicator.
