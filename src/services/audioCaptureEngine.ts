import {
  VadConfig,
  ClientStreamMessage,
  ServerStreamingEvent,
  ServerPartialEvent,
  ServerFinalEvent,
  ServerErrorEvent,
  LocalSegmentData,
} from '../types';
import { DEFAULT_ASR_PORT, transcribeAudioBlob } from './asrService';

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

  public clear() {
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
  private isIntentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 记录连接世代，用于检测中途断线重连 (mid-speech reconnect detection)
  public connectionGeneration = 0;

  public onStreamReady?: (sampleRate: number, streamingReady: boolean) => void;
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
    this.isIntentionalClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }

      let resolved = false;
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn('[WS] Connect timeout (4s), will fallback/retry in background');
          resolve();
        }
      }, 4000);

      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.connectionGeneration++;
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.onConnectionChange?.(true);
          console.log(`[WS] Connected to Streaming ASR server (gen #${this.connectionGeneration}):`, this.wsUrl);

          // 发送 stream_init 握手帧
          this.sendMessage({
            type: 'stream_init',
            protocolVersion: 1,
            sampleRate: 16000,
            channels: 1,
            format: 'f32le',
            packetSamples: 1600,
          });

          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutTimer);
            resolve();
          }
        };

        this.ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            try {
              const event: ServerStreamingEvent = JSON.parse(e.data);
              if (event.type === 'stream_ready') {
                this.onStreamReady?.(event.sampleRate, event.streamingReady);
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
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutTimer);
            resolve();
          }
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.onConnectionChange?.(false);
          console.log('[WS] WebSocket connection closed');

          if (!this.isIntentionalClose) {
            this.scheduleReconnect();
          }

          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutTimer);
            resolve();
          }
        };
      } catch (err) {
        console.warn('[WS] Failed to create WebSocket:', err);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutTimer);
          resolve();
        }
      }
    });
  }

  private scheduleReconnect() {
    if (this.isIntentionalClose) return;
    this.reconnectAttempts++;
    const delay = Math.min(5000, 1000 * Math.pow(1.5, this.reconnectAttempts - 1));
    console.log(`[WS] Scheduling reconnect in ${delay}ms (attempt #${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  public sendMessage(msg: ClientStreamMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public sendBinaryPcm(samples: Float32Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(samples.buffer);
    }
  }

  public disconnect() {
    this.isIntentionalClose = true;
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
  private startedConnectionGeneration = 0;
  private isSpeaking = false;
  private speechStartMs = 0;
  private lastSpeechEvidenceAt = 0; // 记录最近一次非静音/人声采样点的时间戳
  private silenceStartMs = 0;

  // 自适应动态底噪基线
  private noiseFloor = 0.005;
  private readonly noiseFloorWeight = 0.05;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;

  // 本地录音片段缓存 (保留完整时间戳与 Float32 PCM，用于 Final 回调与故障恢复)
  private currentSegmentPcmChunks: Float32Array[] = [];
  public readonly localSegmentCache = new Map<string, LocalSegmentData>();
  private readonly segmentWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  // 外部回调
  public onSpeakingStart?: (segmentId: string) => void;
  public onSpeakingPause?: (remainingMs: number) => void;
  public onSpeakingEnd?: (segmentId: string, durationMs: number) => void;
  public onVolumeUpdate?: (volume: number, isSpeech: boolean, noiseFloor: number) => void;
  public onPartial?: (event: ServerPartialEvent) => void;
  public onFinal?: (event: ServerFinalEvent, cachedData?: LocalSegmentData) => void;
  public onError?: (event: ServerErrorEvent) => void;
  public onConnectionChange?: (connected: boolean) => void;

  constructor(config: VadConfig = DEFAULT_VAD_CONFIG) {
    this.config = { ...config };
    this.transport = new StreamingTransport();

    this.transport.onStreamReady = (_sampleRate, _streamingReady) => {
      // 流式准备就绪
    };

    this.transport.onConnectionChange = (connected) => {
      this.onConnectionChange?.(connected);
    };

    this.transport.onPartial = (event) => {
      if (event.sessionEpoch === this.currentSessionEpoch) {
        this.onPartial?.(event);
      }
    };

    // 关键修复 Blocker: WS Final 到达时执行原子 claim，确保 exactly-once settlement
    this.transport.onFinal = (event) => {
      const cached = this.claimSegmentForFinal(event.segmentId);
      if (!cached) {
        // 已经被 HTTP fallback 抢先完成认领并落库，忽略迟到的 WS Final
        return;
      }

      if (event.sessionEpoch === this.currentSessionEpoch) {
        this.onFinal?.(event, cached);
      }
    };

    this.transport.onError = (event) => {
      this.onError?.(event);
    };
  }

  /**
   * 原子性认领一个 segmentId 的 Final 结算权 (Exactly-Once Settlement)
   * 无论来自 WebSocket Final 还是 HTTP Fallback，只有第一个成功者能认领并获得 cachedData
   */
  private claimSegmentForFinal(segmentId: string): LocalSegmentData | undefined {
    const cached = this.localSegmentCache.get(segmentId);
    if (!cached) {
      return undefined;
    }

    // 立即删除缓存，阻断后续任何竞争通道
    this.localSegmentCache.delete(segmentId);

    // 清除看门狗定时器
    const timer = this.segmentWatchdogs.get(segmentId);
    if (timer) {
      clearTimeout(timer);
      this.segmentWatchdogs.delete(segmentId);
    }

    return cached;
  }

  public updateConfig(newConfig: Partial<VadConfig>) {
    this.config = { ...this.config, ...newConfig };
    const ringCapacity = Math.round((this.config.prefixBufferMs / 1000) * 16000);
    this.prefixRing.reset(ringCapacity);
  }

  /**
   * 原子重置会话世代 (在点击清空文档或重置工作区时调用，复用同一个麦克风时钟)
   */
  public resetSession(newEpoch: number) {
    // 1. 若当前有未完结的说话段，发送 cancel
    if (this.isSpeaking && this.activeSegmentId) {
      this.transport.sendMessage({
        type: 'speech_cancel',
        sessionEpoch: this.currentSessionEpoch,
        segmentId: this.activeSegmentId,
      });
    }

    // 2. 清理所有看门狗定时器
    this.segmentWatchdogs.forEach((t) => clearTimeout(t));
    this.segmentWatchdogs.clear();

    // 3. 原子重置所有状态与缓冲
    this.isSpeaking = false;
    this.activeSegmentId = null;
    this.speechStartMs = 0;
    this.lastSpeechEvidenceAt = 0;
    this.silenceStartMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.prefixRing.clear();
    this.currentSegmentPcmChunks = [];
    this.localSegmentCache.clear();

    // 4. 更新为最新世代
    this.currentSessionEpoch = newEpoch;
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
      if (isSpeechFrame) {
        this.consecutiveSpeechFrames++;
        if (this.consecutiveSpeechFrames < 2) {
          // 关键修复 P0-1：第 1 个人声候选帧必须写入 prefixRing 暂存，绝不丢弃！
          this.prefixRing.write(chunk);
          return;
        }

        // 确认开口说话 (第 2 帧确认)
        this.isSpeaking = true;
        this.speechStartMs = now;
        this.lastSpeechEvidenceAt = now;
        this.silenceStartMs = 0;
        this.consecutiveSpeechFrames = 0;
        this.consecutiveSilenceFrames = 0;
        this.startedConnectionGeneration = this.transport.connectionGeneration;

        const segId = `seg-${now}-${Math.random().toString(36).substring(2, 7)}`;
        this.activeSegmentId = segId;

        // prefixSnapshot 此时已包含过去 800ms 环境音 + 第 1 个人声候选帧！
        const prefixSnapshot = this.prefixRing.snapshot();
        this.prefixRing.clear();

        // 1. 发送 speech_start 控制帧
        this.transport.sendMessage({
          type: 'speech_start',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          hasPrefix: prefixSnapshot.length > 0,
        });

        // 2. 发送前缀快照 (若有)
        if (prefixSnapshot.length > 0) {
          this.transport.sendBinaryPcm(prefixSnapshot);
          this.currentSegmentPcmChunks = [prefixSnapshot, chunk];
        } else {
          this.currentSegmentPcmChunks = [chunk];
        }

        // 3. 发送当前第 2 帧 chunk
        this.transport.sendBinaryPcm(chunk);

        this.onSpeakingStart?.(segId);
        return;
      } else {
        this.consecutiveSpeechFrames = 0;
        // 仅在非触发状态下将环境音频写入 RingBuffer
        this.prefixRing.write(chunk);
      }
      return;
    }

    // 正在说话中：持续推流与本地缓冲
    this.currentSegmentPcmChunks.push(chunk);
    this.transport.sendBinaryPcm(chunk);

    if (isSpeechFrame) {
      this.lastSpeechEvidenceAt = now;
    }

    // 单段最大时长硬保护 (前端 90s 主控切段)
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
    const startMs = this.speechStartMs;
    const lastEvidence = this.lastSpeechEvidenceAt;
    const now = Date.now();

    this.activeSegmentId = null;
    this.silenceStartMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.prefixRing.clear(); // 切段时清空前缀环，防止残留污染下一段

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
    const audioStartedAt = now - durationMs;
    // 关键优化：真正的人声证据净时长 (从 startMs 到最后一次非静音采样点的时间)
    const speechEvidenceDurationMs = lastEvidence > 0 ? lastEvidence - startMs : 0;
    this.currentSegmentPcmChunks = [];

    // 真正人声证据净时长 >= 450ms 才判定为有效语音，过滤短瞬态冲击杂音
    if (speechEvidenceDurationMs >= 450) {
      // 1. 本地缓存该段 PCM 与精准起止时间
      this.localSegmentCache.set(segId, {
        pcm: mergedPcm,
        durationMs,
        startedAt: audioStartedAt,
        endedAt: now,
      });

      this.onSpeakingEnd?.(segId, durationMs);

      // 2. 检查 WebSocket 是否在线且在当前段录制期间未曾发生过断线重连 (mid-speech reconnect)
      const isConnectionContinuous =
        this.transport.ready &&
        this.transport.connectionGeneration === this.startedConnectionGeneration;

      if (isConnectionContinuous) {
        this.transport.sendMessage({
          type: 'speech_end',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          durationMs,
        });

        // 15秒看门狗保护：若 WS 长时间未回包，自动触发 HTTP Fallback 挽救该段 (mode: 'ws-watchdog')
        const watchdog = setTimeout(() => {
          if (this.localSegmentCache.has(segId)) {
            console.warn(`[ASR] WS final timeout (15s) for ${segId}, triggering HTTP fallback (ws-watchdog)...`);
            void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-watchdog');
          }
        }, 15000);
        this.segmentWatchdogs.set(segId, watchdog);
      } else {
        console.warn(`[ASR] Transport disconnected or reconnected mid-speech for ${segId}, immediately fallback to HTTP (ws-unavailable)...`);
        void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-unavailable');
      }
    } else {
      if (this.transport.ready) {
        this.transport.sendMessage({
          type: 'speech_cancel',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
        });
      }
    }
  }

  private async executeHttpFallback(
    segId: string,
    pcm: Float32Array,
    durationMs: number,
    startedAt: number,
    endedAt: number,
    mode: 'ws-watchdog' | 'ws-unavailable'
  ) {
    try {
      const wavBlob = pcmToWavBlob(pcm, 16000);
      const res = await transcribeAudioBlob(wavBlob);

      // 关键修复 Blocker: 原子认领 Final 结算权 (只有第一个成功者能认领)
      const cached = this.claimSegmentForFinal(segId);
      if (!cached) {
        // WS Final 已经抢先一步完成结算并落库
        return;
      }

      const segmentData: LocalSegmentData = {
        pcm,
        durationMs,
        startedAt,
        endedAt,
      };

      this.onFinal?.(
        {
          type: 'final',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          text: res.text,
          modelId: res.modelId || 'http-fallback',
          costMs: 0,
          finalSource: 'second_pass',
        },
        segmentData
      );
    } catch (err) {
      console.error(`[ASR] HTTP fallback failed for segment ${segId} (mode: ${mode}):`, err);

      // 关键 Blocker 修复：
      // 若当前处于 ws-watchdog 模式，说明 WS Second-Pass 仍在后端排队执行，
      // 绝不能 claim/delete 掉 localSegmentCache！保留缓存继续等待迟到的 WS Final。
      if (mode === 'ws-watchdog') {
        console.warn(`[ASR] Retaining local segment cache for ${segId} in case late WS Final arrives`);
        return;
      }

      // 若处于 ws-unavailable 模式（WS 彻底未连或 mid-speech 重连无上下文），
      // 则说明不会有任何 WS Final 到达，此时才正式 settle error 并清理缓存。
      const cached = this.claimSegmentForFinal(segId);
      if (cached) {
        this.onError?.({
          type: 'error',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          message: 'HTTP Fallback failed and WebSocket unavailable',
        });
      }
    }
  }

  public stop(): void {
    if (this.isSpeaking) {
      this.finalizeSpeechSegment();
    }

    this.segmentWatchdogs.forEach((t) => clearTimeout(t));
    this.segmentWatchdogs.clear();

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
    this.lastSpeechEvidenceAt = 0;
    this.prefixRing.clear();
    this.localSegmentCache.clear();
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
