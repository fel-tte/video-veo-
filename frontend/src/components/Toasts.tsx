import { X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

const typeColors = {
  success: 'bg-green-900/80 border-green-700 text-green-200',
  error: 'bg-red-900/80 border-red-700 text-red-200',
  info: 'bg-blue-900/80 border-blue-700 text-blue-200',
};

export function Toasts() {
  const { toasts, removeToast } = useAppStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div key={t.id} className={`flex items-start gap-2 px-3 py-2 rounded border text-sm ${typeColors[t.type]}`}>
          <span className="flex-1">{t.msg}</span>
          <button onClick={() => removeToast(t.id)} className="opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
