import os
import sys
import tarfile
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(exist_ok=True)

def download_file(url, target_path):
    print(f"[*] Downloading {url} -> {target_path} ...")
    target_path.parent.mkdir(parents=True, exist_ok=True)
    
    def reporthook(count, block_size, total_size):
        if total_size > 0:
            percent = int(count * block_size * 100 / total_size)
            downloaded_mb = count * block_size / (1024 * 1024)
            total_mb = total_size / (1024 * 1024)
            sys.stdout.write(f"\r  Progress: {percent}% ({downloaded_mb:.1f}MB / {total_mb:.1f}MB)")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, target_path, reporthook)
    sys.stdout.write("\n")

# 1. 下载 SenseVoice ONNX 模型包 (model.int8.onnx + tokens.txt)
sensevoice_dir = MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
sensevoice_model_file = sensevoice_dir / "model.int8.onnx"
sensevoice_tokens_file = sensevoice_dir / "tokens.txt"

if not (sensevoice_model_file.exists() and sensevoice_tokens_file.exists()):
    tar_path = MODELS_DIR / "sense-voice.tar.bz2"
    sensevoice_urls = [
        "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
    ]
    for u in sensevoice_urls:
        try:
            download_file(u, tar_path)
            print("[*] Extracting SenseVoice archive...")
            with tarfile.open(tar_path, "r:bz2") as tar:
                tar.extractall(path=MODELS_DIR)
            if tar_path.exists():
                tar_path.unlink()
            print("[✓] SenseVoice extracted successfully!")
            break
        except Exception as e:
            print(f"[-] Failed with {u}: {e}")

# 2. 下载 Streaming Paraformer INT8 模型 (用于 First-Pass 实时流式识别)
paraformer_dir = MODELS_DIR / "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
paraformer_encoder = paraformer_dir / "encoder.int8.onnx"
paraformer_decoder = paraformer_dir / "decoder.int8.onnx"
paraformer_tokens = paraformer_dir / "tokens.txt"

if not (paraformer_encoder.exists() and paraformer_decoder.exists() and paraformer_tokens.exists()):
    paraformer_dir.mkdir(parents=True, exist_ok=True)
    file_map = {
        paraformer_encoder: [
            "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx",
            "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx"
        ],
        paraformer_decoder: [
            "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx",
            "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/decoder.int8.onnx"
        ],
        paraformer_tokens: [
            "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/raw/main/tokens.txt",
            "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/raw/main/tokens.txt"
        ]
    }
    headers = {"User-Agent": "Mozilla/5.0"}
    for target_path, urls in file_map.items():
        if not target_path.exists() or target_path.stat().st_size == 0:
            for u in urls:
                try:
                    print(f"[*] Downloading {u} -> {target_path} ...")
                    req = urllib.request.Request(u, headers=headers)
                    with urllib.request.urlopen(req, timeout=30) as resp, open(target_path, "wb") as f:
                        f.write(resp.read())
                    print(f"[✓] {target_path.name} ready ({target_path.stat().st_size / (1024*1024):.2f} MB)")
                    break
                except Exception as e:
                    print(f"[-] Failed with {u}: {e}")

print("\n[★] Model check complete! Model directory structure:")
for item in MODELS_DIR.rglob("*"):
    if item.is_file():
        print(f" - {item.relative_to(MODELS_DIR)} ({item.stat().st_size / (1024*1024):.2f} MB)")

if not (sensevoice_model_file.exists() and sensevoice_tokens_file.exists()):
    print("[!] ERROR: SenseVoice model files are still incomplete!", file=sys.stderr)
    sys.exit(1)

sys.exit(0)
