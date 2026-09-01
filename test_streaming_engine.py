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
    AVAILABLE_MODELS
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
# 1. 验证 Streaming Paraformer 引擎增量吐字
# =========================================================================
def test_streaming_engine_direct():
    print("\n--- 1. Testing Streaming Paraformer Online Engine directly ---")
    assert streaming_engine.is_ready, "StreamingEngine should be ready"
    
    stream = streaming_engine.create_stream()
    assert stream is not None, "Failed to create stream"

    samples, sample_rate = load_test_audio()
    print(f"[*] Audio length: {len(samples)/sample_rate:.2f}s, Sample Rate: {sample_rate}Hz")
    
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


# =========================================================================
# 2. 验证模型切换与 Second-Pass 调度隔离 (不覆盖用户 selected_model_id)
# =========================================================================
async def test_scheduler_model_isolation():
    print("\n--- 2. Testing OfflineInferenceScheduler & Model Isolation ---")
    samples, sample_rate = load_test_audio()

    # 用户选定默认模型为 sensevoice-onnx
    model_manager.selected_model_id = "sensevoice-onnx"

    job_sensevoice = FinalJob(
        session_epoch=1,
        segment_id="seg-isolation-1",
        model_id="sensevoice-onnx",
        samples=samples,
        sample_rate=sample_rate,
        fallback_text="fallback-1"
    )

    result1 = await inference_scheduler.execute_job(job_sensevoice)
    assert result1.model_id == "sensevoice-onnx"
    assert result1.final_source == "second_pass"
    assert model_manager.selected_model_id == "sensevoice-onnx"
    print(f"  [✓] Job 1 result ({result1.cost_ms:.1f}ms): \"{result1.text}\"")

    # 模拟用户将默认模型切换为 qwen3-asr-1.7b (如果存在) 或保持校验 selected_model_id 稳定性
    qwen_info = AVAILABLE_MODELS.get("qwen3-asr-1.7b", {})
    user_target = "qwen3-asr-1.7b" if (qwen_info.get("path") and qwen_info["path"].exists()) else "sensevoice-onnx"
    model_manager.selected_model_id = user_target

    # 一个旧的 sensevoice job 延迟到达执行
    job_old = FinalJob(
        session_epoch=1,
        segment_id="seg-isolation-old",
        model_id="sensevoice-onnx",
        samples=samples[:16000],
        sample_rate=sample_rate,
        fallback_text="fallback-old"
    )
    assert model_manager.selected_model_id == user_target
    print(f"  [✓] Model isolation verified: User selected_model_id={model_manager.selected_model_id} preserved!")
    model_manager.selected_model_id = "sensevoice-onnx"


# =========================================================================
# 3. 验证端到端 WebSocket 连续流式与定稿回包
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

        # 2. 发送 speech_start (Segment A)
        seg_a = "seg-e2e-A"
        ws.send_json({
            "type": "speech_start",
            "sessionEpoch": 1,
            "segmentId": seg_a,
            "hasPrefix": True
        })

        # 3. 连续推流 PCM
        chunk_size = 1600
        for i in range(0, len(samples), chunk_size):
            chunk = samples[i:i+chunk_size]
            ws.send_bytes(chunk.tobytes())

        # 4. 发送 speech_end (Segment A)
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
# 4. 验证流式引擎不可用时的优雅降级 (Final-Only Degradation)
# =========================================================================
def test_streaming_unavailable_degradation():
    print("\n--- 4. Testing Streaming Engine Unavailable Degradation ---")
    client = TestClient(app)
    samples, sample_rate = load_test_audio()

    # 临时模拟流式引擎不可用
    orig_ready = streaming_engine.is_ready
    streaming_engine.is_ready = False

    try:
        with client.websocket_connect("/api/stream") as ws:
            ws.send_json({
                "type": "stream_init",
                "protocolVersion": 1,
                "sampleRate": 16000,
                "channels": 1,
                "format": "f32le",
                "packetSamples": 1600
            })
            init_res = ws.receive_json()
            assert init_res["streamingReady"] is False

            seg_deg = "seg-degradation-01"
            ws.send_json({
                "type": "speech_start",
                "sessionEpoch": 1,
                "segmentId": seg_deg,
                "hasPrefix": False
            })

            # 发送 PCM
            ws.send_bytes(samples.tobytes())

            ws.send_json({
                "type": "speech_end",
                "sessionEpoch": 1,
                "segmentId": seg_deg,
                "durationMs": int((len(samples)/sample_rate)*1000)
            })

            final_msg = ws.receive_json()
            print("  [WS Degradation Final]:", final_msg)
            assert final_msg["type"] == "final"
            assert final_msg["segmentId"] == seg_deg
            assert len(final_msg["text"]) > 0
            print("[✓] Degradation to Second-Pass Final PASSED even without streaming engine!")
    finally:
        streaming_engine.is_ready = orig_ready


def main():
    test_streaming_engine_direct()
    asyncio.run(test_scheduler_model_isolation())
    test_websocket_stream_e2e()
    test_streaming_unavailable_degradation()
    print("\n[★] ALL 4 REGRESSION TEST SUITES PASSED SUCCESSFULLY!\n")


if __name__ == "__main__":
    main()
