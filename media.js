/**
 * VI Iraq – AI media generation behind one small interface, so providers/models can be swapped
 * without touching the rest of the app.
 *
 *   submit(kind, { prompt, style, imageUrl }) → { provider, model, jobId, cost }
 *   poll(job)                                 → { status: "running" | "done" | "failed", url?, error? }
 *
 * Provider: fal.ai queue API (https://queue.fal.run, header "Authorization: Key <FAL_KEY>").
 *   submit  POST   /{model}                         → { request_id }
 *   status  GET    /{model}/requests/{id}/status    → { status: IN_QUEUE | IN_PROGRESS | COMPLETED, error? }
 *   result  GET    /{model}/requests/{id}           → model output
 * Models (env overrides):
 *   FAL_IMAGE_MODEL  fal-ai/flux/schnell                      ~$0.003 per image
 *   FAL_VIDEO_MODEL  minimax/h3-max-turbo/text-to-video       ~$0.025 per second
 *   FAL_I2V_MODEL    minimax/h3-max-turbo/image-to-video      (animate an image)
 */
const clean = (v) => String(v || "").trim();
const FAL_KEY = clean(process.env.FAL_KEY);
const FAL_QUEUE = (clean(process.env.FAL_QUEUE_URL) || "https://queue.fal.run").replace(/\/+$/, "");
const MODELS = {
  image: clean(process.env.FAL_IMAGE_MODEL) || "fal-ai/flux/schnell",
  video: clean(process.env.FAL_VIDEO_MODEL) || "minimax/h3-max-turbo/text-to-video",
  i2v: clean(process.env.FAL_I2V_MODEL) || "minimax/h3-max-turbo/image-to-video",
};
const VIDEO_SECONDS = Math.min(10, Math.max(2, Number(process.env.TRIAL_VIDEO_SECONDS) || 10));
const COST = {
  image: Number(process.env.TRIAL_IMAGE_COST_USD) || 0.003,
  video: (Number(process.env.FAL_VIDEO_COST_PER_SEC) || 0.025) * VIDEO_SECONDS,
};
const configured = Boolean(FAL_KEY);

// Result links we accept from the provider: fal's CDN, and the queue's own origin (the test double).
const FAL_ORIGIN = (() => { try { return new URL(FAL_QUEUE).origin; } catch { return ""; } })();
function isProviderUrl(u) {
  try {
    const x = new URL(u);
    return (x.protocol === "https:" && /(^|[.])fal[.](media|run|ai)$/i.test(x.hostname)) || x.origin === FAL_ORIGIN;
  } catch { return false; }
}

// ChatGPT image model (OpenAI Images API, returns the picture itself as base64):
//   used for the styles in TRIAL_OPENAI_STYLES (default "cartoon" – clearly better there), and
//   automatically for every picture while fal is out of credit / failing. There is no OpenAI video
//   fallback: the Sora video API was shut down on 2026-09-24, so videos need fal.
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_IMAGE_MODEL = clean(process.env.OPENAI_IMAGE_MODEL) || "chatgpt-image-latest";
const OPENAI_IMAGE_QUALITY = clean(process.env.OPENAI_IMAGE_QUALITY) || "medium";
const OPENAI_STYLES = (process.env.TRIAL_OPENAI_STYLES ?? "cartoon").split(",").map((s) => s.trim()).filter(Boolean);
COST.openaiImage = Number(process.env.OPENAI_IMAGE_COST_USD) || 0.04;
COST.speech = Number(process.env.TTS_COST_USD) || 0.01;
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const TTS_MODEL = clean(process.env.TTS_MODEL) || "gpt-4o-mini-tts";
// voice per speaker; the dialect/accent comes from the instructions and from the words themselves
const TTS_VOICES = { male: clean(process.env.TTS_VOICE_MALE) || "onyx", female: clean(process.env.TTS_VOICE_FEMALE) || "nova", child: clean(process.env.TTS_VOICE_CHILD) || "coral" };
const ACCENT = {
  "ar-IQ": "Speak in natural Iraqi Arabic (Baghdadi accent): relaxed, conversational, with Iraqi pronunciation (ق as 'g' where Iraqis say it, چ for ك where natural). Not formal, not Egyptian, not Gulf.",
  ar: "Speak clear Modern Standard Arabic, natural news-presenter pace.",
  en: "Speak natural conversational English.",
  ku: "Speak Kurdish (Sorani) naturally.",
  tr: "Speak natural Turkish.",
  fa: "Speak natural Persian (Farsi).",
};

