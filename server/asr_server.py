import gc
import io
import json
import os
import sys
import time
import urllib.parse
import wave
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np
import sherpa_onnx

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
EXTERNAL_MODELS_DIR = Path(
    os.environ.get("SMARTVOICE_MODELS_DIR", r"D:\resource\AI_WorkSpace\Models")
)
SERVER_HOST = os.environ.get("SMARTVOICE_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("SMARTVOICE_PORT", "8767"))

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# GPU 能力探测。torch 不是 SenseVoice/sherpa-onnx 最小运行路径的硬依赖。
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
        "desc": "中文普通话/口语识别，适合分段式常驻监听；当前为离线整段识别",
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


class ModelManager:
    def __init__(self):
        self.active_model_id = "sensevoice-onnx"
        self.current_engine = None
        self.current_model_id = None
        self.load_model(self.active_model_id)

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
                    "isActive": model_id == self.active_model_id,
                    "gpu": CUDA_AVAILABLE,
                }
            )
        return result

    def load_model(self, model_id: str):
        if model_id not in AVAILABLE_MODELS:
            raise ValueError(f"Unknown model_id: {model_id}")

        info = AVAILABLE_MODELS[model_id]
        if self.current_model_id == model_id and self.current_engine is not None:
            return

        if not info["path"].exists() and not info.get("repo_id"):
            raise FileNotFoundError(f"Model path does not exist: {info['path']}")

        print(
            f"\n[*] Switching ASR Model -> [{info['name']}] "
            f"(Engine: {info['engine']}, CUDA: {CUDA_AVAILABLE})..."
        )
        started = time.perf_counter()

        self.current_engine = None
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

        self.current_model_id = model_id
        self.active_model_id = model_id
        cost_ms = (time.perf_counter() - started) * 1000

        if CUDA_AVAILABLE and torch is not None:
            vram_mb = torch.cuda.memory_allocated() / 1024**2
            print(
                f"[✓] Model [{info['name']}] loaded in {cost_ms:.1f}ms "
                f"(GPU VRAM allocated: {vram_mb:.1f} MB)\n"
            )
        else:
            print(f"[✓] Model [{info['name']}] loaded in {cost_ms:.1f}ms\n")

    def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        if self.current_engine is None:
            raise RuntimeError("No model engine loaded.")

        info = AVAILABLE_MODELS[self.active_model_id]

        if info["engine"] == "sherpa-onnx":
            stream = self.current_engine.create_stream()
            stream.accept_waveform(sample_rate, samples)
            self.current_engine.decode_stream(stream)
            return stream.result.text.strip()

        if info["engine"] == "faster-whisper":
            segments, _ = self.current_engine.transcribe(
                samples,
                language="zh" if "kotoba" not in self.active_model_id else "ja",
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
                # 临时常用繁转简映射。后续应替换为完整 OpenCC/模型级 ITN 流程。
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


model_manager = ModelManager()


def read_wav_data(data_bytes):
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


class AsrHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        # 服务默认只绑定 loopback，因此允许本机浏览器开发前端跨端口访问。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status_code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/health":
            active_info = AVAILABLE_MODELS.get(model_manager.active_model_id, {})
            vram_info = ""
            if CUDA_AVAILABLE and torch is not None:
                vram_info = f" (GPU VRAM: {torch.cuda.memory_allocated() / 1024**2:.1f}MB)"

            self._send_json(
                200,
                {
                    "status": "ok",
                    "online": True,
                    "model": active_info.get("name", "Unknown") + vram_info,
                    "activeModelId": model_manager.active_model_id,
                    "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
                },
            )
            return

        if parsed.path == "/api/models":
            self._send_json(
                200,
                {
                    "models": model_manager.get_model_list(),
                    "activeModelId": model_manager.active_model_id,
                    "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
                },
            )
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if parsed.path == "/api/switch_model":
            try:
                data = json.loads(body.decode("utf-8"))
                model_id = data.get("modelId")
                model_manager.load_model(model_id)
                active_info = AVAILABLE_MODELS[model_manager.active_model_id]
                self._send_json(
                    200,
                    {
                        "success": True,
                        "activeModelId": model_manager.active_model_id,
                        "modelName": active_info["name"],
                    },
                )
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
            return

        if parsed.path == "/api/asr":
            try:
                content_type = self.headers.get("Content-Type", "")
                wav_bytes = None

                if "multipart/form-data" in content_type:
                    boundary_value = content_type.split("boundary=")[-1].strip().strip('"')
                    boundary = boundary_value.encode("utf-8")
                    parts = body.split(b"--" + boundary)
                    for part in parts:
                        if b'filename="' in part:
                            header_end = part.find(b"\r\n\r\n")
                            if header_end != -1:
                                wav_bytes = part[header_end + 4 :].rstrip(b"\r\n")
                                break
                else:
                    wav_bytes = body

                if not wav_bytes:
                    self._send_json(400, {"error": "No audio data received"})
                    return

                started = time.perf_counter()
                samples, sample_rate = read_wav_data(wav_bytes)
                text = model_manager.transcribe(samples, sample_rate)
                cost_ms = (time.perf_counter() - started) * 1000
                duration_sec = len(samples) / sample_rate

                print(
                    f"[{model_manager.active_model_id}] Recognized "
                    f"({duration_sec:.2f}s audio in {cost_ms:.1f}ms): {text}"
                )

                self._send_json(
                    200,
                    {
                        "text": text,
                        "duration": duration_sec,
                        "costMs": cost_ms,
                        "modelId": model_manager.active_model_id,
                    },
                )
            except Exception as exc:
                print(f"[!] ASR Error: {exc}", file=sys.stderr)
                self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "Not found"})


def run_server(host=SERVER_HOST, port=SERVER_PORT):
    server = HTTPServer((host, port), AsrHandler)
    print(f"[*] SmartVoiceListener ASR server running at http://{host}:{port}")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        print("[!] Warning: ASR server is exposed beyond loopback. Protect the port appropriately.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    run_server()
