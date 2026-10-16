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
const VIDEO_SECONDS = Math.min(10, Math.max(2, Number(process.env.TRIAL_VIDEO_SECONDS) || 5));
const COST = {
  image: Number(process.env.TRIAL_IMAGE_COST_USD) || 0.003,
  video: (Number(process.env.FAL_VIDEO_COST_PER_SEC) || 0.025) * VIDEO_SECONDS,
};
const configured = Boolean(FAL_KEY);

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
async function submit(kind, { prompt, style, imageUrl = null }) {
  if (!configured) throw new Error("FAL_KEY is not set");
  const s = STYLE[style] || STYLE.realistic;
  let model, input;
  if (kind === "image") {
    model = MODELS.image;
    input = { prompt: `${s.image} ${prompt}`, image_size: "landscape_4_3", num_images: 1, enable_safety_checker: true, output_format: "jpeg" };
  } else if (imageUrl) {
    model = MODELS.i2v;
    input = { prompt: `${s.video} ${prompt}`, image_url: imageUrl, duration: VIDEO_SECONDS, resolution: "768P", enable_safety_checker: true, prompt_expansion_mode: "balanced" };
  } else {
    model = MODELS.video;
    input = { prompt: `${s.video} ${prompt}`, duration: VIDEO_SECONDS, resolution: "768P", aspect_ratio: "16:9", enable_safety_checker: true, prompt_expansion_mode: "balanced" };
  }
  const r = await fal("POST", model, input);
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

module.exports = { configured, submit, poll, MODELS, COST, VIDEO_SECONDS, STYLE };
