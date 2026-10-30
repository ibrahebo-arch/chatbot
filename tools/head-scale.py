#!/usr/bin/env python3
"""
VI Iraq – head scale without AI: makes ONE person's real head smaller or larger around the chin. Only that person's own
pixels move (hair, face, ears); the thin strip of background the smaller head
uncovers is filled from the surrounding background (OpenCV inpaint). The head outline comes from the MediaPipe
multiclass segmenter (hair + face skin + body skin), run on a crop around the head so the edge is fine. The face stays the real pixels, nothing is
invented, the background (lamps, sky, city lights) does not move, and the other people are never touched.

  /opt/vi-iraq-py/bin/python tools/head-scale.py <in.jpg> <out.jpg> --scale 0.93 [--person 0]

Typical use: proportions.py says "FIX: scale man's head × 0.93" → head-scale.py in.jpg out.jpg --scale 0.93 --person 0
(people are numbered left → right, as in proportions.py).
Needs opencv-contrib-python-headless in the venv for the texture fill (xphoto FSR); plain OpenCV falls back to a smooth fill.
"""
import argparse, json, os, sys
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proportions import measure, MODELS  # noqa: E402
import mediapipe as mp  # noqa: E402
from mediapipe.tasks import python as mpt  # noqa: E402
from mediapipe.tasks.python import vision  # noqa: E402


def head_pixels(img, box):
    """Hair + face skin + body skin (0..1) around one face, full picture size; the segmenter sees a crop of ~2.6 face
    heights, so its 256 px cover the head finely."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    side = int(max(x1 - x0, y1 - y0) * 2.6)
    c0, r0 = max(0, int((x0 + x1) / 2 - side / 2)), max(0, int(y0 - side * 0.35))
    c1, r1 = min(w, c0 + side), min(h, r0 + side)
    crop = np.ascontiguousarray(cv2.cvtColor(img[r0:r1, c0:c1], cv2.COLOR_BGR2RGB))
    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=mpt.BaseOptions(model_asset_path=f"{MODELS}/selfie_multiclass_256x256.tflite"), output_confidence_masks=True))
    conf = [np.array(m.numpy_view(), dtype=np.float32) for m in seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).confidence_masks]
    seg.close()
    # classes: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 others
    m = np.clip(conf[1] + conf[2] + conf[3], 0, 1)
    out = np.zeros((h, w), np.float32)
    out[r0:r1, c0:c1] = cv2.resize(m, (c1 - c0, r1 - r0), interpolation=cv2.INTER_LINEAR)
    return out

ap = argparse.ArgumentParser()
ap.add_argument("input"); ap.add_argument("output")
ap.add_argument("--scale", type=float, default=0.93); ap.add_argument("--person", type=int, default=0)
a = ap.parse_args()
S = a.scale
if not 0.5 < S < 1.5:
    sys.exit("--scale must be between 0.5 and 1.5")

img = cv2.imread(a.input)
if img is None:
    sys.exit(f"cannot read {a.input}")
h, w = img.shape[:2]
people = measure(a.input)["people"]
if a.person >= len(people):
    sys.exit(f"no person {a.person} found (found {len(people)})")
p = people[a.person]
x0, y0, x1, y1 = p["box"]; ax, ay = p["chin"]
fw, fh = x1 - x0, y1 - y0

# the head: the person's own outline inside an ellipse around the face (hair ~0.65 face heights above the forehead,
# ears 0.85 face widths from the centre), above the chin; other people's faces + hair are cut out as well
yy, xx = np.mgrid[0:h, 0:w]
cx, cy, rx, ry = (x0 + x1) / 2, y0 + fh * 0.3, fw * 0.85, fh * 0.95
zone = (((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1) & (yy < ay)
for i, q in enumerate(people):
    if i != a.person:
        b0, b1, b2, b3 = q["box"]; qw, qh = b2 - b0, b3 - b1
        zone &= ~((xx > b0 - qw * 0.15) & (xx < b2 + qw * 0.15) & (yy > b1 - qh * 0.5) & (yy < b3 + qh * 0.35))
head = np.where(zone, head_pixels(img, p["box"]), 0).astype(np.float32)
del xx, zone

# near the chin the smaller head fades into the real neck over 6 % of a face height (the shift there is ~1 px)
ramp = np.clip((ay - yy) / (fh * 0.06), 0, 1).astype(np.float32)
del yy

# background without the old head: the old outline (a little wider, so faint hair rims go too) is filled from the
# real background around it, except in the chin ramp, where the photo itself stays. Only the thin gap between the old
# and the new outline stays visible. The fill copies texture (OpenCV xphoto FSR, so city lights and leaves keep
# their look); plain OpenCV falls back to a smooth fill.
hole = cv2.dilate((head > 0.1).astype(np.uint8) * 255, np.ones((int(fw * 0.05) | 1,) * 2, np.uint8))
hole[ramp < 1] = 0
ys, xs = np.nonzero(hole)
bg = img.copy()
if ys.size:
    pad = int(fw * 0.35)
    r0, r1, c0, c1 = max(0, ys.min() - pad), min(h, ys.max() + pad), max(0, xs.min() - pad), min(w, xs.max() + pad)
    roi, holeRoi = img[r0:r1, c0:c1], hole[r0:r1, c0:c1]
    if hasattr(cv2, "xphoto"):
        filled = roi.copy()
        cv2.xphoto.inpaint(roi, np.where(holeRoi > 0, 0, 255).astype(np.uint8), filled, cv2.xphoto.INPAINT_FSR_FAST)
    else:
        filled = cv2.inpaint(roi, holeRoi, max(3, int(fw * 0.03)), cv2.INPAINT_TELEA)
    np.copyto(bg[r0:r1, c0:c1], filled, where=holeRoi[..., None] > 0)  # only the hole – nothing else may change

# the smaller real head (and its outline as the alpha), scaled around the chin
M = np.float32([[S, 0, ax * (1 - S)], [0, S, ay * (1 - S)]])
small = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
alpha = cv2.warpAffine(head, M, (w, h), flags=cv2.INTER_LINEAR)
alpha = cv2.GaussianBlur(alpha, (0, 0), max(1.5, fw * 0.006)) * ramp
alpha = alpha[..., None]
out = bg.astype(np.float32) * (1 - alpha) + small.astype(np.float32) * alpha
cv2.imwrite(a.output, np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 96])
print(json.dumps({"out": a.output, "person": a.person, "scale": S, "chin": [round(ax), round(ay)], "face": [round(fw), round(fh)]}))
