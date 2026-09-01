import {
  VadConfig,
  ClientStreamMessage,
  ServerStreamingEvent,
  ServerPartialEvent,
  ServerFinalEvent,
  ServerErrorEvent,
} from '../types';
import { DEFAULT_ASR_PORT } from './asrService';

export const DEFAULT_VAD_CONFIG: VadConfig = {
  speechThreshold: 0.02,
  silenceThreshold: 0.012,
  pauseDurationMs: 1500,
  prefixBufferMs: 800,        // 800ms = 12,800 samples @ 16kHz
  maxSpeechDurationMs: 90000,
  sampleRate: 16000,
};

// =========================================================================
// 精确 12,800-sample 环形快照缓冲区 (PrefixRingBuffer)
// =========================================================================

export class PrefixRingBuffer {
  private buffer: Float32Array;
  private capacity: number;
  private writePos = 0;
  private size = 0;

  constructor(capacity = 12800) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
  }

  public reset(capacity = 12800) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.writePos = 0;
    this.size = 0;
  }

  public write(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.capacity;
      if (this.size < this.capacity) {
        this.size++;
      }
    }
  }

  public snapshot(): Float32Array {
    const result = new Float32Array(this.size);
    if (this.size === 0) return result;

    if (this.size < this.capacity) {
      result.set(this.buffer.subarray(0, this.size));
    } else {
      // 环形拼接：先取从 writePos 到末尾的较早数据，再取 0 到 writePos 的较新数据
      const tailLength = this.capacity - this.writePos;
      result.set(this.buffer.subarray(this.writePos, this.capacity), 0);
      result.set(this.buffer.subarray(0, this.writePos), tailLength);
    }
    return result;
  }
}

// =========================================================================
// 音频采样率重采样器 (Downsampler to 16kHz)
// =========================================================================

function resampleAudio(
  inputData: Float32Array,
  fromSampleRate: number,
  toSampleRate = 16000
): Float32Array {
  if (fromSampleRate === toSampleRate) return inputData;
  const ratio = fromSampleRate / toSampleRate;
  const outputLength = Math.round(inputData.length / ratio);
  const result = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const originalPos = i * ratio;
    const index = Math.floor(originalPos);
    const fraction = originalPos - index;
    const s0 = inputData[index] ?? 0;
    const s1 = inputData[index + 1] ?? s0;
    result[i] = s0 + fraction * (s1 - s0);
  }
  return result;
}

// =========================================================================
// WebSocket 流式传输管理器 (StreamingTransport)
// =========================================================================

export class StreamingTransport {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  public onStreamReady?: (sampleRate: number) => void;
  public onPartial?: (event: ServerPartialEvent) => void;
  public onFinal?: (event: ServerFinalEvent) => void;
  public onError?: (event: ServerErrorEvent) => void;
  public onConnectionChange?: (connected: boolean) => void;

  constructor(customUrl?: string) {
    this.wsUrl = customUrl || this.getDefaultWsUrl();
  }

  private getDefaultWsUrl(): string {
    if (typeof window !== 'undefined') {
      const host = window.location.hostname || '127.0.0.1';
      return `ws://${host}:${DEFAULT_ASR_PORT}/api/stream`;
    }
    return `ws://127.0.0.1:${DEFAULT_ASR_PORT}/api/stream`;
  }

  public connect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.isConnected = true;
          this.onConnectionChange?.(true);
          console.log('[WS] Connected to Streaming ASR server:', this.wsUrl);

