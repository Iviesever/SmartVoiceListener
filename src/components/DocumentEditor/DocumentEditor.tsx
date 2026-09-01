import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { EditorState, Transaction, StateField, StateEffect } from '@codemirror/state';
import { EditorView, keymap, placeholder, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

export interface StreamingPartialPayload {
  text: string;
  segmentId?: string;
  isEnded?: boolean;
}

export interface DocumentEditorHandle {
  appendTranscript: (text: string) => void;
  setStreamingPartial: (payload: StreamingPartialPayload) => void;
  clearStreamingPartial: () => void;
  clearContent: () => void;
  getContent: () => string;
  scrollToBottom: () => void;
}

interface DocumentEditorProps {
  initialContent?: string;
  onDocChange?: (content: string, charCount: number) => void;
  onUnreadCountChange?: (count: number) => void;
}

// -----------------------------------------------------------------------------
// CodeMirror 6 Block Widget for Inline Ephemeral Partial
// -----------------------------------------------------------------------------

export const setStreamingPartialEffect = StateEffect.define<StreamingPartialPayload>();
export const clearStreamingPartialEffect = StateEffect.define<void>();

class StreamingPartialBlockWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly segmentId?: string,
    readonly isEnded?: boolean
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-streaming-block';

    const textSpan = document.createElement('span');
    textSpan.className = 'cm-streaming-text';
    textSpan.textContent = this.text;
    wrap.appendChild(textSpan);

    const caret = document.createElement('span');
    caret.className = `cm-streaming-caret ${this.isEnded ? 'frozen' : ''}`;
    caret.textContent = '▌';
    wrap.appendChild(caret);

    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const textSpan = dom.querySelector('.cm-streaming-text');
    const caret = dom.querySelector('.cm-streaming-caret');
    if (textSpan) {
      textSpan.textContent = this.text;
    }
    if (caret) {
      caret.className = `cm-streaming-caret ${this.isEnded ? 'frozen' : ''}`;
    }
    return true;
  }

  eq(other: StreamingPartialBlockWidget): boolean {
    return (
      other.text === this.text &&
      other.segmentId === this.segmentId &&
      other.isEnded === this.isEnded
    );
  }
}

export const streamingPartialField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(setStreamingPartialEffect)) {
        const { text, segmentId, isEnded } = effect.value;
        const trimmed = text.trim();
        if (!trimmed) {
          decorations = Decoration.none;
        } else {
          const docLen = tr.state.doc.length;
          const widget = Decoration.widget({
            widget: new StreamingPartialBlockWidget(trimmed, segmentId, isEnded),
            side: 1,
            block: true,
          });
          decorations = Decoration.set([widget.range(docLen)]);
        }
      } else if (effect.is(clearStreamingPartialEffect)) {
        decorations = Decoration.none;
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// -----------------------------------------------------------------------------
// 高对比度纯白主题配置
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// DocumentEditor 组件
// -----------------------------------------------------------------------------

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
    const hasStreamingPartialRef = useRef<boolean>(false);

    // 人工跳转滚动到文档底部 (带平滑动画)
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

    // 流式增量更新时的即时置底 (使用 requestAnimationFrame 合并，绝不使用 smooth 产生黏滞)
    const instantScrollToBottom = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      requestAnimationFrame(() => {
        const scroller = view.scrollDOM;
        scroller.scrollTop = scroller.scrollHeight;
      });
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
          instantScrollToBottom();
        } else {
          unreadCountRef.current += 1;
          onUnreadCountChangeRef.current?.(unreadCountRef.current);
        }
      }
    }, [instantScrollToBottom]);

    // 尾部打字闲置调度
    const schedulePendingFlushAfterIdle = useCallback(() => {
      if (tailEditTimerRef.current) {
        clearTimeout(tailEditTimerRef.current);
        tailEditTimerRef.current = null;
      }

      if (pendingTranscriptsRef.current.length === 0) return;

      const tryFlush = () => {
        if (isComposingRef.current) {
          tailEditTimerRef.current = setTimeout(tryFlush, 200);
          return;
        }

        const elapsed = Date.now() - lastUserEditAtRef.current;
        if (elapsed < 800) {
          tailEditTimerRef.current = setTimeout(tryFlush, 800 - elapsed);
          return;
        }

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

    // 渲染实时流式 Partial 视觉投影 (绝不修改 EditorState.doc)
    const setStreamingPartial = useCallback(
      (payload: StreamingPartialPayload) => {
        const view = editorViewRef.current;
        if (!view) return;

        hasStreamingPartialRef.current = !!payload.text.trim();
        view.dispatch({
          effects: setStreamingPartialEffect.of(payload),
        });

        if (isAtBottomRef.current) {
          instantScrollToBottom();
        }
      },
      [instantScrollToBottom]
    );

    // 清空流式 Partial 视觉投影
    const clearStreamingPartial = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      hasStreamingPartialRef.current = false;
      view.dispatch({
        effects: clearStreamingPartialEffect.of(),
      });
    }, []);

    // 程序化追加一条定稿转录文本 (Final 到来时调用)
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
          instantScrollToBottom();
        } else {
          unreadCountRef.current += 1;
          onUnreadCountChangeRef.current?.(unreadCountRef.current);
        }
      },
      [instantScrollToBottom, isUserActivelyEditingTail, schedulePendingFlushAfterIdle]
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
          streamingPartialField,
          EditorView.updateListener.of((update) => {
            const hasUserInput = update.transactions.some(
              (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete')
            );
            if (hasUserInput) {
              lastUserEditAtRef.current = Date.now();
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

    // 清空编辑器全文：彻底重置 EditorState
    const clearContent = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      if (tailEditTimerRef.current) {
        clearTimeout(tailEditTimerRef.current);
        tailEditTimerRef.current = null;
      }
      pendingTranscriptsRef.current = [];
      unreadCountRef.current = 0;
      hasStreamingPartialRef.current = false;
      onUnreadCountChangeRef.current?.(0);

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
        setStreamingPartial,
        clearStreamingPartial,
        clearContent,
        getContent,
        scrollToBottom,
      }),
      [
        appendTranscript,
        setStreamingPartial,
        clearStreamingPartial,
        clearContent,
        getContent,
        scrollToBottom,
      ]
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
