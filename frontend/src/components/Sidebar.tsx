import { LayoutDashboard, ListTodo, History, Settings, Chrome } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { Page, BrowserStatus } from '../types';

const navItems: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: 'dashboard', label: 'Trang chủ', icon: LayoutDashboard },
  { page: 'queue', label: 'Hàng đợi', icon: ListTodo },
  { page: 'history', label: 'Lịch sử', icon: History },
  { page: 'settings', label: 'Cài đặt', icon: Settings },
];

const statusLabels: Record<BrowserStatus, string> = {
  connected: 'Đã kết nối',
  launching: 'Đang khởi động...',
  disconnected: 'Chưa kết nối',
  error: 'Lỗi',
};

const statusColors: Record<BrowserStatus, string> = {
  connected: 'bg-green-500',
  launching: 'bg-yellow-500 animate-pulse',
  disconnected: 'bg-gray-500',
  error: 'bg-red-500',
};

export function Sidebar() {
  const { activePage, setPage, browserStatus } = useAppStore();

  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col h-full">
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-lg font-bold text-white">Veo3 Manager</h1>
        <p className="text-xs text-gray-500">Quản lý tạo video AI</p>
      </div>

      <nav className="flex-1 py-2">
        {navItems.map(({ page, label, icon: Icon }) => (
          <button
            key={page}
            onClick={() => setPage(page)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              activePage === page
                ? 'bg-blue-600/20 text-blue-400 border-r-2 border-blue-400'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-800">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Chrome size={14} />
          <span>Trình duyệt</span>
          <span className={`ml-auto w-2 h-2 rounded-full ${statusColors[browserStatus]}`} />
          <span>{statusLabels[browserStatus]}</span>
        </div>
      </div>
    </aside>
  );
}
