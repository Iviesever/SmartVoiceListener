import React from 'react';
import { ListenerState, ModelInfo } from '../types';
import { WaveformIcon, MicIcon, MicOffIcon, SettingsIcon, BoltIcon } from './Icons';

interface StatusHeaderProps {
  state: ListenerState;
  isCapturing: boolean;
  isStarting: boolean;
  isFinalizing: boolean;
  serverOnline: boolean;
  activeModel: string;
  activeModelId: string;
  availableModels: ModelInfo[];
  isSwitchingModel: boolean;
  onSwitchModel: (modelId: string) => void;
  onToggleListening: () => void;
  onOpenSettings: () => void;
}

export const StatusHeader: React.FC<StatusHeaderProps> = ({
  state,
  isCapturing,
  isStarting,
  isFinalizing,
  serverOnline,
  activeModelId,
  availableModels,
  isSwitchingModel,
  onSwitchModel,
  onToggleListening,
  onOpenSettings,
}) => {
  let statusClass = 'status-idle';
  let statusLabel = '未启动';

  if (!serverOnline && !isCapturing) {
    statusClass = 'status-offline';
    statusLabel = '服务未连';
  } else if (state === 'LISTENING_SILENCE') {
    statusClass = 'status-listening';
    statusLabel = '监听中';
  } else if (state === 'SPEAKING_ACTIVE') {
    statusClass = 'status-speaking';
    statusLabel = '流式识别';
  } else if (state === 'PAUSE_WAITING') {
    statusClass = 'status-pause';
    statusLabel = '停顿';
  } else if (state === 'TRANSCRIBING') {
    statusClass = 'status-transcribing';
    statusLabel = isFinalizing ? '定稿收尾' : '定稿校正';
  }

  const isButtonDisabled = isStarting || isFinalizing || (!isCapturing && !serverOnline);
  let buttonLabel = '开启监听';
  if (isStarting) {
    buttonLabel = '启动中...';
  } else if (isFinalizing) {
    buttonLabel = '定稿中...';
  } else if (isCapturing) {
    buttonLabel = '停止监听';
  }

  return (
    <header className="top-header">
      <div className="brand-title">
        <WaveformIcon size={20} className="brand-icon" />
        <span className="brand-name">智能语音文档</span>

        {/* 模型切换下拉选择框 */}
        {availableModels.length > 0 ? (
          <div className="model-selector-wrap">
            <select
              className="model-select"
              value={activeModelId}
              disabled={isSwitchingModel}
              onChange={(e) => onSwitchModel(e.target.value)}
              title="切换语音识别模型"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.available}>
                  {m.name} {!m.available ? '(缺失)' : ''}
                </option>
              ))}
            </select>
            {isSwitchingModel && <span className="switching-spinner" />}
          </div>
        ) : (
          <span className="brand-badge">SenseVoice</span>
        )}
      </div>

      <div className="header-controls">
        <div className={`status-pill ${statusClass}`}>
          <span className="status-dot" />
          <span>{statusLabel}</span>
        </div>

        <button
          className={`primary-listen-btn ${isCapturing ? 'listening' : ''}`}
          onClick={onToggleListening}
          disabled={isButtonDisabled}
          title={
            isFinalizing
              ? '正在完成剩余段落定稿，请稍候...'
              : isCapturing
              ? '点击停止语音监听'
              : '点击开启常驻语音监听'
          }
        >
          {isCapturing ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
          <span>{buttonLabel}</span>
        </button>

        <button
          className="icon-btn"
          onClick={onOpenSettings}
          title="监听参数设置"
        >
          <SettingsIcon size={17} />
        </button>

        <div
          title={serverOnline ? '本地 ASR 服务在线 (8767)' : '本地 ASR 服务未连接'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            borderRadius: 6,
            fontSize: '0.75rem',
            fontWeight: 600,
            background: serverOnline ? '#ecfdf5' : '#fef2f2',
            color: serverOnline ? '#059669' : '#dc2626',
            border: `1px solid ${serverOnline ? '#a7f3d0' : '#fecaca'}`,
          }}
        >
          <BoltIcon size={13} />
          <span>{serverOnline ? '8767 就绪' : '服务未启'}</span>
        </div>
      </div>
    </header>
  );
};
