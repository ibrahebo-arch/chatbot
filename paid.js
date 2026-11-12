/**
 * VI Iraq – paid orders made automatically (PAID_AUTO=1).
 *
 * When Wayl confirms the payment, the order is made without anyone confirming it: a safety look at the request, a
 * storyboard in 10-second parts (with the library knowledge of the scene), a start picture from the customer's own
 * photos, the parts one after the other – each begins on the last frame of the one before, so people, clothes and
 * place continue – joined into one video of the ordered length and quality, the voice-over mixed in, and delivered:
 * the video appears on the customer's order page (and on Telegram when linked) and is mailed to the studio.
 *
 * A risky order (someone else's photos, a sexual wish about a real person, a public figure, a child in an unfit
 * scene) is still served, as a safe version: made-up people instead of the attached photos, modest and friendly.
 * A failure puts the order back to «مراجعة» and mails the studio – the customer never gets a broken file.
 * No watermark (paid). One order at a time.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const orders = require("./orders");
const storage = require("./storage");
const media = require("./media");
const voices = require("./voices");
const library = require("./library");
const watermark = require("./watermark");
const mail = require("./mail");

const clean = (v) => String(v || "").trim();
const ON = () => clean(process.env.PAID_AUTO) === "1";
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = () => clean(process.env.PAID_PLAN_MODEL) || clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const MAX_SECONDS = () => Number(process.env.PAID_AUTO_MAX_SECONDS) || 120;
const dataUri = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;
const log = (id, ...a) => console.log(`paid ${id}:`, ...a);

/** The lengths of the parts for a video of T seconds (pure – tested): 10-second parts, a 5-second one when it fits. */
function partsFor(seconds) {
  const T = Math.max(5, Math.min(MAX_SECONDS(), Math.round(Number(seconds) || 10)));
  const out = [];
  for (let left = T; left > 0; left -= 10) out.push(left <= 5 ? 5 : 10);
  return { total: T, parts: out };
}
/** Order language text → voice language code (pure – tested). */
function langOf(text) {
  const t = clean(text).toLowerCase();
  if (/بدون|no speech|none/.test(t)) return "none";
  if (/english|انجليز|إنجليز/.test(t)) return "en";
  if (/كرد|kurd/.test(t)) return "ku";
  if (/turk|ترك/.test(t)) return "tr";
  if (/فارس|persian|farsi/.test(t)) return "fa";
  if (/فصح/.test(t)) return "ar";
  return "ar-IQ";
}

async function ask(system, text, images = [], max = 6000) {
  const content = [{ type: "text", text }, ...images.map((b) => ({ type: "image_url", image_url: { url: dataUri(b), detail: "low" } }))];
  const model = MODEL();
  const body = { model, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content }] };
  if (/^(gpt-[5-9]|o\d)/.test(model)) body.max_completion_tokens = max; else { body.max_tokens = Math.min(max, 4000); body.temperature = 0.5; }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`plan model ${r.status} ${String(j.error?.message || "").slice(0, 160)}`);
  return JSON.parse(j.choices?.[0]?.message?.content || "{}");
}

/** The customer's own pictures of the characters (at most 3), as the picture model wants them. */
async function characterPhotos(requestId) {
  const out = [];
  for (const a of await orders.orderAssets(requestId)) {
    const role = orders.ROLE_UI[a.role] || "ref";
    if (a.media_type !== "image" || !/^char/.test(role) || Number(a.size_bytes) > 15 * 1048576 || out.length >= 3) continue;
    try { out.push({ role, buf: await watermark.resize(await storage.getBuffer(a.r2_key, 15 * 1048576)) }); } catch (e) { console.error("paid: a picture was skipped:", e.message); }
  }
  return out;
}

/** A look at the request before anything is made. Risky → the order is served as a safe version. */
async function safety(talk, photos) {
  try {
    const v = await ask(
      `You check an order of an AI video studio before it is made automatically. The customer's words and the photos they marked as the video's characters are given. Say "risky": true when making it as asked could harm someone: the photos look like someone else's (a screenshot of a chat, a social profile, a photographed screen, a celebrity or public figure), the request is sexual or humiliating about a real person, a child would appear in a sexual, violent or dangerous way, or it asks for hate, real violence or a fake statement by a real person. Ordinary wishes (an ad, a greeting, "me in a suit", a romantic or funny scene) are NOT risky. Return JSON {"risky":true|false,"why":"short","safe_note":"one sentence telling the video writer how to serve this customer safely – e.g. use made-up adults instead of the photos, keep it modest and friendly"}.`,
      `CUSTOMER:\n${talk.slice(-3500)}\n\nPhotos marked as characters: ${photos.length}`, photos.map((p) => p.buf), 1500);
    return { risky: v.risky === true, why: clean(v.why).slice(0, 200), note: clean(v.safe_note).slice(0, 300) };
  } catch (e) { console.error("paid safety check:", e.message); return { risky: false, why: "", note: "" }; }
}

