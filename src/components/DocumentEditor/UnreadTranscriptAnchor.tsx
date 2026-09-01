import React from 'react';

interface UnreadTranscriptAnchorProps {
  unreadCount: number;
  onClick: () => void;
}

export const UnreadTranscriptAnchor: React.FC<UnreadTranscriptAnchorProps> = ({
  unreadCount,
  onClick,
}) => {
  if (unreadCount <= 0) return null;

  return (
    <button
      className="unread-anchor-badge"
      onClick={onClick}
      title="点击平滑跳转到最新听写内容"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <polyline points="19 12 12 19 5 12" />
      </svg>
      <span>有 {unreadCount} 条新听写</span>
    </button>
  );
};
