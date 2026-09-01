import asyncio
import gc
import io
import json
import os
import sys
import time
import urllib.parse
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, List, Dict, Any

import numpy as np
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
EXTERNAL_MODELS_DIR = Path(
    os.environ.get("SMARTVOICE_MODELS_DIR", r"D:\resource\AI_WorkSpace\Models")
)
SERVER_HOST = os.environ.get("SMARTVOICE_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("SMARTVOICE_PORT", "8767"))

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# GPU 能力探测
try:
    import torch

    CUDA_AVAILABLE = torch.cuda.is_available()
    GPU_NAME = torch.cuda.get_device_name(0) if CUDA_AVAILABLE else "None"
except Exception:
    torch = None
    CUDA_AVAILABLE = False
    GPU_NAME = "None"

print(f"[*] Hardware Acceleration Status: CUDA={CUDA_AVAILABLE} (GPU: {GPU_NAME})")

AVAILABLE_MODELS = {
    "sensevoice-onnx": {
        "id": "sensevoice-onnx",
        "name": "SenseVoice (sherpa-onnx INT8 极速)",
        "engine": "sherpa-onnx",
        "type": "低延迟 / 低功耗",
        "desc": "中文普通话/口语识别，适合分段式常驻监听；二阶段极速定稿",
        "path": MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    },
    "qwen3-asr-1.7b": {
        "id": "qwen3-asr-1.7b",
        "name": "Qwen3-ASR 1.7B",
        "engine": "qwen-asr",
        "type": "高精度大模型",
        "desc": f"Qwen3-ASR 1.7B，本机 GPU: {GPU_NAME if CUDA_AVAILABLE else 'CPU'}",
        "path": EXTERNAL_MODELS_DIR / "Qwen3-ASR-1.7B",
        "repo_id": "Qwen/Qwen3-ASR-1.7B",
    },
    "whisper-large-v3": {
        "id": "whisper-large-v3",
        "name": "Whisper large-v3",
        "engine": "faster-whisper",
        "type": "高精度",
        "desc": f"Whisper large-v3，本机 GPU: {GPU_NAME if CUDA_AVAILABLE else 'CPU'}",
        "path": EXTERNAL_MODELS_DIR / "large-v3",
    },
    "kotoba-v2-faster": {
        "id": "kotoba-v2-faster",
        "name": "Kotoba-v2-faster",
        "engine": "faster-whisper",
        "type": "日文/双语高精度",
        "desc": "日文与双语语音转写",
        "path": EXTERNAL_MODELS_DIR / "kotoba-v2-faster",
    },
}

# =========================================================================
# First-Pass: Streaming Recognizer Engine (sherpa-onnx OnlineParaformer)
# =========================================================================

class StreamingEngine:
    def __init__(self):
        self.recognizer: Optional[sherpa_onnx.OnlineRecognizer] = None
        self.is_ready = False
        self._load_engine()

    def _load_engine(self):
        model_dir = MODELS_DIR / "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
        encoder = model_dir / "encoder.int8.onnx"
        decoder = model_dir / "decoder.int8.onnx"
        tokens = model_dir / "tokens.txt"

        if not (encoder.exists() and decoder.exists() and tokens.exists()):
            print(f"[!] Warning: Streaming Paraformer files not found in {model_dir}")
            self.is_ready = False
            return

        print(f"[*] Loading Streaming Paraformer INT8 engine from {model_dir} ...")
        t0 = time.perf_counter()
        try:
            self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
                tokens=str(tokens),
                encoder=str(encoder),
                decoder=str(decoder),
                num_threads=2,
                sample_rate=16000,
                feature_dim=80,
                decoding_method="greedy_search",
            )
            self.is_ready = True
            cost_ms = (time.perf_counter() - t0) * 1000
            print(f"[✓] Streaming Paraformer engine ready in {cost_ms:.1f}ms")
        except Exception as e:
            print(f"[!] Failed to load Streaming Paraformer: {e}", file=sys.stderr)
            self.is_ready = False

    def create_stream(self) -> Optional[sherpa_onnx.OnlineStream]:
        if not self.is_ready or self.recognizer is None:
            return None
        return self.recognizer.create_stream()

    def decode_stream(self, stream: sherpa_onnx.OnlineStream) -> str:
        if not self.is_ready or self.recognizer is None or stream is None:
            return ""
        while self.recognizer.is_ready(stream):
            self.recognizer.decode_stream(stream)
        result = self.recognizer.get_result(stream)
        if isinstance(result, str):
            return result.strip()
        if hasattr(result, "text"):
            return result.text.strip()
        return str(result).strip()


