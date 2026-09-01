export type ListenerState =
  | 'IDLE'                 // 就绪未启动
  | 'LISTENING_SILENCE'    // 正在监听环境音（静默中）
  | 'SPEAKING_ACTIVE'      // 检测到讲话（正在录制中）
  | 'PAUSE_WAITING'        // 说话短暂停顿（等待判定是否说完）
  | 'TRANSCRIBING';        // 正在语音转写中

export interface TranscriptItem {
  id: string;
  timestamp: number;
  timeString: string;
  text: string;
  durationMs: number;
  audioBlobUrl?: string;
  modelName?: string;
  isEditing?: boolean;
}

export interface VadConfig {
  speechThreshold: number;   // 声音起说话阈值 (0.01 ~ 0.1, 默认 0.025)
  silenceThreshold: number;  // 静音判定阈值 (默认 0.015)
  pauseDurationMs: number;   // 停顿判定说完时长 (默认 1200ms)
  prefixBufferMs: number;    // 回溯保留开口前音频时长 (默认 500ms，保证不丢字)
  maxSpeechDurationMs: number; // 单段最长录音时长 (默认 60000ms)
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
}

export interface AsrServerStatus {
  online: boolean;
  modelName: string;
  activeModelId?: string;
}
