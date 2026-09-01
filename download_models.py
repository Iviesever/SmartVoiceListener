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

# 1. 检查本地原版 SenseVoiceSmall (D:\resource\AI_WorkSpace\Models\SenseVoiceSmall)
local_sensevoice_dir = Path(r"D:\resource\AI_WorkSpace\Models\SenseVoiceSmall")
local_sensevoice_ok = (
    local_sensevoice_dir.exists()
    and (local_sensevoice_dir / "model.pt").exists()
    and (local_sensevoice_dir / "config.yaml").exists()
)

if not local_sensevoice_ok:
    print(f"[-] Warning: Local SenseVoiceSmall not found at {local_sensevoice_dir}")
else:
    print(f"[✓] Local SenseVoiceSmall found at {local_sensevoice_dir}")

# 2. 下载 Streaming Paraformer INT8 模型 (用于 First-Pass 实时流式增量识别)
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

paraformer_ok = paraformer_encoder.exists() and paraformer_decoder.exists() and paraformer_tokens.exists()

if not paraformer_ok:
    print("[!] ERROR: Streaming Paraformer model files are incomplete!", file=sys.stderr)
    sys.exit(1)

sys.exit(0)
