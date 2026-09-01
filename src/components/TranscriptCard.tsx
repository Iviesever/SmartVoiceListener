import React from 'react';
import { TranscriptSegment } from '../types';
import { PlayIcon } from './Icons';

interface TranscriptCardProps {
  segment: TranscriptSegment;
}

export const TranscriptCard: React.FC<TranscriptCardProps> = ({ segment }) => {
  const handlePlayAudio = () => {
    if (segment.audioBlobUrl) {
      const audio = new Audio(segment.audioBlobUrl);
      audio.play().catch(console.error);
    }
  };

  const durSec = (segment.durationMs / 1000).toFixed(1);

  return (
    <div className="transcript-card">
      <div className="card-header">
        <span className="card-time">{new Date(segment.createdAt).toLocaleTimeString()}</span>
        <span className="card-meta">
          <span className="card-model">{segment.modelId}</span>
          <span className="card-dur">{durSec}s</span>
        </span>
      </div>
      <div className="card-text">{segment.originalText}</div>
      {segment.audioBlobUrl && (
        <div className="card-actions">
          <button className="icon-btn-sm" onClick={handlePlayAudio} title="回放录音">
            <PlayIcon size={13} />
          </button>
        </div>
      )}
    </div>
  );
};
