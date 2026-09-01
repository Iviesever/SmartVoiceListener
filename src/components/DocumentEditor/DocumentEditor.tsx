import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

export interface DocumentEditorHandle {
  appendTranscript: (text: string) => void;
  clearContent: () => void;
  getContent: () => string;
  scrollToBottom: () => void;
}

interface DocumentEditorProps {
  initialContent?: string;
  onDocChange?: (content: string, charCount: number) => void;
  onUnreadCountChange?: (count: number) => void;
}

// 强制显式设置 CodeMirror 6 的纯白高对比度主题
const typoraTheme = EditorView.theme({
  '&': {
    height: '100%',
    width: '100%',
    backgroundColor: '#ffffff',
    color: '#0f172a',
    fontSize: '1.05rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  '.cm-scroller': {
    overflowY: 'auto !important',
    overflowX: 'hidden',
    height: '100% !important',
    padding: '24px 32px',
    lineHeight: '1.6',
    fontFamily: 'inherit',
  },
  '.cm-content': {
    caretColor: '#2563eb',
    color: '#0f172a !important',
    minHeight: '100%',
    whiteSpace: 'pre-wrap !important',
    wordBreak: 'break-word !important',
    fontSize: '1.05rem !important',
    lineHeight: '1.6 !important',
    fontFamily: 'inherit !important',
  },
  '.cm-line': {
    color: '#0f172a !important',
    padding: '0 !important',
    fontSize: '1.05rem !important',
    lineHeight: '1.6 !important',
    fontFamily: 'inherit !important',
    minHeight: '1.6em !important',
  },
  '&.cm-focused': {
    outline: 'none !important',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid #2563eb !important',
    height: '1.25em !important',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: '#bfdbfe !important',
  },
  '.cm-placeholder': {
    color: '#94a3b8 !important',
    fontStyle: 'normal !important',
    fontSize: '1.05rem !important',
    lineHeight: '1.6 !important',
    fontFamily: 'inherit !important',
    display: 'inline-block !important',
  },
});

