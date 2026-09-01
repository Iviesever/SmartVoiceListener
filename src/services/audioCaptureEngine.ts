import {
  VadConfig,
  ClientStreamMessage,
  ServerStreamingEvent,
  ServerPartialEvent,
  ServerFinalEvent,
  ServerErrorEvent,
  LocalSegmentData,
} from '../types';
import { getAsrWsUrl, transcribeAudioBlob } from './asrService';

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

  public get currentSize(): number {
    return this.size;
  }
}

// =========================================================================
// 音频采样率重采样器 (Downsampler to 16kHz)
// =========================================================================

export function resampleAudio(
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
    this.wsUrl = customUrl || getAsrWsUrl();
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
        this.wsUrl = getAsrWsUrl();
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
  private silenceStartMs = 0;

  // 真实语音帧样本累加器 (Voiced sample counter)
  private speechEvidenceSamples = 0;
  private hasReceivedPartialForActiveSegment = false;

  // 当前用户选择的模型与当前段冻结的模型 (P1-1: Production Model Freeze)
  public activeModelId = 'sensevoice-onnx';
  private activeSegmentModelId: string | null = null;

  // 自适应动态底噪基线
  private noiseFloor = 0.005;
  private readonly noiseFloorWeight = 0.05;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;

  // 本地录音片段缓存与定时器 (P0-3: 15s Watchdog + 60s Absolute Settlement Deadline)
  private currentSegmentPcmChunks: Float32Array[] = [];
  public readonly localSegmentCache = new Map<string, LocalSegmentData>();
  private readonly segmentTimers = new Map<
    string,
    { watchdog?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> }
  >();

  // 外部回调
  public onSpeakingStart?: (segmentId: string) => void;
  public onSpeakingPause?: (remainingMs: number) => void;
  public onSpeakingEnd?: (segmentId: string, durationMs: number) => void;
  public onSpeakingCancel?: (segmentId: string) => void;
  public onVolumeUpdate?: (volume: number, isSpeech: boolean, noiseFloor: number) => void;
  public onPartial?: (event: ServerPartialEvent) => void;
  public onFinal?: (event: ServerFinalEvent, cachedData?: LocalSegmentData) => void;
  public onError?: (event: ServerErrorEvent) => void;
  public onConnectionChange?: (connected: boolean) => void;

  constructor(config: VadConfig = DEFAULT_VAD_CONFIG, modelId = 'sensevoice-onnx') {
    this.config = { ...config };
    this.activeModelId = modelId;
    this.transport = new StreamingTransport();

    this.transport.onStreamReady = (_sampleRate, _streamingReady) => {
      // 流式准备就绪
    };

    this.transport.onConnectionChange = (connected) => {
      this.onConnectionChange?.(connected);
    };

    this.transport.onPartial = (event) => {
      if (event.sessionEpoch === this.currentSessionEpoch) {
        if (event.text && event.text.trim()) {
          if (event.segmentId === this.activeSegmentId) {
            this.hasReceivedPartialForActiveSegment = true;
          }
        }
        this.onPartial?.(event);
      }
    };

    // 关键修复 P0-5: 只有包含有效非空文本的 Final 才能成功认领结算权
    this.transport.onFinal = (event) => {
      const trimmed = event.text ? event.text.trim() : '';
      if (!trimmed) {
        console.warn(`[ASR] Received empty Final for ${event.segmentId}, routing to fallback`);
        const cached = this.localSegmentCache.get(event.segmentId);
        if (cached) {
          void this.executeHttpFallback(
            event.segmentId,
            cached.pcm,
            cached.durationMs,
            cached.startedAt,
            cached.endedAt,
            'ws-unavailable',
            cached.modelId
          );
        }
        return;
      }

      const cached = this.claimSegmentForFinal(event.segmentId);
      if (!cached) {
        // 已经被抢先完成认领并落库
        return;
      }

      if (event.sessionEpoch === this.currentSessionEpoch) {
        this.onFinal?.(event, cached);
      }
    };

    // 关键修复 P0-4: Server Segment Error 先由 Engine 处理降级，不直接导致状态源分裂
    this.transport.onError = (event) => {
      if (event.segmentId && this.localSegmentCache.has(event.segmentId)) {
        const cached = this.localSegmentCache.get(event.segmentId)!;
        console.warn(`[ASR] Received server error for ${event.segmentId}, routing to terminal HTTP fallback...`);
        void this.executeHttpFallback(
          event.segmentId,
          cached.pcm,
          cached.durationMs,
          cached.startedAt,
          cached.endedAt,
          'ws-unavailable',
          cached.modelId
        );
        return;
      }
      this.onError?.(event);
    };
  }

  /**
   * 原子性认领一个 segmentId 的 Final 结算权 (Exactly-Once Settlement)
   * 成功认领时必须同时清理 watchdog 和 60s 绝对终结 deadline 定时器
   */
  public claimSegmentForFinal(segmentId: string): LocalSegmentData | undefined {
    const cached = this.localSegmentCache.get(segmentId);
    if (!cached) {
      return undefined;
    }

    // 立即删除缓存，阻断后续任何竞争通道
    this.localSegmentCache.delete(segmentId);

    // 清除看门狗与绝对终结定时器
    const timers = this.segmentTimers.get(segmentId);
    if (timers) {
      if (timers.watchdog) clearTimeout(timers.watchdog);
      if (timers.deadline) clearTimeout(timers.deadline);
      this.segmentTimers.delete(segmentId);
    }

    // 若采集已停止且所有在飞段落已全部定稿结算完毕，优雅关闭网络传输
    if (this.mediaStream === null && this.localSegmentCache.size === 0) {
      this.transport.disconnect();
    }

    return cached;
  }

  public updateConfig(newConfig: Partial<VadConfig>) {
    this.config = { ...this.config, ...newConfig };
    const ringCapacity = Math.round((this.config.prefixBufferMs / 1000) * 16000);
    this.prefixRing.reset(ringCapacity);
  }

  /**
   * 原子重置会话世代 (在点击清空文档或重置工作区时调用，对所有未结算 segment 触发 cancel 回调)
   */
  public resetSession(newEpoch: number) {
    // 1. 若当前有未完结的说话段，发送 cancel 并通知 UI 清理
    if (this.isSpeaking && this.activeSegmentId) {
      const segId = this.activeSegmentId;
      this.transport.sendMessage({
        type: 'speech_cancel',
        sessionEpoch: this.currentSessionEpoch,
        segmentId: segId,
      });
      this.onSpeakingCancel?.(segId);
    }

    // 2. 清理所有看门狗与 deadline 定时器，并通知 UI 释放所有未定稿 ephemeral 投影
    this.segmentTimers.forEach((t) => {
      if (t.watchdog) clearTimeout(t.watchdog);
      if (t.deadline) clearTimeout(t.deadline);
    });
    this.segmentTimers.clear();

    const pendingIds = Array.from(this.localSegmentCache.keys());
    for (const segId of pendingIds) {
      this.onSpeakingCancel?.(segId);
    }

    // 3. 原子重置所有状态与缓冲
    this.isSpeaking = false;
    this.activeSegmentId = null;
    this.activeSegmentModelId = null;
    this.speechStartMs = 0;
    this.speechEvidenceSamples = 0;
    this.hasReceivedPartialForActiveSegment = false;
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
          // 关键修复：第 1 个人声候选帧写入 prefixRing 暂存
          this.prefixRing.write(chunk);
          return;
        }

        // 确认开口说话 (第 2 帧确认)
        this.isSpeaking = true;
        this.speechStartMs = now;
        this.speechEvidenceSamples = chunk.length * 2; // 计入候选帧与触发帧
        this.hasReceivedPartialForActiveSegment = false;
        this.silenceStartMs = 0;
        this.consecutiveSpeechFrames = 0;
        this.consecutiveSilenceFrames = 0;
        this.startedConnectionGeneration = this.transport.connectionGeneration;

        const segId = `seg-${now}-${Math.random().toString(36).substring(2, 7)}`;
        this.activeSegmentId = segId;
        // P1-1: 说话开始瞬间冻结段落所使用的模型
        this.activeSegmentModelId = this.activeModelId;

        // prefixSnapshot 包含过去 800ms 环境音 + 第 1 个人声候选帧
        const prefixSnapshot = this.prefixRing.snapshot();
        this.prefixRing.clear();

        // 1. 发送 speech_start 控制帧 (显式附带冻结的模型 ID)
        this.transport.sendMessage({
          type: 'speech_start',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          hasPrefix: prefixSnapshot.length > 0,
          modelId: this.activeSegmentModelId,
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
        this.prefixRing.write(chunk);
      }
      return;
    }

    // 正在说话中：持续推流与本地缓冲
    this.currentSegmentPcmChunks.push(chunk);
    this.transport.sendBinaryPcm(chunk);

    if (isSpeechFrame) {
      this.speechEvidenceSamples += chunk.length;
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
    const samples = this.speechEvidenceSamples;
    const hasPartial = this.hasReceivedPartialForActiveSegment;
    const segModelId = this.activeSegmentModelId || this.activeModelId;
    const segConnectionGen = this.startedConnectionGeneration;
    const now = Date.now();

    this.activeSegmentId = null;
    this.activeSegmentModelId = null;
    this.silenceStartMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.speechEvidenceSamples = 0;
    this.hasReceivedPartialForActiveSegment = false;
    this.prefixRing.clear();

    if (!segId || this.currentSegmentPcmChunks.length === 0) return;

    let totalLength = 0;
    for (const c of this.currentSegmentPcmChunks) totalLength += c.length;

    const mergedPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const c of this.currentSegmentPcmChunks) {
      mergedPcm.set(c, offset);
      offset += c.length;
    }

    const durationMs = Math.round((totalLength / 16000) * 1000);
    const audioStartedAt = now - durationMs;
    const speechEvidenceMs = Math.round((samples / 16000) * 1000);
    this.currentSegmentPcmChunks = [];

    // P1-2: 优化人声采样阈值 (>=100ms) 与 Partial 优先判定，确保“好/对/嗯/OK”等短词完整保留
    const isGenuineSpeech = hasPartial || speechEvidenceMs >= 100;

    if (isGenuineSpeech) {
      // 1. 本地缓存该段 PCM 与精准时间戳和冻结的模型 ID
      this.localSegmentCache.set(segId, {
        pcm: mergedPcm,
        durationMs,
        startedAt: audioStartedAt,
        endedAt: now,
        modelId: segModelId,
      });

      this.onSpeakingEnd?.(segId, durationMs);

      // 2. 检查 WebSocket 是否在录制期间保持连接连续
      const isConnectionContinuous =
        this.transport.ready &&
        this.transport.connectionGeneration === segConnectionGen;

      if (isConnectionContinuous) {
        this.transport.sendMessage({
          type: 'speech_end',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          durationMs,
        });

        // 15秒看门狗保护：若 WS 延迟，按需触发 HTTP Fallback
        const watchdogTimer = setTimeout(() => {
          if (this.localSegmentCache.has(segId)) {
            const currentGen = this.transport.connectionGeneration;
            const isGenValid = this.transport.ready && currentGen === segConnectionGen;

            if (isGenValid) {
              console.warn(`[ASR] WS final timeout (15s) for ${segId} (connection still alive), triggering optimistic HTTP fallback...`);
              void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-watchdog', segModelId);
            } else {
              console.warn(`[ASR] WS connection died or changed generation for ${segId}, triggering terminal HTTP fallback...`);
              void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-unavailable', segModelId);
            }
          }
        }, 15000);

        // P0-3: 60秒绝对终结 deadline 定时器，杜绝任何段落无限处于 Pending
        const deadlineTimer = setTimeout(() => {
          if (this.localSegmentCache.has(segId)) {
            console.error(`[ASR] Absolute settlement deadline (60s) reached for ${segId}, forcing terminal fallback/error!`);
            void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-unavailable', segModelId);
          }
        }, 60000);

        this.segmentTimers.set(segId, { watchdog: watchdogTimer, deadline: deadlineTimer });
      } else {
        console.warn(`[ASR] Transport disconnected or reconnected mid-speech for ${segId}, immediately fallback to HTTP...`);
        void this.executeHttpFallback(segId, mergedPcm, durationMs, audioStartedAt, now, 'ws-unavailable', segModelId);
      }
    } else {
      if (this.transport.ready) {
        this.transport.sendMessage({
          type: 'speech_cancel',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
        });
      }
      this.onSpeakingCancel?.(segId);
    }
  }

  private async executeHttpFallback(
    segId: string,
    pcm: Float32Array,
    durationMs: number,
    startedAt: number,
    endedAt: number,
    mode: 'ws-watchdog' | 'ws-unavailable',
    modelId?: string
  ) {
    try {
      const wavBlob = pcmToWavBlob(pcm, 16000);
      const res = await transcribeAudioBlob(wavBlob, modelId);

      const trimmed = res.text ? res.text.trim() : '';
      if (!trimmed) {
        throw new Error('HTTP fallback returned empty text');
      }

      // 关键修复：原子认领 Final 结算权 (只有第一个成功者能认领)
      const cached = this.claimSegmentForFinal(segId);
      if (!cached) {
        return;
      }

      const segmentData: LocalSegmentData = {
        pcm,
        durationMs,
        startedAt,
        endedAt,
        modelId: res.modelId || modelId || 'http-fallback',
      };

      this.onFinal?.(
        {
          type: 'final',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          text: trimmed,
          modelId: segmentData.modelId || 'http-fallback',
          costMs: 0,
          finalSource: 'second_pass',
        },
        segmentData
      );
    } catch (err) {
      console.error(`[ASR] HTTP fallback failed for segment ${segId} (mode: ${mode}):`, err);

      if (mode === 'ws-watchdog') {
        console.warn(`[ASR] Retaining local segment cache for ${segId} in case late WS Final arrives`);
        return;
      }

      // P0-4: 终态失败，原子 claim 并通知 onError 与 onSpeakingCancel 达成一致终态
      const cached = this.claimSegmentForFinal(segId);
      if (cached) {
        this.onError?.({
          type: 'error',
          sessionEpoch: this.currentSessionEpoch,
          segmentId: segId,
          message: 'HTTP Fallback failed and WebSocket unavailable',
        });
        this.onSpeakingCancel?.(segId);
      }
    }
  }

  /**
   * 优雅停止麦克风采集：
   * 停止录音输入，但保留 WebSocket 与已录制片段的定稿结算权，使正在说出的最后一句话正常定稿落盘。
   */
  public stopCaptureGracefully(): void {
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

    this.isSpeaking = false;
    this.speechEvidenceSamples = 0;
    this.prefixRing.clear();

    if (this.localSegmentCache.size === 0) {
      this.transport.disconnect();
    }
  }

  /**
   * 强制销毁所有状态、看门狗、deadline 定时器与网络连接 (用于组件卸载或硬终止，绝不调用 finalizeSpeechSegment)
   */
  public abortAndDispose(): void {
    // 1. 若当前处于说话状态，发送 cancel 帧并通知取消
    if (this.isSpeaking && this.activeSegmentId) {
      const segId = this.activeSegmentId;
      this.transport.sendMessage({
        type: 'speech_cancel',
        sessionEpoch: this.currentSessionEpoch,
        segmentId: segId,
      });
      this.onSpeakingCancel?.(segId);
    }

    // 2. 对所有未定稿 segment 触发 onSpeakingCancel 回调
    const pendingIds = Array.from(this.localSegmentCache.keys());
    for (const segId of pendingIds) {
      this.onSpeakingCancel?.(segId);
    }

    // 3. 停止硬件输入
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

    // 4. 清理所有定时器与缓存
    this.segmentTimers.forEach((t) => {
      if (t.watchdog) clearTimeout(t.watchdog);
      if (t.deadline) clearTimeout(t.deadline);
    });
    this.segmentTimers.clear();
    this.transport.disconnect();
    this.currentSegmentPcmChunks = [];
    this.activeSegmentId = null;
    this.activeSegmentModelId = null;
    this.isSpeaking = false;
    this.speechEvidenceSamples = 0;
    this.prefixRing.clear();
    this.localSegmentCache.clear();
  }

  public stop(): void {
    this.abortAndDispose();
  }

  public dispose(): void {
    this.abortAndDispose();
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
