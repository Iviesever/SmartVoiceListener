import { VadConfig } from '../types';

export const DEFAULT_VAD_CONFIG: VadConfig = {
  speechThreshold: 0.02,     // 初始灵敏度（更灵敏）
  silenceThreshold: 0.012,   // 静音门限
  pauseDurationMs: 1500,     // 停顿 1.5 秒（更自然，领导思考短暂停顿不切断）
  prefixBufferMs: 800,       // 往前追溯保留 0.8 秒音频（彻底杜绝吞首字）
  maxSpeechDurationMs: 90000,// 单段最大 90 秒
  sampleRate: 16000,         // 16kHz 单声道 PCM
};

export class VadEngine {
  private config: VadConfig;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;

  // 自适应动态底噪基线
  private noiseFloor: number = 0.005;
  private noiseFloorWeight: number = 0.05;

  // 环形前缀缓冲区（保存开口前 0.8s 音频）
  private prefixBuffer: Float32Array[] = [];
  private maxPrefixChunks: number = 0;

  // 连续帧能量平滑检测
  private consecutiveSpeechFrames: number = 0;
  private consecutiveSilenceFrames: number = 0;

  // 当前说话段累积音频
  private speechChunks: Float32Array[] = [];
  private isSpeaking: boolean = false;
  private silenceStartMs: number = 0;
  private speechStartMs: number = 0;

  // 回调事件
  public onSpeakingStart?: () => void;
  public onSpeakingPause?: (remainingMs: number) => void;
  public onSpeakingEnd?: (audioPcm: Float32Array, durationMs: number) => void;
  public onVolumeUpdate?: (volume: number, isSpeech: boolean, noiseFloor: number) => void;

  constructor(config: VadConfig = DEFAULT_VAD_CONFIG) {
    this.config = { ...config };
  }

  public updateConfig(newConfig: Partial<VadConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: this.config.sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.mediaStream = stream;
    this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
      sampleRate: this.config.sampleRate,
    });

    const source = this.audioContext.createMediaStreamSource(stream);
    
    // 增加硬件级带通滤波 (80Hz ~ 7500Hz)，专门滤除电流低频隆隆声和高频刺耳噪音
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

    // 0.8s 环形缓冲区对应分块数
    this.maxPrefixChunks = Math.max(4, Math.round((this.config.prefixBufferMs / 1000) * (this.config.sampleRate / bufferSize)));

    this.scriptProcessor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      this.processAudioFrame(new Float32Array(inputData));
    };

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(this.analyser);
    lowpass.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
  }

  private processAudioFrame(chunk: Float32Array) {
    // 1. 计算当前音频帧的 RMS 能量与峰值
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const abs = Math.abs(chunk[i]);
      if (abs > peak) peak = abs;
      sum += chunk[i] * chunk[i];
    }
    const rms = Math.sqrt(sum / chunk.length);

    const now = Date.now();

    // 2. 动态自适应底噪学习算法
    if (!this.isSpeaking) {
      if (rms < this.config.speechThreshold * 1.2) {
        this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorWeight) + rms * this.noiseFloorWeight;
      }
    }

    // 动态起动门限：自适应基线 + 设定阈值
    const dynamicThreshold = Math.max(this.config.speechThreshold, this.noiseFloor * 2.2 + 0.008);
    const isSpeechFrame = rms >= dynamicThreshold;

    this.onVolumeUpdate?.(rms, this.isSpeaking, this.noiseFloor);

    if (!this.isSpeaking) {
      // 维护前缀环形缓冲
      this.prefixBuffer.push(chunk);
      if (this.prefixBuffer.length > this.maxPrefixChunks) {
        this.prefixBuffer.shift();
      }

      // 连续 2 帧检测到人声能量 ➔ 确认开口，防止偶发杂音触发
      if (isSpeechFrame) {
        this.consecutiveSpeechFrames++;
        if (this.consecutiveSpeechFrames >= 2) {
          this.isSpeaking = true;
          this.speechStartMs = now;
          this.silenceStartMs = 0;
          this.consecutiveSpeechFrames = 0;
          this.consecutiveSilenceFrames = 0;
          // 将前缀环形缓冲（0.8s 前）与当前帧完全拼接
          this.speechChunks = [...this.prefixBuffer, chunk];
          this.prefixBuffer = [];
          this.onSpeakingStart?.();
        }
      } else {
        this.consecutiveSpeechFrames = 0;
      }
    } else {
      // 正在说话中
      this.speechChunks.push(chunk);

      if (rms >= this.config.silenceThreshold) {
        this.silenceStartMs = 0;
        this.consecutiveSilenceFrames = 0;
      } else {
        this.consecutiveSilenceFrames++;
        // 连续若干帧低于门限开始计算静音时间
        if (this.silenceStartMs === 0 && this.consecutiveSilenceFrames >= 2) {
          this.silenceStartMs = now;
        }

        if (this.silenceStartMs > 0) {
          const elapsedSilence = now - this.silenceStartMs;
          const remainingMs = Math.max(0, this.config.pauseDurationMs - elapsedSilence);
          this.onSpeakingPause?.(remainingMs);

          const totalDuration = now - this.speechStartMs;
          if (elapsedSilence >= this.config.pauseDurationMs || totalDuration >= this.config.maxSpeechDurationMs) {
            this.finalizeSpeechSegment();
          }
        }
      }
    }
  }

  private finalizeSpeechSegment() {
    this.isSpeaking = false;
    this.silenceStartMs = 0;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;

    if (this.speechChunks.length === 0) return;

    let totalLength = 0;
    for (const c of this.speechChunks) totalLength += c.length;

    const mergedPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const c of this.speechChunks) {
      mergedPcm.set(c, offset);
      offset += c.length;
    }

    // 音频响度峰值归一化 (Peak Normalization)，将人声放大至标准清晰响度
    let maxAbs = 0.0001;
    for (let i = 0; i < mergedPcm.length; i++) {
      const abs = Math.abs(mergedPcm[i]);
      if (abs > maxAbs) maxAbs = abs;
    }
    const gain = Math.min(4.0, 0.85 / maxAbs);
    for (let i = 0; i < mergedPcm.length; i++) {
      mergedPcm[i] = Math.max(-1.0, Math.min(1.0, mergedPcm[i] * gain));
    }

    const durationMs = Math.round((totalLength / this.config.sampleRate) * 1000);
    this.speechChunks = [];

    // 过滤掉低于 0.45 秒的轻微敲击声/咳嗽
    if (durationMs >= 450) {
      this.onSpeakingEnd?.(mergedPcm, durationMs);
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
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// 辅助工具：将 Float32 PCM 转换为标准 WAV Blob
export function pcmToWavBlob(pcmData: Float32Array, sampleRate = 16000): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

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

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
