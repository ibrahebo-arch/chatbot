/**
 * VI Iraq – automatic quality check of a finished video (the "validate" step).
 *
 * Six frames across the clip are shown to the prompt model, which lists what breaks reality: objects that vanish or
 * appear from nowhere, things that change number/shape/colour, morphing or melting, warped buildings, broken
 * anatomy, impossible physics, wrong directions. Below QA_MIN_SCORE the trial makes the video once more, with the
 * problems added to the avoid-list. The check never blocks a video: any error → "no verdict" and the video is used.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const watermark = require("./watermark");

const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = clean(process.env.QA_MODEL) || clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const ENABLED = clean(process.env.TRIAL_VIDEO_QA) !== "0" && Boolean(OPENAI_KEY) && watermark.ready;
const MIN_SCORE = Number(process.env.QA_MIN_SCORE) || 6;
const TIMES = [0.6, 2.2, 3.8, 5.4, 7.0, 8.8];

/** Six JPEG frames (base64) across the video. */
async function frames(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-"));
  const src = path.join(dir, "v.mp4");
  fs.writeFileSync(src, buf);
  try {
    const out = [];
    for (const [i, t] of TIMES.entries()) {
      const f = path.join(dir, `f${i}.jpg`);
      try {
        await watermark.run(["-y", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", f], 30000);
        if (fs.existsSync(f)) out.push(fs.readFileSync(f).toString("base64"));
      } catch {}
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The model's JSON verdict, normalised (pure – tested). */
function parseVerdict(text) {
  let v;
  try { v = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const score = Math.max(0, Math.min(10, Number(v.score)));
  if (!Number.isFinite(score)) return null;
  const issues = (Array.isArray(v.issues) ? v.issues : []).map((x) => clean(x).slice(0, 160)).filter(Boolean).slice(0, 6);
  return { score, issues, retry: score < MIN_SCORE && issues.length > 0 };
}

/** Checks the video against the idea; returns { score, issues, retry } or null when no verdict could be made. */
async function check(buf, idea) {
  if (!ENABLED) return null;
  try {
    const imgs = await frames(buf);
    if (imgs.length < 3) return null;
    const content = [{ type: "text", text: `These are ${imgs.length} frames, in order, from one AI-generated video (about 10 s). The video was meant to show: "${String(idea || "").slice(0, 600)}".
Act as a strict continuity and realism supervisor. Compare the frames with each other and list every problem that a viewer would notice as NOT REAL:
- an object, person, animal or vehicle that disappears, appears from nowhere, or changes number, shape, size, colour or position without a reason
- morphing or melting objects, faces or bodies; extra or missing limbs, fingers, wheels, legs
- buildings, roads or landmarks that bend, warp, change or duplicate
- impossible physics (floating, sliding without stepping, passing through things, wrong direction of travel)
- the scene not matching the idea
Return JSON only: {"score": 0-10 (10 = indistinguishable from real footage and fully consistent), "issues": ["short concrete problem", ...] (empty if none)}` }];
    for (const b of imgs) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}`, detail: "low" } });
    const body = { model: MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" } };
    if (/^(gpt-[5-9]|o\d)/.test(MODEL)) body.max_completion_tokens = 1500; else { body.max_tokens = 500; body.temperature = 0; }
    const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || `OpenAI ${r.status}`);
    return parseVerdict(d.choices?.[0]?.message?.content);
  } catch (e) {
    console.error("video qa:", e.message);
    return null;
  }
}

/** The avoid-list for the second try: the problems the check found, in the model's words. */
const retryAvoid = (issues) => issues.map((x) => x.replace(/[.;]+$/, "")).join("; ");

module.exports = { check, parseVerdict, retryAvoid, ENABLED, MIN_SCORE, _hash: (b) => crypto.createHash("sha1").update(b).digest("hex") };