# =========================================================================
# Second-Pass: Offline Recognizer Model Manager (模型选择与引擎加载解耦)
# =========================================================================

class ModelManager:
    def __init__(self):
        self.selected_model_id = "sensevoice-onnx"   # 用户选中的默认模型目标
        self.loaded_engine_model_id = None          # 当前内存中实际装载的模型 ID
        self.current_engine = None
        self.load_engine(self.selected_model_id)

    def get_model_list(self):
        result = []
        for model_id, info in AVAILABLE_MODELS.items():
            result.append(
                {
                    "id": model_id,
                    "name": info["name"],
                    "engine": info["engine"],
                    "type": info["type"],
                    "desc": info["desc"],
                    "available": info["path"].exists(),
                    "isActive": model_id == self.selected_model_id,
                    "gpu": CUDA_AVAILABLE,
                }
            )
        return result

    def load_engine(self, model_id: str):
        if model_id not in AVAILABLE_MODELS:
            raise ValueError(f"Unknown model_id: {model_id}")

        info = AVAILABLE_MODELS[model_id]
        if self.loaded_engine_model_id == model_id and self.current_engine is not None:
            return

        if not info["path"].exists() and not info.get("repo_id"):
            raise FileNotFoundError(f"Model path does not exist: {info['path']}")

        print(
            f"\n[*] Loading Second-Pass Model -> [{info['name']}] "
            f"(Engine: {info['engine']}, CUDA: {CUDA_AVAILABLE})..."
        )
        started = time.perf_counter()

        self.current_engine = None
        self.loaded_engine_model_id = None
        gc.collect()
        if CUDA_AVAILABLE and torch is not None:
            torch.cuda.empty_cache()

        if info["engine"] == "sherpa-onnx":
            model_file = info["path"] / "model.int8.onnx"
            if not model_file.exists():
                model_file = info["path"] / "model.onnx"
            tokens_file = info["path"] / "tokens.txt"

            if not model_file.exists() or not tokens_file.exists():
                raise FileNotFoundError(
                    f"SenseVoice model files are incomplete under: {info['path']}"
                )

            self.current_engine = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(model_file),
                tokens=str(tokens_file),
                num_threads=4,
                use_itn=True,
                language="auto",
            )

        elif info["engine"] == "faster-whisper":
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise RuntimeError(
                    "faster-whisper is not installed; install it before selecting this model"
                ) from exc

            self.current_engine = WhisperModel(
                str(info["path"]),
                device="cuda" if CUDA_AVAILABLE else "cpu",
                compute_type="float16" if CUDA_AVAILABLE else "int8",
                cpu_threads=4,
            )

        elif info["engine"] == "qwen-asr":
            try:
                from qwen_asr import Qwen3ASRModel
            except ImportError as exc:
                raise RuntimeError(
                    "qwen-asr is not installed; install it before selecting this model"
                ) from exc

            load_target = (
                str(info["path"])
                if info["path"].exists()
                else info.get("repo_id", "Qwen/Qwen3-ASR-1.7B")
            )
            print(f"    Loading Qwen3-ASR from: {load_target} ...")
            self.current_engine = Qwen3ASRModel.from_pretrained(
                load_target,
                device_map="cuda:0" if CUDA_AVAILABLE else "cpu",
            )

        self.loaded_engine_model_id = model_id
        cost_ms = (time.perf_counter() - started) * 1000

        if CUDA_AVAILABLE and torch is not None:
            vram_mb = torch.cuda.memory_allocated() / 1024**2
            print(
                f"[✓] Second-Pass Model [{info['name']}] loaded in {cost_ms:.1f}ms "
                f"(GPU VRAM allocated: {vram_mb:.1f} MB)\n"
            )
        else:
            print(f"[✓] Second-Pass Model [{info['name']}] loaded in {cost_ms:.1f}ms\n")

    def transcribe(self, samples: np.ndarray, sample_rate: int = 16000) -> str:
        if self.current_engine is None:
            raise RuntimeError("No second-pass model loaded.")

        info = AVAILABLE_MODELS[self.loaded_engine_model_id]

        if info["engine"] == "sherpa-onnx":
            stream = self.current_engine.create_stream()
            stream.accept_waveform(sample_rate, samples)
            self.current_engine.decode_stream(stream)
            return stream.result.text.strip()

        if info["engine"] == "faster-whisper":
            segments, _ = self.current_engine.transcribe(
                samples,
                language="zh" if "kotoba" not in self.loaded_engine_model_id else "ja",
                beam_size=1,
                temperature=0.0,
                vad_filter=True,
            )
            return "".join(seg.text.strip() for seg in segments).strip()

        if info["engine"] == "qwen-asr":
            results = self.current_engine.transcribe(
                (samples, sample_rate),
                language=None,
            )
            if results:
                raw_text = results[0].text.strip()
                tr_map = str.maketrans(
                    {
                        "開": "开",
                        "關": "关",
                        "點": "点",
                        "間": "间",
                        "話": "话",
                        "語": "语",
                        "寫": "写",
                        "錄": "录",
                        "電": "电",
                        "腦": "脑",
                        "們": "们",
                        "個": "个",
                        "時": "时",
                        "會": "会",
                        "後": "后",
                        "聽": "听",
                        "說": "说",
                        "來": "来",
                        "對": "对",
                        "進": "进",
                        "國": "国",
                        "學": "学",
                        "發": "发",
                        "經": "经",
                        "過": "过",
                        "樣": "样",
                        "這": "这",
                        "還": "还",
                        "動": "动",
                        "現": "现",
                    }
                )
                return raw_text.translate(tr_map)

        return ""


