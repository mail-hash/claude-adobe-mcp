"""Offset of each audio file relative to the first, by FFT cross-correlation of their envelopes.
Usage: python sync_audio.py ref.wav other1.wav [other2.wav ...]   (mono WAV, same sample rate, PCM 16-bit)
Prints JSON: {"sampleRate": n, "results": [{"file", "offsetSeconds", "confidence"}]}  (offset > 0: file starts later than ref)
"""
import json, sys, wave
import numpy as np

def load(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate(); n = w.getnframes(); ch = w.getnchannels(); sw = w.getsampwidth()
        raw = w.readframes(n)
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if ch > 1: x = x.reshape(-1, ch).mean(axis=1)
    x -= x.mean()
    if x.std() > 0: x /= x.std()
    return sr, x

def envelope(x, sr, hop_ms=5):
    hop = max(1, int(sr * hop_ms / 1000))
    n = len(x) // hop
    e = np.abs(x[: n * hop]).reshape(n, hop).mean(axis=1)
    e = np.log1p(e * 10)
    e -= e.mean()
    return e, sr / hop

def xcorr_offset(a, b, fs, max_lag_s):
    n = len(a) + len(b) - 1
    nfft = 1 << (n - 1).bit_length()
    A = np.fft.rfft(a, nfft); B = np.fft.rfft(b, nfft)
    c = np.fft.irfft(A * np.conj(B), nfft)
    lags = np.concatenate([np.arange(0, len(a)), np.arange(-len(b) + 1, 0)])
    c = np.concatenate([c[: len(a)], c[nfft - len(b) + 1 :]])
    max_lag = int(max_lag_s * fs)
    keep = np.abs(lags) <= max_lag
    c, lags = c[keep], lags[keep]
    i = int(np.argmax(c))
    peak = c[i]; rest = np.delete(c, i)
    conf = float(peak / (np.abs(rest).mean() + 1e-9)) if len(rest) else 0.0
    # lag L means a[t] ~ b[t - L]: b is delayed by L relative to a → b starts L later in a's timeline
    return lags[i] / fs, conf

def main():
    files = sys.argv[1:]
    max_lag = float(next((f.split("=")[1] for f in files if f.startswith("--max-lag=")), 600))
    files = [f for f in files if not f.startswith("--")]
    sr0, ref = load(files[0]); e0, fs = envelope(ref, sr0)
    results = [{"file": files[0], "offsetSeconds": 0.0, "confidence": None}]
    for f in files[1:]:
        sr, x = load(f)
        if sr != sr0: raise SystemExit(f"sample rate mismatch: {f}")
        e, _ = envelope(x, sr)
        lag, conf = xcorr_offset(e0, e, fs, max_lag)
        results.append({"file": f, "offsetSeconds": round(-float(lag), 4), "confidence": round(conf, 2)})
    print(json.dumps({"sampleRate": sr0, "envelopeRate": fs, "results": results}))

if __name__ == "__main__":
    main()
