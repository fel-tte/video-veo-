import { useEffect, useState } from 'react';
import { FolderOpen, Save, Chrome, Copy, RefreshCw } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { AppConfig } from '../types';

export function SettingsPage() {
  const { config, setConfig, browserStatus, browserInfo, setBrowserInfo, addToast } = useAppStore();
  const [form, setForm] = useState<AppConfig | null>(null);
  const [detectedChrome, setDetectedChrome] = useState<string>('');

  useEffect(() => {
    const load = async () => {
      try {
        const c = await (window as any).go.main.App.GetAppConfig();
        if (c) {
          setConfig(c);
          setForm(c);
        }
      } catch (_) {}
      refreshBrowserInfo();
      detectChrome();
    };
    load();
  }, []);

  const detectChrome = async () => {
    try {
      const path = await (window as any).go.main.App.DetectChromePath();
      if (path) setDetectedChrome(path);
    } catch (_) {}
  };

  const refreshBrowserInfo = async () => {
    try {
      const info = await (window as any).go.main.App.GetBrowserInfo();
      if (info) setBrowserInfo(info);
    } catch (_) {}
  };

  useEffect(() => {
    refreshBrowserInfo();
  }, [browserStatus]);

  if (!form) return <p className="text-gray-500">Đang tải cài đặt...</p>;

  const update = (key: keyof AppConfig, value: any) => {
    setForm({ ...form, [key]: value });
  };

  const save = async () => {
    try {
      await (window as any).go.main.App.UpdateAppConfig(form);
      setConfig(form);
      addToast('Đã lưu cài đặt', 'success');
    } catch (e: any) {
      addToast('Lỗi lưu: ' + String(e), 'error');
    }
  };

  const selectDir = async (key: keyof AppConfig) => {
    try {
      const dir = await (window as any).go.main.App.SelectDirectory();
      if (dir) update(key, dir);
    } catch (_) {}
  };

  const launchBrowser = async () => {
    try {
      await (window as any).go.main.App.LaunchBrowser();
    } catch (e: any) {
      addToast('Lỗi khởi động: ' + String(e), 'error');
    }
  };

  const closeBrowser = async () => {
    try {
      await (window as any).go.main.App.CloseBrowser();
    } catch (e: any) {
      addToast('Lỗi đóng trình duyệt: ' + String(e), 'error');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addToast('Đã sao chép', 'info');
  };

  const statusLabels: Record<string, string> = {
    connected: 'Đã kết nối',
    launching: 'Đang khởi động',
    disconnected: 'Chưa kết nối',
    error: 'Lỗi',
  };

  return (
    <div className="max-w-4xl mx-auto w-full">
      <h2 className="text-xl font-semibold text-white mb-4">Cài đặt Chrome</h2>

      {/* Browser + Debug in 2-column grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        {/* Browser Section */}
        <section>
          <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2"><Chrome size={14} /> Trình duyệt</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 h-full">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Đường dẫn Chrome</label>
              <input
                value={form.chrome_path}
                onChange={(e) => update('chrome_path', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                placeholder="Tự phát hiện"
              />
              {detectedChrome && !form.chrome_path && (
                <p className="text-xs text-green-500 mt-1">Đã phát hiện: {detectedChrome}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Thư mục dữ liệu người dùng</label>
              <div className="flex gap-2">
                <input value={form.user_data_dir} onChange={(e) => update('user_data_dir', e.target.value)} className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
                <button onClick={() => selectDir('user_data_dir')} className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"><FolderOpen size={14} /></button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Cổng debug (Remote Debugging Port)</label>
              <input type="number" value={form.debug_port} onChange={(e) => update('debug_port', parseInt(e.target.value) || 9222)} min={1024} max={65535} className="w-32 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-400">Trạng thái: <span className="font-medium">{statusLabels[browserStatus] || browserStatus}</span></span>
              {browserStatus === 'disconnected' ? (
                <button onClick={launchBrowser} className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-sm">Khởi động</button>
              ) : browserStatus === 'connected' ? (
                <button onClick={closeBrowser} className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-sm">Đóng</button>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={form.show_browser} onChange={(e) => update('show_browser', e.target.checked)} className="rounded" />
              Hiển thị cửa sổ trình duyệt (chế độ headed)
            </label>
          </div>
        </section>

        {/* Chrome Debug Info Panel */}
        <section>
          <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
            <Chrome size={14} /> Thông tin kết nối Debug
            <button onClick={refreshBrowserInfo} className="ml-auto text-gray-500 hover:text-gray-300" title="Làm mới">
              <RefreshCw size={14} />
            </button>
          </h3>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3 h-full">
            {browserInfo && browserInfo.status === 'connected' ? (
              <>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">CDP WebSocket URL (cho AI kết nối)</label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-green-400 font-mono break-all">
                      {browserInfo.control_url || `ws://127.0.0.1:${browserInfo.debug_port}`}
                    </code>
                    <button onClick={() => copyToClipboard(browserInfo.control_url || `ws://127.0.0.1:${browserInfo.debug_port}`)} className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded shrink-0" title="Sao chép">
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Cổng debug</label>
                    <div className="flex gap-2">
                      <code className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-cyan-400 font-mono">
                        {browserInfo.debug_port}
                      </code>
                      <button onClick={() => copyToClipboard(String(browserInfo.debug_port))} className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded shrink-0" title="Sao chép">
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">DevTools URL</label>
                    <div className="flex gap-2">
                      <code className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-cyan-400 font-mono">
                        http://127.0.0.1:{browserInfo.debug_port}
                      </code>
                      <button onClick={() => copyToClipboard(`http://127.0.0.1:${browserInfo.debug_port}`)} className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded shrink-0" title="Sao chép">
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Thư mục profile</label>
                  <code className="block bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-400 font-mono break-all">
                    {browserInfo.profile_dir}
                  </code>
                </div>
                {browserInfo.chrome_path && (
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Đường dẫn Chrome</label>
                    <code className="block bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-400 font-mono break-all">
                      {browserInfo.chrome_path}
                    </code>
                  </div>
                )}
                <div className="p-2 bg-blue-900/20 border border-blue-800/30 rounded text-xs text-blue-400">
                  AI có thể kết nối vào trình duyệt này bằng CDP URL ở trên để đọc elements, debug automation, và lấy CSS selectors.
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-32">
                <p className="text-sm text-gray-600 text-center">Trình duyệt chưa kết nối.<br />Khởi động trình duyệt để xem thông tin debug.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Save */}
      <button onClick={save} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm">
        <Save size={14} /> Lưu cài đặt
      </button>
    </div>
  );
}
