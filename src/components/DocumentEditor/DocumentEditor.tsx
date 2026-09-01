import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { EditorState, Transaction, StateField, StateEffect } from '@codemirror/state';
import { EditorView, keymap, placeholder, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EphemeralSegment } from '../../types';

export interface DocumentEditorHandle {
  appendTranscript: (text: string) => void;
  setStreamingPartial: (segmentId: string, text: string) => void;
  sealStreamingPartial: (segmentId: string) => void;
  commitStreamingFinal: (segmentId: string, finalText: string) => void;
  clearStreamingPartial: (segmentId?: string) => void;
  flushPendingTranscriptsNow: () => string;
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
// CodeMirror 6 Block Widget for Multi-Segment Ephemeral Tail
// -----------------------------------------------------------------------------

export const setStreamingPartialEffect = StateEffect.define<EphemeralSegment>();
export const sealStreamingPartialEffect = StateEffect.define<string>();
export const commitStreamingFinalEffect = StateEffect.define<string>();
export const clearAllStreamingEffect = StateEffect.define<void>();

class StreamingTailBlockWidget extends WidgetType {
  constructor(readonly segments: EphemeralSegment[]) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-streaming-block';

    for (const seg of this.segments) {
      const segEl = document.createElement('div');
      segEl.className = 'cm-streaming-segment';
      segEl.dataset.segmentId = seg.segmentId;

      const textSpan = document.createElement('span');
      textSpan.className = 'cm-streaming-text';
      textSpan.textContent = seg.text;
      segEl.appendChild(textSpan);

      const caret = document.createElement('span');
      caret.className = `cm-streaming-caret ${seg.status === 'sealed' ? 'frozen' : ''}`;
      caret.textContent = '▌';
      segEl.appendChild(caret);

      wrap.appendChild(segEl);
    }

    return wrap;
  }

  updateDOM(dom: HTMLElement): boolean {
    const existingSegEls = Array.from(dom.querySelectorAll<HTMLElement>('.cm-streaming-segment'));
    
    // 若段落数量不一致，直接整块重新渲染
    if (existingSegEls.length !== this.segments.length) {
      return false;
    }

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const el = existingSegEls[i];
      if (!el || el.dataset.segmentId !== seg.segmentId) {
        return false;
      }

      const textSpan = el.querySelector('.cm-streaming-text');
      const caret = el.querySelector('.cm-streaming-caret');
      if (textSpan && textSpan.textContent !== seg.text) {
        textSpan.textContent = seg.text;
      }
      if (caret) {
        caret.className = `cm-streaming-caret ${seg.status === 'sealed' ? 'frozen' : ''}`;
      }
    }
    return true;
  }

  eq(other: StreamingTailBlockWidget): boolean {
    if (other.segments.length !== this.segments.length) return false;
    for (let i = 0; i < this.segments.length; i++) {
      const a = this.segments[i];
      const b = other.segments[i];
      if (a.segmentId !== b.segmentId || a.text !== b.text || a.status !== b.status) {
        return false;
      }
    }
    return true;
  }
}