# =========================================================================
# Second-Pass Inference Scheduler (Semaphore & Error Fallback Guard)
# =========================================================================

@dataclass
class FinalJob:
    session_epoch: int
    segment_id: str
    model_id: str
    samples: np.ndarray
    sample_rate: int = 16000
    fallback_text: str = ""

@dataclass
class FinalResult:
    session_epoch: int
    segment_id: str
    text: str
    model_id: str
    cost_ms: float
    final_source: str  # 'second_pass' | 'streaming_fallback'


class OfflineInferenceScheduler:
    def __init__(self, model_mgr: ModelManager):
        self.model_mgr = model_mgr
        self.semaphore = asyncio.Semaphore(1)

    async def execute_job(self, job: FinalJob) -> FinalResult:
        async with self.semaphore:
            t0 = time.perf_counter()
            try:
                # 确保当前 engine 实例加载了 job 所请求的模型（不覆盖 user selected_model_id）
                if self.model_mgr.loaded_engine_model_id != job.model_id:
                    await asyncio.to_thread(self.model_mgr.load_engine, job.model_id)

                # 在后台线程执行推理，不阻塞 asyncio 事件循环
                text = await asyncio.to_thread(
                    self.model_mgr.transcribe, job.samples, job.sample_rate
                )
                cost_ms = (time.perf_counter() - t0) * 1000
                final_text = text.strip() if text else job.fallback_text.strip()
                source = "second_pass" if text and text.strip() else "streaming_fallback"

                return FinalResult(
                    session_epoch=job.session_epoch,
                    segment_id=job.segment_id,
                    text=final_text,
                    model_id=job.model_id,
                    cost_ms=cost_ms,
                    final_source=source,
                )
            except Exception as e:
                cost_ms = (time.perf_counter() - t0) * 1000
                print(f"[!] Second-Pass Inference error for {job.segment_id}: {e}", file=sys.stderr)
                return FinalResult(
                    session_epoch=job.session_epoch,
                    segment_id=job.segment_id,
                    text=job.fallback_text.strip(),
                    model_id=job.model_id,
                    cost_ms=cost_ms,
                    final_source="streaming_fallback",
                )


# =========================================================================
# FastAPI Application & WebSocket Stream Endpoint
# =========================================================================

streaming_engine = StreamingEngine()
model_manager = ModelManager()
inference_scheduler = OfflineInferenceScheduler(model_manager)