          // 发送 stream_init 握手帧
          this.sendMessage({
            type: 'stream_init',
            protocolVersion: 1,
            sampleRate: 16000,
            channels: 1,
            format: 'f32le',
            packetSamples: 1600,
          });
          resolve();
        };

        this.ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            try {
              const event: ServerStreamingEvent = JSON.parse(e.data);
              if (event.type === 'stream_ready') {
                this.onStreamReady?.(event.sampleRate);
              } else if (event.type === 'partial') {
                this.onPartial?.(event);
              } else if (event.type === 'final') {
                this.onFinal?.(event);
              } else if (event.type === 'error') {
                this.onError?.(event);
              }
            } catch (err) {
              console.warn('[WS] Error parsing message:', err, e.data);
            }
          }
        };

        this.ws.onerror = (e) => {
          console.warn('[WS] WebSocket error:', e);
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.onConnectionChange?.(false);
          console.log('[WS] WebSocket connection closed');
        };
      } catch (err) {
        console.warn('[WS] Failed to connect WebSocket:', err);
        resolve();
      }
    });
  }

  public sendMessage(msg: ClientStreamMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public sendBinaryPcm(samples: Float32Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 保持 Float32Array 紧凑二进制传输 (4 字节/采样)
      this.ws.send(samples.buffer);
    }
  }

  public disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.onConnectionChange?.(false);
  }

  public get ready(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// =========================================================================
// 单一麦克风与音频采集引擎 (AudioCaptureEngine)
// =========================================================================

export class AudioCaptureEngine {
  private config: VadConfig;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;

  // 传输与缓冲
  public readonly transport: StreamingTransport;
  private readonly prefixRing = new PrefixRingBuffer(12800); // 16000 * 0.8s = 12800 samples
  private currentSessionEpoch = 1;
  private activeSegmentId: string | null = null;
  private isSpeaking = false;
  private speechStartMs = 0;
  private silenceStartMs = 0;

  // 自适应动态底噪基线
  private noiseFloor = 0.005;
  private readonly noiseFloorWeight = 0.05;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;

  // 本地录音片段缓存 (直到收到 Final ACK 才清除，用于降级与回放)
  private currentSegmentPcmChunks: Float32Array[] = [];
  public readonly localSegmentCache = new Map<string, { pcm: Float32Array; durationMs: number; createdAt: number }>();

  // 外部回调
  public onSpeakingStart?: (segmentId: string) => void;
  public onSpeakingPause?: (remainingMs: number) => void;
  public onSpeakingEnd?: (segmentId: string, pcm: Float32Array, durationMs: number) => void;
  public onVolumeUpdate?: (volume: number, isSpeech: boolean, noiseFloor: number) => void;
  public onPartial?: (event: ServerPartialEvent) => void;
  public onFinal?: (event: ServerFinalEvent) => void;
  public onError?: (event: ServerErrorEvent) => void;

  constructor(config: VadConfig = DEFAULT_VAD_CONFIG) {
    this.config = { ...config };
    this.transport = new StreamingTransport();

    this.transport.onPartial = (event) => {
      if (event.sessionEpoch === this.currentSessionEpoch) {
        this.onPartial?.(event);
      }
    };

    this.transport.onFinal = (event) => {
      // 收到 Final ACK，安全清理本地暂存
      this.localSegmentCache.delete(event.segmentId);
      if (event.sessionEpoch === this.currentSessionEpoch) {
        this.onFinal?.(event);
      }
    };

    this.transport.onError = (event) => {
      this.onError?.(event);
    };
  }

  public updateConfig(newConfig: Partial<VadConfig>) {
    this.config = { ...this.config, ...newConfig };
    const ringCapacity = Math.round((this.config.prefixBufferMs / 1000) * 16000);
    this.prefixRing.reset(ringCapacity);
  }

  public setSessionEpoch(epoch: number) {
    this.currentSessionEpoch = epoch;
  }

  public async start(epoch: number): Promise<void> {
    this.currentSessionEpoch = epoch;

    // 1. 建立 WebSocket 连接
    await this.transport.connect();

    // 2. 申请麦克风音频流
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.mediaStream = stream;
    this.audioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )();

    const source = this.audioContext.createMediaStreamSource(stream);

    // 滤波处理：高通 80Hz 滤除低频隆隆声，低通 7500Hz 削减超高频杂音
    const highpass = this.audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 80;

    const lowpass = this.audioContext.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 7500;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;

    // 采集帧大小：2048 采样（在 16kHz 下约 128ms，若 48kHz 下约 42ms）
    const bufferSize = 2048;
    this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.scriptProcessor.onaudioprocess = (e) => {
      const rawChannelData = e.inputBuffer.getChannelData(0);
      const nativeRate = this.audioContext?.sampleRate || 16000;

      // 确保统一重采样到 16kHz
      const pcm16k = resampleAudio(rawChannelData, nativeRate, 16000);
      this.processAudioFrame(pcm16k);
    };

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(this.analyser);
    lowpass.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
  }

  private processAudioFrame(chunk: Float32Array) {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) {
      sum += chunk[i] * chunk[i];
    }
    const rms = Math.sqrt(sum / chunk.length);
    const now = Date.now();

    // 动态底噪学习
    if (!this.isSpeaking && rms < this.config.speechThreshold * 1.2) {
      this.noiseFloor =
        this.noiseFloor * (1 - this.noiseFloorWeight) + rms * this.noiseFloorWeight;
    }

    const dynamicThreshold = Math.max(
      this.config.speechThreshold,
      this.noiseFloor * 2.2 + 0.008
    );
    const isSpeechFrame = rms >= dynamicThreshold;

    this.onVolumeUpdate?.(rms, this.isSpeaking, this.noiseFloor);

    if (!this.isSpeaking) {
      // 维护 800ms 前缀快照环
      this.prefixRing.write(chunk);

      if (isSpeechFrame) {
        this.consecutiveSpeechFrames++;
        if (this.consecutiveSpeechFrames >= 2) {
          // 确认开口说话
          this.isSpeaking = true;
          this.speechStartMs = now;
          this.silenceStartMs = 0;
          this.consecutiveSpeechFrames = 0;
          this.consecutiveSilenceFrames = 0;

          const segId = `seg-${now}-${Math.random().toString(36).substring(2, 7)}`;
          this.activeSegmentId = segId;

          // 1. 发送 speech_start 控制帧
          this.transport.sendMessage({
            type: 'speech_start',
            sessionEpoch: this.currentSessionEpoch,
            segmentId: segId,
            hasPrefix: true,
          });

          // 2. 立即将 800ms 前缀快照作为首包 Binary Frame 发送
          const prefixSnapshot = this.prefixRing.snapshot();
          if (prefixSnapshot.length > 0) {
            this.transport.sendBinaryPcm(prefixSnapshot);
            this.currentSegmentPcmChunks = [prefixSnapshot, chunk];
          } else {
            this.currentSegmentPcmChunks = [chunk];
          }

          // 3. 发送当前触发帧
          this.transport.sendBinaryPcm(chunk);

          this.onSpeakingStart?.(segId);
        }
      } else {
        this.consecutiveSpeechFrames = 0;
      }
      return;
    }

    // 正在说话中：持续推流与本地缓冲
    this.currentSegmentPcmChunks.push(chunk);
    this.transport.sendBinaryPcm(chunk);

    // 单段最大时长硬保护
    if (now - this.speechStartMs >= this.config.maxSpeechDurationMs) {
      this.finalizeSpeechSegment();
      return;
    }

    if (rms >= this.config.silenceThreshold) {
      this.silenceStartMs = 0;
      this.consecutiveSilenceFrames = 0;
      return;
    }

    this.consecutiveSilenceFrames++;
    if (this.silenceStartMs === 0 && this.consecutiveSilenceFrames >= 2) {
      this.silenceStartMs = now;
    }

    if (this.silenceStartMs > 0) {
      const elapsedSilence = now - this.silenceStartMs;
      const remainingMs = Math.max(0, this.config.pauseDurationMs - elapsedSilence);
      this.onSpeakingPause?.(remainingMs);

      if (elapsedSilence >= this.config.pauseDurationMs) {
        this.finalizeSpeechSegment();
      }
    }
  }

  private finalizeSpeechSegment() {
    this.isSpeaking = false;
    const segId = this.activeSegmentId;
    this.activeSegmentId = null;
    this.silenceStartMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;

    if (!segId || this.currentSegmentPcmChunks.length === 0) return;

    let totalLength = 0;
    for (const c of this.currentSegmentPcmChunks) totalLength += c.length;

    const mergedPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const c of this.currentSegmentPcmChunks) {
      mergedPcm.set(c, offset);
      offset += c.length;
    }

    // 音频响度平滑增益归一化
    let maxAbs = 0.0001;
    for (let i = 0; i < mergedPcm.length; i++) {
      const abs = Math.abs(mergedPcm[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    const gain = Math.min(4.0, 0.85 / maxAbs);
    for (let i = 0; i < mergedPcm.length; i++) {
      mergedPcm[i] = Math.max(-1.0, Math.min(1.0, mergedPcm[i] * gain));
    }

    const durationMs = Math.round((totalLength / 16000) * 1000);
    this.currentSegmentPcmChunks = [];

    // 过滤掉低于 450ms 的短促冲击杂音
    if (durationMs >= 450) {
      // 1. 发送 speech_end 通知后端触发 Second-Pass 定稿
      this.transport.sendMessage({
        type: 'speech_end',
        sessionEpoch: this.currentSessionEpoch,
        segmentId: segId,
        durationMs,
      });

      // 2. 本地缓存该段 PCM（用于 Final 到来时生成 WAV 播放，或网络异常时重试）
      this.localSegmentCache.set(segId, {
        pcm: mergedPcm,
        durationMs,
        createdAt: Date.now(),
      });

      this.onSpeakingEnd?.(segId, mergedPcm, durationMs);
    } else {
      // 杂音段发送 cancel
      this.transport.sendMessage({
        type: 'speech_cancel',
        sessionEpoch: this.currentSessionEpoch,
        segmentId: segId,
      });
    }
  }

  public stop(): void {
    if (this.isSpeaking) {
      this.finalizeSpeechSegment();
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close();
      this.audioContext = null;
    }

    this.transport.disconnect();
    this.currentSegmentPcmChunks = [];
    this.activeSegmentId = null;
    this.isSpeaking = false;
  }
}

// =========================================================================
// Float32 PCM 转标准 16-bit WAV Blob
// =========================================================================

export function pcmToWavBlob(pcmData: Float32Array, sampleRate = 16000): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(v: DataView, off: number, s: string) {
    for (let i = 0; i < s.length; i++) {
      v.setUint8(off + i, s.charCodeAt(i));
    }
  }

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcmData.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
