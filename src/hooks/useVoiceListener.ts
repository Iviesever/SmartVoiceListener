import { useState, useRef, useEffect, useCallback } from 'react';
import { ListenerState, TranscriptSegment, VadConfig, ModelInfo } from '../types';
import { VadEngine, DEFAULT_VAD_CONFIG, pcmToWavBlob } from '../services/vadEngine';
import { transcribeAudioBlob, checkAsrHealth, fetchAvailableModels, switchActiveModel } from '../services/asrService';

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
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  // 关键：Document Generation Token (防清空或切换后的旧请求迟到竞态复活)
  const documentGenerationRef = useRef<number>(1);
  const engineRef = useRef<VadEngine | null>(null);
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
  const handleSpeakingEnd = useCallback(async (pcmData: Float32Array, durationMs: number) => {
    setState('TRANSCRIBING');
    setPauseCountdown(0);

    // 绑定当前发起任务时的 Generation Token
    const jobGeneration = documentGenerationRef.current;
    const now = Date.now();
    const startedAt = now - durationMs;
    const endedAt = now;
    const wavBlob = pcmToWavBlob(pcmData, vadConfig.sampleRate);
    const audioUrl = URL.createObjectURL(wavBlob);

    try {
      const res = await transcribeAudioBlob(wavBlob);
      
      // 竞态校验：若用户在识别过程中点击了清空，或文档代数已更新，彻底丢弃此迟到结果
      if (jobGeneration !== documentGenerationRef.current) {
        console.log('[ASR] Discarding stale transcript due to generation mismatch:', res.text);
        URL.revokeObjectURL(audioUrl);
        return;
      }

      if (res.text) {
        const segment: TranscriptSegment = {
          id: `seg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          generation: jobGeneration,
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
      if (engineRef.current) {
        setState('LISTENING_SILENCE');
      }
    }
  }, [vadConfig.sampleRate, activeModelId]);

  // 启动常驻监听
  const startListening = useCallback(async () => {
    try {
      if (engineRef.current) {
        engineRef.current.stop();
      }

      const engine = new VadEngine(vadConfig);
      engine.onSpeakingStart = () => {
        setState('SPEAKING_ACTIVE');
        setPauseCountdown(0);
      };
      engine.onSpeakingPause = (remainingMs) => {
        setState('PAUSE_WAITING');
        setPauseCountdown(remainingMs);
      };
      engine.onSpeakingEnd = (pcm, dur) => {
        void handleSpeakingEnd(pcm, dur);
      };
      engine.onVolumeUpdate = (vol) => {
        setVolume(vol);
      };

      await engine.start();
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

  // 清空文档与底层 Segments（同时递增 Generation Token 杜绝竞态）
  const resetWorkspace = useCallback(() => {
    documentGenerationRef.current += 1;
    setSegments((prev) => {
      prev.forEach((s) => {
        if (s.audioBlobUrl) URL.revokeObjectURL(s.audioBlobUrl);
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