app = FastAPI(title="SmartVoiceListener Two-Pass ASR Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def get_health():
    active_info = AVAILABLE_MODELS.get(model_manager.selected_model_id, {})
    vram_info = ""
    if CUDA_AVAILABLE and torch is not None:
        vram_info = f" (GPU VRAM: {torch.cuda.memory_allocated() / 1024**2:.1f}MB)"

    return {
        "status": "ok",
        "online": True,
        "model": active_info.get("name", "Unknown") + vram_info,
        "activeModelId": model_manager.selected_model_id,
        "streamingEngineReady": streaming_engine.is_ready,
        "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
    }


@app.get("/api/models")
async def get_models():
    return {
        "models": model_manager.get_model_list(),
        "activeModelId": model_manager.selected_model_id,
        "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
    }


@app.post("/api/switch_model")
async def post_switch_model(request: Request):
    try:
        data = await request.json()
        model_id = data.get("modelId")
        if not model_id or model_id not in AVAILABLE_MODELS:
            return JSONResponse(status_code=400, content={"error": f"Invalid modelId: {model_id}"})

        previous_model = model_manager.selected_model_id

        # 保护：在 scheduler 信号量内先装载；若发生异常自动回滚重载 previous_model
        async with inference_scheduler.semaphore:
            try:
                await asyncio.to_thread(model_manager.load_engine, model_id)
                model_manager.selected_model_id = model_id
            except Exception as exc:
                print(f"[!] Failed to switch model to {model_id}, rolling back to {previous_model}: {exc}", file=sys.stderr)
                try:
                    await asyncio.to_thread(model_manager.load_engine, previous_model)
                except Exception as rb_err:
                    print(f"[!] Rollback to {previous_model} failed: {rb_err}", file=sys.stderr)
                raise exc

        active_info = AVAILABLE_MODELS[model_manager.selected_model_id]
        return {
            "success": True,
            "activeModelId": model_manager.selected_model_id,
            "modelName": active_info["name"],
        }
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


def read_wav_data(data_bytes: bytes):
    with wave.open(io.BytesIO(data_bytes), "rb") as wav_file:
        num_channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        num_frames = wav_file.getnframes()
        raw_frames = wav_file.readframes(num_frames)

        if sample_width == 2:
            samples = np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32) / 32768.0
        elif sample_width == 4:
            samples = np.frombuffer(raw_frames, dtype=np.float32)
        else:
            raise ValueError(f"Unsupported sample width: {sample_width}")

        if num_channels > 1:
            samples = samples.reshape(-1, num_channels)[:, 0]

        return samples, sample_rate


@app.post("/api/asr")
async def post_legacy_asr(request: Request, file: Optional[UploadFile] = File(None)):
    try:
        if file is not None:
            wav_bytes = await file.read()
        else:
            wav_bytes = await request.body()

        if not wav_bytes:
            return JSONResponse(status_code=400, content={"error": "No audio data received"})

        started = time.perf_counter()
        samples, sample_rate = read_wav_data(wav_bytes)

        # 保护：通过 inference_scheduler.semaphore 进行线程与模型隔离保护
        target_model = model_manager.selected_model_id
        async with inference_scheduler.semaphore:
            if model_manager.loaded_engine_model_id != target_model:
                await asyncio.to_thread(model_manager.load_engine, target_model)
            text = await asyncio.to_thread(model_manager.transcribe, samples, sample_rate)

        cost_ms = (time.perf_counter() - started) * 1000
        duration_sec = len(samples) / sample_rate

        print(
            f"[{target_model}] Legacy Recognized "
            f"({duration_sec:.2f}s audio in {cost_ms:.1f}ms): {text}"
        )

        return {
            "text": text,
            "duration": duration_sec,
            "costMs": cost_ms,
            "modelId": target_model,
        }
    except Exception as exc:
        print(f"[!] Legacy ASR Error: {exc}", file=sys.stderr)
        return JSONResponse(status_code=500, content={"error": str(exc)})


# =========================================================================
# WebSocket Full-Duplex Streaming Endpoint
# =========================================================================

