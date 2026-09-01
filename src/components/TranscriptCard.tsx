import React, { useState } from 'react';
import { TranscriptItem } from '../types';
import { CopyIcon, CheckIcon, TrashIcon } from './Icons';

interface TranscriptCardProps {
  item: TranscriptItem;
  onDelete: (id: string) => void;
}

export const TranscriptCard: React.FC<TranscriptCardProps> = ({ item, onDelete }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const durationSec = (item.durationMs / 1000).toFixed(1);

  return (
    <div className="transcript-card">
      <div className="transcript-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="transcript-time">
            {item.timeString} · {durationSec}s
          </span>
          {item.modelName && (
            <span className="transcript-model-badge">{item.modelName.split(' ')[0]}</span>
          )}
        </div>

        <div className="transcript-actions">
          <button
            className={`icon-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            title="复制文字"
          >
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => onDelete(item.id)}
            title="删除记录"
          >
            <TrashIcon size={15} />
          </button>
        </div>
      </div>
      <div className="transcript-text">{item.text}</div>
    </div>
  );
};
