import { TranscriptSegment } from '../types';

const STORAGE_KEY = 'smart_voice_document_content';
const SEGMENTS_KEY = 'smart_voice_segments';

// 加载最近一次保存的文档全文内容
export function loadSavedDocument(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (e) {
    console.error('Failed to load document from localStorage:', e);
    return '';
  }
}

// 缓存文档内容
export function saveDocumentContent(content: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, content);
  } catch (e) {
    console.error('Failed to save document to localStorage:', e);
  }
}

// 保存底层 Segments 记录 (排除临时 Blob URL)
export function saveSegments(segments: TranscriptSegment[]): void {
  try {
    const clean = segments.map((item) => ({
      ...item,
      audioBlobUrl: undefined,
    }));
    localStorage.setItem(SEGMENTS_KEY, JSON.stringify(clean));
  } catch (e) {
    console.error('Failed to save segments to localStorage:', e);
  }
}

// 加载底层 Segments 记录
export function loadSavedSegments(): TranscriptSegment[] {
  try {
    const raw = localStorage.getItem(SEGMENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load segments from localStorage:', e);
    return [];
  }
}
