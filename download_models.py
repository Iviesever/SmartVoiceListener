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

# 1. 下载 Silero VAD 模型 (用于说话起止活动检测，仅约 2MB)
vad_model_path = MODELS_DIR / "silero_vad.onnx"
if not vad_model_path.exists():
    vad_urls = [
        "https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-vad-models/resolve/main/silero_vad.onnx",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
    ]
    for u in vad_urls:
        try:
            download_file(u, vad_model_path)
            if vad_model_path.stat().st_size > 1000:
                print(f"[✓] Silero VAD ready ({vad_model_path.stat().st_size / 1024:.1f} KB)")
                break
        except Exception as e:
            print(f"[-] Failed with {u}: {e}")

# 2. 下载 SenseVoice ONNX 模型包
sensevoice_dir = MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
sensevoice_model_file = sensevoice_dir / "model.int8.onnx"
if not sensevoice_model_file.exists():
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

print("\n[★] Model check complete! Model directory structure:")
for item in MODELS_DIR.rglob("*"):
    if item.is_file():
        print(f" - {item.relative_to(MODELS_DIR)} ({item.stat().st_size / (1024*1024):.2f} MB)")

