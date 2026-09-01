export type ListenerState =
  | 'IDLE'                 // 就绪未启动
  | 'LISTENING_SILENCE'    // 正在监听环境音（静默中）
  | 'SPEAKING_ACTIVE'      // 检测到讲话（正在录制中）
  | 'PAUSE_WAITING'        // 说话短暂停顿（等待判定是否说完）
  | 'TRANSCRIBING';        // 正在语音转写中

// 底层 Segment 数据层（投影到文档，但保留原始 ASR 证据）
export interface TranscriptSegment {
  id: string;
  generation: number;       // 文档世代代数（清空或新建后递增，防竞态复活）
  startedAt: number;
  endedAt: number;
  originalText: string;     // 原始 ASR 转录文字（不可变证据）
  modelId: string;
  durationMs: number;
  audioBlobUrl?: string;
  createdAt: number;
}

// 预留的流式转录事件协议
export type TranscriptEvent =
  | {
      type: 'partial';
      segmentId: string;
      generation: number;
      text: string;
    }
  | {
      type: 'final';
      segmentId: string;
      generation: number;
      text: string;
      startedAt: number;
      endedAt: number;
      modelId: string;
      durationMs: number;
      audioBlobUrl?: string;
    };

export interface VadConfig {
  speechThreshold: number;   // 声音起说话阈值 (0.01 ~ 0.1, 默认 0.02)
  silenceThreshold: number;  // 静音判定阈值 (默认 0.012)
  pauseDurationMs: number;   // 停顿判定说完时长 (默认 1500ms)
  prefixBufferMs: number;    // 回溯保留开口前音频时长 (默认 800ms)
  maxSpeechDurationMs: number; // 单段最长录音时长 (默认 90000ms)
  sampleRate: number;        // 音频采样率 (默认 16000Hz)
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
  gpu?: string;
}
