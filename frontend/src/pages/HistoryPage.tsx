import { useState, useMemo } from 'react';
import { Search, Eye, RotateCcw, Film } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { StatusBadge } from '../components/StatusBadge';
import { parseVideoPaths } from '../lib/videoPaths';
import type { TaskStatus } from '../types';

export function HistoryPage() {
  const { tasks, openPreview, addToast, setTasks } = useAppStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (search && !t.prompt.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [tasks, search, statusFilter]);

  const requeue = async (id: number) => {
    try {
      await (window as any).go.main.App.RequeueTask(id);
      addToast('Đã thêm lại vào hàng đợi', 'info');
      const t = await (window as any).go.main.App.GetAllTasks();
      if (t) setTasks(t);
    } catch (e: any) {
      addToast('Lỗi thêm lại: ' + String(e), 'error');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-xl font-semibold text-white mb-4 shrink-0">Lịch sử</h2>

      {/* Filters */}
      <div className="flex gap-2 mb-3 shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm kiếm prompt..."
            className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="pending">Chờ xử lý</option>
          <option value="generating">Đang tạo</option>
          <option value="completed">Hoàn thành</option>
          <option value="failed">Thất bại</option>
        </select>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-gray-900 border border-gray-800 rounded-lg">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900 z-10">
            <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
              <th className="text-left px-4 py-2.5">Prompt</th>
              <th className="text-left px-4 py-2.5 w-20">Video</th>
              <th className="text-left px-4 py-2.5 w-28">Trạng thái</th>
              <th className="text-left px-4 py-2.5 w-36">Ngày tạo</th>
              <th className="text-right px-4 py-2.5 w-24">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-600">Không tìm thấy tác vụ nào</td></tr>
            ) : (
              filtered.map((task) => (
                <tr key={task.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-2.5 text-gray-300"><span className="block truncate max-w-xs">{task.prompt}</span></td>
                  <td className="px-4 py-2.5">
                    {(() => {
                      const count = parseVideoPaths(task.video_path).length;
                      return count > 0 ? (
                        <span className="flex items-center gap-1 text-gray-400 text-xs">
                          <Film size={12} /> {count}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">-</span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={task.status} /></td>
                  <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{new Date(task.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openPreview(task)} className="p-1 text-gray-500 hover:text-blue-400" title="Xem">
                        <Eye size={14} />
                      </button>
                      {task.status === 'failed' && (
                        <button onClick={() => requeue(task.id)} className="p-1 text-gray-500 hover:text-green-400" title="Thêm lại hàng đợi">
                          <RotateCcw size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
