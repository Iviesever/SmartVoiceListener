import { useState, useRef, useCallback, useEffect } from 'react';
import { useVoiceListener } from './hooks/useVoiceListener';
import { StatusHeader } from './components/StatusHeader';
import { DocumentEditor, DocumentEditorHandle } from './components/DocumentEditor/DocumentEditor';
import { UnreadTranscriptAnchor } from './components/DocumentEditor/UnreadTranscriptAnchor';
import { SettingsModal } from './components/SettingsModal';
import { CopyIcon, CheckIcon, DownloadIcon, TrashIcon } from './components/Icons';
import { loadSavedDocument, saveDocumentContent } from './services/storageService';

export default function App() {
  const editorRef = useRef<DocumentEditorHandle | null>(null);

  // 初始加载历史保存文档
  const initialDocumentRef = useRef<string>(loadSavedDocument());
  const latestDocRef = useRef<string>(initialDocumentRef.current);
  const lastStreamingPartialTextRef = useRef<string>('');

  const [charCount, setCharCount] = useState<number>(() => {
    return initialDocumentRef.current.replace(/\s/g, '').length;
  });
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. 流式 Partial 增量回调（更新视觉投影，零文档污染）
  const handleTranscriptPartial = useCallback((text: string, segmentId: string) => {
    lastStreamingPartialTextRef.current = text;
    editorRef.current?.setStreamingPartial({
      text,
      segmentId,
      isEnded: false,
    });
  }, []);

  // 2. 说话结束回调（保持最后一版灰字显示，呼吸光标静止，防止 Final 到来前视觉闪断）
  const handleTranscriptSpeechEnd = useCallback((segmentId: string) => {
    if (lastStreamingPartialTextRef.current) {
      editorRef.current?.setStreamingPartial({
        text: lastStreamingPartialTextRef.current,
        segmentId,
        isEnded: true,
      });
    }
  }, []);

  // 3. 二阶段 Final 定稿回调：移除 Partial 投影并正式将定稿文本追加写入文档
  const handleTranscriptFinal = useCallback((text: string) => {
    lastStreamingPartialTextRef.current = '';
    editorRef.current?.clearStreamingPartial();
    editorRef.current?.appendTranscript(text);
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
  });

  // 监听 pagehide 与 visibilitychange，在刷新/关闭/切后台时同步立即落盘文档
  useEffect(() => {
    const handleImmediateFlush = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveDocumentContent(latestDocRef.current);
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
      lastStreamingPartialTextRef.current = '';
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
  if (state === 'LISTENING_SILENCE') statusDetail = '正在监听环境音 (开口说话自动捕捉)';
  if (state === 'SPEAKING_ACTIVE') statusDetail = '正在实时流式识别 (Partial)...';
  if (state === 'PAUSE_WAITING') {
    const sec = (pauseCountdown / 1000).toFixed(1);
    statusDetail = `停顿检测 (${sec}s 后自动二阶段定稿)`;
  }
  if (state === 'TRANSCRIBING') statusDetail = `${activeModel} 大模型正在二阶段高精校正...`;

  return (
    <div className="app-container">
      {/* 顶部极简主控栏 */}
      <StatusHeader
        state={state}
        serverOnline={serverOnline}
        activeModel={activeModel}
        activeModelId={activeModelId}
        availableModels={availableModels}
        isSwitchingModel={isSwitchingModel}
        onSwitchModel={handleSwitchModel}
        onToggleListening={toggleListening}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* 核心文档编辑主工作区 (CodeMirror 6 纯白备忘录纸张 + Inline Ephemeral Partial) */}
      <div className="editor-main-wrapper">
        <DocumentEditor
          ref={editorRef}
          initialContent={initialDocumentRef.current}
          onDocChange={handleDocChange}
          onUnreadCountChange={handleUnreadCountChange}
        />

        {/* 智能未读听写悬浮胶囊 (用户阅读上文时出现，点击平滑触底) */}
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

        <div className="footer-actions-group">
          <span className="char-counter">字数: {charCount}</span>

          <button
            className={`action-pill-btn ${isCopied ? 'copied' : ''}`}
            onClick={handleCopyFullText}
            title="一键复制文档全文"
            disabled={charCount === 0}
          >
            {isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{isCopied ? '已复制' : '复制全文'}</span>
          </button>

          <button
            className="action-pill-btn"
            onClick={handleExportDocument}
            title="导出为 Markdown 文件"
            disabled={charCount === 0}
          >
            <DownloadIcon size={14} />
            <span>导出</span>
          </button>

          <button
            className="action-pill-btn danger"
            onClick={handleClearAll}
            title="清空当前文档"
            disabled={charCount === 0}
          >
            <TrashIcon size={14} />
            <span>清空</span>
          </button>
        </div>
      </footer>

      {/* 监听参数调节弹窗 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={vadConfig}
        onSave={updateVadConfig}
      />
    </div>
  );
}
