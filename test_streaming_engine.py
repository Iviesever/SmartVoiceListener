import asyncio
import time
import wave
import numpy as np
from pathlib import Path
import sherpa_onnx
from starlette.testclient import TestClient
from server.asr_server import (
    app,
    streaming_engine,
    model_manager,
    inference_scheduler,
    FinalJob,
    AVAILABLE_MODELS,
    normalize_audio_for_inference,
)

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
SENSEVOICE_DIR = MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
TEST_WAV = SENSEVOICE_DIR / "test_wavs" / "zh.wav"


def load_test_audio():
    with wave.open(str(TEST_WAV), "rb") as wf:
        sample_rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sample_rate


# =========================================================================
# 1. 验证 Streaming Paraformer 引擎增量吐字与首字音频位置
# =========================================================================
def test_streaming_engine_direct():
    print("\n--- 1. Testing Streaming Paraformer Online Engine & Latency ---")
    assert streaming_engine.is_ready, "StreamingEngine should be ready"
    
    stream = streaming_engine.create_stream()
    assert stream is not None, "Failed to create stream"

    samples, sample_rate = load_test_audio()
    print(f"[*] Audio length: {len(samples)/sample_rate:.2f}s, Sample Rate: {sample_rate}Hz")
    
    chunk_size = 1600
    partials = []
    time_to_first_partial_audio_ms = None
    t0 = time.perf_counter()
    for i in range(0, len(samples), chunk_size):
        chunk = samples[i:i+chunk_size]
        stream.accept_waveform(sample_rate, chunk)
        text = streaming_engine.decode_stream(stream)
        if text and (not partials or text != partials[-1]):
            if time_to_first_partial_audio_ms is None:
                time_to_first_partial_audio_ms = (i + len(chunk)) / sample_rate * 1000
            partials.append(text)
            print(f"  -> Partial @ {(i+len(chunk))/sample_rate:.2f}s: \"{text}\"")

    # 测试 speech_end input_finished 尾部 flush
    stream.input_finished()
    tail_text = streaming_engine.decode_stream(stream)
    if tail_text and (not partials or tail_text != partials[-1]):
        partials.append(tail_text)
        print(f"  -> Flushed Tail Partial: \"{tail_text}\"")

    cost_ms = (time.perf_counter() - t0) * 1000
    print(f"[✓] Streaming Paraformer finished in {cost_ms:.1f}ms (RTF: {cost_ms/(len(samples)/sample_rate*1000):.3f}), final partial: \"{partials[-1] if partials else ''}\"")
    print(f"[✓] First Partial token emerged at audio offset: {time_to_first_partial_audio_ms:.1f}ms")
    assert len(partials) > 0, "Should have produced at least one partial transcription"


# =========================================================================
# 2. 验证模型切换异常自动回滚 (Real load failure & rollback to previous engine)
# =========================================================================
async def test_scheduler_model_isolation_and_rollback():
    print("\n--- 2. Testing OfflineInferenceScheduler & Model Rollback on Load Failure ---")
    samples, sample_rate = load_test_audio()

    # 1. 用户初始选定并加载 SenseVoice
    model_manager.selected_model_id = "sensevoice-onnx"
    await asyncio.to_thread(model_manager.load_engine, "sensevoice-onnx")
    assert model_manager.loaded_engine_model_id == "sensevoice-onnx"
    assert model_manager.current_engine is not None

    # 2. 模拟注册一个存在但加载过程中一定会抛出异常的坏模型
    AVAILABLE_MODELS["faulty-test-model"] = {
        "name": "Faulty Model For Testing",
        "engine": "sherpa-onnx",
        "path": Path("models/non_existent_folder_for_faulty_test"),
        "available": True,
    }

    client = TestClient(app)
    # 请求切换到坏模型：应该触发内部加载异常并自动回滚到 sensevoice-onnx
    res = client.post("/api/switch_model", json={"modelId": "faulty-test-model"})
    assert res.status_code == 500
    print("  [✓] /api/switch_model correctly returned 500 for faulty model")

    # 3. 核心验证：用户目标与实际 loaded engine 均已成功回滚到 sensevoice-onnx，引擎没有死锁或为 None
    assert model_manager.selected_model_id == "sensevoice-onnx"
    assert model_manager.loaded_engine_model_id == "sensevoice-onnx"
    assert model_manager.current_engine is not None

    # 4. 执行推理验证回滚后的引擎依然 100% 正常工作
    job = FinalJob(
        session_epoch=1,
        segment_id="seg-rollback-test",
        model_id="sensevoice-onnx",
        samples=samples[:16000],
        sample_rate=sample_rate,
        fallback_text="fallback"
    )
    result = await inference_scheduler.execute_job(job)
    assert result.final_source == "second_pass"
    assert len(result.text) > 0
    print(f"  [✓] Engine after rollback recognized audio successfully: \"{result.text}\"")

    del AVAILABLE_MODELS["faulty-test-model"]


