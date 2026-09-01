import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

export interface DocumentEditorHandle {
  appendTranscript: (text: string) => void;
  clearContent: () => void;
  getContent: () => string;
  scrollToBottom: () => void;
}

interface DocumentEditorProps {
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
  ({ onDocChange, onUnreadCountChange }, ref) => {
    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);

    const onDocChangeRef = useRef(onDocChange);
    onDocChangeRef.current = onDocChange;

    const onUnreadCountChangeRef = useRef(onUnreadCountChange);
    onUnreadCountChangeRef.current = onUnreadCountChange;

    const isComposingRef = useRef<boolean>(false);
    const pendingTranscriptsRef = useRef<string[]>([]);
    const isAtBottomRef = useRef<boolean>(true);
    const unreadCountRef = useRef<number>(0);

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

    const flushPendingTranscripts = useCallback(() => {
      if (pendingTranscriptsRef.current.length === 0) return;
      const view = editorViewRef.current;
      if (!view) return;

      const textsToInsert = [...pendingTranscriptsRef.current];
      pendingTranscriptsRef.current = [];

      for (const text of textsToInsert) {
        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + text;

        view.dispatch({
          changes: { from: docLength, insert: insertText },
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

    const appendTranscript = useCallback(
      (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        if (isComposingRef.current) {
          pendingTranscriptsRef.current.push(trimmed);
          return;
        }

        const view = editorViewRef.current;
        if (!view) return;

        const docLength = view.state.doc.length;
        const insertText = (docLength > 0 ? '\n\n' : '') + trimmed;

        view.dispatch({
          changes: { from: docLength, insert: insertText },
          userEvent: 'input.asr',
        });

        if (isAtBottomRef.current) {
          scrollToBottom();
        } else {
          unreadCountRef.current += 1;
          onUnreadCountChangeRef.current?.(unreadCountRef.current);
        }
      },
      [scrollToBottom]
    );

    const clearContent = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;

      pendingTranscriptsRef.current = [];
      unreadCountRef.current = 0;
      onUnreadCountChangeRef.current?.(0);

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
        userEvent: 'delete.all',
      });
      isAtBottomRef.current = true;
    }, []);

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

    useEffect(() => {
      if (!editorContainerRef.current) return;

      const startState = EditorState.create({
        doc: '',
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholder('等待语音输入，或在此直接打字编辑...'),
          typoraTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const str = update.state.doc.toString();
              onDocChangeRef.current?.(str, str.length);
            }
          }),
        ],
      });

      const view = new EditorView({
        state: startState,
        parent: editorContainerRef.current,
      });

      editorViewRef.current = view;

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

      const handleCompositionStart = () => {
        isComposingRef.current = true;
      };

      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        queueMicrotask(() => {
          flushPendingTranscripts();
        });
      };

      view.contentDOM.addEventListener('compositionstart', handleCompositionStart);
      view.contentDOM.addEventListener('compositionend', handleCompositionEnd);

      return () => {
        scroller.removeEventListener('scroll', handleScroll);
        view.contentDOM.removeEventListener('compositionstart', handleCompositionStart);
        view.contentDOM.removeEventListener('compositionend', handleCompositionEnd);
        view.destroy();
        editorViewRef.current = null;
      };
    }, [flushPendingTranscripts]);

    return (
      <div className="document-workspace">
        <div ref={editorContainerRef} className="document-editor-container" />
      </div>
    );
  }
);
DocumentEditor.displayName = 'DocumentEditor';
