# Phase 3: Frontend UI

## Context Links

- [Research: Wails bindings/events](research/researcher-01-report.md)
- [Phase 1: Foundation](phase-01-foundation-chrome-core.md)
- [Phase 2: Automation](phase-02-automation-engine.md)
- [Plan Overview](plan.md)

## Overview

- **Date:** 2026-03-07
- **Priority:** High
- **Status:** Not started
- **Depends on:** Phase 1 (bindings), Phase 2 (all task lifecycle events)
- **Description:** Build React+TS frontend with four pages (Dashboard, Queue, History, Settings), real-time status updates via Wails events, video preview modal, and responsive design using Tailwind CSS + shadcn/ui.

## Key Insights

- Wails generates TS bindings automatically; import from `wailsjs/go/main/App`
- Events via `window.runtime.EventsOn("event:name", callback)` for real-time updates
- shadcn/ui provides headless components; copy-paste model, no heavy dependency
- Zustand for lightweight state management (single store or split by domain)
- HTML5 `<video>` element handles local file playback (Wails serves local files)
- Wails v2 uses `wails://` protocol for serving frontend assets; local video files need backend binding to serve

## Requirements

### Functional
- F1: Sidebar navigation with four pages: Dashboard, Queue, History, Settings
- F2: Dashboard: stats cards (total, pending, completed, failed), recent activity list
- F3: Queue page: add single prompt, batch import (CSV/TXT), task list with status badges, start/pause/stop controls
- F4: History page: searchable/filterable table of completed/failed tasks, re-queue failed
- F5: Settings page: Chrome path, download folder, delay config, retry config, browser status indicator
- F6: Video preview modal: inline video player, metadata display, copy prompt button
- F7: Real-time status updates (task status changes, queue state, browser state)
- F8: Toast notifications for errors and completions
- F9: Login-required alert when browser needs authentication

### Non-Functional
- NF1: Responsive layout (min 800x600 window)
- NF2: Dark theme default (matches developer tool aesthetic)
- NF3: No external network requests from frontend
- NF4: Sub-100ms UI response for local interactions

## Architecture

### Page/Component Tree

```
App
├── Sidebar
│   ├── Logo/Title
│   ├── NavItem: Dashboard
│   ├── NavItem: Queue
│   ├── NavItem: History
│   ├── NavItem: Settings
│   └── BrowserStatusBadge
├── MainContent (router)
│   ├── DashboardPage
│   │   ├── StatsCards (4x: total, pending, completed, failed)
│   │   └── RecentActivityList
│   ├── QueuePage
│   │   ├── QueueControls (Start, Pause, Stop buttons)
│   │   ├── AddPromptForm (textarea + submit)
│   │   ├── BatchImportButton (file dialog trigger)
│   │   └── TaskList
│   │       └── TaskRow (prompt, status badge, actions)
│   ├── HistoryPage
│   │   ├── SearchBar
│   │   ├── StatusFilter (dropdown)
│   │   └── HistoryTable
│   │       └── HistoryRow (prompt, status, date, video link, actions)
│   └── SettingsPage
│       ├── ChromeSection (path input, user data dir, browser status)
│       ├── DownloadSection (folder picker, file naming preview)
│       ├── DelaySection (min/max sliders)
│       └── RetrySection (max retries input)
└── VideoPreviewModal (global overlay)
    ├── VideoPlayer (HTML5 <video>)
    ├── MetadataPanel (prompt, dates, status, file path)
    └── ActionButtons (copy prompt, open folder, re-queue)
```

### State Management (Zustand)

```
stores/
├── taskStore.ts      -- tasks array, CRUD, filters, pagination
├── queueStore.ts     -- queue status, controls
├── browserStore.ts   -- browser connection status
├── settingsStore.ts  -- app config, save/load
└── uiStore.ts        -- modal state, active page, toasts
```

### Event Wiring

```
Wails Event              -->  Store Update           -->  UI Re-render
"task:updated"           -->  taskStore.updateTask()  -->  TaskList, HistoryTable, StatsCards
"queue:status"           -->  queueStore.setStatus()  -->  QueueControls, Sidebar badge
"browser:status"         -->  browserStore.setStatus() --> Sidebar badge, Settings
"browser:login-required" -->  uiStore.showLoginAlert() --> Alert dialog
```

## Related Code Files

