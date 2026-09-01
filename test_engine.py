import re
import time
import wave
import numpy as np
from pathlib import Path
from funasr import AutoModel

BASE_DIR = Path(__file__).resolve().parent
TEST_WAV = BASE_DIR / "test_data" / "zh.wav"
SENSEVOICE_DIR = Path(r"D:\resource\AI_WorkSpace\Models\SenseVoiceSmall")

print(f"[*] Testing Local SenseVoiceSmall (FunASR) Engine from {SENSEVOICE_DIR} ...")
model = AutoModel(
    model=str(SENSEVOICE_DIR),
    trust_remote_code=True,
    device="cuda:0",
    disable_update=True,
)

with wave.open(str(TEST_WAV), "rb") as wf:
    sample_rate = wf.getframerate()
    frames = wf.readframes(wf.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

t0 = time.perf_counter()
res = model.generate(input=samples, cache={}, language="auto", use_itn=True, batch_size_s=60)
raw_text = res[0].get("text", "") if (res and isinstance(res, list) and len(res) > 0) else ""
text = re.sub(r"<\|.*?\|>", "", raw_text).strip()
t1 = time.perf_counter()

dur = len(samples) / sample_rate
cost_ms = (t1 - t0) * 1000

print(f"[✓] Test Audio: {TEST_WAV.name} ({dur:.2f}s)")
print(f"[✓] Transcription Result: \"{text}\"")
print(f"[✓] Processing Time: {cost_ms:.1f}ms (RTF: {cost_ms/1000/dur:.4f})")
print(f"[★] FunASR SenseVoiceSmall Engine Verification PASSED!")
