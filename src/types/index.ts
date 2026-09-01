export type ListenerState =
  | 'IDLE'                 // 就绪未启动
  | 'LISTENING_SILENCE'    // 正在监听环境音（静默中）
  | 'SPEAKING_ACTIVE'      // 检测到讲话（流式识别中）
  | 'PAUSE_WAITING'        // 说话短暂停顿（等待判定是否说完）
  | 'TRANSCRIBING';        // 正在二阶段定稿中

// 临时流式分段状态（支持多句重叠与密封状态）
export interface EphemeralSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly status: 'live' | 'sealed'; // 'live' = 呼吸光标, 'sealed' = 停顿静止等待 Final
}

// 本地音频片段原始缓存（用于 Final 匹配、时间戳校准与降级回放）
export interface LocalSegmentData {
  readonly pcm: Float32Array;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

// 底层不可变 Segment 数据层（投影到文档，保留原始不可变 ASR 证据）
export interface TranscriptSegment {
  readonly id: string;
  readonly generation: number;       // 会话/文档世代代数（sessionEpoch）
  readonly startedAt: number;
  readonly endedAt: number;
  readonly originalText: string;     // 原始 ASR 转录文字（不可变证据）
  readonly modelId: string;
  readonly durationMs: number;
  readonly audioBlobUrl?: string;
  readonly createdAt: number;
  readonly finalSource?: 'second_pass' | 'streaming_fallback';
}

// -------------------------------------------------------------
// WebSocket 实时流式协议 (Client -> Server)
// -------------------------------------------------------------

export interface StreamInitHandshake {
  type: 'stream_init';
  protocolVersion: number;
  sampleRate: number;
  channels: number;
  format: 'f32le';
  packetSamples: number;
}

export interface SpeechStartPayload {
  type: 'speech_start';
  sessionEpoch: number;
  segmentId: string;
  hasPrefix: boolean;
}

export interface SpeechEndPayload {
  type: 'speech_end';
  sessionEpoch: number;
  segmentId: string;
  durationMs: number;
}

export interface SpeechCancelPayload {
  type: 'speech_cancel';
  sessionEpoch: number;
  segmentId: string;
}

export type ClientStreamMessage =
  | StreamInitHandshake
  | SpeechStartPayload
  | SpeechEndPayload
  | SpeechCancelPayload;

// -------------------------------------------------------------
// WebSocket 实时流式协议 (Server -> Client)
// -------------------------------------------------------------

export interface ServerStreamReadyEvent {
  type: 'stream_ready';
  protocolVersion: number;
  sampleRate: number;
  streamingReady: boolean;
  activeModelId: string;
}

export interface ServerPartialEvent {
  type: 'partial';
  sessionEpoch: number;
  segmentId: string;
  revision: number;
  text: string;
}

export interface ServerFinalEvent {
  type: 'final';
  sessionEpoch: number;
  segmentId: string;
  text: string;
  modelId: string;
  costMs: number;
  finalSource: 'second_pass' | 'streaming_fallback';
}

export interface ServerErrorEvent {
  type: 'error';
  sessionEpoch?: number;
  segmentId?: string;
  message: string;
  fallbackText?: string;
}

export type ServerStreamingEvent =
  | ServerStreamReadyEvent
  | ServerPartialEvent
  | ServerFinalEvent
  | ServerErrorEvent;

// -------------------------------------------------------------
// VAD 与模型配置
// -------------------------------------------------------------

export interface VadConfig {
  speechThreshold: number;     // 声音起说话阈值 (0.01 ~ 0.1, 默认 0.02)
  silenceThreshold: number;    // 静音门限 (默认 0.012)
  pauseDurationMs: number;     // 停顿判定说完时长 (默认 1500ms)
  prefixBufferMs: number;      // 回溯保留开口前音频时长 (默认 800ms = 12800 samples)
  maxSpeechDurationMs: number; // 单段最长录音时长 (默认 90000ms)
  sampleRate: number;          // 音频采样率 (默认 16000Hz)
}

export interface ModelInfo {
  id: string;
  name: string;
  engine: string;
  type: string;
  desc: string;
  available: boolean;
  isActive: boolean;
  gpu?: boolean;
}

export interface AsrServerStatus {
  online: boolean;
  modelName: string;
  activeModelId?: string;
  streamingEngineReady?: boolean;
  gpu?: string;
}
