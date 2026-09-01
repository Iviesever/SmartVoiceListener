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
# 1. 验证 Streaming Paraformer 引擎增量吐字与首字音频位置 (First Token Audio Lookahead)
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

    cost_ms = (time.perf_counter() - t0) * 1000
    print(f"[✓] Streaming Paraformer finished in {cost_ms:.1f}ms (RTF: {cost_ms/(len(samples)/sample_rate*1000):.3f}), final partial: \"{partials[-1] if partials else ''}\"")
    print(f"[✓] First Partial token emerged at audio offset: {time_to_first_partial_audio_ms:.1f}ms")
    assert len(partials) > 0, "Should have produced at least one partial transcription"


# =========================================================================
# 2. 验证模型切换与 Second-Pass 调度隔离 & 失败回滚恢复保护
# =========================================================================
async def test_scheduler_model_isolation():
    print("\n--- 2. Testing OfflineInferenceScheduler & Model Isolation / Rollback ---")
    samples, sample_rate = load_test_audio()

    # 用户初始选定默认模型为 sensevoice-onnx
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

    # 模拟用户将默认模型切换为目标模型
    user_target = "qwen3-asr-1.7b" if (AVAILABLE_MODELS.get("qwen3-asr-1.7b", {}).get("path") and AVAILABLE_MODELS["qwen3-asr-1.7b"]["path"].exists()) else "sensevoice-onnx"
    model_manager.selected_model_id = user_target

    # 一个旧的 sensevoice job 延迟到达并真正执行
    job_old = FinalJob(
        session_epoch=1,
        segment_id="seg-isolation-old",
        model_id="sensevoice-onnx",
        samples=samples[:16000],
        sample_rate=sample_rate,
        fallback_text="fallback-old"
    )
    result2 = await inference_scheduler.execute_job(job_old)
    assert result2.model_id == "sensevoice-onnx"
    # 核心验证 1：执行旧 job 绝不抹除或覆盖用户当前选定的 user_target！
    assert model_manager.selected_model_id == user_target
    print(f"  [✓] Model isolation verified: Job executed and user selected_model_id={model_manager.selected_model_id} preserved!")

    # 核心验证 2：加载失败时，selected_model_id 不会被破坏，且原引擎正常可用
    client = TestClient(app)
    res = client.post("/api/switch_model", json={"modelId": "non-existent-model"})
    assert res.status_code == 400
    assert model_manager.selected_model_id == user_target
    print("  [✓] Model switch failure rollback verified!")

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


# =========================================================================
# 5. 验证前缀快照 sample-by-sample 精确连续性与零重复/零丢失
# =========================================================================
def test_prefix_ring_continuity_and_no_drop():
    print("\n--- 5. Testing Prefix Ring Sample-by-Sample Continuity & Zero Duplication ---")
    capacity = 12800
    ring = np.zeros(capacity, dtype=np.float32)
    write_pos = 0
    size = 0

    def ring_write(chunk):
        nonlocal write_pos, size
        for s in chunk:
            ring[write_pos] = s
            write_pos = (write_pos + 1) % capacity
            if size < capacity:
                size += 1

    def ring_snapshot():
        nonlocal write_pos, size
        if size == 0:
            return np.array([], dtype=np.float32)
        if size < capacity:
            return ring[:size].copy()
        return np.concatenate([ring[write_pos:], ring[:write_pos]])

    def ring_clear():
        nonlocal write_pos, size
        write_pos = 0
        size = 0

    # 1. 模拟过去 500ms 环境音 (8000 采样，全 0.1)
    ambient = np.full(8000, 0.1, dtype=np.float32)
    ring_write(ambient)

    # 2. 模拟第 1 个人声候选帧 (1600 采样，全 0.5)
    candidate_frame_1 = np.full(1600, 0.5, dtype=np.float32)
    ring_write(candidate_frame_1)

    # 3. 模拟第 2 个确认人声帧 (1600 采样，全 0.8)
    trigger_frame_2 = np.full(1600, 0.8, dtype=np.float32)
    snapshot = ring_snapshot()
    ring_clear()

    segment_pcm = np.concatenate([snapshot, trigger_frame_2])

    assert len(snapshot) == 9600
    assert np.allclose(snapshot[-1600:], candidate_frame_1)
    assert np.sum(segment_pcm == 0.5) == 1600
    assert np.sum(segment_pcm == 0.8) == 1600
    assert len(ring_snapshot()) == 0
    print("[✓] Prefix sample-by-sample continuity & zero-drop/zero-duplication verified!")


# =========================================================================
# 6. 验证 Exactly-Once 结算与 Watchdog Fallback 失败保护
# =========================================================================
def test_exactly_once_settlement_and_watchdog_failure_protection():
    print("\n--- 6. Testing Exactly-Once Settlement & Watchdog Fallback Failure Protection ---")
    local_cache = {"seg-001": {"pcm": np.zeros(16000), "durationMs": 1000}}
    commit_history = []

    def claim_segment_for_final(segment_id: str):
        if segment_id in local_cache:
            data = local_cache.pop(segment_id)
            return data
        return None

    def execute_http_fallback(segment_id: str, will_succeed: bool, mode: str):
        if will_succeed:
            cached = claim_segment_for_final(segment_id)
            if cached is not None:
                commit_history.append(("HTTP_SUCCESS", segment_id, "HTTP转录结果"))
                return True
        else:
            # 关键验证：若为 ws-watchdog 模式，失败时不 claim，保留缓存给迟到的 WS Final！
            if mode == "ws-watchdog":
                return False
            # 若为 ws-unavailable 模式，则 claim 并报错
            cached = claim_segment_for_final(segment_id)
            if cached is not None:
                commit_history.append(("HTTP_ERROR", segment_id, "ERROR"))
            return False

    def on_ws_final(segment_id: str, text: str):
        cached = claim_segment_for_final(segment_id)
        if cached is None:
            # 已经被抢先认领
            return False
        commit_history.append(("WS_SUCCESS", segment_id, text))
        return True

    # 场景 1：15s watchdog 触发 HTTP fallback，但 fallback 异常/超时失败了 (mode: 'ws-watchdog')
    fallback_ok = execute_http_fallback("seg-001", will_succeed=False, mode="ws-watchdog")
    assert fallback_ok is False
    # 验证：本地缓存依然被完好保留！
    assert "seg-001" in local_cache

    # 随后在 t=30s 时迟到的 WS Qwen Final 终于到达
    ws_ok = on_ws_final("seg-001", "迟到但成功的WS定稿文本")
    assert ws_ok is True
    assert "seg-001" not in local_cache

    # 验证结果：迟到的主通道 WS Final 成功被落库，绝对没有被失败的备用通道破坏！
    assert len(commit_history) == 1
    assert commit_history[0][0] == "WS_SUCCESS"
    print(f"[✓] Watchdog fallback failure protection verified: Late WS Final succeeded -> {commit_history[0]}")


def main():
    test_streaming_engine_direct()
    asyncio.run(test_scheduler_model_isolation())
    test_websocket_stream_e2e()
    test_streaming_unavailable_degradation()
    test_prefix_ring_continuity_and_no_drop()
    test_exactly_once_settlement_and_watchdog_failure_protection()
    print("\n[★] ALL 6 REGRESSION TEST SUITES PASSED SUCCESSFULLY!\n")


if __name__ == "__main__":
    main()
