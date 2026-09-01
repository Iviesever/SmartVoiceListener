import React, { useState } from 'react';
import { VadConfig } from '../types';
import { CloseIcon } from './Icons';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: VadConfig;
  onSave: (newConfig: Partial<VadConfig>) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSave,
}) => {
  const [pauseDurationMs, setPauseDurationMs] = useState(config.pauseDurationMs);
  const [speechThreshold, setSpeechThreshold] = useState(config.speechThreshold);
  const [prefixBufferMs, setPrefixBufferMs] = useState(config.prefixBufferMs);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave({
      pauseDurationMs,
      speechThreshold,
      prefixBufferMs,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">语音监听与切片参数</span>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="setting-group">
          <div className="setting-label">
            <span>停顿判定时长</span>
            <span style={{ color: 'var(--primary)' }}>{pauseDurationMs} ms ({(pauseDurationMs / 1000).toFixed(1)}s)</span>
          </div>
          <div className="setting-desc">领导停顿超过该时长即判定整段话说完，并触发转写</div>
          <input
            type="range"
            min={600}
            max={3000}
            step={100}
            value={pauseDurationMs}
            onChange={(e) => setPauseDurationMs(Number(e.target.value))}
            className="setting-input"
          />
        </div>

        <div className="setting-group">
          <div className="setting-label">
            <span>人声开口灵敏度</span>
            <span style={{ color: 'var(--primary)' }}>{speechThreshold.toFixed(3)}</span>
          </div>
          <div className="setting-desc">数值越小越灵敏（嘈杂环境建议调大至 0.035~0.05）</div>
          <input
            type="range"
            min={0.01}
            max={0.08}
            step={0.005}
            value={speechThreshold}
            onChange={(e) => setSpeechThreshold(Number(e.target.value))}
            className="setting-input"
          />
        </div>

        <div className="setting-group">
          <div className="setting-label">
            <span>开口前缓冲时长</span>
            <span style={{ color: 'var(--primary)' }}>{prefixBufferMs} ms</span>
          </div>
          <div className="setting-desc">检测到开口时向前追溯保留的音频（防止吞掉第一个字）</div>
          <input
            type="range"
            min={200}
            max={1000}
            step={100}
            value={prefixBufferMs}
            onChange={(e) => setPrefixBufferMs(Number(e.target.value))}
            className="setting-input"
          />
        </div>

        <button className="btn-primary" onClick={handleSave} style={{ marginTop: '8px' }}>
          保存并应用
        </button>
      </div>
    </div>
  );
};
