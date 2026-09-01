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
  it('claimSegmentForFinal should be atomic and exactly-once', () => {
    const engine = new AudioCaptureEngine();
    const segId = 'seg-test-001';

    // Populate localSegmentCache
    engine.localSegmentCache.set(segId, {
      pcm: new Float32Array(16000),
      durationMs: 1000,
      startedAt: 1000,
      endedAt: 2000,
      modelId: 'sensevoice-onnx',
    });

    expect(engine.localSegmentCache.has(segId)).toBe(true);

    // First claim: should succeed and return cached data
    const claim1 = engine.claimSegmentForFinal(segId);
    expect(claim1).toBeDefined();
    expect(claim1?.durationMs).toBe(1000);
    expect(claim1?.modelId).toBe('sensevoice-onnx');
    expect(engine.localSegmentCache.has(segId)).toBe(false);

    // Second concurrent claim (e.g. late WS or HTTP duplicate): should return undefined
    const claim2 = engine.claimSegmentForFinal(segId);
    expect(claim2).toBeUndefined();
  });

  it('resetSession should cancel all pending segments via onSpeakingCancel', () => {
    const engine = new AudioCaptureEngine();
    const cancelSpy = vi.fn();
    engine.onSpeakingCancel = cancelSpy;

    engine.localSegmentCache.set('seg-a', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });
    engine.localSegmentCache.set('seg-b', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });

    engine.resetSession(2);

    expect(cancelSpy).toHaveBeenCalledWith('seg-a');
    expect(cancelSpy).toHaveBeenCalledWith('seg-b');
    expect(engine.localSegmentCache.size).toBe(0);
  });

  it('abortAndDispose should cancel all pending segments without finalizing active speech', () => {
    const engine = new AudioCaptureEngine();
    const cancelSpy = vi.fn();
    const endSpy = vi.fn();
    engine.onSpeakingCancel = cancelSpy;
    engine.onSpeakingEnd = endSpy;

    engine.localSegmentCache.set('seg-pending', { pcm: new Float32Array(100), durationMs: 100, startedAt: 0, endedAt: 100 });

    engine.abortAndDispose();

    expect(cancelSpy).toHaveBeenCalledWith('seg-pending');
    expect(endSpy).not.toHaveBeenCalled();
    expect(engine.localSegmentCache.size).toBe(0);
  });
});
