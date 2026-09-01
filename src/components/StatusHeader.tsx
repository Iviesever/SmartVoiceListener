import React from 'react';
import { ListenerState, ModelInfo } from '../types';
import { WaveformIcon, MicIcon, MicOffIcon, SettingsIcon, BoltIcon } from './Icons';

interface StatusHeaderProps {
  state: ListenerState;
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
  serverOnline,
  activeModelId,
  availableModels,
  isSwitchingModel,
  onSwitchModel,
  onToggleListening,
  onOpenSettings,
}) => {
  const isListening = state !== 'IDLE';

  let statusClass = 'status-idle';
  let statusLabel = '未启动';

  if (state === 'LISTENING_SILENCE') {
    statusClass = 'status-listening';
    statusLabel = '监听中';
  } else if (state === 'SPEAKING_ACTIVE') {
    statusClass = 'status-speaking';
    statusLabel = '收听中';
  } else if (state === 'PAUSE_WAITING') {
    statusClass = 'status-pause';
    statusLabel = '停顿';
  } else if (state === 'TRANSCRIBING') {
    statusClass = 'status-transcribing';
    statusLabel = '转写中';
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
          className={`primary-listen-btn ${isListening ? 'listening' : ''}`}
          onClick={onToggleListening}
          title={isListening ? '点击停止语音监听' : '点击开启常驻语音监听'}
        >
          {isListening ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
          <span>{isListening ? '停止监听' : '开启监听'}</span>
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
            color: serverOnline ? '#16a34a' : '#94a3b8',
          }}
        >
          <BoltIcon size={17} />
        </div>
      </div>
    </header>
  );
};