/**
 * Spoken line → MP3 Buffer (OpenAI TTS). lang picks the accent instructions; voice: male | female | child.
 * The result is passed to the video model as the soundtrack (data URI), so the mouth follows the words.
 */
async function speak({ text, lang = "ar-IQ", voice = "male", tone = "" }) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not set");
  const r = await fetch(`${OPENAI_BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: TTS_MODEL, voice: TTS_VOICES[voice] || TTS_VOICES.male, input: String(text).slice(0, 400), response_format: "mp3", speed: 1.0,
      instructions: `${ACCENT[lang] || ACCENT["ar-IQ"]} ${tone ? "Tone: " + tone + "." : ""} Speak the text exactly as written, no additions.`,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`openai tts ${r.status} ${String((await r.json().catch(() => ({}))).error?.message || "").slice(0, 160)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error("openai tts: empty audio");
  return buf;
}
const audioDataUri = (buf) => `data:audio/mpeg;base64,${buf.toString("base64")}`;
const openaiReady = Boolean(OPENAI_KEY);

COST.openaiEdit = Number(process.env.OPENAI_EDIT_COST_USD) || 0.10;
const ROLE_TEXT = { char1: "Character 1", char2: "Character 2", char3: "Character 3", ref: "style/place/product reference (not a person to copy)" };

/**
 * A picture made FROM the customer's photos (ChatGPT image edit): the people in the photos appear in the
 * described scene with the same faces, hair and clothes. refs: [{ role, buf }] (JPEG buffers, max 3).
 */
async function openaiImageEdit(prompt, style, refs) {
  const s = STYLE[style] || STYLE.realistic;
  const roles = refs.map((r, i) => `Picture ${i + 1} is ${ROLE_TEXT[r.role] || ROLE_TEXT.ref}`).join("; ");
  const text = `${s.image} ${prompt}\n${roles}. Every person in a character picture must appear in the scene with exactly the same face, hair, skin tone and clothing as in their picture. A reference picture only gives style, place or product – do not copy its people.`;
  const send = async (withFidelity) => {
    const fd = new FormData();
    fd.append("model", OPENAI_IMAGE_MODEL);
    fd.append("prompt", text);
    refs.forEach((r, i) => fd.append("image[]", new Blob([r.buf], { type: "image/jpeg" }), `picture-${i + 1}.jpg`));
    fd.append("size", "auto"); fd.append("quality", OPENAI_IMAGE_QUALITY); fd.append("output_format", "jpeg");
    if (withFidelity) fd.append("input_fidelity", "high"); // keeps the faces
    return fetch(`${OPENAI_BASE}/v1/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd, signal: AbortSignal.timeout(180000) });
  };
  let r = await send(true);
  if (r.status === 400) r = await send(false); // a model without input_fidelity
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`openai image edit ${r.status} ${String(j.error?.message || "").slice(0, 200)}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai image edit: nothing returned");
  return Buffer.from(b64, "base64");
}

// fal out of credit (or failing) → skip it for 10 minutes: pictures go to ChatGPT, videos are paused
let falDownUntil = 0;
const falUp = () => configured && Date.now() > falDownUntil;
function markFalDown(err) {
  falDownUntil = Date.now() + 10 * 60e3;
  console.error(`fal unavailable for 10 min (${String(err?.message || err).slice(0, 160)})`);
}
const useOpenAIImage = (style) => openaiReady && (!falUp() || OPENAI_STYLES.includes(style));

/** One picture from the ChatGPT image model → JPEG Buffer. */
async function openaiImage(prompt, style) {
  const s = STYLE[style] || STYLE.realistic;
  const r = await fetch(`${(clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "")}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: `${s.image} ${prompt}`, size: "1024x1024", quality: OPENAI_IMAGE_QUALITY, output_format: "jpeg", n: 1 }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`openai image ${r.status} ${String(j.error?.message || "").slice(0, 200)}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai image: nothing returned");
  return Buffer.from(b64, "base64");
}

// Style is added in English (models follow English prompts best); the visitor's idea comes after it.
const STYLE = {
  realistic: {
    image: "Photorealistic photograph, natural light, sharp focus, realistic skin and textures, high detail.",
    video: "Photorealistic cinematic live-action footage, natural light, realistic motion.",
  },
  cartoon: {
    image: "Colorful 3D cartoon illustration, Pixar-like animated movie style, soft lighting, expressive characters.",
    video: "Colorful 3D animated cartoon, Pixar-like style, smooth playful motion.",
  },
};

async function fal(method, path, body) {
  const r = await fetch(`${FAL_QUEUE}/${path}`, {
    method,
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !(method === "GET" && r.status === 202)) {
    const msg = data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : data.message || data.error || "";
    throw new Error(`fal ${r.status} ${String(msg).slice(0, 200)}`.trim());
  }
  return data;
}

/** Starts a job; returns the provider job id and the cost estimate counted against the trial budget. */
async function submit(kind, { prompt, style, imageUrl = null, audioUrl = null, negative = "" }) {
  if (!configured) throw new Error("FAL_KEY is not set");
  const s = STYLE[style] || STYLE.realistic;
  let model, input;
  if (kind === "image") {
    model = MODELS.image;
    input = { prompt: `${s.image} ${prompt}`, image_size: "landscape_4_3", num_images: 1, enable_safety_checker: true, output_format: "jpeg" };
  } else if (imageUrl) {
    model = MODELS.i2v;
    input = { prompt: `${s.video} ${prompt}`, image_url: imageUrl, duration: VIDEO_SECONDS, resolution: "768P", enable_safety_checker: true, prompt_expansion_mode: "disabled" };
  } else {
    model = MODELS.video;
    input = { prompt: `${s.video} ${prompt}`, duration: VIDEO_SECONDS, resolution: "768P", aspect_ratio: "16:9", enable_safety_checker: true, prompt_expansion_mode: "disabled" };
  }
  // the spoken line as the soundtrack: the model animates the mouth to it (MiniMax target_audio_url, ≥ 2 s, ≤ 15 MB)
  if (kind === "video" && audioUrl) input.target_audio_url = audioUrl;
  if (negative && kind === "image") input.prompt += `. Avoid: ${negative}`;
  let r;
  try {
    r = await fal("POST", model, input);
  } catch (e) {
    markFalDown(e); // out of credit, locked or down: stop sending work there for a while
    throw e;
  }
  if (!r.request_id) throw new Error("fal: no request_id");
  return { provider: "fal", model, jobId: r.request_id, cost: COST[kind] };
}

// Status/result URLs use the app id – the first two parts of the model id
// ("fal-ai/flux/schnell" → "fal-ai/flux"); the full model id answers 405 there.
const appOf = (model) => model.split("/").slice(0, 2).join("/");

/** Status of a submitted job; on completion returns the media URL. */
async function poll({ model, provider_job_id: id, kind }) {
  const base = `${appOf(model)}/requests/${encodeURIComponent(id)}`;
  const st = await fal("GET", `${base}/status`);
  if (st.status === "IN_QUEUE" || st.status === "IN_PROGRESS") return { status: "running" };
  if (st.status !== "COMPLETED") return { status: "running" };
  if (st.error) return { status: "failed", error: String(st.error).slice(0, 300) };
  const out = await fal("GET", base);
  if (kind === "image") {
    const img = out.images?.[0];
    if (!img?.url) return { status: "failed", error: "no image returned" };
    if (out.has_nsfw_concepts?.[0]) return { status: "failed", error: "blocked by the safety filter" };
    return { status: "done", url: img.url };
  }
  return out.video?.url ? { status: "done", url: out.video.url } : { status: "failed", error: "no video returned" };
}

module.exports = {
  configured, openaiReady, falUp, useOpenAIImage, openaiImage, openaiImageEdit, OPENAI_IMAGE_MODEL, speak, audioDataUri, TTS_MODEL, isProviderUrl,
  resetFal: () => { falDownUntil = 0; },
  submit, poll, MODELS, COST, VIDEO_SECONDS, STYLE,
};
