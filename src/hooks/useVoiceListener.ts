import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ListenerState, TranscriptSegment, VadConfig, ModelInfo } from '../types';
import { AudioCaptureEngine, DEFAULT_VAD_CONFIG, pcmToWavBlob } from '../services/audioCaptureEngine';
import { checkAsrHealth, fetchAvailableModels, switchActiveModel } from '../services/asrService';
import { loadSavedSegments, saveSegments } from '../services/storageService';

interface UseVoiceListenerOptions {
  onTranscriptPartial?: (segmentId: string, text: string) => void;
  onTranscriptSpeechEnd?: (segmentId: string) => void;
  onTranscriptFinal?: (segmentId: string, text: string, segment: TranscriptSegment) => void;
  onTranscriptCancelled?: (segmentId: string) => void;
}

export function useVoiceListener(options?: UseVoiceListenerOptions) {
  const [captureState, setCaptureState] = useState<'IDLE' | 'LISTENING_SILENCE' | 'SPEAKING_ACTIVE' | 'PAUSE_WAITING'>('IDLE');
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [pendingFinalCount, setPendingFinalCount] = useState<number>(0);
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

  // 关键修复 P0-1: 确切的待定稿 SegmentId 集合 (Single Source of Truth)
  const pendingFinalIdsRef = useRef<Set<string>>(new Set());

  // 全局会话世代 (Session Epoch)，在清空、新开启时递增
  const sessionEpochRef = useRef<number>(1);
  const engineRef = useRef<AudioCaptureEngine | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>(segments);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 辅助函数：原子增减 pendingFinalIds
  const markPending = useCallback((segmentId: string) => {
    pendingFinalIdsRef.current.add(segmentId);
    setPendingFinalCount(pendingFinalIdsRef.current.size);
  }, []);

  const settlePending = useCallback((segmentId: string) => {
    if (pendingFinalIdsRef.current.has(segmentId)) {
      pendingFinalIdsRef.current.delete(segmentId);
      setPendingFinalCount(pendingFinalIdsRef.current.size);
    }
  }, []);

  const clearAllPending = useCallback(() => {
    pendingFinalIdsRef.current.clear();
    setPendingFinalCount(0);
  }, []);

  // 状态拆分 P0-1 & P0-2
  const isCapturing = captureState !== 'IDLE';
  const isFinalizing = !isCapturing && pendingFinalCount > 0;

  // UI 展示状态
  const state: ListenerState = useMemo(() => {
    if (captureState === 'IDLE') {
      return pendingFinalCount > 0 ? 'TRANSCRIBING' : 'IDLE';
    }
    if (captureState === 'SPEAKING_ACTIVE') return 'SPEAKING_ACTIVE';
    if (captureState === 'PAUSE_WAITING') return 'PAUSE_WAITING';
    if (pendingFinalCount > 0) return 'TRANSCRIBING';
    return 'LISTENING_SILENCE';
  }, [captureState, pendingFinalCount]);

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
      engineRef.current?.abortAndDispose();
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
        if (engineRef.current) {
          engineRef.current.activeModelId = modelId;
        }
      } else {
        alert(`切换模型 ${modelId} 失败，请检查模型文件是否存在！`);
      }
    } catch (e) {
      console.error('Failed to switch model:', e);
    } finally {
      setIsSwitchingModel(false);
    }
  }, [refreshServerStatus]);

  // 启动常驻双通道流式监听 (带互斥与安全初始化)
  const startListening = useCallback(async () => {
    // 关键优化 P0-2: 如果正在启动中或处于旧段落 draining 定稿中，禁止重复启动
    if (isStarting || (captureState === 'IDLE' && pendingFinalIdsRef.current.size > 0)) {
      return;
    }

    setIsStarting(true);
    try {
      if (engineRef.current) {
        engineRef.current.abortAndDispose();
        engineRef.current = null;
      }

      sessionEpochRef.current += 1;
      const currentSession = sessionEpochRef.current;
      clearAllPending();

      const engine = new AudioCaptureEngine(vadConfig, activeModelId);

      // 0. WebSocket 握手就绪与连接状态回调
      engine.transport.onStreamReady = (_sampleRate, ready) => {
        setStreamingReady(ready);
      };

      engine.onConnectionChange = (connected) => {
        if (!connected) {
          setStreamingReady(false);
        }
      };

      // 1. 说话开始回调
      engine.onSpeakingStart = () => {
        setCaptureState('SPEAKING_ACTIVE');
        setPauseCountdown(0);
      };

      // 2. 停顿倒计时回调
      engine.onSpeakingPause = (remainingMs) => {
        setCaptureState('PAUSE_WAITING');
        setPauseCountdown(remainingMs);
      };

      // 3. 说话结束回调（流式结束，加入精确待定稿集合）
      engine.onSpeakingEnd = (segmentId) => {
        setCaptureState('LISTENING_SILENCE');
        setPauseCountdown(0);
        markPending(segmentId);
        optionsRef.current?.onTranscriptSpeechEnd?.(segmentId);
      };

      // 3.1 说话取消回调 (短噪声 < 180ms 过滤或主动取消)
      engine.onSpeakingCancel = (segmentId) => {
        settlePending(segmentId);
        optionsRef.current?.onTranscriptCancelled?.(segmentId);
      };

      // 4. 音量波形更新
      engine.onVolumeUpdate = (vol) => {
        setVolume(vol);
      };

      // 5. 实时流式 Partial 增量文本
      engine.onPartial = (event) => {
        if (event.sessionEpoch !== sessionEpochRef.current) return;
        optionsRef.current?.onTranscriptPartial?.(event.segmentId, event.text);
      };

      // 6. 二阶段 Final 定稿文本到达 (安全携带 cachedData 真实时间戳与 PCM)
      engine.onFinal = (event, cachedData) => {
        settlePending(event.segmentId);

        if (event.sessionEpoch !== sessionEpochRef.current) {
          console.log('[ASR] Discarding stale Final due to session epoch change:', event.text);
          optionsRef.current?.onTranscriptCancelled?.(event.segmentId);
          return;
        }

        const trimmed = event.text ? event.text.trim() : '';
        if (trimmed) {
          let audioUrl: string | undefined = undefined;
          if (cachedData?.pcm) {
            const wavBlob = pcmToWavBlob(cachedData.pcm, 16000);
            audioUrl = URL.createObjectURL(wavBlob);
          }

          const now = Date.now();
          const startedAt = cachedData?.startedAt || (now - (cachedData?.durationMs || 3000));
          const endedAt = cachedData?.endedAt || now;
          const durationMs = cachedData?.durationMs || Math.max(500, endedAt - startedAt);

          const segment: TranscriptSegment = {
            id: event.segmentId,
            generation: event.sessionEpoch,
            startedAt,
            endedAt,
            originalText: trimmed,
            modelId: event.modelId || activeModelId,
            durationMs,
            audioBlobUrl: audioUrl,
            createdAt: now,
            finalSource: event.finalSource,
          };

          const nextSegments = [...segmentsRef.current, segment];
          segmentsRef.current = nextSegments;
          setSegments(nextSegments);

          optionsRef.current?.onTranscriptFinal?.(event.segmentId, trimmed, segment);
        } else {
          optionsRef.current?.onTranscriptCancelled?.(event.segmentId);
        }
      };

      engine.onError = (event) => {
        if (event.segmentId) {
          settlePending(event.segmentId);
          optionsRef.current?.onTranscriptCancelled?.(event.segmentId);
        }
        console.warn('[ASR] Stream error event:', event);
      };

      await engine.start(currentSession);

      // 若在启动异步过程中用户切换了世代，安全放弃
      if (currentSession !== sessionEpochRef.current) {
        engine.abortAndDispose();
        return;
      }

      engineRef.current = engine;
      setCaptureState('LISTENING_SILENCE');
    } catch (err) {
      console.error('Failed to start AudioCaptureEngine:', err);
      alert('启动麦克风失败，请检查浏览器麦克风权限！');
      setCaptureState('IDLE');
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, captureState, vadConfig, activeModelId, markPending, settlePending, clearAllPending]);

  // 停止监听 (优雅停止麦克风采集，但保留已录制段落的定稿结算权)
  const stopListening = useCallback(() => {
    setCaptureState('IDLE');
    setVolume(0);
    setPauseCountdown(0);
    setStreamingReady(false);

    if (engineRef.current) {
      engineRef.current.stopCaptureGracefully();
      if (engineRef.current.localSegmentCache.size === 0) {
        engineRef.current = null;
      }
    }
  }, []);

  // 切换监听状态
  const toggleListening = useCallback(() => {
    if (isStarting || isFinalizing) return;
    if (isCapturing) {
      stopListening();
    } else {
      void startListening();
    }
  }, [isStarting, isFinalizing, isCapturing, startListening, stopListening]);

  // 清空文档与后台 Segments (原子重置会话世代，取消飞行中的所有录音)
  const resetWorkspace = useCallback(() => {
    sessionEpochRef.current += 1;
    clearAllPending();

    if (engineRef.current) {
      engineRef.current.resetSession(sessionEpochRef.current);
    }

    const previousSegments = segmentsRef.current;
    previousSegments.forEach((s) => {
      if (s.audioBlobUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(s.audioBlobUrl);
      }
    });

    segmentsRef.current = [];
    setSegments([]);
    saveSegments([]);
  }, [clearAllPending]);

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
    isCapturing,
    isStarting,
    isFinalizing,
    pendingFinalCount,
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
