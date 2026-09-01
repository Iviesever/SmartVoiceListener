import { ModelInfo } from '../types';

export const DEFAULT_ASR_PORT = 8767;

/**
 * 统一解析 ASR 服务的 Base HTTP URL (兼容 custom url, location hostname, http/https)
 */
export function getAsrHttpBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const customUrl = localStorage.getItem('smart-voice-asr-url');
    if (customUrl) {
      return customUrl.replace(/\/api\/.*$/, '').replace(/\/+$/, '');
    }

    if (window.location?.hostname) {
      const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
      const host = window.location.hostname;
      return `${proto}//${host}:${DEFAULT_ASR_PORT}`;
    }
  }
  return `http://127.0.0.1:${DEFAULT_ASR_PORT}`;
}

/**
 * 统一由 HTTP Base URL 推导 WebSocket URL (http->ws, https->wss)
 */
export function getAsrWsUrl(): string {
  const httpBase = getAsrHttpBaseUrl();
  const wsProto = httpBase.startsWith('https:') ? 'wss:' : 'ws:';
  const hostAndPort = httpBase.replace(/^https?:\/\//, '');
  return `${wsProto}//${hostAndPort}/api/stream`;
}

export function getAsrEndpointCandidates(): string[] {
  const base = getAsrHttpBaseUrl();
  const candidates: string[] = [`${base}/api/asr`];

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      candidates.push(`http://127.0.0.1:${DEFAULT_ASR_PORT}/api/asr`);
    }
  }
  return [...new Set(candidates)];
}

export async function checkAsrHealth(): Promise<{
  online: boolean;
  model?: string;
  activeModelId?: string;
  streamingEngineReady?: boolean;
}> {
  const candidates = getAsrEndpointCandidates();
  for (const url of candidates) {
    try {
      const healthUrl = url.replace('/api/asr', '/api/health');
      const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        return {
          online: true,
          model: data.model || 'SenseVoice',
          activeModelId: data.activeModelId,
          streamingEngineReady: data.streamingEngineReady,
        };
      }
    } catch {
      // ignore
    }
  }
  return { online: false };
}

export async function fetchAvailableModels(): Promise<{ models: ModelInfo[]; activeModelId: string } | null> {
  const candidates = getAsrEndpointCandidates();
  for (const url of candidates) {
    try {
      const modelsUrl = url.replace('/api/asr', '/api/models');
      const res = await fetch(modelsUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function switchActiveModel(modelId: string): Promise<boolean> {
  const candidates = getAsrEndpointCandidates();
  for (const url of candidates) {
    try {
      const switchUrl = url.replace('/api/asr', '/api/switch_model');
      const res = await fetch(switchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
        signal: AbortSignal.timeout(60000), // 给予大模型充足的加载时间
      });
      if (res.ok) {
        const data = await res.json();
        return !!data.success;
      }
    } catch (err) {
      console.warn(`Switch model on ${url} failed:`, err);
    }
  }
  return false;
}

export async function transcribeAudioBlob(
  wavBlob: Blob,
  modelId?: string
): Promise<{ text: string; modelId?: string }> {
  const candidates = getAsrEndpointCandidates();
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  if (modelId) {
    formData.append('modelId', modelId);
  }

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(25000),
      });

      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.text === 'string') {
          return { text: data.text.trim(), modelId: data.modelId };
        }
      }
    } catch (err) {
      console.warn(`ASR request to ${url} failed:`, err);
    }
  }

  throw new Error('未连接到本地语音识别服务 (8767 端口)。请确保已启动 python server/asr_server.py');
}