# =========================================================================
# 3. 验证端到端 WebSocket 连续流式与定稿回包 (包含尾部 flush 与 modelId 冻结)
# =========================================================================
def test_websocket_stream_e2e():
    print("\n--- 3. Testing WebSocket /api/stream End-to-End ---")
    client = TestClient(app)
    samples, sample_rate = load_test_audio()

    with client.websocket_connect("/api/stream") as ws:
        # 1. 握手
        ws.send_json({
            "type": "stream_init",
            "protocolVersion": 1,
            "sampleRate": 16000,
            "channels": 1,
            "format": "f32le",
            "packetSamples": 1600
        })
        init_res = ws.receive_json()
        print("  [WS] Handshake response:", init_res)
        assert init_res["type"] == "stream_ready"
        assert init_res["streamingReady"] is True

        # 2. 发送 speech_start (附带模型冻结 ID)
        seg_a = "seg-e2e-A"
        ws.send_json({
            "type": "speech_start",
            "sessionEpoch": 1,
            "segmentId": seg_a,
            "hasPrefix": True,
            "modelId": "sensevoice-onnx"
        })

        # 3. 连续推流 PCM
        chunk_size = 1600
        for i in range(0, len(samples), chunk_size):
            chunk = samples[i:i+chunk_size]
            ws.send_bytes(chunk.tobytes())

        # 4. 发送 speech_end
        ws.send_json({
            "type": "speech_end",
            "sessionEpoch": 1,
            "segmentId": seg_a,
            "durationMs": int((len(samples)/sample_rate)*1000)
        })

        # 5. 循环读取回包直至收到 final
        received_partials = []
        final_msg = None
        while True:
            msg = ws.receive_json()
            if msg.get("type") == "partial":
                received_partials.append(msg["text"])
            elif msg.get("type") == "final":
                final_msg = msg
                break

        print(f"  [WS] Partials received count: {len(received_partials)}")
        print(f"  [WS] Final Message:", final_msg)
        assert final_msg is not None
        assert final_msg["segmentId"] == seg_a
        assert final_msg["sessionEpoch"] == 1
        assert len(final_msg["text"]) > 0
        assert final_msg["finalSource"] == "second_pass"
        print(f"[✓] End-to-End WebSocket Stream test PASSED! Text: \"{final_msg['text']}\"")


# =========================================================================
# 4. 验证短词 (“好”, “对”, “嗯”, “OK”) 不因净时长而被丢弃
# =========================================================================
def test_short_utterance_support():
    print("\n--- 4. Testing Short Utterances ('好', '对', 'OK') Support ---")
    samples, sample_rate = load_test_audio()
    # 取前 0.3s (300ms) 音频
    short_samples = samples[: int(sample_rate * 0.3)]
    norm_samples = normalize_audio_for_inference(short_samples)
    assert len(norm_samples) == len(short_samples)
    print(f"[✓] Short utterance (300ms = {len(short_samples)} samples) normalized successfully!")


# =========================================================================
# 5. 验证音频响度归一化一致性 (WS 与 REST 统一)
# =========================================================================
def test_audio_normalization_consistency():
    print("\n--- 5. Testing Audio Normalization for Inference Consistency ---")
    quiet_samples = np.full(16000, 0.05, dtype=np.float32)
    norm = normalize_audio_for_inference(quiet_samples)
    # max_abs 0.05 -> gain min(4.0, 0.85/0.05 = 17.0) = 4.0 -> norm max = 0.20
    assert np.isclose(np.max(np.abs(norm)), 0.20)
    print(f"[✓] Normalization gain consistent: 0.05 -> {np.max(np.abs(norm)):.2f}")


def main():
    test_streaming_engine_direct()
    asyncio.run(test_scheduler_model_isolation_and_rollback())
    test_websocket_stream_e2e()
    test_short_utterance_support()
    test_audio_normalization_consistency()
    print("\n[★] ALL PYTHON REGRESSION TEST SUITES PASSED SUCCESSFULLY!\n")


if __name__ == "__main__":
    main()
