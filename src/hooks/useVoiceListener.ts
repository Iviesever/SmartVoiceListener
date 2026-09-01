import { useState, useRef, useEffect, useCallback } from 'react';
import { ListenerState, TranscriptSegment, VadConfig, ModelInfo } from '../types';
import { VadEngine, DEFAULT_VAD_CONFIG, pcmToWavBlob } from '../services/vadEngine';
import { transcribeAudioBlob, checkAsrHealth, fetchAvailableModels, switchActiveModel } from '../services/asrService';
import { loadSavedSegments, saveSegments } from '../services/storageService';

interface UseVoiceListenerOptions {
  onTranscriptFinal?: (text: string, segment: TranscriptSegment) => void;
}

export function useVoiceListener(options?: UseVoiceListenerOptions) {
  const [state, setState] = useState<ListenerState>('IDLE');
  const [volume, setVolume] = useState<number>(0);
  const [pauseCountdown, setPauseCountdown] = useState<number>(0);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [activeModel, setActiveModel] = useState<string>('SenseVoice');
  const [activeModelId, setActiveModelId] = useState<string>('sensevoice-onnx');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isSwitchingModel, setIsSwitchingModel] = useState<boolean>(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>(() => loadSavedSegments());

  // 关键：全局会话世代 (Session Epoch)，在清空、停止、新开启时递增，彻底封死并发竞态
  const sessionEpochRef = useRef<number>(1);
  const currentSpeechEpochRef = useRef<number>(1);
  const engineRef = useRef<VadEngine | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>(segments);
  segmentsRef.current = segments;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 定期检测本地 ASR 服务健康度与模型列表
  const refreshServerStatus = useCallback(async () => {
    const health = await checkAsrHealth();
    setServerOnline(health.online);
    if (health.model) setActiveModel(health.model);
    if (health.activeModelId) setActiveModelId(health.activeModelId);

    if (health.online) {
      const modelData = await fetchAvailableModels();
      if (modelData) {
        setAvailableModels(modelData.models);
        setActiveModelId(modelData.activeModelId);
      }
    }
  }, []);

  useEffect(() => {
    void refreshServerStatus();
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void refreshServerStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshServerStatus]);

  // Segments 变更防抖持久化 (500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveSegments(segments);
    }, 500);
    return () => clearTimeout(timer);
  }, [segments]);

  // 页面卸载时释放所有未释放的 Blob URL 以及麦克风
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
      segmentsRef.current.forEach((s) => {
        if (s.audioBlobUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(s.audioBlobUrl);
        }
      });
    };
  }, []);

  // 切换 ASR 识别模型
  const handleSwitchModel = useCallback(async (modelId: string) => {
    setIsSwitchingModel(true);
    try {
      const ok = await switchActiveModel(modelId);
      if (ok) {
        await refreshServerStatus();
      } else {
        alert(`切换模型 ${modelId} 失败，请检查模型文件是否存在！`);
      }
    } catch (e) {
      console.error('Failed to switch model:', e);
    } finally {
      setIsSwitchingModel(false);
    }
  }, [refreshServerStatus]);

  // 处理一段说话结束后的 ASR 转写
  const handleSpeakingEnd = useCallback(async (pcmData: Float32Array, durationMs: number, speechEpoch: number) => {
    // 若在说话期间已经发生 session reset/stop，直接放弃发起请求
    if (speechEpoch !== sessionEpochRef.current) {
      console.log('[ASR] Discarding speech chunk due to session epoch change during recording');
      return;
    }

    setState('TRANSCRIBING');
    setPauseCountdown(0);

    const now = Date.now();
    const startedAt = now - durationMs;
    const endedAt = now;
    const wavBlob = pcmToWavBlob(pcmData, vadConfig.sampleRate);
    const audioUrl = URL.createObjectURL(wavBlob);

    try {
      const res = await transcribeAudioBlob(wavBlob);
      
      // 竞态校验：比对 speechEpoch 是否等于当前的 sessionEpochRef
      if (speechEpoch !== sessionEpochRef.current) {
        console.log('[ASR] Discarding stale transcript due to epoch mismatch:', res.text);
        URL.revokeObjectURL(audioUrl);
        return;
      }

      if (res.text) {
        const segment: TranscriptSegment = {
          id: `seg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          generation: speechEpoch,
          startedAt,
          endedAt,
          originalText: res.text, // 原始 ASR 证据不可变
          modelId: res.modelId || activeModelId,
          durationMs,
          audioBlobUrl: audioUrl,
          createdAt: Date.now(),
        };

        setSegments((prev) => [...prev, segment]);
        optionsRef.current?.onTranscriptFinal?.(res.text, segment);
      }
    } catch (err: unknown) {
      console.error('ASR transcription failed:', err);
      URL.revokeObjectURL(audioUrl);
    } finally {
      // 关键保护：只有当前仍是同一 session 且引擎仍在运行时才切换为 LISTENING_SILENCE
      if (speechEpoch === sessionEpochRef.current && engineRef.current) {
        setState((current) => (current === 'TRANSCRIBING' ? 'LISTENING_SILENCE' : current));
      }
    }
  }, [vadConfig.sampleRate, activeModelId]);

  // 启动常驻监听
  const startListening = useCallback(async () => {
    try {
      if (engineRef.current) {
        engineRef.current.stop();
      }

      // 开启新会话时更新 session epoch
      sessionEpochRef.current += 1;
      const currentSession = sessionEpochRef.current;

      const engine = new VadEngine(vadConfig);
      engine.onSpeakingStart = () => {
        // 在开口说话的一瞬间锁定当前 speech epoch
        currentSpeechEpochRef.current = sessionEpochRef.current;
        setState('SPEAKING_ACTIVE');
        setPauseCountdown(0);
      };
      engine.onSpeakingPause = (remainingMs) => {
        setState('PAUSE_WAITING');
        setPauseCountdown(remainingMs);
      };
      engine.onSpeakingEnd = (pcm, dur) => {
        const speechEpoch = currentSpeechEpochRef.current;
        void handleSpeakingEnd(pcm, dur, speechEpoch);
      };
      engine.onVolumeUpdate = (vol) => {
        setVolume(vol);
      };

      await engine.start();
      if (currentSession !== sessionEpochRef.current) {
        engine.stop();
        return;
      }

      engineRef.current = engine;
      setState('LISTENING_SILENCE');
    } catch (err) {
      console.error('Failed to start microphone VAD:', err);
      alert('启动麦克风失败，请检查浏览器麦克风权限！');
      setState('IDLE');
    }
  }, [vadConfig, handleSpeakingEnd]);

  // 停止监听
  const stopListening = useCallback(() => {
    sessionEpochRef.current += 1; // 终止当前所有 in-flight 任务的合法性
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
    }
    setState('IDLE');
    setVolume(0);
    setPauseCountdown(0);
  }, []);

  // 切换监听状态
  const toggleListening = useCallback(() => {
    if (state === 'IDLE') {
      void startListening();
    } else {
      stopListening();
    }
  }, [state, startListening, stopListening]);

  // 清空文档与后台 Segments
  const resetWorkspace = useCallback(() => {
    sessionEpochRef.current += 1; // 递增世代，彻底废弃已在队列或飞行中的所有请求
    setSegments((prev) => {
      prev.forEach((s) => {
        if (s.audioBlobUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(s.audioBlobUrl);
        }
      });
      return [];
    });
  }, []);

  // 更新设置
  const updateVadConfig = useCallback((newConfig: Partial<VadConfig>) => {
    setVadConfig((prev) => {
      const merged = { ...prev, ...newConfig };
      engineRef.current?.updateConfig(merged);
      return merged;
    });
  }, []);

  return {
    state,
    segments,
    volume,
    pauseCountdown,
    vadConfig,
    serverOnline,
    activeModel,
    activeModelId,
    availableModels,
    isSwitchingModel,
    handleSwitchModel,
    toggleListening,
    resetWorkspace,
    updateVadConfig,
  };
}
