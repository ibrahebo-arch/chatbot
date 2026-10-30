#!/usr/bin/env python3
"""
VI Iraq – proportion check: measures every person in a picture and compares them with real human proportions.

  /opt/vi-iraq-py/bin/python tools/proportions.py <picture.jpg> [--people "man:183:76,woman:163"] [--json]

People are matched left → right to --people entries "<label>:<height cm>[:<weight kg>]".
For each person (MediaPipe face + pose landmarks, body outline from the pose segmentation):
  face height (forehead to chin) and width (cheek to cheek), shoulder width (joint to joint),
  body width at chest height (outline) – in pixels and as ratios.
Checks (real adults standing side by side at the same distance from the camera):
  - face size between people follows their heights: a 183 cm man's face is about 1.04–1.12× a 163 cm woman's
  - shoulder width ÷ face width: men about 2.6–3.1, women about 2.3–2.8
  - body bulk = chest outline ÷ shoulder width, judged against BMI (lean < ~1.25, heavier above)
Prints the fixes (e.g. "scale the man's head by 1.06") so a picture can be corrected to real proportions.
Models: /opt/vi-iraq-py/models/{face_landmarker,pose_landmarker_heavy}.task (MediaPipe).
"""
import argparse, json, math, os, sys
import numpy as np
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision

MODELS = os.environ.get("MP_MODELS", "/opt/vi-iraq-py/models")

def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])

def measure(path):
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"cannot read {path}")
    h, w = img.shape[:2]
    rgb = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    fl = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=f"{MODELS}/face_landmarker.task"), num_faces=6))
    pl = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=f"{MODELS}/pose_landmarker_heavy.task"), num_poses=6, output_segmentation_masks=True))
    faces = []
    for lm in fl.detect(rgb).face_landmarks:
        p = lambda i: (lm[i].x * w, lm[i].y * h)
        xs = [q.x * w for q in lm]; ys = [q.y * h for q in lm]
        faces.append({
            "center": (sum(xs) / len(xs), sum(ys) / len(ys)),
            "face_h": dist(p(10), p(152)),      # forehead (hairline area) → chin
            "face_w": dist(p(234), p(454)),     # cheek → cheek
            "box": [min(xs), min(ys), max(xs), max(ys)],
            "chin": p(152),
        })
    poses = []
    res = pl.detect(rgb)
    for k, lm in enumerate(res.pose_landmarks):
        p = lambda i: (lm[i].x * w, lm[i].y * h)
        ls, rs = p(11), p(12)
        entry = {"nose": p(0), "shoulder_w": dist(ls, rs), "shoulder_y": (ls[1] + rs[1]) / 2, "shoulder_mid_x": (ls[0] + rs[0]) / 2}
        if res.segmentation_masks and k < len(res.segmentation_masks):
            m = res.segmentation_masks[k].numpy_view()
            m = m[..., 0] if m.ndim == 3 else m
            hip_y = (lm[23].y + lm[24].y) / 2 * h if min(lm[23].visibility, lm[24].visibility) > 0.3 else None
            chest_y = int(entry["shoulder_y"] + ((hip_y - entry["shoulder_y"]) * 0.3 if hip_y else entry["shoulder_w"] * 0.45))
            chest_y = max(0, min(h - 1, chest_y))
            row = np.where(m[chest_y] > 0.5)[0]
            if row.size:
                # the run of body pixels that contains the shoulder mid-point
                mid = int(entry["shoulder_mid_x"]); runs = np.split(row, np.where(np.diff(row) != 1)[0] + 1)
                run = min(runs, key=lambda r: 0 if r[0] <= mid <= r[-1] else min(abs(r[0] - mid), abs(r[-1] - mid)))
                entry["chest_w"] = float(run[-1] - run[0] + 1)
                entry["chest_y"] = chest_y
        poses.append(entry)
    # pair each face with the pose whose nose is closest
    people = []
    for f in faces:
        best = min(poses, key=lambda q: dist(q["nose"], f["center"]), default=None)
        if best is not None and dist(best["nose"], f["center"]) > f["face_h"] * 1.2:
            best = None
        people.append({**f, **({k: v for k, v in best.items() if k != "nose"} if best else {})})
    people.sort(key=lambda q: q["center"][0])
    return {"size": [w, h], "people": people}

