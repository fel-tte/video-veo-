import { useEffect } from 'react';
import { Film, Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { StatusBadge } from '../components/StatusBadge';
import type { Task } from '../types';

export function DashboardPage() {
  const { stats, tasks, setStats, setTasks, openPreview } = useAppStore();

  useEffect(() => {
    const load = async () => {
      try {
        const s = await (window as any).go.main.App.GetDashboardStats();
        if (s) setStats(s);
        const t = await (window as any).go.main.App.GetAllTasks();
        if (t) setTasks(t);
      } catch (_) {}
    };
    load();
  }, []);

  const recentTasks = tasks.slice(0, 10);

  const cards = [
    { label: 'Tổng cộng', value: stats.total, icon: Film, color: 'text-blue-400' },
    { label: 'Chờ xử lý', value: stats.pending, icon: Clock, color: 'text-yellow-400' },
    { label: 'Đang tạo', value: stats.generating, icon: Loader2, color: 'text-cyan-400' },
    { label: 'Hoàn thành', value: stats.completed, icon: CheckCircle, color: 'text-green-400' },
    { label: 'Thất bại', value: stats.failed, icon: XCircle, color: 'text-red-400' },
  ];

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-4">Trang chủ</h2>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500 uppercase">{label}</span>
              <Icon size={16} className={color} />
            </div>
            <span className="text-2xl font-bold text-white">{value}</span>
          </div>
        ))}
      </div>

      {/* Recent Activity */}
      <h3 className="text-sm font-medium text-gray-400 mb-2">Hoạt động gần đây</h3>
      <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
        {recentTasks.length === 0 ? (
          <p className="p-4 text-sm text-gray-600">Chưa có tác vụ nào. Thêm prompt ở tab Hàng đợi.</p>
        ) : (
          recentTasks.map((task: Task) => (
            <div
              key={task.id}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-800/50 cursor-pointer transition-colors"
              onClick={() => task.status === 'completed' || task.status === 'failed' ? openPreview(task) : null}
            >
              <span className="text-sm text-gray-300 truncate max-w-[60%]">{task.prompt}</span>
              <div className="flex items-center gap-3">
                <StatusBadge status={task.status} />
                <span className="text-xs text-gray-600">{new Date(task.created_at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
