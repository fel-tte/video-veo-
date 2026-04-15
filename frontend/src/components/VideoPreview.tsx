import { useState } from 'react';
import { X, Copy, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { StatusBadge } from './StatusBadge';
import { parseVideoPaths, videoSrc } from '../lib/videoPaths';

export function VideoPreview() {
  const { previewTask, closePreview, addToast } = useAppStore();
  const [currentIdx, setCurrentIdx] = useState(0);

  if (!previewTask) return null;

  const paths = parseVideoPaths(previewTask.video_path);
  const hasPaths = paths.length > 0;
  const hasMultiple = paths.length > 1;
  const safeIdx = Math.min(currentIdx, paths.length - 1);

  const copyPrompt = () => {
    navigator.clipboard.writeText(previewTask.prompt);
    addToast('Đã sao chép prompt', 'info');
  };

  const requeue = async () => {
    try {
      await (window as any).go.main.App.RequeueTask(previewTask.id);
      addToast('Đã thêm lại vào hàng đợi', 'info');
      closePreview();
    } catch (e: any) {
      addToast('Lỗi khi thêm lại: ' + String(e), 'error');
    }
  };

  const formatDate = (d: string) => d ? new Date(d).toLocaleString() : '-';

  const prev = () => setCurrentIdx((i) => (i > 0 ? i - 1 : paths.length - 1));
  const next = () => setCurrentIdx((i) => (i < paths.length - 1 ? i + 1 : 0));

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={closePreview}>
      <div className="bg-gray-900 rounded-xl border border-gray-700 w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 shrink-0">
          <h2 className="text-white font-semibold text-sm">
            Xem trước video
            {hasMultiple && <span className="text-gray-500 ml-2">({safeIdx + 1}/{paths.length})</span>}
          </h2>
          <button onClick={closePreview} className="text-gray-400 hover:text-white transition-colors"><X size={18} /></button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {/* Video Player */}
          <div className="bg-black rounded-lg overflow-hidden relative">
            {hasPaths ? (
              <>
                <video
                  key={paths[safeIdx]}
                  controls
                  autoPlay
                  className="w-full max-h-[400px] object-contain"
                  src={videoSrc(paths[safeIdx])}
                >
                  Trình duyệt không hỗ trợ phát video.
                </video>
                {hasMultiple && (
                  <>
                    <button onClick={prev} className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white rounded-full p-1.5 transition-colors">
                      <ChevronLeft size={20} />
                    </button>
                    <button onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white rounded-full p-1.5 transition-colors">
                      <ChevronRight size={20} />
                    </button>
                  </>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-gray-600 text-sm">Chưa có video</p>
              </div>
            )}
          </div>

          {/* Video thumbnails for multi-video */}
          {hasMultiple && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {paths.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentIdx(i)}
                  className={`shrink-0 px-3 py-1.5 rounded text-xs transition-colors ${
                    i === safeIdx
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  Video {i + 1}
                </button>
              ))}
            </div>
          )}

          {/* Metadata */}
          <div className="space-y-3">
            <div>
              <label className="text-gray-500 text-xs block mb-1">Prompt</label>
              <p className="text-gray-200 text-sm leading-relaxed">{previewTask.prompt}</p>
            </div>
            <div className="flex items-center gap-4">
              <div>
                <label className="text-gray-500 text-xs block mb-1">Trạng thái</label>
                <StatusBadge status={previewTask.status} />
              </div>
              <div>
                <label className="text-gray-500 text-xs block mb-1">Thử lại</label>
                <span className="text-gray-300 text-sm">{previewTask.retry_count}/{previewTask.max_retries}</span>
              </div>
              <div>
                <label className="text-gray-500 text-xs block mb-1">Ngày tạo</label>
                <span className="text-gray-300 text-sm">{formatDate(previewTask.created_at)}</span>
              </div>
              <div>
                <label className="text-gray-500 text-xs block mb-1">Hoàn thành</label>
                <span className="text-gray-300 text-sm">{formatDate(previewTask.completed_at)}</span>
              </div>
            </div>
            {previewTask.error_message && (
              <div className="p-2.5 bg-red-950/50 border border-red-800/50 rounded-lg">
                <label className="text-red-400 text-xs block mb-1">Lỗi</label>
                <p className="text-red-300 text-xs">{previewTask.error_message}</p>
              </div>
            )}
            {hasPaths && (
              <div>
                <label className="text-gray-500 text-xs block mb-1">Đường dẫn file ({paths.length} video)</label>
                <p className="text-gray-500 text-xs break-all font-mono">{paths[safeIdx]}</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 py-3 border-t border-gray-800 shrink-0">
          <button onClick={copyPrompt} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-sm transition-colors">
            <Copy size={14} /> Sao chép Prompt
          </button>
          {previewTask.status === 'failed' && (
            <button onClick={requeue} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm transition-colors">
              <RotateCcw size={14} /> Thêm lại hàng đợi
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
