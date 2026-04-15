import { Minus, Square, X } from 'lucide-react';
import { WindowMinimise, WindowToggleMaximise, Quit } from '../../wailsjs/runtime/runtime';

export function TitleBar() {
  return (
    <div
      className="flex items-center justify-between h-8 bg-gray-950 border-b border-gray-800 select-none shrink-0"
      style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 pl-3">
        <span className="text-xs font-semibold text-gray-400">Veo3 Video Manager</span>
      </div>
      <div className="flex h-full" style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => WindowMinimise()}
          className="flex items-center justify-center w-11 h-full text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          title="Thu nhỏ"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => WindowToggleMaximise()}
          className="flex items-center justify-center w-11 h-full text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          title="Phóng to"
        >
          <Square size={12} />
        </button>
        <button
          onClick={() => Quit()}
          className="flex items-center justify-center w-11 h-full text-gray-400 hover:bg-red-600 hover:text-white transition-colors"
          title="Đóng"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
