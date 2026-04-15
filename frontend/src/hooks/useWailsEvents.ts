import { useEffect } from 'react';
import { EventsOn, EventsOff } from '../../wailsjs/runtime/runtime';
import { useAppStore } from '../stores/appStore';
import type { Task, QueueStatus, BrowserStatus } from '../types';

export function useWailsEvents() {
  const { updateTask, removeTask, setQueueStatus, setQueueProgress, setBrowserStatus, addToast, setStats } = useAppStore();

  useEffect(() => {
    EventsOn('task:updated', (task: Task) => {
      updateTask(task);
      if (task.status === 'completed') {
        addToast(`Video hoàn thành: ${task.prompt.substring(0, 40)}...`, 'success');
      } else if (task.status === 'failed') {
        addToast(`Tác vụ thất bại: ${task.prompt.substring(0, 40)}...`, 'error');
      }
      try {
        (window as any).go.main.App.GetDashboardStats().then((s: any) => {
          if (s) setStats(s);
        });
      } catch (_) {}
    });

    EventsOn('task:deleted', (id: number) => {
      removeTask(id);
    });

    EventsOn('queue:status', (status: string) => {
      setQueueStatus(status as QueueStatus);
      if (status === 'idle') {
        setQueueProgress(null);
      }
    });

    EventsOn('browser:status', (status: string) => {
      setBrowserStatus(status as BrowserStatus);
    });

    EventsOn('queue:progress', (data: { step: string; detail: string }) => {
      setQueueProgress(data);
    });

    EventsOn('browser:login-required', () => {
      addToast('Cần đăng nhập — vui lòng đăng nhập Google trong cửa sổ trình duyệt', 'error');
    });

    EventsOn('tasks:batch-added', (count: number) => {
      addToast(`Đã thêm ${count} prompt vào hàng đợi`, 'info');
    });

    return () => {
      EventsOff('task:updated');
      EventsOff('task:deleted');
      EventsOff('queue:status');
      EventsOff('browser:status');
      EventsOff('queue:progress');
      EventsOff('browser:login-required');
      EventsOff('tasks:batch-added');
    };
  }, []);
}
