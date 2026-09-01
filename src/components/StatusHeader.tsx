import React from 'react';
import { ListenerState, ModelInfo } from '../types';
import { WaveformIcon, BoltIcon } from './Icons';

interface StatusHeaderProps {
  state: ListenerState;
  serverOnline: boolean;
  activeModel: string;
  activeModelId: string;
  availableModels: ModelInfo[];
  isSwitchingModel: boolean;
  onSwitchModel: (modelId: string) => void;
}

export const StatusHeader: React.FC<StatusHeaderProps> = ({
  state,
  serverOnline,
  activeModelId,
  availableModels,
  isSwitchingModel,
  onSwitchModel,
}) => {
  let statusClass = 'status-idle';
  let statusLabel = '未启动';

  if (state === 'LISTENING_SILENCE') {
    statusClass = 'status-listening';
    statusLabel = '静默监听中';
  } else if (state === 'SPEAKING_ACTIVE') {
    statusClass = 'status-speaking';
    statusLabel = '正在收听';
  } else if (state === 'PAUSE_WAITING') {
    statusClass = 'status-pause';
    statusLabel = '停顿检测';
  } else if (state === 'TRANSCRIBING') {
    statusClass = 'status-transcribing';
    statusLabel = '正在转写';
  }

  return (
    <header className="top-header">
      <div className="brand-title">
        <WaveformIcon size={22} className="brand-icon" />
        <span>智能语音监听</span>

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
                  {m.name} {!m.available ? '(文件缺失)' : ''}
                </option>
              ))}
            </select>
            {isSwitchingModel && <span className="switching-spinner" />}
          </div>
        ) : (
          <span className="brand-badge">SenseVoice</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div className={`status-pill ${statusClass}`}>
          <span className="status-dot" />
          <span>{statusLabel}</span>
        </div>

        <div
          title={serverOnline ? '本地 ASR 服务在线 (8767)' : '本地 ASR 服务未连接'}
          style={{
            display: 'flex',
            alignItems: 'center',
            color: serverOnline ? '#16a34a' : '#94a3b8',
          }}
        >
          <BoltIcon size={18} />
        </div>
      </div>
    </header>
  );
};
