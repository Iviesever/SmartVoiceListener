import { useState } from 'react';
import { useVoiceListener } from './hooks/useVoiceListener';
import { StatusHeader } from './components/StatusHeader';
import { AudioVisualizer } from './components/AudioVisualizer';
import { TranscriptCard } from './components/TranscriptCard';
import { ControlFloatingBar } from './components/ControlFloatingBar';
import { SettingsModal } from './components/SettingsModal';
import { WaveformIcon } from './components/Icons';

export default function App() {
  const {
    state,
    transcripts,
    volume,
    pauseCountdown,
    vadConfig,
    serverOnline,
    activeModel,
    activeModelId,
    availableModels,
    isSwitchingModel,
    handleSwitchModel,
    toggleListening,
    deleteTranscript,
    clearAllTranscripts,
    updateVadConfig,
  } = useVoiceListener();

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // 导出全部转写文本为 Markdown
  const handleExportMarkdown = () => {
    if (transcripts.length === 0) return;
    const content = transcripts
      .slice()
      .reverse()
      .map((t) => `### [${t.timeString}] (${(t.durationMs / 1000).toFixed(1)}s - ${t.modelName || activeModel})\n\n${t.text}\n`)
      .join('\n---\n\n');

    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `语音转写记录_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-container">
      {/* 顶部极简状态栏（包含多模型切换） */}
      <StatusHeader
        state={state}
        serverOnline={serverOnline}
        activeModel={activeModel}
        activeModelId={activeModelId}
        availableModels={availableModels}
        isSwitchingModel={isSwitchingModel}
        onSwitchModel={handleSwitchModel}
      />

      {/* 极简动态声波可视化 */}
      <AudioVisualizer
        state={state}
        volume={volume}
        pauseCountdown={pauseCountdown}
      />

      {/* 历史转写段落流式列表 */}
      <main className="transcript-list">
        {transcripts.length === 0 ? (
          <div className="empty-state">
            <WaveformIcon size={40} className="empty-state-icon" />
            <p style={{ fontSize: '0.92rem', color: 'var(--text-muted)' }}>
              暂无语音转写记录
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-subtle)', maxWidth: '320px' }}>
              点击下方按钮开启常驻监听。支持自由切换 SenseVoice 与 Whisper large-v3 模型。
            </p>
          </div>
        ) : (
          transcripts.map((item) => (
            <TranscriptCard
              key={item.id}
              item={item}
              onDelete={deleteTranscript}
            />
          ))
        )}
      </main>

      {/* 底部悬浮主控栏 */}
      <ControlFloatingBar
        state={state}
        onToggle={toggleListening}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onClear={clearAllTranscripts}
        onExport={handleExportMarkdown}
        hasItems={transcripts.length > 0}
      />

      {/* 参数调节弹窗 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={vadConfig}
        onSave={updateVadConfig}
      />
    </div>
  );
}