### Files to Create

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/frontend/src/App.tsx` | Rewrite | App layout with sidebar + main content |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/layout/Sidebar.tsx` | Create | Sidebar navigation |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/layout/MainLayout.tsx` | Create | Layout wrapper |
| `c:/Users/Admin/Desktop/veo3/frontend/src/pages/DashboardPage.tsx` | Create | Dashboard with stats and activity |
| `c:/Users/Admin/Desktop/veo3/frontend/src/pages/QueuePage.tsx` | Create | Queue management page |
| `c:/Users/Admin/Desktop/veo3/frontend/src/pages/HistoryPage.tsx` | Create | History table page |
| `c:/Users/Admin/Desktop/veo3/frontend/src/pages/SettingsPage.tsx` | Create | Settings form page |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/queue/AddPromptForm.tsx` | Create | Single prompt input |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/queue/QueueControls.tsx` | Create | Start/pause/stop buttons |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/queue/TaskList.tsx` | Create | List of queued tasks |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/queue/TaskRow.tsx` | Create | Individual task row |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/queue/BatchImportButton.tsx` | Create | File import trigger |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/history/HistoryTable.tsx` | Create | Searchable history table |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/history/HistoryRow.tsx` | Create | Individual history row |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/dashboard/StatsCards.tsx` | Create | Dashboard stat cards |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/dashboard/RecentActivity.tsx` | Create | Recent activity list |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/settings/ChromeSettings.tsx` | Create | Chrome configuration |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/settings/DownloadSettings.tsx` | Create | Download configuration |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/settings/DelaySettings.tsx` | Create | Delay configuration |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/VideoPreviewModal.tsx` | Create | Video player modal |
| `c:/Users/Admin/Desktop/veo3/frontend/src/components/StatusBadge.tsx` | Create | Colored status badge |
| `c:/Users/Admin/Desktop/veo3/frontend/src/stores/taskStore.ts` | Create | Task state management |
| `c:/Users/Admin/Desktop/veo3/frontend/src/stores/queueStore.ts` | Create | Queue state management |
| `c:/Users/Admin/Desktop/veo3/frontend/src/stores/browserStore.ts` | Create | Browser state management |
| `c:/Users/Admin/Desktop/veo3/frontend/src/stores/settingsStore.ts` | Create | Settings state management |
| `c:/Users/Admin/Desktop/veo3/frontend/src/stores/uiStore.ts` | Create | UI state (modal, page, toasts) |
| `c:/Users/Admin/Desktop/veo3/frontend/src/hooks/useWailsEvent.ts` | Create | Custom hook for Wails events |
| `c:/Users/Admin/Desktop/veo3/frontend/src/hooks/useTaskPolling.ts` | Create | Initial data load + event subscription |
| `c:/Users/Admin/Desktop/veo3/frontend/src/types/task.ts` | Create | Task TypeScript interfaces |
| `c:/Users/Admin/Desktop/veo3/frontend/src/types/config.ts` | Create | Config TypeScript interfaces |
| `c:/Users/Admin/Desktop/veo3/frontend/src/lib/utils.ts` | Create | Utility functions (date format, truncate) |

### Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `c:/Users/Admin/Desktop/veo3/frontend/src/index.css` | Modify | Tailwind imports, dark theme defaults |
| `c:/Users/Admin/Desktop/veo3/frontend/tailwind.config.js` | Modify | shadcn/ui theme config |
| `c:/Users/Admin/Desktop/veo3/frontend/package.json` | Modify | Add zustand, shadcn deps |
| `c:/Users/Admin/Desktop/veo3/app.go` | Modify | Add video file serving binding |

## Implementation Steps

### Step 1: Frontend Dependencies Setup

1. Install npm packages:
   ```bash
   cd frontend
   npm install zustand
   npm install -D @types/node
   ```
2. Initialize shadcn/ui:
   ```bash
   npx shadcn-ui@latest init
   ```
   - Style: Default
   - Base color: Slate
   - CSS variables: Yes
3. Add shadcn components needed:
   ```bash
   npx shadcn-ui@latest add button card input textarea badge table dialog select separator toast
   ```
4. Configure Tailwind for dark mode: `darkMode: "class"`, add `dark` class to `<html>`

### Step 2: TypeScript Types

1. Create `frontend/src/types/task.ts`:
   ```typescript
   export type TaskStatus = 'pending' | 'queued' | 'generating' | 'downloading' | 'completed' | 'failed';

   export interface Task {
     id: number;
     prompt: string;
     status: TaskStatus;
     video_path: string | null;
     thumbnail_path: string | null;
     error_message: string | null;
     screenshot_path: string | null;
     retry_count: number;
     max_retries: number;
     created_at: string;
     started_at: string | null;
     completed_at: string | null;
     metadata: string | null;
   }

   export interface DashboardStats {
     total: number;
     pending: number;
     generating: number;
     completed: number;
     failed: number;
   }
   ```
2. Create `frontend/src/types/config.ts`:
   ```typescript
   export interface AppConfig {
     chrome_path: string;
     user_data_dir: string;
     download_dir: string;
     min_delay_seconds: number;
     max_delay_seconds: number;
     max_retries: number;
     show_browser: boolean;
   }
   ```

### Step 3: Zustand Stores

