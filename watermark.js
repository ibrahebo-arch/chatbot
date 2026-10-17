/**
 * VI Iraq – the "VI-Iraq" mark on every free-trial picture and video (assets/watermark.png: bold
 * Arial, gold "VI" + white "-Iraq", thin dark outline so it reads on light and dark footage).
 *
 * Placement: bottom-right, mark width = 16% of the frame width (110–340 px), margin 2.5% of the width,
 * 88% opaque – visible, but it covers nothing important. Pictures stay JPEG (q 2); videos are re-encoded
 * H.264 (CRF 20, same size) with the audio copied untouched.
 *
 * Uses ffmpeg-static (an npm dependency, so it works on the VPS and on Render) or `ffmpeg` from PATH.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const WM_FILE = path.join(__dirname, "assets", "watermark.png");
const WIDTH_SHARE = 0.16;
const MARGIN_SHARE = 0.025;
const OPACITY = 0.88;

function findFfmpeg() {
  let p = "ffmpeg";
  try { p = require("ffmpeg-static") || "ffmpeg"; } catch {}
  const t = spawnSync(p, ["-version"], { stdio: "ignore" });
  return t.status === 0 ? p : null;
}
const FFMPEG = findFfmpeg();
const ready = Boolean(FFMPEG);

// at most two ffmpeg runs at a time (a video takes a few seconds of CPU)
let running = 0;
const waiting = [];
async function slot() {
  if (running >= 2) await new Promise((r) => waiting.push(r));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

function run(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
  });
}

/** Frame size and audio presence, read from ffmpeg's own report (ffmpeg-static ships no ffprobe). */
async function probe(file) {
  const { stderr } = await run(["-i", file]); // exits 1 without an output file – the report is what we want
  const m = stderr.match(/Video:.*?[ ,](\d{2,5})x(\d{2,5})/);
  return { width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0, hasAudio: /Audio:/.test(stderr) };
}

/**
 * Returns a copy of the picture / video Buffer with the mark on it. kind: "image" | "video".
 * Throws if ffmpeg fails – callers must not show the unstamped file.
 */
async function apply(buffer, kind) {
  if (!ready) throw new Error("ffmpeg is not available");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vi-wm-"));
  await slot();
  try {
    const video = kind === "video";
    const input = path.join(dir, video ? "in.mp4" : "in.img");
    const output = path.join(dir, video ? "out.mp4" : "out.jpg");
    await fs.writeFile(input, buffer);
    const { width } = await probe(input);
    const frameW = width || 1024;
    const markW = Math.min(340, Math.max(110, Math.round(frameW * WIDTH_SHARE)));
    const margin = Math.round(frameW * MARGIN_SHARE);
    const stamp = `[1:v]scale=${markW}:-1,format=rgba,colorchannelmixer=aa=${OPACITY}[w];[0:v][w]overlay=x=main_w-overlay_w-${margin}:y=main_h-overlay_h-${margin}:format=auto`;
    const args = video
      ? ["-y", "-v", "error", "-i", input, "-i", WM_FILE,
         "-filter_complex", `${stamp}[o];[o]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v]`,
         "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-metadata", "title=VI-Iraq", output]
      : ["-y", "-v", "error", "-i", input, "-i", WM_FILE, "-filter_complex", `${stamp}[v]`, "-map", "[v]", "-frames:v", "1", "-q:v", "2", "-map_metadata", "-1", "-fflags", "+bitexact", output];
    const r = await run(args);
    if (r.code !== 0) throw new Error(`ffmpeg ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
    const out = await fs.readFile(output);
    if (out.length < 1000) throw new Error("ffmpeg produced an empty file");
    return out;
  } finally {
    release();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A customer's photo as a JPEG no larger than max × max (never enlarged), upright. Phone photos are several MB;
 * the models do not need that. Throws for files ffmpeg cannot read (e.g. HEIC) – callers skip that picture.
 */
async function resize(buffer, max = 1280) {
  if (!ready) throw new Error("ffmpeg is not available");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vi-rs-"));
  await slot();
  try {
    const input = path.join(dir, "in.img");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    const r = await run(["-y", "-v", "error", "-i", input, "-vf", `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`, "-frames:v", "1", "-q:v", "3", output]);
    if (r.code !== 0) throw new Error(`ffmpeg ${r.code}: ${r.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
    return await fs.readFile(output);
  } finally {
    release();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { apply, resize, probe, ready, FFMPEG, WIDTH_SHARE, MARGIN_SHARE, run, slot, release };
