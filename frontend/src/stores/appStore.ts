import { create } from 'zustand';
import type { Task, DashboardStats, AppConfig, QueueStatus, BrowserStatus, BrowserInfo, Page } from '../types';

interface AppState {
  // UI
  activePage: Page;
  previewTask: Task | null;
  toasts: { id: number; msg: string; type: 'success' | 'error' | 'info' }[];

  // Data
  tasks: Task[];
  stats: DashboardStats;
  config: AppConfig | null;
  queueStatus: QueueStatus;
  browserStatus: BrowserStatus;
  browserInfo: BrowserInfo | null;
  queueProgress: { step: string; detail: string } | null;

  // Actions
  setPage: (page: Page) => void;
  setTasks: (tasks: Task[]) => void;
  updateTask: (task: Task) => void;
  removeTask: (id: number) => void;
  setStats: (stats: DashboardStats) => void;
  setConfig: (config: AppConfig) => void;
  setQueueStatus: (status: QueueStatus) => void;
  setQueueProgress: (progress: { step: string; detail: string } | null) => void;
  setBrowserStatus: (status: BrowserStatus) => void;
  setBrowserInfo: (info: BrowserInfo | null) => void;
  openPreview: (task: Task) => void;
  closePreview: () => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  removeToast: (id: number) => void;
}

let toastId = 0;

export const useAppStore = create<AppState>((set) => ({
  activePage: 'dashboard',
  previewTask: null,
  toasts: [],
  tasks: [],
  stats: { total: 0, pending: 0, generating: 0, completed: 0, failed: 0 },
  config: null,
  queueStatus: 'idle',
  browserStatus: 'disconnected',
  browserInfo: null,
  queueProgress: null,

  setPage: (page) => set({ activePage: page }),

  setTasks: (tasks) => set({ tasks }),

  updateTask: (task) => set((state) => {
    const idx = state.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      const tasks = [...state.tasks];
      tasks[idx] = task;
      return { tasks };
    }
    return { tasks: [task, ...state.tasks] };
  }),

  removeTask: (id) => set((state) => ({
    tasks: state.tasks.filter((t) => t.id !== id),
  })),

  setStats: (stats) => set({ stats }),
  setConfig: (config) => set({ config }),
  setQueueStatus: (status) => set({ queueStatus: status }),
  setQueueProgress: (progress) => set({ queueProgress: progress }),
  setBrowserStatus: (status) => set({ browserStatus: status }),
  setBrowserInfo: (info) => set({ browserInfo: info }),
  openPreview: (task) => set({ previewTask: task }),
  closePreview: () => set({ previewTask: null }),

  addToast: (msg, type) => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, msg, type }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },

  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id),
  })),
}));
