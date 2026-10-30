#!/usr/bin/env node
/**
 * Head scale without AI: makes ONE person's real head (and the soft background around it) smaller or larger around
 * the chin and blends it into the photo far from the head – the face stays the real pixels, nothing is invented,
 * and the other people are never touched.
 *
 *   node tools/head-scale.js <in.jpg> <out.jpg> --scale 0.93 --person 0 [--protect 1]
 *
 * Positions come from tools/proportions.py (--json, people sorted left → right): the person's face box and chin
 * place the zone; every --protect person's face box (plus a margin) is kept out of it with a hard edge.
 * Typical use: proportions.py says "FIX: scale man's head × 0.93" → head-scale.js … --scale 0.93 --person 0 --protect 1.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const FF = require("ffmpeg-static");
const PY = process.env.VI_PY || "/opt/vi-iraq-py/bin/python";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const [input, output] = args;
const S = Number(opt("scale", 0.93)), who = Number(opt("person", 0));
const protect = String(opt("protect", "")).split(",").filter((x) => x !== "").map(Number);
if (!input || !output || !(S > 0.5 && S < 1.5)) { console.error("usage: node tools/head-scale.js <in.jpg> <out.jpg> --scale 0.93 --person 0 [--protect 1]"); process.exit(1); }
const ff = (...a) => execFileSync(FF, ["-v", "error", "-y", ...a]);

const m = spawnSync(PY, [path.join(__dirname, "proportions.py"), input, "--json"], { encoding: "utf8" });
const people = JSON.parse(String(m.stdout).trim().split("\n").pop()).people;
const p = people[who];
if (!p) { console.error(`no person ${who} found (found ${people.length})`); process.exit(1); }
const [W, H] = String(spawnSync(FF, ["-i", input]).stderr).match(/, (\d{3,5})x(\d{3,5})/).slice(1).map(Number);
const [x0, y0, x1, y1] = p.box, [AX, AY] = p.chin;
const fw = x1 - x0, fh = y1 - y0;
// zone around the whole head (hair and ears included): wider than the face box, from above the hair to the chin
const cx = Math.round((x0 + x1) / 2), cy = Math.round(y0 + fh * 0.25), rx = Math.round(fw * 1.25), ry = Math.round(fh * 1.25);
const ox = Math.round(AX * (1 - S)), oy = Math.round(AY * (1 - S)), sw = Math.round(W * S / 2) * 2, sh = Math.round(H * S / 2) * 2;
// hard keep-out boxes for the protected people (their face box + 35 % margin)
const keep = protect.map((i) => people[i]).filter(Boolean).map((q) => { const [a, b, c, d] = q.box, mw = (c - a) * 0.35, mh = (d - b) * 0.35; return [a - mw, b - mh * 2, c + mw, d + mh]; });
const keepExpr = keep.map(([a, b, c, d]) => `not(between(X,${Math.round(a)},${Math.round(c)})*between(Y,${Math.round(b)},${Math.round(d)}))`).join("*") || "1";
const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "head-scale-"));
try {
  ff("-f", "lavfi", "-i", `color=black:s=${W}x${H},format=gray`, "-vf",
    `geq=lum='if(lte(((X-${cx})*(X-${cx}))/(${rx}*${rx})+((Y-${cy})*(Y-${cy}))/(${ry}*${ry}),1)*lt(Y,${Math.round(AY + fh * 0.02)})*gt(Y,${oy + 60}),255,0)',gblur=sigma=${Math.round(fw * 0.12)}`, "-frames:v", "1", `${tmp}/soft.png`);
  ff("-f", "lavfi", "-i", `color=black:s=${W}x${H},format=gray`, "-vf", `geq=lum='if(${keepExpr},255,0)'`, "-frames:v", "1", `${tmp}/keep.png`);
  ff("-i", `${tmp}/soft.png`, "-i", `${tmp}/keep.png`, "-filter_complex", "[0][1]blend=all_mode=multiply", "-frames:v", "1", `${tmp}/zone.png`);
  ff("-i", input, "-i", `${tmp}/zone.png`, "-filter_complex",
    `[0]scale=${sw}:${sh}:flags=lanczos,pad=${W}:${H}:${ox}:${oy}:black[sc];[sc][1]alphamerge[z];[0][z]overlay=0:0`, "-q:v", "1", output);
  console.log(JSON.stringify({ out: output, person: who, scale: S, chin: [AX, AY], zone: { cx, cy, rx, ry }, protected: protect }));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
