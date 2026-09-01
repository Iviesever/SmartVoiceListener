import { useState, useRef, useEffect, useCallback } from 'react';
import { ListenerState, TranscriptSegment, VadConfig, ModelInfo } from '../types';
import { AudioCaptureEngine, DEFAULT_VAD_CONFIG, pcmToWavBlob } from '../services/audioCaptureEngine';
import { checkAsrHealth, fetchAvailableModels, switchActiveModel } from '../services/asrService';
import { loadSavedSegments, saveSegments } from '../services/storageService';

interface UseVoiceListenerOptions {
  onTranscriptPartial?: (text: string, segmentId: string) => void;
  onTranscriptSpeechEnd?: (segmentId: string) => void;
  onTranscriptFinal?: (text: string, segment: TranscriptSegment) => void;
}

export function useVoiceListener(options?: UseVoiceListenerOptions) {
  const [state, setState] = useState<ListenerState>('IDLE');
  const [volume, setVolume] = useState<number>(0);
  const [pauseCountdown, setPauseCountdown] = useState<number>(0);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [streamingReady, setStreamingReady] = useState<boolean>(false);
  const [activeModel, setActiveModel] = useState<string>('SenseVoice');
  const [activeModelId, setActiveModelId] = useState<string>('sensevoice-onnx');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isSwitchingModel, setIsSwitchingModel] = useState<boolean>(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>(() => loadSavedSegments());

  // 全局会话世代 (Session Epoch)，在清空、停止、新开启时递增
  const sessionEpochRef = useRef<number>(1);
  const engineRef = useRef<AudioCaptureEngine | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>(segments);

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
      saveSegments(segmentsRef.current);
    }, 500);
    return () => clearTimeout(timer);
  }, [segments]);

  // 自闭环管理 pagehide 与 visibilitychange 立即同步落盘 Segments
  useEffect(() => {
    const handleImmediateFlush = () => {
      saveSegments(segmentsRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleImmediateFlush();
      }
    };

    window.addEventListener('pagehide', handleImmediateFlush);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handleImmediateFlush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      handleImmediateFlush();
    };
  }, []);

  // 页面卸载时安全清理
  useEffect(() => {
    return () => {
      sessionEpochRef.current += 1;
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

  // 启动常驻双通道流式监听
  const startListening = useCallback(async () => {
    try {
      if (engineRef.current) {
        engineRef.current.stop();
      }

      sessionEpochRef.current += 1;
      const currentSession = sessionEpochRef.current;

      const engine = new AudioCaptureEngine(vadConfig);

      // 1. 说话开始回调
      engine.onSpeakingStart = () => {
        setState('SPEAKING_ACTIVE');
        setPauseCountdown(0);
      };

      // 2. 停顿倒计时回调
      engine.onSpeakingPause = (remainingMs) => {
        setState('PAUSE_WAITING');
        setPauseCountdown(remainingMs);
      };

      // 3. 说话结束回调（流式结束，等待 Second-Pass 定稿）
      engine.onSpeakingEnd = (segmentId) => {
        setState('TRANSCRIBING');
        setPauseCountdown(0);
        optionsRef.current?.onTranscriptSpeechEnd?.(segmentId);
      };

      // 4. 音量波形更新
      engine.onVolumeUpdate = (vol) => {
        setVolume(vol);
      };

      // 5. 实时流式 Partial 增量文本
      engine.onPartial = (event) => {
        if (event.sessionEpoch !== sessionEpochRef.current) return;
        optionsRef.current?.onTranscriptPartial?.(event.text, event.segmentId);
      };

      // 6. 二阶段 Final 定稿文本到达
      engine.onFinal = (event) => {
        if (event.sessionEpoch !== sessionEpochRef.current) {
          console.log('[ASR] Discarding stale Final due to session epoch change:', event.text);
          return;
        }

        const trimmed = event.text.trim();
        if (trimmed) {
          // 生成本地音频 Blob URL（若存在）
          let audioUrl: string | undefined = undefined;
          const cached = engine.localSegmentCache.get(event.segmentId);
          if (cached) {
            const wavBlob = pcmToWavBlob(cached.pcm, 16000);
            audioUrl = URL.createObjectURL(wavBlob);
          }

          const now = Date.now();
          const segment: TranscriptSegment = {
            id: event.segmentId,
            generation: event.sessionEpoch,
            startedAt: now - 3000,
            endedAt: now,
            originalText: trimmed,
            modelId: event.modelId || activeModelId,
            durationMs: cached?.durationMs || 3000,
            audioBlobUrl: audioUrl,
            createdAt: now,
            finalSource: event.finalSource,
          };

          const nextSegments = [...segmentsRef.current, segment];
          segmentsRef.current = nextSegments;
          setSegments(nextSegments);

          optionsRef.current?.onTranscriptFinal?.(trimmed, segment);
        }

        if (engineRef.current) {
          setState('LISTENING_SILENCE');
        }
      };

      engine.onError = (event) => {
        console.warn('[ASR] Stream error event:', event);
      };

      await engine.start(currentSession);

      if (currentSession !== sessionEpochRef.current) {
        engine.stop();
        return;
      }

      engineRef.current = engine;
      setStreamingReady(true);
      setState('LISTENING_SILENCE');
    } catch (err) {
      console.error('Failed to start AudioCaptureEngine:', err);
      alert('启动麦克风失败，请检查浏览器麦克风权限！');
      setState('IDLE');
    }
  }, [vadConfig, activeModelId]);

  // 停止监听
  const stopListening = useCallback(() => {
    sessionEpochRef.current += 1;
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
    }
    setState('IDLE');
    setVolume(0);
    setPauseCountdown(0);
    setStreamingReady(false);
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
    sessionEpochRef.current += 1;

    const previousSegments = segmentsRef.current;
    previousSegments.forEach((s) => {
      if (s.audioBlobUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(s.audioBlobUrl);
      }
    });

    segmentsRef.current = [];
    setSegments([]);
    saveSegments([]);
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
    streamingReady,
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
