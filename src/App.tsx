import { useState, useRef, useEffect, useCallback } from 'react';
import { StatusHeader } from './components/StatusHeader';
import { DocumentEditor, DocumentEditorHandle } from './components/DocumentEditor/DocumentEditor';
import { UnreadTranscriptAnchor } from './components/DocumentEditor/UnreadTranscriptAnchor';
import { SettingsModal } from './components/SettingsModal';
import { useVoiceListener } from './hooks/useVoiceListener';
import { CopyIcon, DownloadIcon, TrashIcon, CheckIcon } from './components/Icons';
import { loadSavedDocument, saveDocumentContent } from './services/storageService';

export function App() {
  const editorRef = useRef<DocumentEditorHandle | null>(null);
  const initialDocumentRef = useRef<string>(loadSavedDocument());
  const latestDocRef = useRef<string>(initialDocumentRef.current);

  const [charCount, setCharCount] = useState<number>(() => {
    return initialDocumentRef.current.replace(/\s/g, '').length;
  });
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. 实时流式 Partial 增量回调（按 segmentId 更新独立的 live ephemeral 投影）
  const handleTranscriptPartial = useCallback((segmentId: string, text: string) => {
    editorRef.current?.setStreamingPartial(segmentId, text);
  }, []);

  // 2. 某一段说话结束回调（将该段置为 sealed 状态，光标静止，防止 Final 异步返回前视觉闪断）
  const handleTranscriptSpeechEnd = useCallback((segmentId: string) => {
    editorRef.current?.sealStreamingPartial(segmentId);
  }, []);

  // 3. 二阶段 Final 定稿回调：原子性提交该段 Final 正文，并精准仅移除该 segmentId 的 ephemeral 投影
  const handleTranscriptFinal = useCallback((segmentId: string, text: string) => {
    editorRef.current?.commitStreamingFinal(segmentId, text);
  }, []);

  // 4. 取消/丢弃回调：清除对应 segmentId 的 ephemeral 投影 (短噪声、取消或彻底失败)
  const handleTranscriptCancelled = useCallback((segmentId: string) => {
    editorRef.current?.clearStreamingPartial(segmentId);
  }, []);

  // 文档内容变化防抖持久化 (600ms debounce)
  const handleDocChange = useCallback((text: string, count: number) => {
    latestDocRef.current = text;
    setCharCount(count);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveDocumentContent(text);
    }, 600);
  }, []);

  const handleUnreadCountChange = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  const {
    state,
    isCapturing,
    isStarting,
    isFinalizing,
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
    resetWorkspace,
    updateVadConfig,
  } = useVoiceListener({
    onTranscriptPartial: handleTranscriptPartial,
    onTranscriptSpeechEnd: handleTranscriptSpeechEnd,
    onTranscriptFinal: handleTranscriptFinal,
    onTranscriptCancelled: handleTranscriptCancelled,
  });

  // 关键修复 P0-6: 监听 pagehide 与 visibilitychange，先同步 flush editor 待提交队列再落盘文档
  useEffect(() => {
    const handleImmediateFlush = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      const flushed = editorRef.current?.flushPendingTranscriptsNow();
      const textToSave = flushed !== undefined ? flushed : latestDocRef.current;
      latestDocRef.current = textToSave;
      saveDocumentContent(textToSave);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleImmediateFlush();
      }
    };

    window.addEventListener('pagehide', handleImmediateFlush);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handleImmediateFlush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      handleImmediateFlush();
    };
  }, []);

  // 复制全文到剪贴板
  const handleCopyFullText = async () => {
    const fullText = editorRef.current?.getContent() || '';
    if (!fullText.trim()) return;

    try {
      await navigator.clipboard.writeText(fullText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  // 导出为 Markdown / TXT 文档
  const handleExportDocument = () => {
    const fullText = editorRef.current?.getContent() || '';
    if (!fullText.trim()) return;

    const blob = new Blob([fullText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `语音转录纪要_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 清空文档与后台 Generation
  const handleClearAll = () => {
    if (window.confirm('确定要清空文档内容吗？')) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      latestDocRef.current = '';
      saveDocumentContent('');
      editorRef.current?.clearStreamingPartial();
      editorRef.current?.clearContent();
      resetWorkspace();
      setCharCount(0);
      setUnreadCount(0);
    }
  };

  // 状态栏动态指示文案
  let statusDetail = '就绪';
  if (isFinalizing) {
    statusDetail = `${activeModel} 正在完成最后定稿收尾...`;
  } else if (state === 'LISTENING_SILENCE') {
    statusDetail = '正在监听环境音 (开口说话自动捕捉)';
  } else if (state === 'SPEAKING_ACTIVE') {
    statusDetail = '正在实时流式识别 (Partial)...';
  } else if (state === 'PAUSE_WAITING') {
    const sec = (pauseCountdown / 1000).toFixed(1);
    statusDetail = `停顿检测 (${sec}s 后自动二阶段定稿)`;
  } else if (state === 'TRANSCRIBING') {
    statusDetail = `${activeModel} 大模型正在二阶段高精校正...`;
  }

  return (
    <div className="app-container">
      {/* 顶部极简主控栏 */}
      <StatusHeader
        state={state}
        isCapturing={isCapturing}
        isStarting={isStarting}
        isFinalizing={isFinalizing}
        serverOnline={serverOnline}
        activeModel={activeModel}
        activeModelId={activeModelId}
        availableModels={availableModels}
        isSwitchingModel={isSwitchingModel}
        onSwitchModel={handleSwitchModel}
        onToggleListening={toggleListening}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* 核心文档编辑主工作区 (CodeMirror 6 纯白备忘录纸张 + 多段重叠 Ephemeral Tail) */}
      <div className="editor-main-wrapper">
        <DocumentEditor
          ref={editorRef}
          initialContent={initialDocumentRef.current}
          onDocChange={handleDocChange}
          onUnreadCountChange={handleUnreadCountChange}
        />

        {/* 智能未读听写悬浮胶囊 */}
        <UnreadTranscriptAnchor
          unreadCount={unreadCount}
          onClick={() => editorRef.current?.scrollToBottom()}
        />
      </div>

      {/* 底部极简状态与操作栏 */}
      <footer className="bottom-status-bar">
        <div className="status-indicator-group">
          <div className="voice-pulse-dot" data-state={state} style={{ transform: `scale(${1 + Math.min(1, volume * 15)})` }} />
          <span className="status-text">{statusDetail}</span>
        </div>

        <div className="status-actions-group">
          <span className="char-counter">{charCount} 字</span>

          <div className="divider-v" />

          <button
            className="action-link-btn"
            onClick={handleCopyFullText}
            title="复制全文内容"
          >
            {isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{isCopied ? '已复制' : '复制全文'}</span>
          </button>

          <button
            className="action-link-btn"
            onClick={handleExportDocument}
            title="导出为 Markdown 格式文档"
          >
            <DownloadIcon size={14} />
            <span>导出文档</span>
          </button>

          <button
            className="action-link-btn danger"
            onClick={handleClearAll}
            title="清空当前文档所有内容"
          >
            <TrashIcon size={14} />
            <span>清空</span>
          </button>
        </div>
      </footer>

      {/* 监听参数调节抽屉/模态框 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        config={vadConfig}
        onClose={() => setIsSettingsOpen(false)}
        onSave={updateVadConfig}
      />
    </div>
  );
}

export default App;
