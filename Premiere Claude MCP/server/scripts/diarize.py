"""Who is speaking: label every word of a pr_transcribe JSON with a speaker, using ECAPA-TDNN speaker embeddings
(speechbrain/spkrec-ecapa-voxceleb, public, no token) clustered with agglomerative clustering (cosine, average linkage).
Usage: python diarize.py transcript.json audio-16k.wav [--speakers=N] [--min-speakers=1] [--max-speakers=6]
       [--threshold=0.75] [--window=1.5] [--hop=0.5] [--min-turn=0.6] [--offset=0] [--device=cpu]
--offset: seconds to subtract from the transcript's times to land on the WAV (a sequence transcribed from in_seconds).
Prints one JSON line: {"wordSpeakers": [..per word..], "speakers": {...}, "windows": n, "clustering": {...}}
Word times are read from the transcript in the same time base as the WAV (its "source"), so sequence-mode and media-mode
transcripts both work as long as the WAV is the one they were made from.
"""
import json, sys, wave, os, time, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import numpy as np


def arg(name, default):
    for a in sys.argv[3:]:
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return default


def load_wav(path):
    with wave.open(path, "rb") as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float32) / float(2 ** (8 * sw - 1))
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return sr, x


def main():
    t0 = time.time()
    tr = json.load(open(sys.argv[1]))
    sr, audio = load_wav(sys.argv[2])
    n_speakers = int(arg("speakers", 0) or 0)
    min_spk, max_spk = int(arg("min-speakers", 1)), int(arg("max-speakers", 6))
    threshold, W, H = float(arg("threshold", 0.75)), float(arg("window", 1.5)), float(arg("hop", 0.5))
    offset = float(arg("offset", 0))
    min_turn, device = float(arg("min-turn", 0.6)), arg("device", "cpu")
    words = tr.get("words") or []
    times = [(max(0.0, float(w["start"]["seconds"]) - offset), max(0.0, float(w["end"]["seconds"]) - offset)) for w in words]
    if not words:
        print(json.dumps({"wordSpeakers": [], "speakers": {}, "windows": 0, "clustering": {"note": "no words"}}))
        return

    # speech runs: consecutive words with gaps under 0.5 s; windows of W seconds every H seconds inside each run
    runs, cur = [], [0]
    for i in range(1, len(words)):
        if times[i][0] - times[i - 1][1] > 0.5:
            runs.append(cur); cur = []
        cur.append(i)
    runs.append(cur)
    dur = len(audio) / sr
    windows = []  # (start, end)
    for r in runs:
        s, e = times[r[0]][0], times[r[-1]][1]
        if e - s <= W:
            c = (s + e) / 2; half = max(0.4, (e - s) / 2)
            windows.append((max(0.0, c - half), min(dur, c + half)))
        else:
            t = s
            while t + W <= e + 1e-6:
                windows.append((t, t + W)); t += H
            if windows[-1][1] < e - 0.3:
                windows.append((e - W, e))

    import torch
    from speechbrain.inference.speaker import EncoderClassifier
    enc = EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", run_opts={"device": device},
                                         savedir=os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Premiere Claude Bridge", "models", "spkrec-ecapa-voxceleb"))
    t_load = time.time() - t0
    if sr != 16000:
        raise SystemExit("expected a 16 kHz WAV")
    embs = []
    for s, e in windows:
        seg = audio[int(s * sr):int(e * sr)]
        if len(seg) < int(0.3 * sr):
            seg = np.pad(seg, (0, int(0.3 * sr) - len(seg)))
        with torch.no_grad():
            v = enc.encode_batch(torch.from_numpy(seg).unsqueeze(0)).squeeze().cpu().numpy()
        embs.append(v / (np.linalg.norm(v) + 1e-9))
    X = np.stack(embs)

    from sklearn.cluster import AgglomerativeClustering
    nw = len(windows)
    if nw == 1:
        labels = np.zeros(1, dtype=int)
    elif n_speakers:
        labels = AgglomerativeClustering(n_clusters=min(n_speakers, nw), metric="cosine", linkage="average").fit_predict(X)
    else:
        labels = AgglomerativeClustering(n_clusters=None, distance_threshold=threshold, metric="cosine", linkage="average").fit_predict(X)
        k = labels.max() + 1
        if k > max_spk:
            labels = AgglomerativeClustering(n_clusters=max_spk, metric="cosine", linkage="average").fit_predict(X)
        elif k < min_spk and nw >= min_spk:
            labels = AgglomerativeClustering(n_clusters=min_spk, metric="cosine", linkage="average").fit_predict(X)
    # tiny clusters (a single window, or under 1 s of windows: usually one window straddling a turn change) fold into the
    # nearest remaining centroid
    k = labels.max() + 1
    cents = np.stack([X[labels == c].mean(axis=0) for c in range(k)])
    wdur = np.array([e - s for s, e in windows])
    small = [c for c in range(k) if ((labels == c).sum() < 2 or wdur[labels == c].sum() < 1.0) and k > 1]
    others = [o for o in range(k) if o not in small]
    if not others and small:
        others = [max(small, key=lambda c: wdur[labels == c].sum())]; small = [c for c in small if c not in others]
    for c in small:
        for i in np.where(labels == c)[0]:
            labels[i] = max(others, key=lambda o: float(X[i] @ cents[o]))
    labels = np.array([sorted(set(labels.tolist())).index(l) for l in labels])
    k = labels.max() + 1
    cents = np.stack([X[labels == c].mean(axis=0) for c in range(k)])
    cents /= np.linalg.norm(cents, axis=1, keepdims=True) + 1e-9

    # words: overlap-weighted vote of the windows that cover them, else the nearest window centre
    ws = np.array([s for s, e in windows]); we = np.array([e for s, e in windows])
    word_lab, word_conf = [], []
    for (s, e) in times:
        ov = np.clip(np.minimum(we, e) - np.maximum(ws, s), 0, None)
        if ov.sum() <= 0:
            c = (s + e) / 2; i = int(np.argmin(np.abs((ws + we) / 2 - c))); ov = np.zeros(nw); ov[i] = 1.0
        votes = np.zeros(k)
        for i in np.where(ov > 0)[0]:
            votes[labels[i]] += ov[i]
        lab = int(np.argmax(votes)); word_lab.append(lab); word_conf.append(float(votes[lab] / votes.sum()))
    # smoothing: inside a speech run, a stretch of another speaker shorter than min_turn between two stretches of the
    # same speaker takes that speaker (window edges straddle turn changes)
    for r in runs:
        changed = True
        while changed:
            changed = False
            i = 0
            while i < len(r):
                j = i
                while j + 1 < len(r) and word_lab[r[j + 1]] == word_lab[r[i]]:
                    j += 1
                span = times[r[j]][1] - times[r[i]][0]
                prev = word_lab[r[i - 1]] if i > 0 else None
                nxt = word_lab[r[j + 1]] if j + 1 < len(r) else None
                if span < min_turn and prev is not None and nxt is not None and prev == nxt and prev != word_lab[r[i]]:
                    for q in range(i, j + 1): word_lab[r[q]] = prev
                    changed = True
                i = j + 1
    # relabel by talk time (S1 = the most), dropping clusters that ended up with no words after the vote and smoothing
    talk = np.zeros(k)
    for i, (s, e) in enumerate(times): talk[word_lab[i]] += e - s
    ids = sorted([c for c in range(k) if talk[c] > 0], key=lambda c: -talk[c])
    remap = {c: i for i, c in enumerate(ids)}
    word_lab = [remap[l] for l in word_lab]
    labels = np.array([remap.get(l, -1) for l in labels])
    k = len(ids); cents = cents[ids]
    names = ["S%d" % (c + 1) for c in range(k)]
    out_words = [{"speaker": names[l], "confidence": round(c, 2)} for l, c in zip(word_lab, word_conf)]
    # totals per speaker from word times (plus intra-turn gaps)
    totals = {n: {"seconds": 0.0, "words": 0, "turns": 0} for n in names}
    prev = None
    for i, (s, e) in enumerate(times):
        n = names[word_lab[i]]
        totals[n]["words"] += 1
        gap = s - times[i - 1][1] if i > 0 and prev == n and s - times[i - 1][1] < 0.5 else 0.0
        totals[n]["seconds"] += (e - s) + gap
        if n != prev: totals[n]["turns"] += 1
        prev = n
    total = sum(v["seconds"] for v in totals.values()) or 1.0
    for v in totals.values():
        v["seconds"] = round(v["seconds"], 2); v["share"] = round(v["seconds"] / total, 3)
    # cluster separation: cosine distance between centroids, and the mean within-cluster distance
    sep = [[round(float(1 - cents[a] @ cents[b]), 3) for b in range(k)] for a in range(k)]
    within = [round(float(np.mean([1 - X[i] @ cents[c] for i in np.where(labels == c)[0]])), 3) for c in range(k)]
    print(json.dumps({"wordSpeakers": out_words, "speakers": totals, "windows": nw, "windowLabels": [names[l] if l >= 0 else None for l in labels],
                      "windowTimes": [[round(s, 2), round(e, 2)] for s, e in windows],
                      "clustering": {"method": "ecapa-tdnn + agglomerative(cosine, average)", "requestedSpeakers": n_speakers or None,
                                     "distanceThreshold": None if n_speakers else threshold, "found": k, "centroidDistances": sep, "withinClusterDistance": within,
                                     "windowSeconds": W, "hopSeconds": H, "minTurnSeconds": min_turn},
                      "timing": {"modelLoad": round(t_load, 1), "total": round(time.time() - t0, 1)}}))


if __name__ == "__main__":
    main()
