import { describe, it, expect, vi } from 'vitest';
import { PrefixRingBuffer, AudioCaptureEngine, resampleAudio } from './audioCaptureEngine';

describe('PrefixRingBuffer (Real TypeScript Class)', () => {
  it('should correctly store samples and snapshot linear buffer', () => {
    const ring = new PrefixRingBuffer(10);
    expect(ring.currentSize).toBe(0);

    const chunk1 = new Float32Array([1, 2, 3]);
    ring.write(chunk1);
    expect(ring.currentSize).toBe(3);

    const snap1 = ring.snapshot();
    expect(Array.from(snap1)).toEqual([1, 2, 3]);
  });

  it('should wrap around circularly without data loss or discontinuity', () => {
    const ring = new PrefixRingBuffer(5);
    // Write 5 items: [1, 2, 3, 4, 5]
    ring.write(new Float32Array([1, 2, 3, 4, 5]));
    expect(Array.from(ring.snapshot())).toEqual([1, 2, 3, 4, 5]);

    // Write 2 more items: overwrites [1, 2] with [6, 7] -> ring becomes [3, 4, 5, 6, 7]
    ring.write(new Float32Array([6, 7]));
    expect(ring.currentSize).toBe(5);
    expect(Array.from(ring.snapshot())).toEqual([3, 4, 5, 6, 7]);
  });

  it('should cleanly reset and clear', () => {
    const ring = new PrefixRingBuffer(5);
    ring.write(new Float32Array([1, 2, 3]));
    ring.clear();
    expect(ring.currentSize).toBe(0);
    expect(ring.snapshot().length).toBe(0);
  });
});

describe('Resampler (Real TypeScript)', () => {
  it('should preserve samples when sample rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const output = resampleAudio(input, 16000, 16000);
    expect(output).toBe(input);
  });

  it('should correctly downsample 48kHz to 16kHz (3:1 ratio)', () => {
    const input = new Float32Array(48000);
    for (let i = 0; i < input.length; i++) input[i] = 1.0;
    const output = resampleAudio(input, 48000, 16000);
    expect(output.length).toBe(16000);
    expect(output[0]).toBeCloseTo(1.0, 5);
  });
});