def bmi(height, weight):
    return weight / ((height / 100) ** 2) if height and weight else None

def check(data, spec):
    out = {"people": [], "fixes": []}
    ppl = data["people"]
    for i, q in enumerate(ppl):
        s = spec[i] if i < len(spec) else {"label": f"person {i + 1}"}
        r = {"label": s["label"], "face_h_px": round(q["face_h"]), "face_w_px": round(q["face_w"]),
             "box": [round(v) for v in q["box"]], "chin": [round(v) for v in q["chin"]]}
        # shoulders are only trusted when both are in the picture and plausibly placed (≥ 1.8 face widths apart);
        # cut-off or overlapping people give nonsense, so the body is then reported as not measurable
        shoulders_ok = "shoulder_w" in q and q["shoulder_w"] >= 1.8 * q["face_w"]
        if shoulders_ok:
            r["shoulder_w_px"] = round(q["shoulder_w"]); r["shoulder_to_face"] = round(q["shoulder_w"] / q["face_w"], 2)
            if "chest_w" in q and q["chest_w"] <= 2.0 * q["shoulder_w"]:
                r["chest_w_px"] = round(q["chest_w"]); r["bulk"] = round(q["chest_w"] / q["shoulder_w"], 2)
            else:
                r["body"] = "outline merges with someone else – not measurable"
        else:
            r["body"] = "shoulders cut off or hidden – not measurable"
        if s.get("height"): r["height_cm"] = s["height"]
        if s.get("weight"): r["weight_kg"] = s["weight"]; r["bmi"] = round(bmi(s["height"], s["weight"]), 1)
        out["people"].append(r)
    if len(ppl) >= 2 and len(spec) >= 2 and spec[0].get("height") and spec[1].get("height"):
        a, b = ppl[0], ppl[1]
        # head size grows a little with body height (about 0.4 cm of face per 10 cm of height) and men's faces are ~5 % larger
        sex = lambda s: 1.05 if s.get("sex") == "m" else 1.0
        target = (1 + (spec[0]["height"] - spec[1]["height"]) / 400) * sex(spec[0]) / sex(spec[1])
        now = (a["face_h"] / b["face_h"] + a["face_w"] / b["face_w"]) / 2
        out["face_ratio_now"] = round(now, 3); out["face_ratio_target"] = round(target, 3)
        k = target / now
        if abs(k - 1) > 0.03:
            out["fixes"].append({"what": f"scale {spec[0]['label']}'s head", "by": round(k, 3),
                                 "why": f"{spec[0]['label']}'s face is {now:.2f}× {spec[1]['label']}'s; real people of these heights ≈ {target:.2f}×"})
    for i, q in enumerate(ppl[:len(spec)]):
        s = spec[i]
        if "bulk" in (out["people"][i] or {}) and s.get("weight") and s.get("height"):
            b = bmi(s["height"], s["weight"]); bulk = out["people"][i]["bulk"]
            limit = 1.18 if b < 23 else 1.28 if b < 26 else 1.40
            if bulk > limit:
                out["fixes"].append({"what": f"slim {s['label']}'s body", "by": round(limit / bulk, 3),
                                     "why": f"chest outline is {bulk:.2f}× the shoulder joints; a BMI {b:.1f} build is ≤ {limit}"})
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("picture"); ap.add_argument("--people", default=""); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    spec = []
    for part in [x for x in a.people.split(",") if x.strip()]:
        f = part.split(":")
        spec.append({"label": f[0], "height": float(f[1]) if len(f) > 1 and f[1] else None, "weight": float(f[2]) if len(f) > 2 and f[2] else None,
                     "sex": "m" if f[0].lower() in ("man", "him", "male", "ibrahim") else "f" if f[0].lower() in ("woman", "her", "female", "vivian") else None})
    data = measure(a.picture)
    res = check(data, spec)
    if a.json:
        print(json.dumps(res))
    else:
        for r in res["people"]:
            print(" · ".join(f"{k}={v}" for k, v in r.items()))
        if "face_ratio_now" in res:
            print(f"face size {res['people'][0]['label']} ÷ {res['people'][1]['label']}: now {res['face_ratio_now']}, real {res['face_ratio_target']}")
        for f in res["fixes"]:
            print(f"FIX: {f['what']} × {f['by']} – {f['why']}")
        if not res["fixes"]:
            print("proportions look real")
