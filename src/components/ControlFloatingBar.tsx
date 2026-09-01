import React from 'react';
import { ListenerState } from '../types';
import { MicIcon, MicOffIcon, SettingsIcon, TrashIcon, DownloadIcon } from './Icons';

interface ControlFloatingBarProps {
  state: ListenerState;
  onToggle: () => void;
  onOpenSettings: () => void;
  onClear: () => void;
  onExport: () => void;
  hasItems: boolean;
}

export const ControlFloatingBar: React.FC<ControlFloatingBarProps> = ({
  state,
  onToggle,
  onOpenSettings,
  onClear,
  onExport,
  hasItems,
}) => {
  const isListening = state !== 'IDLE';

  return (
    <div className="bottom-bar">
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className="icon-btn"
          style={{ width: '38px', height: '38px', borderRadius: '50%' }}
          onClick={onOpenSettings}
          title="监听参数设置"
        >
          <SettingsIcon size={18} />
        </button>

        {hasItems && (
          <>
            <button
              className="icon-btn"
              style={{ width: '38px', height: '38px', borderRadius: '50%' }}
              onClick={onExport}
              title="导出全部文本"
            >
              <DownloadIcon size={18} />
            </button>
            <button
              className="icon-btn"
              style={{ width: '38px', height: '38px', borderRadius: '50%' }}
              onClick={onClear}
              title="清空记录"
            >
              <TrashIcon size={18} />
            </button>
          </>
        )}
      </div>

      <button
        className={`main-toggle-btn ${isListening ? 'is-active' : ''}`}
        onClick={onToggle}
      >
        {isListening ? (
          <>
            <MicOffIcon size={18} />
            <span>停止监听</span>
          </>
        ) : (
          <>
            <MicIcon size={18} />
            <span>开启常驻监听</span>
          </>
        )}
      </button>
    </div>
  );
};