/** The whole video written as consecutive parts that continue from each other. */
async function storyboard(o, talk, lens, lib, safe, withVoice, lang) {
  const opt = o.options || {};
  const v = await ask(
    `You are the director of VI Iraq, an AI video studio for Iraqi and Arab customers. Write the plan of ONE video of ${lens.total} seconds made as ${lens.parts.length} consecutive part(s) of ${lens.parts.join(" + ")} seconds. Each part is generated on its own and BEGINS ON THE LAST FRAME of the part before, so it must continue the same moment: same people, same clothes, same place, same light, no jump in time unless the customer asked for different scenes.
Return JSON only:
{"aspect":"9:16" for reels, stories, TikTok, Instagram or a phone video, else "16:9",
 "style":"realistic" or "cartoon" (cartoon only if the customer asked for it),
 "look":"ONE paragraph, English, max 90 words, repeated in every part: every person (age, face, hair, exact clothes and colours), the place, the light and the camera style. Real, concrete, nothing vague.",
 "first_frame":"English, max 60 words: the opening moment as one still photo.",
 "parts":[{"prompt":"English, max 110 words: only what happens in this part – actions in order, one main action, natural camera, the sounds heard. It continues exactly where the previous part ended."}],
 "narration": ${withVoice ? `{"text":"a voice-over in ${lang === "en" ? "English" : lang === "ar" ? "Modern Standard Arabic" : lang === "ku" ? "Kurdish (Sorani)" : lang === "tr" ? "Turkish" : lang === "fa" ? "Persian" : "Iraqi Arabic dialect (Baghdadi)"} of at most ${Math.round(lens.total * 2)} words that fits ${lens.total} seconds – the customer's own words when they gave a text","gender":"male|female","age":"young|adult|old","tone":"one sentence"} (null when the customer wants no speech)` : "null"},
 "negative":"things to avoid, English, max 40 words"}
Exactly ${lens.parts.length} part(s). Follow the customer's idea and words; write real everyday detail an Iraqi viewer recognises; no brand logos or readable text unless the customer gave it; nothing sexual, violent, political or religious.${safe.risky ? `\nSAFETY – this order must be served as a safe version: ${safe.note || "use made-up adults, keep it modest and friendly"} Do not describe the people of the attached photos.` : ""}`,
    `ORDER: ${lens.total} s · ${opt.quality || 720}p · language: ${opt.language || "العربية"} · characters: ${opt.characters || 1}\nCUSTOMER'S IDEA: ${clean(opt.description)}\n\nCONVERSATION:\n${talk.slice(-6000)}${lib.text || ""}`, [], 9000);
  const parts = (Array.isArray(v.parts) ? v.parts : []).map((p) => clean(p?.prompt)).filter(Boolean);
  if (!clean(v.look) || parts.length < 1) throw new Error("the plan came back empty");
  while (parts.length < lens.parts.length) parts.push(parts[parts.length - 1]);
  const n = v.narration && clean(v.narration.text) ? { text: clean(v.narration.text), gender: v.narration.gender, age: v.narration.age, tone: clean(v.narration.tone) } : null;
  return { aspect: v.aspect === "9:16" ? "9:16" : "16:9", style: v.style === "cartoon" ? "cartoon" : "realistic", look: clean(v.look), first: clean(v.first_frame), parts: parts.slice(0, lens.parts.length), narration: n, negative: clean(v.negative).slice(0, 400) };
}

const ff = async (args, ms = 300000) => { const r = await watermark.run(["-y", ...args], ms); if (r.code !== 0) throw new Error(`ffmpeg: ${(r.stderr.split("\n").filter((l) => /error|invalid|not match|unable|failed|no such/i.test(l)).slice(0, 4).join(" | ") || r.stderr.slice(-300)).slice(0, 600)}`); };