describe('AudioCaptureEngine Settlement & Lifecycle (Real TypeScript)', () => {
  it('claimSegmentForFinal should be atomic and clear both watchdog and deadline timers', () => {
    const engine = new AudioCaptureEngine();
    const segId = 'seg-test-001';

    const watchdogSpy = vi.fn();
    const deadlineSpy = vi.fn();
    const wTimer = setTimeout(watchdogSpy, 15000);
    const dTimer = setTimeout(deadlineSpy, 60000);

    (engine as any).segmentTimers.set(segId, { watchdog: wTimer, deadline: dTimer });

    // Populate localSegmentCache
    engine.localSegmentCache.set(segId, {
      pcm: new Float32Array(16000),
      durationMs: 1000,
      startedAt: 1000,
      endedAt: 2000,
      modelId: 'sensevoice-onnx',
    });

    expect(engine.localSegmentCache.has(segId)).toBe(true);

    // First claim: succeeds, returns cached data and cancels both timers
    const claim1 = engine.claimSegmentForFinal(segId);
    expect(claim1).toBeDefined();
    expect(claim1?.durationMs).toBe(1000);
    expect(claim1?.modelId).toBe('sensevoice-onnx');
    expect(engine.localSegmentCache.has(segId)).toBe(false);
    expect((engine as any).segmentTimers.has(segId)).toBe(false);

    // Second concurrent claim: returns undefined
    const claim2 = engine.claimSegmentForFinal(segId);
    expect(claim2).toBeUndefined();
  });

  it('resetSession should cancel all pending segments and active segment via onSpeakingCancel', () => {
    const engine = new AudioCaptureEngine();
    const cancelSpy = vi.fn();
    engine.onSpeakingCancel = cancelSpy;

    (engine as any).isSpeaking = true;
    (engine as any).activeSegmentId = 'seg-active-now';

    engine.localSegmentCache.set('seg-a', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });
    engine.localSegmentCache.set('seg-b', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });

    engine.resetSession(2);

    expect(cancelSpy).toHaveBeenCalledWith('seg-active-now');
    expect(cancelSpy).toHaveBeenCalledWith('seg-a');
    expect(cancelSpy).toHaveBeenCalledWith('seg-b');
    expect(engine.localSegmentCache.size).toBe(0);
  });

  it('abortAndDispose with real active speech should cancel active speech and NOT call onSpeakingEnd', () => {
    const engine = new AudioCaptureEngine();
    const cancelSpy = vi.fn();
    const endSpy = vi.fn();
    engine.onSpeakingCancel = cancelSpy;
    engine.onSpeakingEnd = endSpy;

    (engine as any).isSpeaking = true;
    (engine as any).activeSegmentId = 'seg-active-speech';
    engine.localSegmentCache.set('seg-pending', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });

    engine.abortAndDispose();

    // 关键验证：active segment 和 pending segment 均触发 cancel，且绝不调用 onSpeakingEnd
    expect(cancelSpy).toHaveBeenCalledWith('seg-active-speech');
    expect(cancelSpy).toHaveBeenCalledWith('seg-pending');
    expect(endSpy).not.toHaveBeenCalled();
    expect(engine.localSegmentCache.size).toBe(0);
  });

  it('stopCaptureGracefully should finalize active speech when speaking', () => {
    const engine = new AudioCaptureEngine();
    const endSpy = vi.fn();
    engine.onSpeakingEnd = endSpy;

    (engine as any).isSpeaking = true;
    (engine as any).activeSegmentId = 'seg-graceful';
    (engine as any).speechEvidenceSamples = 3200; // 200ms >= 100ms
    (engine as any).currentSegmentPcmChunks = [new Float32Array(3200)];

    engine.stopCaptureGracefully();

    expect(endSpy).toHaveBeenCalledWith('seg-graceful', 200);
    expect(engine.localSegmentCache.has('seg-graceful')).toBe(true);
  });

  it('should freeze activeModelId into SpeechStartPayload and localSegmentCache', () => {
    const engine = new AudioCaptureEngine(undefined, 'qwen3-asr-1.7b');
    const sendMsgSpy = vi.fn();
    engine.transport.sendMessage = sendMsgSpy;

    // Trigger speech frame
    const chunk = new Float32Array(1600);
    for (let i = 0; i < chunk.length; i++) chunk[i] = 0.5;

    (engine as any).consecutiveSpeechFrames = 1; // will hit threshold on next frame
    (engine as any).processAudioFrame(chunk);

    expect(sendMsgSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'speech_start',
        modelId: 'qwen3-asr-1.7b',
      })
    );

    // If user switches activeModelId during speech
    engine.activeModelId = 'sensevoice-onnx';

    // When finalized, the segment should still preserve the frozen 'qwen3-asr-1.7b'
    (engine as any).finalizeSpeechSegment();

    const cached = Array.from(engine.localSegmentCache.values())[0];
    expect(cached?.modelId).toBe('qwen3-asr-1.7b');
  });

  it('should accept short utterance with >= 100ms voiced samples and reject click noise', () => {
    const engine = new AudioCaptureEngine();
    const endSpy = vi.fn();
    const cancelSpy = vi.fn();
    engine.onSpeakingEnd = endSpy;
    engine.onSpeakingCancel = cancelSpy;

    // 1. Short valid utterance: "好" (120ms = 1920 samples @ 16kHz)
    (engine as any).activeSegmentId = 'seg-hao';
    (engine as any).isSpeaking = true;
    (engine as any).speechEvidenceSamples = 1920;
    (engine as any).currentSegmentPcmChunks = [new Float32Array(1920)];

    (engine as any).finalizeSpeechSegment();
    expect(endSpy).toHaveBeenCalledWith('seg-hao', 120);

    // 2. Click noise: 50ms = 800 samples < 100ms
    (engine as any).activeSegmentId = 'seg-click';
    (engine as any).isSpeaking = true;
    (engine as any).speechEvidenceSamples = 800;
    (engine as any).currentSegmentPcmChunks = [new Float32Array(800)];

    (engine as any).finalizeSpeechSegment();
    expect(cancelSpy).toHaveBeenCalledWith('seg-click');
  });
});