export const streamingTailField = StateField.define<{ segments: EphemeralSegment[]; decorations: DecorationSet }>({
  create() {
    return { segments: [], decorations: Decoration.none };
  },
  update(value, tr) {
    let segments = [...value.segments];
    let changed = false;

    for (const effect of tr.effects) {
      if (effect.is(setStreamingPartialEffect)) {
        const incoming = effect.value;
        const trimmed = incoming.text.trim();
        if (!trimmed) continue;

        const idx = segments.findIndex((s) => s.segmentId === incoming.segmentId);
        if (idx >= 0) {
          segments[idx] = { ...incoming, text: trimmed };
        } else {
          segments.push({ ...incoming, text: trimmed });
        }
        changed = true;
      } else if (effect.is(sealStreamingPartialEffect)) {
        const segId = effect.value;
        const idx = segments.findIndex((s) => s.segmentId === segId);
        if (idx >= 0 && segments[idx].status !== 'sealed') {
          segments[idx] = { ...segments[idx], status: 'sealed' };
          changed = true;
        }
      } else if (effect.is(commitStreamingFinalEffect)) {
        const segId = effect.value;
        const next = segments.filter((s) => s.segmentId !== segId);
        if (next.length !== segments.length) {
          segments = next;
          changed = true;
        }
      } else if (effect.is(clearAllStreamingEffect)) {
        if (segments.length > 0) {
          segments = [];
          changed = true;
        }
      }
    }

    if (changed || tr.docChanged) {
      if (segments.length === 0) {
        return { segments: [], decorations: Decoration.none };
      }
      const docLen = tr.state.doc.length;
      const widget = Decoration.widget({
        widget: new StreamingTailBlockWidget(segments),
        side: 1,
        block: true,
      });
      return {
        segments,
        decorations: Decoration.set([widget.range(docLen)]),
      };
    }

    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (val) => val.decorations),
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
    const pendingTranscriptsRef = useRef<{ segmentId?: string; text: string }[]>([]);
    const isAtBottomRef = useRef<boolean>(true);
    const unreadCountRef = useRef<number>(0);
    const lastUserEditAtRef = useRef<number>(0);
    const tailEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 人工跳转滚动到文档底部 (平滑动画)
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

    // 流式增量更新时的即时置底 (requestAnimationFrame 合并置底)
    const instantScrollToBottom = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      requestAnimationFrame(() => {
        const scroller = view.scrollDOM;
        scroller.scrollTop = scroller.scrollHeight;
      });
    }, []);

    // 实际执行队列消费与追加写入 (原子性写入 doc 并移除对应的 ephemeral segment)
    const flushPendingTranscripts = useCallback(() => {
      if (pendingTranscriptsRef.current.length === 0) return;
      const view = editorViewRef.current;
      if (!view) return;

      const itemsToInsert = [...pendingTranscriptsRef.current];
      pendingTranscriptsRef.current = [];

      for (const item of itemsToInsert) {
        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + item.text;

        const effects: StateEffect<any>[] = [];
        if (item.segmentId) {
          effects.push(commitStreamingFinalEffect.of(item.segmentId));
        }

        view.dispatch({
          changes: { from: docLength, insert: insertText },
          effects,
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

    // 1. 设置/更新某一段的实时流式 Partial (live 状态)
    const setStreamingPartial = useCallback(
      (segmentId: string, text: string) => {
        const view = editorViewRef.current;
        if (!view) return;

        view.dispatch({
          effects: setStreamingPartialEffect.of({
            segmentId,
            text,
            status: 'live',
          }),
        });

        if (isAtBottomRef.current) {
          instantScrollToBottom();
        }
      },
      [instantScrollToBottom]
    );

    // 2. 封存某一段流式 Partial (停顿结束，等待 Final，光标静止防止闪断)
    const sealStreamingPartial = useCallback((segmentId: string) => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: sealStreamingPartialEffect.of(segmentId),
      });
    }, []);

    // 3. 提交 Final 结果：将该段正式写入文档，同时仅移除该段对应的 ephemeral 投影（不影响正在录音的其他段）
    const commitStreamingFinal = useCallback(
      (segmentId: string, finalText: string) => {
        const trimmed = finalText.trim();
        if (!trimmed) return;

        const view = editorViewRef.current;
        if (!view) return;

        // 若正处于 IME 或尾部编辑中，将写入排入队列（在此期间 ephemeral sealed 文本保持显示，0 闪失！）
        if (isComposingRef.current || isUserActivelyEditingTail(view)) {
          pendingTranscriptsRef.current.push({ segmentId, text: trimmed });
          schedulePendingFlushAfterIdle();
          return;
        }

        // 正常状态：原子性写入 doc 并清除该段 ephemeral
        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + trimmed;

        view.dispatch({
          changes: { from: docLength, insert: insertText },
          effects: commitStreamingFinalEffect.of(segmentId),
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

    // 兼容原有的无 segmentId 的 appendTranscript
    const appendTranscript = useCallback(
      (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        const view = editorViewRef.current;
        if (!view) return;

        if (isComposingRef.current || isUserActivelyEditingTail(view)) {
          pendingTranscriptsRef.current.push({ text: trimmed });
          schedulePendingFlushAfterIdle();
          return;
        }

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

    // 清空指定或全部流式投影 (关键修复 P0-6: 同步清除 pendingTranscripts 中对应 segmentId，避免 Cancel 后幽灵文本再次刷入)
    const clearStreamingPartial = useCallback((segmentId?: string) => {
      const view = editorViewRef.current;
      if (!view) return;

      if (segmentId) {
        pendingTranscriptsRef.current = pendingTranscriptsRef.current.filter(
          (item) => item.segmentId !== segmentId
        );
        view.dispatch({ effects: commitStreamingFinalEffect.of(segmentId) });
      } else {
        pendingTranscriptsRef.current = [];
        view.dispatch({ effects: clearAllStreamingEffect.of() });
      }
    }, []);

    // 立即同步清空与提交所有待写入队列 (用于 pagehide/切后台时同步落盘)
    const flushPendingTranscriptsNow = useCallback(() => {
      if (tailEditTimerRef.current) {
        clearTimeout(tailEditTimerRef.current);
        tailEditTimerRef.current = null;
      }
      flushPendingTranscripts();
      return editorViewRef.current?.state.doc.toString() || '';
    }, [flushPendingTranscripts]);

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
          streamingTailField,
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
        sealStreamingPartial,
        commitStreamingFinal,
        clearStreamingPartial,
        flushPendingTranscriptsNow,
        clearContent,
        getContent,
        scrollToBottom,
      }),
      [
        appendTranscript,
        setStreamingPartial,
        sealStreamingPartial,
        commitStreamingFinal,
        clearStreamingPartial,
        flushPendingTranscriptsNow,
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