1. Create `taskStore.ts`:
   - State: `tasks: Task[]`, `stats: DashboardStats`, `filter: TaskStatus | 'all'`, `searchQuery: string`
   - Actions: `fetchTasks()`, `fetchStats()`, `updateTask(task: Task)`, `setFilter()`, `setSearch()`
   - `fetchTasks` calls `window.go.main.App.GetAllTasks()`
   - `updateTask` called from Wails event listener
2. Create `queueStore.ts`:
   - State: `status: QueueStatus`
   - Actions: `start()`, `pause()`, `resume()`, `stop()`, `setStatus()`
   - Each action calls corresponding Go binding
3. Create `browserStore.ts`:
   - State: `status: BrowserStatus`, `loginRequired: boolean`
   - Actions: `launch()`, `close()`, `setStatus()`, `setLoginRequired()`
4. Create `settingsStore.ts`:
   - State: `config: AppConfig`
   - Actions: `fetchConfig()`, `updateConfig(partial)`
5. Create `uiStore.ts`:
   - State: `activePage: string`, `previewTask: Task | null`, `toasts: Toast[]`
   - Actions: `setPage()`, `openPreview(task)`, `closePreview()`, `addToast()`, `removeToast()`

### Step 4: Wails Event Hooks

1. Create `hooks/useWailsEvent.ts`:
   ```typescript
   import { useEffect } from 'react';
   import { EventsOn, EventsOff } from '../../wailsjs/runtime/runtime';

   export function useWailsEvent(eventName: string, callback: (data: any) => void) {
     useEffect(() => {
       EventsOn(eventName, callback);
       return () => { EventsOff(eventName); };
     }, [eventName, callback]);
   }
   ```
2. Create `hooks/useTaskPolling.ts`:
   - On mount: fetch all tasks and stats from Go backend
   - Subscribe to `task:updated` event, update taskStore
   - Subscribe to `queue:status`, update queueStore
   - Subscribe to `browser:status`, update browserStore
   - Subscribe to `browser:login-required`, show alert

### Step 5: Layout Components

1. Create `components/layout/Sidebar.tsx`:
   - Fixed left sidebar, 240px wide
   - App title at top ("Veo3 Manager")
   - Navigation items with icons (use Lucide React icons):
     - LayoutDashboard for Dashboard
     - ListTodo for Queue
     - History for History
     - Settings for Settings
   - Active page highlighted
   - Browser status badge at bottom (green dot = connected, red = disconnected, yellow = launching)
   - Click handler: `uiStore.setPage()`
2. Create `components/layout/MainLayout.tsx`:
   - Flex container: sidebar + main content area
   - Main content has padding, scrollable
   - Conditionally renders active page based on `uiStore.activePage`

### Step 6: Dashboard Page

1. Create `pages/DashboardPage.tsx`:
   - Grid of 4 StatsCards (total, pending, completed, failed)
   - Each card: icon, label, count, subtle color coding
2. Create `components/dashboard/StatsCards.tsx`:
   - Uses shadcn `Card` component
   - Reads from `taskStore.stats`
3. Create `components/dashboard/RecentActivity.tsx`:
   - List of 10 most recent tasks (any status)
   - Each item: truncated prompt, status badge, relative time ("2m ago")
   - Click opens VideoPreviewModal for completed tasks

### Step 7: Queue Page

1. Create `pages/QueuePage.tsx`:
   - Top section: QueueControls + AddPromptForm side by side
   - Bottom section: TaskList (pending/queued/generating tasks)
2. Create `components/queue/QueueControls.tsx`:
   - Three buttons: Start (play icon), Pause, Stop
   - Disabled states based on queue status
   - Queue status text label
3. Create `components/queue/AddPromptForm.tsx`:
   - Textarea for prompt input (multiline, 3 rows)
   - "Add to Queue" button
   - Calls `window.go.main.App.AddPrompt(prompt)`
   - Clears input on success, shows toast
4. Create `components/queue/BatchImportButton.tsx`:
   - "Import File" button
   - Calls `window.go.main.App.ImportPromptsFromFile()` (triggers native file dialog)
   - Shows toast with count imported
5. Create `components/queue/TaskList.tsx`:
   - Scrollable list of TaskRow components
   - Filtered to show only pending/queued/generating status
   - Empty state message when no tasks
6. Create `components/queue/TaskRow.tsx`:
   - Prompt text (truncated to 100 chars)
   - StatusBadge component
   - Remove button (trash icon)
   - Generating tasks show spinner animation

### Step 8: History Page

1. Create `pages/HistoryPage.tsx`:
   - Top: search input + status filter dropdown
   - Below: HistoryTable
2. Create `components/history/HistoryTable.tsx`:
   - shadcn Table component
   - Columns: Prompt, Status, Created, Completed, Actions
   - Sorted by created_at descending
   - Filtered by `taskStore.filter` and `taskStore.searchQuery`
