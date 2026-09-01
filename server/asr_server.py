import io
import os
import sys
import gc
import time
import wave
import json
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse
import numpy as np

# 导入 GPU 依赖
try:
    import torch
    CUDA_AVAILABLE = torch.cuda.is_available()
    GPU_NAME = torch.cuda.get_device_name(0) if CUDA_AVAILABLE else "None"
except Exception:
    torch = None
    CUDA_AVAILABLE = False
    GPU_NAME = "None"

import sherpa_onnx
from faster_whisper import WhisperModel

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
EXTERNAL_MODELS_DIR = Path(r"D:\resource\AI_WorkSpace\Models")

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

print(f"[*] Hardware Acceleration Status: CUDA={CUDA_AVAILABLE} (GPU: {GPU_NAME})")

# 模型注册表配置
AVAILABLE_MODELS = {
    "sensevoice-onnx": {
        "id": "sensevoice-onnx",
        "name": "SenseVoice (sherpa-onnx INT8 极速)",
        "engine": "sherpa-onnx",
        "type": "毫秒极速 / 低功耗",
        "desc": "毫秒级响应，中文普通话/口语/标点极佳，适合日常监听 (跨平台通用)",
        "path": MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    },
    "qwen3-asr-1.7b": {
        "id": "qwen3-asr-1.7b",
        "name": "Qwen3-ASR 1.7B (通义千问 RTX 4070 GPU加速)",
        "engine": "qwen-asr",
        "type": "阿里旗舰 1.7B (GPU加速)",
        "desc": f"阿里通义千问 2024 最新 1.7B 语音大模型 (运行在 {GPU_NAME})",
        "path": EXTERNAL_MODELS_DIR / "Qwen3-ASR-1.7B",
        "repo_id": "Qwen/Qwen3-ASR-1.7B",
    },
    "whisper-large-v3": {
        "id": "whisper-large-v3",
        "name": "Whisper large-v3 (RTX 4070 GPU加速)",
        "engine": "faster-whisper",
        "type": "最高精度 (GPU加速)",
        "desc": f"OpenAI 旗舰大模型，专业术语与复杂长句识别天花板 (运行在 {GPU_NAME})",
        "path": EXTERNAL_MODELS_DIR / "large-v3",
    },
    "kotoba-v2-faster": {
        "id": "kotoba-v2-faster",
        "name": "Kotoba-v2-faster (日文/双语 GPU加速)",
        "engine": "faster-whisper",
        "type": "蒸馏高精 (GPU加速)",
        "desc": "专注日文/二次元及高精度语音转写",
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
        for mid, info in AVAILABLE_MODELS.items():
            path_exists = info["path"].exists()
            result.append({
                "id": mid,
                "name": info["name"],
                "engine": info["engine"],
                "type": info["type"],
                "desc": info["desc"],
                "available": path_exists,
                "isActive": (mid == self.active_model_id),
                "gpu": CUDA_AVAILABLE,
            })
        return result

    def load_model(self, model_id: str):
        if model_id not in AVAILABLE_MODELS:
            raise ValueError(f"Unknown model_id: {model_id}")

        info = AVAILABLE_MODELS[model_id]
        if self.current_model_id == model_id and self.current_engine is not None:
            return

        print(f"\n[*] Switching ASR Model -> [{info['name']}] (Engine: {info['engine']}, GPU: {CUDA_AVAILABLE})...")
        t0 = time.perf_counter()

        # 释放旧模型资源并彻底清空 GPU 显存
        self.current_engine = None
        gc.collect()
        if CUDA_AVAILABLE and torch is not None:
            torch.cuda.empty_cache()

        if info["engine"] == "sherpa-onnx":
            model_file = info["path"] / "model.int8.onnx"
            if not model_file.exists():
                model_file = info["path"] / "model.onnx"
            tokens_file = info["path"] / "tokens.txt"

            self.current_engine = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(model_file),
                tokens=str(tokens_file),
                num_threads=4,
                use_itn=True,
                language="auto",
            )

        elif info["engine"] == "faster-whisper":
            self.current_engine = WhisperModel(
                str(info["path"]),
                device="cuda" if CUDA_AVAILABLE else "cpu",
                compute_type="float16" if CUDA_AVAILABLE else "int8",
                cpu_threads=4,
            )

        elif info["engine"] == "qwen-asr":
            from qwen_asr import Qwen3ASRModel
            load_target = str(info["path"]) if info["path"].exists() else info.get("repo_id", "Qwen/Qwen3-ASR-1.7B")
            print(f"    Loading Qwen3-ASR into GPU from: {load_target} ...")
            self.current_engine = Qwen3ASRModel.from_pretrained(
                load_target,
                device_map="cuda:0" if CUDA_AVAILABLE else "cpu",
            )

        self.current_model_id = model_id
        self.active_model_id = model_id
        cost = (time.perf_counter() - t0) * 1000

        if CUDA_AVAILABLE and torch is not None:
            vram_mb = torch.cuda.memory_allocated() / 1024**2
            print(f"[✓] Model [{info['name']}] loaded in {cost:.1f}ms! (GPU VRAM Allocated: {vram_mb:.1f} MB)\n")
        else:
            print(f"[✓] Model [{info['name']}] loaded in {cost:.1f}ms!\n")

    def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        if self.current_engine is None:
            raise RuntimeError("No model engine loaded.")

        info = AVAILABLE_MODELS[self.active_model_id]

        if info["engine"] == "sherpa-onnx":
            stream = self.current_engine.create_stream()
            stream.accept_waveform(sample_rate, samples)
            self.current_engine.decode_stream(stream)
            return stream.result.text.strip()

        elif info["engine"] == "faster-whisper":
            segments, _ = self.current_engine.transcribe(
                samples,
                language="zh" if "kotoba" not in self.active_model_id else "ja",
                beam_size=1,
                temperature=0.0,
                vad_filter=True,
            )
            texts = [seg.text.strip() for seg in segments]
            return "".join(texts).strip()

        elif info["engine"] == "qwen-asr":
            results = self.current_engine.transcribe(
                (samples, sample_rate),
                language=None,
            )
            if results and len(results) > 0:
                raw_text = results[0].text.strip()
                # 简单高效的常用繁体转简体映射处理
                tr_map = str.maketrans({
                    '開': '开', '關': '关', '點': '点', '間': '间', '話': '话',
                    '語': '语', '寫': '写', '錄': '录', '電': '电', '腦': '脑',
                    '們': '们', '個': '个', '時': '时', '會': '会', '後': '后',
                    '聽': '听', '說': '说', '來': '来', '對': '对', '進': '进',
                    '國': '国', '學': '学', '發': '发', '經': '经', '過': '过',
                    '樣': '样', '這': '这', '還': '还', '動': '动', '現': '现'
                })
                return raw_text.translate(tr_map)

        return ""

model_manager = ModelManager()

def read_wav_data(data_bytes):
    with wave.open(io.BytesIO(data_bytes), "rb") as wf:
        num_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        num_frames = wf.getnframes()
        raw_frames = wf.readframes(num_frames)

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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.end_headers()
            active_info = AVAILABLE_MODELS.get(model_manager.active_model_id, {})
            vram_info = ""
            if CUDA_AVAILABLE and torch is not None:
                vram_info = f" (GPU VRAM: {torch.cuda.memory_allocated() / 1024**2:.1f}MB)"

            resp = json.dumps({
                "status": "ok",
                "online": True,
                "model": active_info.get("name", "Unknown") + vram_info,
                "activeModelId": model_manager.active_model_id,
                "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
            })
            self.wfile.write(resp.encode("utf-8"))

        elif parsed.path == "/api/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.end_headers()
            resp = json.dumps({
                "models": model_manager.get_model_list(),
                "activeModelId": model_manager.active_model_id,
                "gpu": GPU_NAME if CUDA_AVAILABLE else "CPU",
            })
            self.wfile.write(resp.encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if parsed.path == "/api/switch_model":
            try:
                data = json.loads(body.decode("utf-8"))
                model_id = data.get("modelId")
                model_manager.load_model(model_id)

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self._send_cors_headers()
                self.end_headers()
                active_info = AVAILABLE_MODELS[model_manager.active_model_id]
                self.wfile.write(json.dumps({
                    "success": True,
                    "activeModelId": model_manager.active_model_id,
                    "modelName": active_info["name"],
                }).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

        elif parsed.path == "/api/asr":
            try:
                content_type = self.headers.get("Content-Type", "")
                wav_bytes = None
                if "multipart/form-data" in content_type:
                    boundary = content_type.split("boundary=")[-1].strip().encode("utf-8")
                    parts = body.split(b"--" + boundary)
                    for part in parts:
                        if b'filename="' in part:
                            header_end = part.find(b"\r\n\r\n")
                            if header_end != -1:
                                wav_bytes = part[header_end + 4:].rstrip(b"\r\n")
                                break
                else:
                    wav_bytes = body

                if not wav_bytes:
                    self.send_response(400)
                    self._send_cors_headers()
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No audio data received"}).encode("utf-8"))
                    return

                t0 = time.perf_counter()
                samples, sample_rate = read_wav_data(wav_bytes)
                text = model_manager.transcribe(samples, sample_rate)
                t1 = time.perf_counter()

                duration_sec = len(samples) / sample_rate
                cost_ms = (t1 - t0) * 1000
                print(f"[{model_manager.active_model_id} - GPU] Recognized ({duration_sec:.2f}s audio in {cost_ms:.1f}ms): {text}")

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({
                    "text": text,
                    "duration": duration_sec,
                    "costMs": cost_ms,
                    "modelId": model_manager.active_model_id,
                }).encode("utf-8"))

            except Exception as e:
                print(f"[!] ASR Error: {e}", file=sys.stderr)
                self.send_response(500)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

def run_server(port=8767):
    server = HTTPServer(("0.0.0.0", port), AsrHandler)
    print(f"[*] SmartVoiceListener GPU-Accelerated Server running at http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server...")
        server.server_close()

if __name__ == "__main__":
    run_server()
