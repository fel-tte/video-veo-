import type { TaskStatus } from '../types';

const statusConfig: Record<TaskStatus, { color: string; label: string }> = {
  pending: { color: 'bg-gray-500/20 text-gray-400', label: 'Chờ xử lý' },
  queued: { color: 'bg-blue-500/20 text-blue-400', label: 'Trong hàng đợi' },
  generating: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Đang tạo' },
  downloading: { color: 'bg-cyan-500/20 text-cyan-400', label: 'Đang tải' },
  completed: { color: 'bg-green-500/20 text-green-400', label: 'Hoàn thành' },
  failed: { color: 'bg-red-500/20 text-red-400', label: 'Thất bại' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const cfg = statusConfig[status] || statusConfig.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color}`}>
      {(status === 'generating' || status === 'downloading') && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      )}
      {cfg.label}
    </span>
  );
}
