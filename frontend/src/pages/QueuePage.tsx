import { useEffect, useState } from 'react';
import { Play, Pause, Square, Upload, Plus, Trash2, Save, FolderOpen, Settings2, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { StatusBadge } from '../components/StatusBadge';
import type { AppConfig } from '../types';

export function QueuePage() {
  const { tasks, queueStatus, queueProgress, config, setConfig, addToast, setTasks } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [form, setForm] = useState<AppConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dirty, setDirty] = useState(false);

  const queueTasks = tasks.filter((t) => ['pending', 'queued', 'generating', 'downloading'].includes(t.status));

  useEffect(() => {
    const load = async () => {
      try {
        const c = await (window as any).go.main.App.GetAppConfig();
        if (c) {
          setConfig(c);
          setForm(c);
        }
      } catch (_) {}
    };
    load();
  }, []);

  const update = (key: keyof AppConfig, value: any) => {
    if (!form) return;
    setForm({ ...form, [key]: value });
    setDirty(true);
  };

  const saveSettings = async () => {
    if (!form) return;
    try {
      await (window as any).go.main.App.UpdateAppConfig(form);
      setConfig(form);
      setDirty(false);
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

  const addPrompt = async () => {
    const text = prompt.trim();
    if (!text) return;
    try {
      await (window as any).go.main.App.AddPrompt(text);
      setPrompt('');
      const t = await (window as any).go.main.App.GetAllTasks();
      if (t) setTasks(t);
      await autoStartQueue();
    } catch (e: any) {
      addToast('Lỗi khi thêm: ' + String(e), 'error');
    }
  };

  const importFile = async () => {
    try {
      const count = await (window as any).go.main.App.ImportPromptsFromFile();
      if (count > 0) {
        addToast(`Đã nhập ${count} prompt`, 'success');
        const t = await (window as any).go.main.App.GetAllTasks();
        if (t) setTasks(t);
        await autoStartQueue();
      }
    } catch (e: any) {
      addToast('Lỗi nhập file: ' + String(e), 'error');
    }
  };

  const autoStartQueue = async () => {
    try {
      const status = await (window as any).go.main.App.GetQueueStatus();
      if (status === 'idle') {
        await (window as any).go.main.App.StartQueue();
      }
    } catch (e: any) {
      addToast('Lỗi khởi động hàng đợi: ' + String(e), 'error');
    }
  };

  const startQueue = async () => {
    try {
      await (window as any).go.main.App.StartQueue();
    } catch (e: any) {
      addToast('Lỗi khởi động: ' + String(e), 'error');
    }
  };

  const pauseQueue = () => (window as any).go.main.App.PauseQueue();
  const resumeQueue = () => (window as any).go.main.App.ResumeQueue();
  const stopQueue = () => (window as any).go.main.App.StopQueue();

  const deleteTask = async (id: number) => {
    try {
      await (window as any).go.main.App.DeleteTask(id);
      const t = await (window as any).go.main.App.GetAllTasks();
      if (t) setTasks(t);
    } catch (e: any) {
      addToast('Lỗi xóa: ' + String(e), 'error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addPrompt();
    }
  };

  const queueStatusLabels: Record<string, string> = {
    idle: 'Chờ',
    running: 'Đang chạy',
    paused: 'Tạm dừng',
    stopping: 'Đang dừng',
  };

  const isActive = queueStatus === 'running' || queueStatus === 'paused';

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-xl font-semibold text-white mb-4 shrink-0">Hàng đợi</h2>

      {/* Controls + Status */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {queueStatus === 'idle' || queueStatus === 'paused' ? (
            <button onClick={queueStatus === 'paused' ? resumeQueue : startQueue} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded text-sm transition-colors">
              <Play size={14} /> {queueStatus === 'paused' ? 'Tiếp tục' : 'Bắt đầu'}
            </button>
          ) : (
            <button onClick={pauseQueue} className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded text-sm transition-colors">
              <Pause size={14} /> Tạm dừng
            </button>
          )}
          <button onClick={stopQueue} disabled={queueStatus === 'idle'} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-sm disabled:opacity-30 transition-colors">
            <Square size={14} /> Dừng
          </button>
        </div>
        <span className={`text-xs px-2 py-1 rounded ${
          queueStatus === 'running' ? 'bg-green-900/50 text-green-400' :
          queueStatus === 'paused' ? 'bg-yellow-900/50 text-yellow-400' :
          'bg-gray-800 text-gray-500'
        }`}>{queueStatusLabels[queueStatus] || queueStatus}</span>
        <div className="flex-1" />
        <button onClick={importFile} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm border border-gray-700 transition-colors">
          <Upload size={14} /> Nhập file
        </button>
      </div>

      {/* Live Progress - show whenever progress exists */}
      {queueProgress && (
        <div className={`flex items-center gap-2.5 mb-3 px-3.5 py-2.5 rounded-lg border text-sm shrink-0 ${
          queueProgress.step === 'error' ? 'bg-red-950/50 border-red-800/70 text-red-300' :
          queueProgress.step === 'completed' ? 'bg-green-950/50 border-green-800/70 text-green-300' :
          'bg-blue-950/40 border-blue-800/60 text-blue-300'
        }`}>
          {queueProgress.step !== 'error' && queueProgress.step !== 'completed' && (
            <Loader2 size={15} className="animate-spin shrink-0" />
          )}
          {queueProgress.step === 'completed' && <span className="text-green-400 shrink-0 text-base">&#10003;</span>}
          {queueProgress.step === 'error' && <span className="text-red-400 shrink-0 text-base">&#10007;</span>}
          <span className="flex-1">{queueProgress.detail}</span>
          {isActive && queueProgress.step !== 'error' && queueProgress.step !== 'completed' && (
            <span className="text-xs opacity-50">đang xử lý</span>
          )}
        </div>
      )}

      {/* Generation Settings */}
      {form && (
        <div className="mb-3 shrink-0">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-2 w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-400 hover:text-gray-300 hover:border-gray-700 transition-colors"
          >
            <Settings2 size={14} />
            <span className="font-medium">Cài đặt tạo video</span>
            <span className="text-xs text-gray-600 ml-1">
              {form.model === 'veo_3_1_fast' ? 'Veo 3.1 Fast' : form.model} &middot; {form.aspect_ratio === '16:9' ? 'Landscape' : 'Portrait'} &middot; x{form.output_count}
            </span>
            <div className="flex-1" />
            {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showSettings && (
            <div className="mt-2 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Model</label>
                  <select value={form.model} onChange={(e) => update('model', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500">
                    <option value="veo_3_1_fast">Veo 3.1 Fast (Ultra)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Tỷ lệ khung hình</label>
                  <select value={form.aspect_ratio} onChange={(e) => update('aspect_ratio', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500">
                    <option value="16:9">16:9 (Landscape)</option>
                    <option value="9:16">9:16 (Portrait)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Số lượng output</label>
                  <select value={form.output_count} onChange={(e) => update('output_count', parseInt(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500">
                    <option value={1}>x1</option>
                    <option value={2}>x2</option>
                    <option value={3}>x3</option>
                    <option value={4}>x4</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 block mb-1">Thư mục tải xuống</label>
                <div className="flex gap-1">
                  <input value={form.download_dir} onChange={(e) => update('download_dir', e.target.value)} className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
                  <button onClick={() => selectDir('download_dir')} className="px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded shrink-0"><FolderOpen size={14} /></button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Thử lại tối đa</label>
                  <input type="number" value={form.max_retries} onChange={(e) => update('max_retries', parseInt(e.target.value) || 1)} min={0} max={10} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Độ trễ tối thiểu (giây)</label>
                  <input type="number" value={form.min_delay_seconds} onChange={(e) => update('min_delay_seconds', parseInt(e.target.value) || 5)} min={1} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Độ trễ tối đa (giây)</label>
                  <input type="number" value={form.max_delay_seconds} onChange={(e) => update('max_delay_seconds', parseInt(e.target.value) || 15)} min={3} className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>

              {dirty && (
                <button onClick={saveSettings} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm transition-colors">
                  <Save size={14} /> Lưu cài đặt
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add Prompt */}
      <div className="flex gap-2 mb-3 shrink-0">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nhập nội dung prompt video..."
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500"
          rows={2}
        />
        <button onClick={addPrompt} disabled={!prompt.trim()} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm disabled:opacity-30 self-end transition-colors">
          <Plus size={14} /> Thêm
        </button>
      </div>

      {/* Task List - scrollable */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
          {queueTasks.length === 0 ? (
            <p className="p-4 text-sm text-gray-600">Hàng đợi trống. Thêm prompt ở trên hoặc nhập từ file.</p>
          ) : (
            queueTasks.map((task) => (
              <div key={task.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/40 transition-colors">
                <span className="text-sm text-gray-300 truncate flex-1 min-w-0">{task.prompt}</span>
                <StatusBadge status={task.status} />
                <button onClick={() => deleteTask(task.id)} className="text-gray-600 hover:text-red-400 transition-colors shrink-0" title="Xóa">
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