@app.websocket("/api/stream")
async def websocket_stream_endpoint(ws: WebSocket):
    await ws.accept()

    stream: Optional[sherpa_onnx.OnlineStream] = streaming_engine.create_stream()
    active_segment_id: Optional[str] = None
    active_session_epoch: int = 1
    audio_chunks: List[np.ndarray] = []
    last_partial_text: str = ""
    last_revision: int = 0

    print(f"[*] WebSocket client connected: {ws.client}")

    async def run_and_send_final(job: FinalJob):
        result = await inference_scheduler.execute_job(job)
        duration_sec = len(job.samples) / job.sample_rate
        print(
            f"[✓ Final] {result.segment_id} ({duration_sec:.2f}s audio in {result.cost_ms:.1f}ms, "
            f"model: {result.model_id}, source: {result.final_source}): {result.text}"
        )
        try:
            await ws.send_json(
                {
                    "type": "final",
                    "sessionEpoch": result.session_epoch,
                    "segmentId": result.segment_id,
                    "text": result.text,
                    "modelId": result.model_id,
                    "costMs": result.cost_ms,
                    "finalSource": result.final_source,
                }
            )
        except Exception:
            pass

    try:
        while True:
            message = await ws.receive()
            msg_type = message.get("type")

            if msg_type == "websocket.disconnect":
                break

            # 1. 文本控制帧 (JSON Frame)
            if "text" in message:
                raw_text = message["text"]
                try:
                    data = json.loads(raw_text)
                except Exception:
                    continue

                event_type = data.get("type")

                if event_type == "stream_init":
                    await ws.send_json(
                        {
                            "type": "stream_ready",
                            "protocolVersion": 1,
                            "sampleRate": 16000,
                            "streamingReady": streaming_engine.is_ready,
                            "activeModelId": model_manager.selected_model_id,
                        }
                    )

                elif event_type == "speech_start":
                    active_segment_id = data.get("segmentId", f"seg-{int(time.time()*1000)}")
                    active_session_epoch = data.get("sessionEpoch", 1)
                    audio_chunks = []
                    last_partial_text = ""
                    last_revision = 0
                    stream = streaming_engine.create_stream()

                elif event_type == "speech_end":
                    seg_id = data.get("segmentId")
                    epoch = data.get("sessionEpoch", active_session_epoch)

                    if seg_id == active_segment_id and audio_chunks:
                        sealed_audio = np.concatenate(audio_chunks)
                        captured_model = model_manager.selected_model_id
                        job = FinalJob(
                            session_epoch=epoch,
                            segment_id=seg_id,
                            model_id=captured_model,
                            samples=sealed_audio,
                            sample_rate=16000,
                            fallback_text=last_partial_text,
                        )
                        # 立即重置流式识别槽位以供下一段随时使用
                        stream = streaming_engine.create_stream()
                        active_segment_id = None
                        audio_chunks = []
                        last_partial_text = ""
                        last_revision = 0

                        # 异步调度二阶段推理，不阻塞 WebSocket 接收循环
                        asyncio.create_task(run_and_send_final(job))
                    else:
                        active_segment_id = None
                        audio_chunks = []
                        stream = streaming_engine.create_stream()

                elif event_type == "speech_cancel":
                    active_segment_id = None
                    audio_chunks = []
                    last_partial_text = ""
                    stream = streaming_engine.create_stream()

            # 2. 二进制音频数据帧 (Binary Frame: Float32 PCM 16kHz)
            elif "bytes" in message:
                raw_bytes = message["bytes"]
                if not raw_bytes or active_segment_id is None:
                    continue

                # 解析 Float32Array PCM
                if len(raw_bytes) % 4 == 0:
                    samples = np.frombuffer(raw_bytes, dtype=np.float32)
                elif len(raw_bytes) % 2 == 0:
                    samples = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                else:
                    continue

                # 1. 永远紧凑累加到二阶段音频缓存 (即便 streaming 引擎不可用也能定稿)
                audio_chunks.append(samples.copy())

                # 2. 若 Streaming 引擎就绪，喂入 OnlineRecognizer 进行增量解码
                if stream is not None and streaming_engine.is_ready:
                    stream.accept_waveform(16000, samples)
                    current_text = streaming_engine.decode_stream(stream)

                    if current_text and current_text != last_partial_text:
                        last_partial_text = current_text
                        last_revision += 1
                        await ws.send_json(
                            {
                                "type": "partial",
                                "sessionEpoch": active_session_epoch,
                                "segmentId": active_segment_id,
                                "revision": last_revision,
                                "text": current_text,
                            }
                        )

                # 防御性单段 120 秒最大时长保险（避免与前端 90s 主控竞争，纯做异常断网兜底）
                total_samples = sum(len(c) for c in audio_chunks)
                if total_samples >= 16000 * 120:
                    sealed_audio = np.concatenate(audio_chunks)
                    captured_model = model_manager.selected_model_id
                    job = FinalJob(
                        session_epoch=active_session_epoch,
                        segment_id=active_segment_id,
                        model_id=captured_model,
                        samples=sealed_audio,
                        sample_rate=16000,
                        fallback_text=last_partial_text,
                    )
                    stream = streaming_engine.create_stream()
                    active_segment_id = None
                    audio_chunks = []
                    last_partial_text = ""
                    last_revision = 0
                    asyncio.create_task(run_and_send_final(job))

    except WebSocketDisconnect:
        print(f"[*] WebSocket client disconnected: {ws.client}")
    except Exception as e:
        print(f"[!] WebSocket error: {e}", file=sys.stderr)
    finally:
        audio_chunks.clear()
        stream = None


def run_server(host=SERVER_HOST, port=SERVER_PORT):
    print(f"[*] SmartVoiceListener Two-Pass Server running on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    run_server()
