#!/usr/bin/env python3
"""
VI Iraq – face paste without AI: puts the REAL faces of a source picture (e.g. the approved high-resolution couple
picture) onto the same people in a target picture (e.g. the same couple in a new place, where the model redrew and
softened the faces).

  /opt/vi-iraq-py/bin/python tools/face-paste.py <target.jpg> <source.jpg> <out.jpg> [--people 0,1]

People are matched left → right in both pictures. Each source face is moved onto the target face with one similarity
transform (shift + turn + uniform scale) fitted to all 478 MediaPipe landmarks – the face itself is never reshaped –
its colours are matched to the target's light, and only the inner face (the landmark outline, eroded and feathered,
so the target's own jaw line, ears and hair stay) is blended in.
"""
import argparse, os, sys
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proportions import measure  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("target"); ap.add_argument("source"); ap.add_argument("output")
ap.add_argument("--people", default="")
a = ap.parse_args()

tgt, src = cv2.imread(a.target), cv2.imread(a.source)
if tgt is None or src is None:
    sys.exit("cannot read the pictures")
T, S = measure(a.target)["people"], measure(a.source)["people"]
which = [int(x) for x in a.people.split(",") if x != ""] or list(range(min(len(T), len(S))))
h, w = tgt.shape[:2]
out = tgt.astype(np.float32)
for i in which:
    if i >= len(T) or i >= len(S):
        sys.exit(f"person {i} not found in both pictures ({len(T)} / {len(S)} faces)")
    tp, sp = np.float32(T[i]["points"]), np.float32(S[i]["points"])
    M, _ = cv2.estimateAffinePartial2D(sp, tp, method=cv2.LMEDS)
    warped = cv2.warpAffine(src, M, (w, h), flags=cv2.INTER_AREA if abs(M[0, 0]) < 1 else cv2.INTER_LANCZOS4,
                            borderMode=cv2.BORDER_REFLECT).astype(np.float32)
    fw = T[i]["face_w"]
    mask = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(tp.astype(np.int32)), 255)
    mask = cv2.erode(mask, np.ones((int(fw * 0.07) | 1,) * 2, np.uint8))
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255, (0, 0), max(2.0, fw * 0.035))[..., None]
    # colour match in Lab inside the face: the source face takes the target's light and colour
    inside = mask > 0
    tl = cv2.cvtColor(tgt, cv2.COLOR_BGR2LAB).astype(np.float32)
    wl = cv2.cvtColor(np.clip(warped, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    for c in range(3):
        ts, ws = tl[..., c][inside], wl[..., c][inside]
        wl[..., c] = (wl[..., c] - ws.mean()) * (ts.std() / max(ws.std(), 1e-3)) + ts.mean()
    warped = cv2.cvtColor(np.clip(wl, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR).astype(np.float32)
    out = out * (1 - alpha) + warped * alpha
    print(f"person {i}: scale {np.hypot(M[0, 0], M[1, 0]):.3f}, face {int(fw)} px wide")
cv2.imwrite(a.output, np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 96])
