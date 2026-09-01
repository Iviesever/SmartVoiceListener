import { useState, useRef, useEffect, useCallback } from 'react';
import { ListenerState, TranscriptItem, VadConfig, ModelInfo } from '../types';
import { VadEngine, DEFAULT_VAD_CONFIG, pcmToWavBlob } from '../services/vadEngine';
import { transcribeAudioBlob, checkAsrHealth, fetchAvailableModels, switchActiveModel } from '../services/asrService';
import { loadTranscripts, saveTranscripts } from '../services/storageService';

function revokeAudioUrl(item: TranscriptItem | undefined) {
  if (item?.audioBlobUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(item.audioBlobUrl);
  }
}

export function useVoiceListener() {
  const [state, setState] = useState<ListenerState>('IDLE');
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>(() => loadTranscripts());
  const [volume, setVolume] = useState<number>(0);
  const [pauseCountdown, setPauseCountdown] = useState<number>(0);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [activeModel, setActiveModel] = useState<string>('SenseVoice');
  const [activeModelId, setActiveModelId] = useState<string>('sensevoice-onnx');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isSwitchingModel, setIsSwitchingModel] = useState<boolean>(false);

  const engineRef = useRef<VadEngine | null>(null);
  const transcriptsRef = useRef<TranscriptItem[]>(transcripts);

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

  // 保存文字记录；Blob URL 仅属于当前运行时，不写入 localStorage。
  useEffect(() => {
    transcriptsRef.current = transcripts;
    saveTranscripts(transcripts);
  }, [transcripts]);

  // 页面卸载时释放麦克风以及所有仍存活的 Blob URL，避免长时间运行/热重载后的资源泄漏。
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
      transcriptsRef.current.forEach(revokeAudioUrl);
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
  const handleSpeakingEnd = useCallback(async (pcmData: Float32Array, durationMs: number) => {
    setState('TRANSCRIBING');
    setPauseCountdown(0);

    const wavBlob = pcmToWavBlob(pcmData, vadConfig.sampleRate);
    const now = new Date();
    const timeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const itemId = `trans-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    try {
      const res = await transcribeAudioBlob(wavBlob);
      if (res.text) {
        const newItem: TranscriptItem = {
          id: itemId,
          timestamp: Date.now(),
          timeString,
          text: res.text,
          durationMs,
          audioBlobUrl: URL.createObjectURL(wavBlob),
          modelName: activeModel,
        };
        setTranscripts((prev) => [newItem, ...prev]);
      }
    } catch (err: unknown) {
      console.error('ASR transcription failed:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      const errorItem: TranscriptItem = {
        id: itemId,
        timestamp: Date.now(),
        timeString,
        text: `[转写失败] ${errMsg}`,
        durationMs,
        audioBlobUrl: URL.createObjectURL(wavBlob),
        modelName: activeModel,
      };
      setTranscripts((prev) => [errorItem, ...prev]);
    } finally {
      if (engineRef.current) {
        setState('LISTENING_SILENCE');
      }
    }
  }, [vadConfig.sampleRate, activeModel]);

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

  // 删除单条记录，同时释放当前运行时音频 URL。
  const deleteTranscript = useCallback((id: string) => {
    setTranscripts((prev) => {
      const target = prev.find((item) => item.id === id);
      revokeAudioUrl(target);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  // 清空所有记录
  const clearAllTranscripts = useCallback(() => {
    if (window.confirm('确定要清空所有已转写的语音记录吗？')) {
      setTranscripts((prev) => {
        prev.forEach(revokeAudioUrl);
        return [];
      });
    }
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
    transcripts,
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
    deleteTranscript,
    clearAllTranscripts,
    updateVadConfig,
  };
}
