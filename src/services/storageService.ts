import { TranscriptItem } from '../types';

const STORAGE_KEY = 'smart-voice-transcripts';

export function loadTranscripts(): TranscriptItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load transcripts:', e);
  }
  return [];
}

export function saveTranscripts(items: TranscriptItem[]): void {
  try {
    // 过滤掉不可序列化的 blob 字段
    const cleanItems = items.map(({ audioBlobUrl, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanItems));
  } catch (e) {
    console.error('Failed to save transcripts:', e);
  }
}
