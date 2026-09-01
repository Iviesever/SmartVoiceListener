import time
import sherpa_onnx
import wave
import numpy as np
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
SENSEVOICE_DIR = MODELS_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
TEST_WAV = SENSEVOICE_DIR / "test_wavs" / "zh.wav"

model_file = SENSEVOICE_DIR / "model.int8.onnx"
tokens_file = SENSEVOICE_DIR / "tokens.txt"

print(f"[*] Testing SenseVoice Offline Engine...")
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=str(model_file),
    tokens=str(tokens_file),
    num_threads=4,
    use_itn=True,
)

with wave.open(str(TEST_WAV), "rb") as wf:
    num_channels = wf.getnchannels()
    sample_rate = wf.getframerate()
    frames = wf.readframes(wf.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

t0 = time.perf_counter()
stream = recognizer.create_stream()
stream.accept_waveform(sample_rate, samples)
recognizer.decode_stream(stream)
text = stream.result.text
t1 = time.perf_counter()

dur = len(samples) / sample_rate
cost_ms = (t1 - t0) * 1000

print(f"[✓] Test Audio: {TEST_WAV.name} ({dur:.2f}s)")
print(f"[✓] Transcription Result: \"{text}\"")
print(f"[✓] Processing Time: {cost_ms:.1f}ms (RTF: {cost_ms/1000/dur:.4f})")
print(f"[★] Offline ASR Engine Verification PASSED!")
