import React, { useEffect, useRef } from 'react';
import { ListenerState } from '../types';

interface AudioVisualizerProps {
  state: ListenerState;
  volume: number;
  pauseCountdown: number;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  state,
  volume,
  pauseCountdown,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const barCount = 42;
    const barWidth = 4;
    const barGap = 4;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const totalBarsWidth = barCount * (barWidth + barGap) - barGap;
      const startX = (width - totalBarsWidth) / 2;

      let barColor = '#cbd5e1';
      if (state === 'LISTENING_SILENCE') barColor = '#86efac';
      if (state === 'SPEAKING_ACTIVE') barColor = '#ef4444';
      if (state === 'PAUSE_WAITING') barColor = '#f97316';
      if (state === 'TRANSCRIBING') barColor = '#3b82f6';

      for (let i = 0; i < barCount; i++) {
        const x = startX + i * (barWidth + barGap);
        const centerDistance = Math.abs(i - barCount / 2) / (barCount / 2);
        const factor = Math.cos(centerDistance * (Math.PI / 2));

        let barHeight = 4;
        if (state === 'SPEAKING_ACTIVE') {
          const dynamicVol = Math.min(1, volume * 25);
          barHeight = Math.max(4, Math.min(height - 4, dynamicVol * height * factor * (0.6 + Math.sin(Date.now() * 0.02 + i * 0.8) * 0.4)));
        } else if (state === 'LISTENING_SILENCE') {
          barHeight = Math.max(3, 8 * factor + Math.sin(Date.now() * 0.004 + i) * 3);
        } else if (state === 'PAUSE_WAITING') {
          barHeight = Math.max(3, 6 * factor);
        } else if (state === 'TRANSCRIBING') {
          barHeight = Math.max(4, (height * 0.35) * (0.5 + Math.sin(Date.now() * 0.015 + i * 0.5) * 0.5));
        }

        const y = (height - barHeight) / 2;
        ctx.fillStyle = barColor;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [state, volume]);

  let statusText = '点击下方按钮开始常驻语音监听';
  if (state === 'LISTENING_SILENCE') statusText = '正在自适应监听环境音... (开口说话立即捕捉，回溯 0.8s 防吞字)';
  if (state === 'SPEAKING_ACTIVE') statusText = '正在收听说话中... (停顿后将自动转写)';
  if (state === 'PAUSE_WAITING') {
    const sec = (pauseCountdown / 1000).toFixed(1);
    statusText = `检测到停顿，${sec} 秒后判定讲完并自动转写...`;
  }
  if (state === 'TRANSCRIBING') statusText = 'RTX 4070 GPU 正在毫秒级大模型转写...';

  return (
    <div className="visualizer-card">
      <canvas
        ref={canvasRef}
        className="visualizer-canvas"
        width={360}
        height={60}
      />
      <div className="visualizer-hint">{statusText}</div>
    </div>
  );
};
