"""Where is the on-screen person looking: head yaw / pitch / roll per sampled frame with MediaPipe Face Landmarker
(facial transformation matrix) plus an iris-offset eye estimate, and an on-lens / off-lens call with a confidence.
Usage: python gaze.py video.mp4 --ffmpeg=/opt/homebrew/bin/ffmpeg [--step=0.5] [--start=0] [--end=0] [--width=640]
       [--yaw=20] [--pitch=20] [--eye=0.35] [--model=~/Library/.../face_landmarker.task]
Prints one JSON line: {"samples": [[t, yaw, pitch, roll, eyeH, eyeV, onLens(0/1/-1), confidence], ...], "fps": sampled rate, ...}
Yaw > 0: the face is turned toward the camera's right (the viewer's right); pitch > 0: looking up. eyeH > 0: eyes toward the
viewer's right, eyeV > 0: up. "lens" = |yaw| <= yaw threshold and |pitch| <= pitch threshold and |eyeH| <= eye threshold.
onLens -1 = no face found. Confidence 0..1 = how far the pose sits from the thresholds (0 at the threshold, 1 at 10 deg / 0.2 away).
"""
import json, sys, os, subprocess, tempfile, glob, math, time, urllib.request, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault("GLOG_minloglevel", "2")
import numpy as np

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def arg(name, default):
    for a in sys.argv[2:]:
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return default


def euler_from_matrix(m):
    # m: 4x4 facial transformation matrix (canonical face → camera). Rotation R = m[:3,:3]. Camera looks down -Z, +Y up, +X right.
    R = np.array(m)[:3, :3]
    # yaw about Y, pitch about X, roll about Z (Y-X-Z Tait-Bryan). Signs checked against the 2D landmarks over 100 frames of a
    # talking head: yaw correlates +0.98 with the nose tip moving to the image's right, and asin(-R[1,2]) correlates +0.77 with
    # the nose tip moving DOWN the image, so it is negated here to make pitch > 0 = looking up.
    yaw = math.degrees(math.atan2(R[0, 2], R[2, 2]))
    pitch = -math.degrees(math.asin(max(-1.0, min(1.0, -R[1, 2]))))
    roll = math.degrees(math.atan2(R[1, 0], R[1, 1]))
    return yaw, pitch, roll


def main():
    t0 = time.time()
    video = sys.argv[1]
    ffmpeg, step = arg("ffmpeg", "ffmpeg"), float(arg("step", 0.5))
    start, end, width = float(arg("start", 0)), float(arg("end", 0)), int(arg("width", 640))
    yaw_t, pitch_t, eye_t = float(arg("yaw", 20)), float(arg("pitch", 20)), float(arg("eye", 0.35))
    model = os.path.expanduser(arg("model", "~/Library/Application Support/Premiere Claude Bridge/models/face_landmarker.task"))
    if not os.path.exists(model):
        os.makedirs(os.path.dirname(model), exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, model)
    tmp = tempfile.mkdtemp(prefix="gaze-")
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-nostdin"]
    if start: cmd += ["-ss", str(start)]
    cmd += ["-i", video]
    if end: cmd += ["-t", str(max(0.0, end - start))]
    cmd += ["-vf", "fps=%s,scale=%d:-2" % (repr(1.0 / step), width), "-q:v", "3", os.path.join(tmp, "f%06d.jpg")]
    subprocess.run(cmd, check=True)
    frames = sorted(glob.glob(os.path.join(tmp, "f*.jpg")))
    import mediapipe as mp
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision
    opts = vision.FaceLandmarkerOptions(base_options=mpp.BaseOptions(model_asset_path=model), output_facial_transformation_matrixes=True,
                                        num_faces=1, running_mode=vision.RunningMode.IMAGE)
    lm = vision.FaceLandmarker.create_from_options(opts)
    samples = []
    for i, f in enumerate(frames):
        t = round(start + i * step, 3)
        img = mp.Image.create_from_file(f)
        res = lm.detect(img)
        if not res.face_landmarks:
            samples.append([t, None, None, None, None, None, -1, 0.0]); continue
        yaw, pitch, roll = euler_from_matrix(res.facial_transformation_matrixes[0])
        pts = res.face_landmarks[0]
        # iris offset inside each eye: 0 = centred; +: toward the image's right (viewer's right); vertical +: up
        def eye(inner, outer, top, bottom, iris):
            cx = (pts[inner].x + pts[outer].x) / 2; w = abs(pts[outer].x - pts[inner].x) or 1e-6
            cy = (pts[top].y + pts[bottom].y) / 2; h = abs(pts[bottom].y - pts[top].y)
            if h < 0.15 * w:   # lid nearly closed (blink): no vertical reading
                return (pts[iris].x - cx) / w, None
            return (pts[iris].x - cx) / w, -(pts[iris].y - cy) / h
        r_h, r_v = eye(133, 33, 159, 145, 468)     # subject's right eye (image left)
        l_h, l_v = eye(362, 263, 386, 374, 473)    # subject's left eye (image right)
        clamp = lambda v: max(-1.0, min(1.0, v))
        # iris offset scaled so ±1 is the eye corner; ~0.35 is clearly looking sideways
        eye_h = round(clamp((r_h + l_h)), 3)
        vs = [v for v in (r_v, l_v) if v is not None]
        eye_v = round(clamp(sum(vs) / len(vs) * 2), 3) if vs else None
        margins = [yaw_t - abs(yaw), pitch_t - abs(pitch), (eye_t - abs(eye_h)) * 50]   # eye units → "degrees" (0.2 ≈ 10°)
        m = min(margins)
        on = 1 if m >= 0 else 0
        conf = min(1.0, abs(m) / 10.0)
        samples.append([t, round(yaw, 1), round(pitch, 1), round(roll, 1), eye_h, eye_v, on, round(conf, 2)])
        os.remove(f)
    try: os.rmdir(tmp)
    except OSError: pass
    faces = [s for s in samples if s[6] >= 0]
    yaws = [s[1] for s in faces]; pitches = [s[2] for s in faces]
    pct = lambda xs, q: (round(float(np.percentile(xs, q)), 1) if xs else None)
    print(json.dumps({"samples": samples, "step": step, "count": len(samples), "faces": len(faces),
                      "lens": sum(1 for s in faces if s[6] == 1), "away": sum(1 for s in faces if s[6] == 0),
                      "thresholds": {"yaw": yaw_t, "pitch": pitch_t, "eye": eye_t},
                      "distribution": {"yaw": {"p10": pct(yaws, 10), "p50": pct(yaws, 50), "p90": pct(yaws, 90)},
                                       "pitch": {"p10": pct(pitches, 10), "p50": pct(pitches, 50), "p90": pct(pitches, 90)},
                                       "absYawBuckets": {"0-10": sum(1 for y in yaws if abs(y) < 10), "10-20": sum(1 for y in yaws if 10 <= abs(y) < 20),
                                                         "20-35": sum(1 for y in yaws if 20 <= abs(y) < 35), "35+": sum(1 for y in yaws if abs(y) >= 35)}},
                      "timing": round(time.time() - t0, 1)}))


if __name__ == "__main__":
    main()