export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(
  ({ initialContent = '', onDocChange, onUnreadCountChange }, ref) => {
    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);

    const onDocChangeRef = useRef(onDocChange);
    onDocChangeRef.current = onDocChange;

    const onUnreadCountChangeRef = useRef(onUnreadCountChange);
    onUnreadCountChangeRef.current = onUnreadCountChange;

    // 控制器内部状态
    const isComposingRef = useRef<boolean>(false);
    const pendingTranscriptsRef = useRef<string[]>([]);
    const isAtBottomRef = useRef<boolean>(true);
    const unreadCountRef = useRef<number>(0);
    const lastUserEditAtRef = useRef<number>(0);
    const tailEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 智能滚动到文档底部
    const scrollToBottom = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      const scroller = view.scrollDOM;
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: 'smooth',
      });

      isAtBottomRef.current = true;
      unreadCountRef.current = 0;
      onUnreadCountChangeRef.current?.(0);
    }, []);

    // 实际执行队列消费与追加写入
    const flushPendingTranscripts = useCallback(() => {
      if (pendingTranscriptsRef.current.length === 0) return;
      const view = editorViewRef.current;
      if (!view) return;

      const textsToInsert = [...pendingTranscriptsRef.current];
      pendingTranscriptsRef.current = [];

      for (const text of textsToInsert) {
        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + text;

        // ASR 自动追加不进入用户 Undo 栈
        view.dispatch({
          changes: { from: docLength, insert: insertText },
          annotations: Transaction.addToHistory.of(false),
          userEvent: 'input.asr',
        });

        if (isAtBottomRef.current) {
          scrollToBottom();
        } else {
          unreadCountRef.current += 1;
          onUnreadCountChangeRef.current?.(unreadCountRef.current);
        }
      }
    }, [scrollToBottom]);

    // 优化：首次调度即按剩余时间 (800 - elapsed) 计算，真正做到“自最后一次敲键起满 800ms 就追加”
    const schedulePendingFlushAfterIdle = useCallback(() => {
      if (tailEditTimerRef.current) {
        clearTimeout(tailEditTimerRef.current);
        tailEditTimerRef.current = null;
      }

      if (pendingTranscriptsRef.current.length === 0) return;

      const tryFlush = () => {
        // 1. 若仍处于输入法 composition 状态，继续等待
        if (isComposingRef.current) {
          tailEditTimerRef.current = setTimeout(tryFlush, 200);
          return;
        }

        // 2. 严格校验距离最后一次用户真实打字是否满 800ms
        const elapsed = Date.now() - lastUserEditAtRef.current;
        if (elapsed < 800) {
          tailEditTimerRef.current = setTimeout(tryFlush, 800 - elapsed);
          return;
        }

        // 3. 用户确实已闲置 800ms，安全出队写入
        flushPendingTranscripts();
      };

      const elapsed = Date.now() - lastUserEditAtRef.current;
      const initialDelay = Math.max(0, 800 - elapsed);
      tailEditTimerRef.current = setTimeout(tryFlush, initialDelay);
    }, [flushPendingTranscripts]);

    // 判断用户是否正在文档尾部活跃打字
    const isUserActivelyEditingTail = useCallback((view: EditorView): boolean => {
      if (!view.hasFocus) return false;
      const docLength = view.state.doc.length;
      const selectionHead = view.state.selection.main.head;
      const isNearTail = selectionHead >= docLength - 2;
      const isRecentEdit = Date.now() - lastUserEditAtRef.current < 800;
      return isNearTail && isRecentEdit;
    }, []);

    // 程序化追加一条定稿转录文本
    const appendTranscript = useCallback(
      (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        const view = editorViewRef.current;
        if (!view) return;

        // 1. 若处于 IME 中文拼音输入中 -> 排队并进入调度器
        if (isComposingRef.current) {
          pendingTranscriptsRef.current.push(trimmed);
          schedulePendingFlushAfterIdle();
          return;
        }

        // 2. 若用户正处于文档尾部连续打字编辑中 -> 排队并进入调度器
        if (isUserActivelyEditingTail(view)) {
          pendingTranscriptsRef.current.push(trimmed);
          schedulePendingFlushAfterIdle();
          return;
        }

        // 3. 正常状态：派发 Transaction 追加
        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + trimmed;

        view.dispatch({
          changes: { from: docLength, insert: insertText },
          annotations: Transaction.addToHistory.of(false),
          userEvent: 'input.asr',
        });

        if (isAtBottomRef.current) {
          scrollToBottom();
        } else {
          unreadCountRef.current += 1;
          onUnreadCountChangeRef.current?.(unreadCountRef.current);
        }
      },
      [scrollToBottom, isUserActivelyEditingTail, schedulePendingFlushAfterIdle]
    );

    // 辅助函数：创建统一配置的 EditorState
    const createNewEditorState = useCallback((content: string) => {
      return EditorState.create({
        doc: content,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholder('等待语音输入，或在此直接打字编辑...'),
          typoraTheme,
          EditorView.updateListener.of((update) => {
            // 追踪用户真实输入行为
            const hasUserInput = update.transactions.some(
              (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete')
            );
            if (hasUserInput) {
              lastUserEditAtRef.current = Date.now();
              // 如果此时有排队的 pending transcripts，用户继续输入必须重新 reschedule 计时器
              if (pendingTranscriptsRef.current.length > 0) {
                schedulePendingFlushAfterIdle();
              }
            }

            if (update.docChanged) {
              const str = update.state.doc.toString();
              const strictCount = str.replace(/\s/g, '').length;
              onDocChangeRef.current?.(str, strictCount);
            }
          }),
        ],
      });
    }, [schedulePendingFlushAfterIdle]);

    // 清空编辑器全文：彻底重置 EditorState 以抹去 Undo 历史栈，维持 Document/Segment 分层一致性
    const clearContent = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      if (tailEditTimerRef.current) {
        clearTimeout(tailEditTimerRef.current);
        tailEditTimerRef.current = null;
      }
      pendingTranscriptsRef.current = [];
      unreadCountRef.current = 0;
      onUnreadCountChangeRef.current?.(0);

      // 通过 view.setState 赋予全新空 state，彻底重置 Undo 历史栈
      const emptyState = createNewEditorState('');
      view.setState(emptyState);

      isAtBottomRef.current = true;
    }, [createNewEditorState]);

    // 获取全文内容
    const getContent = useCallback(() => {
      return editorViewRef.current?.state.doc.toString() || '';
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        appendTranscript,
        clearContent,
        getContent,
        scrollToBottom,
      }),
      [appendTranscript, clearContent, getContent, scrollToBottom]
    );

    // 初始化 CodeMirror 6 (仅在 mount 时执行一次)
    useEffect(() => {
      if (!editorContainerRef.current) return;

      const startState = createNewEditorState(initialContent);
      const view = new EditorView({
        state: startState,
        parent: editorContainerRef.current,
      });

      editorViewRef.current = view;

      if (initialContent) {
        const strictCount = initialContent.replace(/\s/g, '').length;
        onDocChangeRef.current?.(initialContent, strictCount);
      }

      // 容差滚动监听 (80px)
      const scroller = view.scrollDOM;
      const handleScroll = () => {
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        const atBottom = distanceFromBottom <= 80;
        isAtBottomRef.current = atBottom;

        if (atBottom && unreadCountRef.current > 0) {
          unreadCountRef.current = 0;
          onUnreadCountChangeRef.current?.(0);
        }
      };

      scroller.addEventListener('scroll', handleScroll, { passive: true });

      // IME 中文拼音输入法保护
      const handleCompositionStart = () => {
        isComposingRef.current = true;
      };

      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        schedulePendingFlushAfterIdle();
      };

      view.contentDOM.addEventListener('compositionstart', handleCompositionStart);
      view.contentDOM.addEventListener('compositionend', handleCompositionEnd);

      return () => {
        if (tailEditTimerRef.current) {
          clearTimeout(tailEditTimerRef.current);
          tailEditTimerRef.current = null;
        }
        scroller.removeEventListener('scroll', handleScroll);
        view.contentDOM.removeEventListener('compositionstart', handleCompositionStart);
        view.contentDOM.removeEventListener('compositionend', handleCompositionEnd);
        view.destroy();
        editorViewRef.current = null;
      };
    }, [initialContent, createNewEditorState, schedulePendingFlushAfterIdle]);

    return (
      <div className="document-workspace">
        <div ref={editorContainerRef} className="document-editor-container" />
      </div>
    );
  }
);
DocumentEditor.displayName = 'DocumentEditor';