3. Create `components/history/HistoryRow.tsx`:
   - Prompt (truncated, click to expand)
   - StatusBadge
   - Formatted dates
   - Actions: View (opens preview modal), Re-queue (for failed tasks), Open folder
   - Re-queue calls `window.go.main.App.RequeueTask(id)`

### Step 9: Settings Page

1. Create `pages/SettingsPage.tsx`:
   - Sections separated by dividers
   - Save button at bottom (calls `settingsStore.updateConfig()`)
2. Create `components/settings/ChromeSettings.tsx`:
   - Chrome path input with "Browse" button (native folder dialog)
   - User data directory input with "Browse" button
   - Browser status indicator (connected/disconnected)
   - "Launch Browser" / "Close Browser" button
3. Create `components/settings/DownloadSettings.tsx`:
   - Download folder input with "Browse" button
   - File naming preview based on current format
4. Create `components/settings/DelaySettings.tsx`:
   - Min delay slider/input (range: 10-300 seconds)
   - Max delay slider/input (range: 30-600 seconds)
   - Validation: max >= min

### Step 10: Video Preview Modal

1. Create `components/VideoPreviewModal.tsx`:
   - shadcn Dialog component, fullscreen overlay
   - Left side: HTML5 `<video>` player with controls
   - Right side: metadata panel
   - Video source: need Go binding `GetVideoFileURL(path string) string` that returns servable URL
   - Metadata: prompt (full text), status, created/completed dates, file path, file size
   - Action buttons: Copy prompt (clipboard API), Open containing folder (Go binding), Re-queue
   - Close on Escape key or X button

### Step 11: StatusBadge Component

1. Create `components/StatusBadge.tsx`:
   - Uses shadcn Badge component
   - Color mapping:
     - pending: gray
     - queued: blue
     - generating: yellow/amber (with pulse animation)
     - downloading: cyan
     - completed: green
     - failed: red

### Step 12: Video File Serving

1. Modify `app.go` to add binding:
   ```go
   func (a *App) ReadVideoFile(path string) ([]byte, error) {
       // Validate path is within download directory (security)
       // Read file bytes
       // Return for frontend consumption
   }
   ```
2. Frontend creates blob URL from returned bytes for `<video>` src
3. Alternative: Wails v2 `AssetServer` can serve local files if configured

### Step 13: Toast Notifications

1. Use shadcn toast component
2. Wire to events:
   - Task completed -> success toast with prompt preview
   - Task failed -> error toast with error message
   - Batch import -> info toast with count
   - Browser disconnected -> warning toast

## Todo List

- [ ] Install npm dependencies (zustand, shadcn/ui, lucide-react)
- [ ] Configure Tailwind dark mode
- [ ] Create TypeScript type definitions
- [ ] Implement Zustand stores (task, queue, browser, settings, ui)
- [ ] Create useWailsEvent hook
- [ ] Create useTaskPolling hook
- [ ] Build Sidebar and MainLayout
- [ ] Build DashboardPage with StatsCards and RecentActivity
- [ ] Build QueuePage with controls, prompt form, task list
- [ ] Build BatchImportButton
- [ ] Build HistoryPage with search, filter, table
- [ ] Build SettingsPage with all config sections
- [ ] Build VideoPreviewModal with video player
- [ ] Build StatusBadge component
- [ ] Add video file serving binding in Go
- [ ] Wire toast notifications
- [ ] Test all pages with real data from Phase 2
- [ ] Test real-time event updates

## Success Criteria

1. All four pages render correctly with real data
2. Real-time task status updates reflect in UI without page refresh
3. Queue controls (start/pause/stop) work and update UI state
4. Adding single prompt creates task and appears in queue list
5. Batch import from TXT/CSV file creates multiple tasks
6. History search and filter work correctly
7. Video preview modal plays completed videos inline
8. Settings changes persist across app restarts
9. Browser status badge reflects actual Chrome connection state
10. Toast notifications appear for key events

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Wails TS binding generation fails | Low | Medium | Manually define types if needed; bindings are straightforward |
| Video playback from local files | Medium | Medium | Use Go binding to read file bytes + frontend blob URL; test early |
| Large task lists slow rendering | Low | Low | Virtualized list if >1000 items; unlikely for this use case |
| shadcn/ui version incompatibility | Low | Low | Pin version; components are copy-pasted, not imported |

## Security Considerations

- Video file serving binding must validate path is within configured download directory (prevent directory traversal)
- No user-inputted HTML rendered; prompt text displayed as plain text
- Clipboard API for copy prompt is secure (requires user gesture in modern browsers)
- No external network requests from frontend

## Next Steps

- Phase 4 depends on: all pages functional, event system working
- Consider: adding keyboard shortcuts (Ctrl+N for new prompt, Space for start/pause)
- Consider: drag-and-drop reordering of queue items (deferred, YAGNI)