/** Makes and delivers one paid order. Throws on failure (the caller puts the order back to review). */
async function make(requestId) {
  const o = await orders.getOrder(requestId);
  if (!o) throw new Error("order not found");
  if (o.video_key || ["completed", "delivered", "cancelled"].includes(o.status)) return { skipped: o.status };
  if (orders.paymentsRequired() && !o.paid_at) throw new Error("not paid");
  const id = o.request_id, opt = o.options || {};
  await orders.setStatus(id, "awaiting_admin", "prompt_ready", { by: "auto", action: "confirm" }).catch(() => {});
  await orders.setStatus(id, "prompt_ready", "generating", { by: "auto" }).catch(() => {});

  const msgs = Array.isArray(o.messages) ? o.messages : [];
  const talk = msgs.map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${typeof m.content === "string" ? m.content : ""}`).join("\n") || clean(opt.description);
  const conversation = [...msgs.filter((m) => typeof m.content === "string"), { role: "user", content: clean(opt.description) }];
  let photos = await characterPhotos(id);
  const safe = await safety(`${clean(opt.description)}\n${talk}`, photos);
  if (safe.risky) { log(id, "safe version –", safe.why); photos = []; }
  const lens = partsFor(opt.seconds);
  const lang = langOf(opt.language), withVoice = lang !== "none" && opt.voice?.mode !== "none";
  const lib = await library.note(conversation, "video").catch(() => ({ text: "", ids: [] }));
  const plan = await storyboard(o, talk, lens, lib, safe, withVoice, lang);
  await orders.addEvent(null, id, "auto_plan", { parts: lens.parts, aspect: plan.aspect, safe: safe.risky ? safe.why : null, library: (lib.ids || []).length });
  log(id, `plan: ${lens.parts.join("+")} s, ${plan.aspect}, ${photos.length} photo(s)${safe.risky ? ", safe version" : ""}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paid-"));
  let cost = 0, canvas = null;
  try {
    // the opening picture (from the customer's photos when given), then the parts, each from the last frame before
    let frame = await media.startFrame(`${plan.look} ${plan.first}`, plan.style, photos, { size: plan.aspect === "9:16" ? "1024x1536" : "1536x1024" });
    cost += media.frameCost(photos.length > 0, plan.style);
    // the picture model gives 2:3 / 3:2 – cut to the real video shape (9:16 or 16:9), or the whole video keeps the wrong one
    try {
      const raw = path.join(dir, "frame-raw.jpg"), cut = path.join(dir, "frame.jpg"); fs.writeFileSync(raw, frame);
      await ff(["-i", raw, "-vf", plan.aspect === "9:16" ? "crop=trunc(ih*9/32)*2:ih" : "crop=iw:trunc(iw*9/32)*2", "-q:v", "2", cut]);
      frame = fs.readFileSync(cut);
    } catch (e) { console.error(`paid ${id}: frame not cut (${String(e.message).slice(0, 100)})`); }
    const files = [];
    for (const [i, secs] of lens.parts.entries()) {
      const prompt = `${plan.look} ${plan.parts[i]}`;
      let c = null, err = null;
      for (let attempt = 0; attempt < 2 && !c; attempt++) {
        try { c = await media.clip({ prompt, imageUrl: dataUri(frame), negative: plan.negative, seconds: secs, aspect: plan.aspect }); } catch (e) { err = e; console.error(`paid ${id}: part ${i + 1} try ${attempt + 1}: ${String(e.message).slice(0, 160)}`); }
      }
      if (!c) throw err || new Error("part failed");
      cost += c.cost;
      if (!media.isProviderUrl(c.url)) throw new Error("unexpected result address");
      const r = await fetch(c.url, { signal: AbortSignal.timeout(180000) }); if (!r.ok) throw new Error(`download ${r.status}`);
      const file = path.join(dir, `p${i}.mp4`); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      // every part in the same frame (the first part's size – the model may return a few pixels more or less), the
      // same rate and a sound track, so they join cleanly
      const info = await watermark.probe(file), norm = path.join(dir, `n${i}.mp4`);
      if (!canvas) canvas = { w: (info.width || (plan.aspect === "9:16" ? 1080 : 1920)) & ~1, h: (info.height || (plan.aspect === "9:16" ? 1920 : 1080)) & ~1 };
      await ff(["-i", file, ...(info.hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]), "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-shortest",
        "-vf", `scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${canvas.w}:${canvas.h},setsar=1,fps=24`, "-af", "aresample=44100:async=1",
        "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2", norm]);
      files.push(norm);
      if (i < lens.parts.length - 1) {
        const last = path.join(dir, `f${i}.jpg`);
        await ff(["-sseof", "-0.12", "-i", norm, "-frames:v", "1", "-q:v", "2", last]);
        frame = fs.readFileSync(last);
      }
      log(id, `part ${i + 1}/${lens.parts.length} done`);
    }
    // join, cut to the ordered length, scale to the ordered quality
    const q = [480, 720, 1080].includes(Number(opt.quality)) ? Number(opt.quality) : 720;
    const long = Math.round((q * 16) / 9 / 2) * 2, [W, H] = plan.aspect === "9:16" ? [q, long] : [long, q]; // 480/720/1080 = the short side
    const scale = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`;
    const joined = path.join(dir, "joined.mp4");
    const n = files.length, inputs = files.flatMap((f) => ["-i", f]);
    await ff([...inputs, "-filter_complex", `${files.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("")}concat=n=${n}:v=1:a=1[v0][a];[v0]${scale}[v]`, "-map", "[v]", "-map", "[a]", "-t", String(lens.total), "-c:v", "libx264", "-crf", "19", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-map_metadata", "-1", joined], 900000);
    let final = joined;
    // the voice-over: our voice in the order's language over the video's own sound, which is turned down under it
    if (plan.narration) {
      try {
        const voice = voices.pick(opt.voice?.preset && opt.voice.preset !== "auto" ? { preset: opt.voice.preset } : { gender: plan.narration.gender, age: plan.narration.age });
        if (voice) {
          const spoken = await voices.speak(voice, { text: plan.narration.text, lang, tone: plan.narration.tone });
          const fit = await voices.fit(spoken, Math.max(3, lens.total - 0.6), true).catch(() => ({ mp3: spoken }));
          const mp3 = path.join(dir, "voice.mp3"), mixed = path.join(dir, "mixed.mp4"); fs.writeFileSync(mp3, fit.mp3);
          await ff(["-i", joined, "-i", mp3, "-filter_complex", "[0:a]volume=0.4[bg];[1:a]adelay=400|400,volume=1.9[vo];[bg][vo]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.94[a]", "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", mixed]);
          final = mixed;
        }
      } catch (e) { console.error(`paid ${id}: voice-over failed (${String(e.message).slice(0, 120)}) – video with its own sound`); }
    }
    const key = `deliveries/${id}.mp4`;
    await storage.put(key, fs.readFileSync(final), { contentType: "video/mp4" });
    await orders.addEvent(null, id, "auto_made", { seconds: lens.total, parts: n, cost_usd: Number(cost.toFixed(2)), voice: Boolean(plan.narration && final !== joined) });
    const done = await require("./telegram").deliver(id, { key });
    log(id, `delivered (${lens.total} s, ${n} part(s), ~$${cost.toFixed(2)})`);
    return { delivered: done.status, cost };
  } catch (e) {
    // PAID_DEBUG_DIR keeps the work files of a failed order, so the fault can be found without paying for it again
    const keep = clean(process.env.PAID_DEBUG_DIR);
    if (keep) { try { fs.cpSync(dir, path.join(keep, `${id}-${Date.now()}`), { recursive: true }); } catch {} }
    throw e;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- one order at a time; a failure goes back to review and the studio is told --------------------------------
const waiting = new Set();
let chain = Promise.resolve();
function start(requestId) {
  const id = String(requestId || "").toUpperCase();
  if (!ON() || !id || waiting.has(id)) return false;
  waiting.add(id);
  chain = chain.then(async () => {
    try { await make(id); }
    catch (e) {
      console.error(`paid ${id}: FAILED – ${String(e.message).slice(0, 300)}`);
      await orders.addEvent(null, id, "auto_failed", { error: String(e.message).slice(0, 300) }).catch(() => {});
      await orders.setStatus(id, "generating", "awaiting_admin", { by: "auto", reason: "automatic making failed" }).catch(() => {});
      await mail.send({ subject: `VI Iraq – order ${id} needs you (automatic making failed)`, text: `The paid order ${id} could not be made automatically:\n\n${String(e.message).slice(0, 500)}\n\nIt is back in review. The customer has not received anything yet.` }).catch(() => {});
    } finally { waiting.delete(id); }
  });
  return true;
}
/** After a restart: paid orders that were being made are made again. */
async function resume() {
  if (!ON()) return 0;
  const rows = (await db.query("SELECT request_id FROM orders WHERE paid_at IS NOT NULL AND video_key IS NULL AND status IN ('prompt_ready','generating') AND updated_at > now() - interval '2 days' ORDER BY paid_at")).rows;
  for (const r of rows) start(r.request_id);
  return rows.length;
}

module.exports = { ON, start, resume, make, partsFor, langOf };
