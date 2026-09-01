import asyncio
import time
import wave
import numpy as np
from pathlib import Path
import sherpa_onnx
from server.asr_server import streaming_engine, model_manager, inference_scheduler, FinalJob

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
SENSEVOICE_DIR = MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
TEST_WAV = SENSEVOICE_DIR / "test_wavs" / "zh.wav"

def test_streaming_engine_direct():
    print("\n--- 1. Testing Streaming Paraformer Online Engine directly ---")
    assert streaming_engine.is_ready, "StreamingEngine should be ready"
    
    stream = streaming_engine.create_stream()
    assert stream is not None, "Failed to create stream"

    with wave.open(str(TEST_WAV), "rb") as wf:
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    print(f"[*] Audio length: {len(samples)/sample_rate:.2f}s, Sample Rate: {sample_rate}Hz")
    
    # 模拟 100ms (1600 samples) 逐包流式喂入
    chunk_size = 1600
    partials = []
    t0 = time.perf_counter()
    for i in range(0, len(samples), chunk_size):
        chunk = samples[i:i+chunk_size]
        stream.accept_waveform(sample_rate, chunk)
        text = streaming_engine.decode_stream(stream)
        if text and (not partials or text != partials[-1]):
            partials.append(text)
            print(f"  -> Partial @ {(i+len(chunk))/sample_rate:.2f}s: \"{text}\"")

    cost_ms = (time.perf_counter() - t0) * 1000
    print(f"[✓] Streaming Paraformer finished in {cost_ms:.1f}ms, final partial: \"{partials[-1] if partials else ''}\"")
    assert len(partials) > 0, "Should have produced at least one partial transcription"

async def test_scheduler_and_second_pass():
    print("\n--- 2. Testing OfflineInferenceScheduler & Second-Pass Final ---")
    with wave.open(str(TEST_WAV), "rb") as wf:
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    job = FinalJob(
        session_epoch=1,
        segment_id="test-seg-scheduler",
        model_id=model_manager.active_model_id,
        samples=samples,
        sample_rate=sample_rate,
        fallback_text="fallback text"
    )

    t0 = time.perf_counter()
    result = await inference_scheduler.execute_job(job)
    cost_ms = (time.perf_counter() - t0) * 1000

    print(f"  [Scheduler Final Result]: text=\"{result.text}\", cost={cost_ms:.1f}ms, source={result.final_source}")
    assert result.session_epoch == 1
    assert result.segment_id == "test-seg-scheduler"
    assert len(result.text) > 0
    assert result.final_source == "second_pass"
    print("[✓] Second-Pass FinalJob execution PASSED!")

def main():
    test_streaming_engine_direct()
    asyncio.run(test_scheduler_and_second_pass())
    print("\n[★] ALL STREAMING TWO-PASS ASR PIPELINE TESTS PASSED!\n")

if __name__ == "__main__":
    main()
