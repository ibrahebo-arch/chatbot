/**
 * VI Iraq – free trial (no account, no payment): per visitor IP a few images and one short video.
 *
 *   TRIAL_IMAGES=3 · TRIAL_VIDEOS=1 per TRIAL_WINDOW_DAYS=30 days, per IP (stored only as a salted hash)
 *   TRIAL_DAILY_BUDGET_USD=5 – once today's estimated spend reaches it, the trial pauses until tomorrow
 *                               (protects the bill from visitors who keep changing IP / VPN)
 *
 * A job reserves its slot first (row in trial_jobs, inside a lock), then is sent to the provider;
 * a job that fails is not counted, so the visitor can try again.
 */
const crypto = require("crypto");
const db = require("./db");
const media = require("./media");
const storage = require("./storage");
const watermark = require("./watermark");
const qa = require("./qa");
const orders = require("./orders");
const voices = require("./voices");

const clean = (v) => String(v || "").trim();
const LIMIT = { image: Number(process.env.TRIAL_IMAGES ?? 3), video: Number(process.env.TRIAL_VIDEOS ?? 1) };
const WINDOW_DAYS = Number(process.env.TRIAL_WINDOW_DAYS) || 30;
const DAILY_BUDGET = Number(process.env.TRIAL_DAILY_BUDGET_USD ?? 5);
const SALT = clean(process.env.TRIAL_SALT) || clean(process.env.ADMIN_TOKEN) || "vi-iraq-trial";
// ChatGPT pictures come back as files, so they need storage (the VPS has it; Render without R2 does not)
const openaiOk = () => media.openaiReady && storage.ready;
// Every free result is stamped with the VI-Iraq mark and kept on our storage before the visitor sees it,
// so the trial needs storage and ffmpeg – without them it stays off rather than hand out unmarked files.
const enabled = () =>
  storage.ready && watermark.ready && (media.configured || media.openaiReady) && clean(process.env.TRIAL_ENABLED).toLowerCase() !== "false";

class TrialError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const ipHash = (ip) => crypto.createHmac("sha256", SALT).update(String(ip || "?")).digest("hex").slice(0, 32);

// Free ticket, e.g. FT-261016-K3F9 – the number the team uses to track a free result.
function newTicket() {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `FT-${ymd}-${[...crypto.randomBytes(4)].map((b) => abc[b % abc.length]).join("")}`;
}

// called once per finished free job (the server sends it to the Telegram admins)
let onDone = async () => {};
const setOnDone = (fn) => { onDone = fn; };

/** Reports a finished job once (notified_at): the team gets its ticket and the stamped file. */
async function archive(job) {
  const first = (await db.query("UPDATE trial_jobs SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING id", [job.id])).rows[0];
  if (first) await onDone(job).catch((e) => console.error("trial notify:", e.message));
  return job;
}

const ROLE_ORDER = ["char1", "char2", "char3", "ref"];
/**
 * The pictures the customer sent in the chat (the same uploads the paid order uses): Character 1, 2, 3 first,
 * then references, at most `max`, each shrunk to a JPEG ≤ 1280 px. A picture that cannot be read (HEIC…) is skipped.
 * messages: the chat as the page keeps it – user messages carry files: [{ image, stored, role }].
 */
async function refsFrom(messages, max = 3) {
  const seen = new Set();
  const found = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "user") continue;
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (!f || !f.image || !f.stored || seen.has(f.stored)) continue;
      seen.add(f.stored);
      found.push({ stored: String(f.stored), role: ROLE_ORDER.includes(f.role) ? f.role : "ref" });
    }
  }
  found.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const out = [];
  for (const f of found) {
    if (out.length >= max) break;
    try {
      const a = await orders.getAsset(f.stored);
      if (!a || a.media_type !== "image" || Number(a.size_bytes) > 15 * 1048576) continue;
      out.push({ role: f.role, buf: await watermark.resize(await storage.getBuffer(a.r2_key, 15 * 1048576)) });
    } catch (e) { console.error("trial: a chat picture was skipped:", e.message); }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = { image: "jpg", video: "mp4" };
const MIME = { image: "image/jpeg", video: "video/mp4" };

/** The provider's result file (only from addresses we trust). */
async function download(url, maxBytes = 150 * 1048576) {
  if (!media.isProviderUrl(url)) throw new Error("unexpected result address");
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  if ((Number(r.headers.get("content-length")) || 0) > maxBytes) throw new Error("result too large");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("result too large");
  return buf;
}

/** The stamped copy of an original picture/video (kept as trial/<ticket>.<ext>). */
async function stampAndStore(job, original) {
  const marked = await watermark.apply(original, job.kind);
  const key = `trial/${job.ticket}.${EXT[job.kind]}`;
  await storage.put(key, marked, { contentType: MIME[job.kind] });
  return key;
}

/**
 * Last step of every free job: the original (from the provider, or ChatGPT's picture in memory) is stamped
 * with the VI-Iraq mark and stored; only then the job turns "done" and the visitor can see it. A picture's
 * clean original is kept privately (trial/src/) – only to animate it, so the mark is never baked in twice.
 * If stamping fails twice the job fails (and is not counted) – an unstamped file is never shown.
 */
async function finalize(job, original = null) {
  let lastError, raw = original;
  // videos: the realism/continuity check first; a clear failure is made once more with the problems to avoid
  if (job.kind === "video" && !original && qa.ENABLED) {
    try {
      raw = await download(job.raw_url);
      const verdict = await qa.check(raw, job.model_prompt || job.prompt);
      if (verdict) {
        await db.query("UPDATE trial_jobs SET qa = coalesce(qa, '[]'::jsonb) || $2::jsonb WHERE id = $1",
          [job.id, JSON.stringify([{ ...verdict, model: job.model, at: new Date().toISOString() }])]);
        console.log(`free ticket ${job.ticket}: qa ${verdict.score}/10${verdict.issues.length ? " – " + verdict.issues.join("; ") : ""}`);
        if (verdict.retry && (job.qa_retries || 0) < 1 && (await remake(job, verdict))) return;
      }
    } catch (e) { console.error(`trial qa ${job.ticket}:`, e.message); }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const buf = raw || (await download(job.raw_url));
      if (job.kind === "image") await storage.put(`trial/src/${job.ticket}.jpg`, buf, { contentType: "image/jpeg" });
      const key = await stampAndStore(job, buf);
      const done = (await db.query(
        `UPDATE trial_jobs SET status = 'done', result_url = $2, stored_key = $3, watermarked = true, finished_at = now()
          WHERE id = $1 AND status IN ('queued','running') RETURNING *`,
        [job.id, `store:${key}`, key]
      )).rows[0];
      if (done) await archive(done);
      return;
    } catch (e) {
      lastError = e;
      console.error(`trial finalize ${job.ticket} (try ${attempt}):`, e.message);
      if (attempt < 2) await sleep(1500);
    }
  }
  await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('queued','running')", [job.id, `could not finish: ${lastError.message}`.slice(0, 300)])
    .catch((e2) => console.error(`trial finalize ${job.ticket} (saving the failure):`, e2.message)); // e.g. during a shutdown
}

/**
 * Makes a video again after a failed quality check: same prompt and voice track, plus the problems the check found
 * as things to avoid. Only within the daily budget; the job stays "running" and is picked up by the normal polling.
 */
async function remake(job, verdict) {
  try {
    const audio = job.audio_key && storage.ready ? await storage.getBuffer(job.audio_key, 15 * 1048576).catch(() => null) : null;
    const audioUrl = audio ? media.audioDataUri(audio) : null;
    // a video that started from a picture is made again from the same picture (our start frame); without it
    // (a customer photo or an animated trial picture that was not kept) it is not remade
    const frame = job.image_first_frame && storage.ready ? await storage.getBuffer(`trial/frame/${job.ticket}.jpg`, 25 * 1048576).catch(() => null) : null;
    if (job.image_first_frame && !frame) return false;
    const cost = media.videoCost(Boolean(audioUrl));
    if ((await spentToday()) + cost > DAILY_BUDGET) return false;
    const plan = typeof job.plan === "string" ? JSON.parse(job.plan) : job.plan || {};
    const prompt = `${job.model_prompt || job.prompt} Keep every object, person and building continuous and unchanged for the whole clip. Avoid especially: ${qa.retryAvoid(verdict.issues)}.`;
    const r = await media.submit("video", { prompt, style: job.style, imageUrl: frame ? `data:image/jpeg;base64,${frame.toString("base64")}` : null, audioUrl, negative: plan.negative || "" });
    const row = (await db.query(
      `UPDATE trial_jobs SET provider_job_id = $2, model = $3, cost_usd = cost_usd + $4, raw_url = NULL, checked_at = now(), qa_retries = qa_retries + 1
        WHERE id = $1 AND status IN ('queued','running') RETURNING id`, [job.id, r.jobId, r.model, r.cost]
    )).rows[0];
    if (row) console.log(`free ticket ${job.ticket}: remade after qa (${verdict.score}/10)`);
    return Boolean(row);
  } catch (e) {
    console.error(`trial remake ${job.ticket}:`, e.message);
    return false;
  }
}

/** Results made before the mark existed: stamp the stored copy in place (and keep the clean original). */
async function backfill(limit = 3) {
  const rows = (await db.query(
    "SELECT * FROM trial_jobs WHERE status = 'done' AND watermarked = false AND stored_key IS NOT NULL ORDER BY created_at LIMIT $1", [limit]
  )).rows;
  for (const j of rows) {
    try {
      const original = await storage.getBuffer(j.stored_key, 150 * 1048576);
      if (j.kind === "image") await storage.put(`trial/src/${j.ticket}.jpg`, original, { contentType: "image/jpeg" });
      const marked = await watermark.apply(original, j.kind);
      await storage.put(j.stored_key, marked, { contentType: MIME[j.kind] });
      await db.query("UPDATE trial_jobs SET watermarked = true, result_url = $2 WHERE id = $1", [j.id, `store:${j.stored_key}`]);
      console.log(`trial ${j.ticket}: stamped the stored result`);
    } catch (e) { console.error(`trial backfill ${j.ticket}:`, e.message); }
  }
}

async function usage(hash, client = db) {
  const rows = (await client.query(
    `SELECT kind, count(*)::int AS n FROM trial_jobs
      WHERE ip_hash = $1 AND status <> 'failed' AND created_at > now() - make_interval(days => $2)
      GROUP BY kind`,
    [hash, WINDOW_DAYS]
  )).rows;
  const used = { image: 0, video: 0 };
  for (const r of rows) used[r.kind] = r.n;
  return { used, left: { image: Math.max(0, LIMIT.image - used.image), video: Math.max(0, LIMIT.video - used.video) } };
}

const spentToday = async (client = db) =>
  Number((await client.query(
    "SELECT coalesce(sum(cost_usd), 0) AS s FROM trial_jobs WHERE status <> 'failed' AND created_at >= date_trunc('day', now())"
  )).rows[0].s);

async function status(ip) {
  if (!enabled()) return { enabled: false };
  const u = await usage(ipHash(ip));
  const paused = (await spentToday()) + Math.min(media.COST.image, media.COST.video) > DAILY_BUDGET;
  return { enabled: true, paused, videoAvailable: media.falUp(), left: u.left, limit: LIMIT, windowDays: WINDOW_DAYS, videoSeconds: media.VIDEO_SECONDS };
}

/**
 * What the visitor's page gets. Only the stamped copy on our storage is ever linked (through the job's
 * id + token); a finished job whose stamped copy is not stored yet still reads as "running".
 */
const view = (j, token = null) => {
  const ready = j.status === "done" && j.watermarked;
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return {
    id: j.id, ticket: j.ticket, kind: j.kind, style: j.style, prompt: j.prompt,
    status: j.status === "done" && !ready ? "running" : j.status,
    speech: j.speech_text ? { text: j.speech_text, lang: j.speech_lang } : null,
    voice: j.voice ? { mode: j.voice.mode, label: j.voice.label || "", fitted: j.voice.fitted || "" } : null,
    url: ready ? `/api/trial/jobs/${j.id}/media${q}` : null,
    download: ready && token ? `/api/trial/jobs/${j.id}/download${q}` : null,
    error: j.status === "failed" ? j.error : null,
    sourceJob: j.source_job, createdAt: j.created_at,
  };
};

/** ChatGPT picture in the background (from the customer's photos when there are any), then stamped and stored. */
async function runOpenAI(job, refs = []) {
  try {
    const prompt = job.model_prompt || job.prompt;
    let buf = refs.length ? await media.openaiImageEdit(prompt, job.style, refs) : await media.openaiImage(prompt, job.style);
    if (job.style === "realistic" && media.realismOn()) buf = await media.realism(buf, refs); // keeps the ChatGPT picture if it fails
    await finalize(job, buf);
  } catch (e) {
    console.error(`trial openai ${job.id}:`, e.message);
    await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'", [job.id, e.message.slice(0, 300)])
      .catch((e2) => console.error(`trial openai ${job.id} (saving the failure):`, e2.message)); // e.g. during a shutdown
  }
}
async function startOpenAI(job, refs = []) {
  const row = (await db.query(
    "UPDATE trial_jobs SET provider = 'openai', model = $2, provider_job_id = $3, cost_usd = $4, status = 'running' WHERE id = $1 RETURNING *",
    [job.id, media.OPENAI_IMAGE_MODEL, `openai:${job.id}`, (refs.length ? media.COST.openaiEdit : media.COST.openaiImage) + (job.style === "realistic" && media.realismOn() ? media.COST.realism : 0)]
  )).rows[0];
  runOpenAI(row, refs).catch(() => {}); // not awaited: the visitor's page polls the job
  return row;
}

/**
 * The video's soundtrack from the customer's voice choice (see voices.js), fitted to the video length.
 *   voice = { mode: tts|own|convert|none, preset, gender, age, clip: { mp3, transcript, lang } }
 * Returns { mp3, info } or null (no voice).
 */
async function soundtrack(voice, speech, seconds) {
  const mode = voice?.mode || "tts";
  if (mode === "none") return null;
  const note = (f) => (f.cut ? "قُصّ ليناسب طول الفيديو" : f.tempo > 1 ? "سُرّع قليلاً ليناسب طول الفيديو" : "");
  // fitting is an improvement, never a reason to lose the voice: if ffmpeg cannot fit it, the track is used as it is
  const fitOr = (mp3, allowSpeedUp) => voices.fit(mp3, seconds, allowSpeedUp).catch((e) => {
    console.error(`voice fit: ${String(e.message).slice(0, 100)} – track used as it is`);
    return { mp3, tempo: 1, cut: false };
  });
  if (mode === "own" && voice.clip?.mp3) {
    const f = await fitOr(voice.clip.mp3, false); // the customer's own voice: cut if needed, never sped up
    return { mp3: f.mp3, info: { mode, label: "صوتك كما سجّلته", clip: voice.clip.id, fitted: note(f) } };
  }
  const chosen = voice?.preset && voice.preset !== "auto" ? { preset: voice.preset } : null;
  const type = { ...voices.typeFromSpeech(speech || {}), ...(voices.GENDERS.includes(voice?.gender) ? { gender: voice.gender } : {}), ...(voices.AGES.includes(voice?.age) ? { age: voice.age } : {}) };
  const v = voices.pick(chosen || type);
  const text = mode === "convert" ? clean(voice?.clip?.transcript) : clean(speech?.text);
  if (!v || !text) return null;
  const f = await fitOr(await voices.speak(v, { text, lang: speech?.lang || voice?.clip?.lang || "ar-IQ", tone: speech?.tone || "" }), true);
  return { mp3: f.mp3, info: { mode, preset: v.id, label: mode === "convert" ? `كلامك بصوت: ${v.label}` : v.label, clip: voice?.clip?.id || null, fitted: note(f) } };
}

/**
 * Reserves a slot and starts the job.
 * opts: { ip, kind: "image"|"video", style, prompt, modelPrompt, sourceJobId, sourceToken, termsSections, voice }
 */
async function start({ ip, kind, style, prompt, modelPrompt, plan = null, speech = null, refs = [], sourceJobId = null, sourceToken = null, termsSections = [], planFn = null, voice = null }) {
  if (!enabled()) throw new TrialError("off", "التجربة المجانية غير متاحة حالياً.");
  if (!["image", "video"].includes(kind)) throw new TrialError("invalid", "نوع غير معروف.");
  if (!["realistic", "cartoon"].includes(style)) throw new TrialError("invalid", "اختر واقعي أو كرتون.");
  const text = clean(prompt).slice(0, 800);
  if (text.length < 3) throw new TrialError("invalid", "اكتب وصفاً لما تريد إنشاءه.");
  const hash = ipHash(ip);
  if (kind === "video" && !media.falUp()) throw new TrialError("video_off", "الفيديو المجاني غير متاح حالياً، جرّب صورة 🙏");
  // The customer's chat pictures are used (not when animating a trial picture – that has its own first frame):
  //   picture → ChatGPT image *edit* of their photos (same faces, hair, clothes)
  //   video   → image-to-video starting from their photo (Character 1 first)
  const useRefs = !sourceJobId && refs.length > 0;
  const editImage = kind === "image" && useRefs && openaiOk();
  // pictures with writing in them go to the ChatGPT image model too (fal's FLUX misspells Arabic text)
  const routeOf = (pl) => kind === "image" && openaiOk() && (editImage || media.useOpenAIImage(style) || Boolean(pl?.onScreenText));
  // every video starts from a made picture (VIDEO_START_FRAME=1) – not when animating a trial picture, that has its own
  const framed = kind === "video" && !sourceJobId && media.startFrameOn() && storage.ready;
  const frameCost = framed ? media.frameCost(useRefs, style) : 0;
  const realismCost = kind === "image" && style === "realistic" && media.realismOn() ? media.COST.realism : 0;
  const costOf = (pl, sp) => (editImage ? media.COST.openaiEdit + realismCost : routeOf(pl) ? media.COST.openaiImage + realismCost : kind === "video" ? media.videoCost(Boolean(sp || voice?.clip)) + frameCost : media.COST[kind]) + (sp ? media.COST.speech : 0);
  // with planFn the plan is written after the visitor already has the job: reserve the highest possible cost
  const cost = planFn
    ? (kind === "video" ? Math.max(media.COST.video + media.COST.speech, media.videoCost(false)) + frameCost : Math.max(editImage ? media.COST.openaiEdit : 0, media.COST.openaiImage, media.COST.image) + realismCost)
    : costOf(plan, speech);

  // "animate this image": only one of this visitor's own finished images
  let imageUrl = null;
  if (kind === "video" && sourceJobId) {
    const src = (await db.query("SELECT * FROM trial_jobs WHERE id = $1", [String(sourceJobId)])).rows[0];
    const ok = src && src.kind === "image" && src.status === "done" && src.ip_hash === hash && safeEqual(src.token, sourceToken);
    if (!ok) throw new TrialError("invalid", "الصورة غير موجودة.");
    // the clean original (not the stamped copy) as a data URI – the video model needs no access to our storage
    let original = null;
    for (const key of [`trial/src/${src.ticket}.jpg`, src.stored_key]) {
      if (original || !key) continue;
      try { original = await storage.getBuffer(key, 25 * 1048576); } catch {}
    }
    if (!original) throw new TrialError("invalid", "الصورة غير متاحة.");
    imageUrl = `data:image/jpeg;base64,${original.toString("base64")}`;
  } else if (kind === "video" && useRefs) {
    imageUrl = `data:image/jpeg;base64,${refs[0].buf.toString("base64")}`; // the customer's photo is the first frame
  }

  const job = await db.tx(async (c) => {
    // one visitor (and the shared daily budget) at a time, so double clicks cannot pass the limits
    await c.query("SELECT pg_advisory_xact_lock(hashtext('trial-budget'))");
    const u = await usage(hash, c);
    if (u.left[kind] <= 0) {
      throw new TrialError("limit", kind === "image"
        ? `استخدمت كل الصور المجانية (${LIMIT.image}). اطلب فيديو كامل من الاستوديو!`
        : `استخدمت الفيديو المجاني (${LIMIT.video}). اطلب فيديو كامل من الاستوديو!`);
    }
    if ((await spentToday(c)) + cost > DAILY_BUDGET) throw new TrialError("paused", "التجربة المجانية متوقفة لليوم بسبب الضغط الكبير، جرّب غداً 🙏");
    const id = "T" + crypto.randomBytes(9).toString("base64url");
    const token = crypto.randomBytes(18).toString("base64url");
    let ticket = newTicket();
    for (let i = 0; i < 5 && (await c.query("SELECT 1 FROM trial_jobs WHERE ticket = $1", [ticket])).rowCount; i++) ticket = newTicket();
    return (await c.query(
      `INSERT INTO trial_jobs (id, token, ticket, ip_hash, kind, style, prompt, model_prompt, source_job, model, cost_usd, terms_sections, speech_text, speech_lang, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, $14) RETURNING *`,
      [id, token, ticket, hash, kind, style, text, modelPrompt || text, sourceJobId, cost, termsSections.length ? termsSections : null,
       speech?.text || null, speech?.lang || null, plan ? JSON.stringify(plan) : null]
    )).rows[0];
  });

  const launch = async (job, plan, speech, modelPrompt) => {
    if (routeOf(plan)) return { job: await startOpenAI(job, editImage ? refs : []), token: job.token };
    try {
      // the voice track first (the customer's choice: a character voice, their own recording, or their words in a
      // character's voice – Iraqi by default), fitted to the video length, then the video with it as the soundtrack
      let audioUrl = null;
      if (kind === "video" && (speech?.text || voice?.clip)) {
        try {
          const st = await soundtrack(voice, speech, media.VIDEO_SECONDS);
          if (st) {
            audioUrl = media.audioDataUri(st.mp3);
            const akey = `trial/${job.ticket}.mp3`;
            if (storage.ready) await storage.put(akey, st.mp3, { contentType: "audio/mpeg" });
            await db.query("UPDATE trial_jobs SET audio_key = $2, voice = $3 WHERE id = $1", [job.id, storage.ready ? akey : null, JSON.stringify(st.info)]);
          }
        } catch (e) { console.error(`trial ${job.ticket}: voice failed (${e.message.slice(0, 120)}) – video without voice`); }
      }
      // the opening moment as a picture first (ChatGPT image + realism pass, from the customer's photos when given);
      // kept for a quality-check remake. If it fails the video is made the way it was before.
      if (framed) {
        try {
          const frame = await media.startFrame(modelPrompt || text, style, useRefs ? refs : []);
          await storage.put(`trial/frame/${job.ticket}.jpg`, frame, { contentType: "image/jpeg" });
          imageUrl = `data:image/jpeg;base64,${frame.toString("base64")}`;
        } catch (e) { console.error(`trial ${job.ticket}: start frame failed (${e.message.slice(0, 120)}) – video without it`); }
      }
      const r = await media.submit(kind, { prompt: modelPrompt || text, style, imageUrl, audioUrl, negative: plan?.negative || "" });
      const row = (await db.query(
        "UPDATE trial_jobs SET provider = $2, model = $3, provider_job_id = $4, cost_usd = $5, status = 'running', image_first_frame = $6 WHERE id = $1 RETURNING *",
        [job.id, r.provider, r.model, r.jobId, r.cost, Boolean(imageUrl)]
      )).rows[0];
      return { job: row, token: job.token };
    } catch (e) {
      // fal out of credit / failing: pictures switch to ChatGPT automatically
      if (kind === "image" && openaiOk()) {
        console.error(`trial ${job.id}: fal failed (${e.message.slice(0, 120)}) – using ChatGPT image`);
        return { job: await startOpenAI(job, useRefs ? refs : []), token: job.token };
      }
      await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job.id, e.message.slice(0, 300)]);
      throw new TrialError("provider", "تعذّر بدء الإنشاء، حاول مرة ثانية بعد قليل (لم تُحتسب من رصيدك).");
    }
  };

  if (!planFn) return launch(job, plan, speech, modelPrompt);
  // the visitor gets the job (and sees it in the chat) at once; the plan is written and the job started in the background
  (async () => {
    try {
      const p = await planFn();
      await db.query(
        "UPDATE trial_jobs SET model_prompt = $2, plan = $3, speech_text = $4, speech_lang = $5, cost_usd = $6 WHERE id = $1",
        [job.id, p.plan.prompt || text, JSON.stringify(p.plan), p.plan.speech?.text || null, p.plan.speech?.lang || null, costOf(p.plan, p.plan.speech)]
      );
      await launch(job, p.plan, p.plan.speech, p.plan.prompt);
    } catch (e) {
      console.error(`trial ${job.ticket}: start failed (${String(e.message).slice(0, 160)})`);
      await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND provider_job_id IS NULL", [job.id, String(e.message).slice(0, 300)]).catch(() => {});
    }
  })();
  return { job, token: job.token };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** Asks the provider (at most every 3 s per job) and stores the outcome. */
async function refresh(job) {
  if (!["queued", "running"].includes(job.status)) return job;
  if (!job.provider_job_id) {
    if (Date.now() - new Date(job.created_at).getTime() < 3 * 60e3) return job;
    return (await db.query("UPDATE trial_jobs SET status = 'failed', error = 'not started', finished_at = now() WHERE id = $1 AND provider_job_id IS NULL RETURNING *", [job.id])).rows[0] || job;
  }
  if (job.provider === "openai") {
    // generated in this process; if the server restarted meanwhile, close it after 5 minutes (not counted)
    if (Date.now() - new Date(job.created_at).getTime() < 5 * 60e3) return job;
    return (await db.query(
      "UPDATE trial_jobs SET status = 'failed', error = 'interrupted', finished_at = now() WHERE id = $1 AND status = 'running' RETURNING *", [job.id]
    )).rows[0] || job;
  }
  if (job.raw_url) {
    // the provider has finished and the stamped copy is being made (in this process): nothing to ask yet;
    // if the server restarted meanwhile, one caller takes the job over after 3 minutes
    if (job.checked_at && Date.now() - new Date(job.checked_at).getTime() < 3 * 60e3) return job;
    const again = (await db.query(
      "UPDATE trial_jobs SET checked_at = now() WHERE id = $1 AND status = 'running' AND checked_at < now() - interval '3 minutes' RETURNING *", [job.id]
    )).rows[0];
    if (again) finalize(again).catch(() => {});
    return again || job;
  }
  if (job.checked_at && Date.now() - new Date(job.checked_at).getTime() < 3000) return job;
  let r;
  try { r = await media.poll(job); } catch (e) {
    console.error(`trial poll ${job.id}:`, e.message.slice(0, 200));
    // the provider rejected the request itself (bad input): fail now (not counted) instead of waiting 30 minutes
    r = /^fal (400|404|422)/.test(e.message) ? { status: "failed", error: e.message.slice(0, 300) } : { status: "running" };
  }
  // a job that never finishes is closed after 30 minutes (and not counted)
  if (r.status === "running" && Date.now() - new Date(job.created_at).getTime() > 30 * 60e3) r = { status: "failed", error: "timed out" };
  if (r.status === "done") {
    // finished at the provider: remember its address, stamp and store the copy in the background –
    // the job stays "running" (and the provider's unstamped link is never shown) until that is ready
    const row = (await db.query(
      "UPDATE trial_jobs SET checked_at = now(), raw_url = $2 WHERE id = $1 AND status IN ('queued','running') AND raw_url IS NULL RETURNING *",
      [job.id, r.url]
    )).rows[0];
    if (row) finalize(row).catch(() => {});
    return row || job;
  }
  const row = (await db.query(
    `UPDATE trial_jobs SET checked_at = now(), status = $2, error = $3,
            finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('queued','running') RETURNING *`,
    [job.id, r.status, r.error || null]
  )).rows[0];
  return row || job;
}

/** Recent free tickets for the team (admin API / Telegram). */
const list = async (limit = 50) =>
  (await db.query(
    `SELECT id, ticket, kind, style, prompt, speech_text, speech_lang, status, provider, model, cost_usd, error, stored_key, result_url,
            left(ip_hash, 8) AS visitor, created_at, finished_at
       FROM trial_jobs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit) || 50))]
  )).rows;
const byTicket = async (ticket) => (await db.query("SELECT * FROM trial_jobs WHERE ticket = $1", [String(ticket || "").toUpperCase()])).rows[0] || null;

/** The visitor's own job (id + token), without asking the provider. */
async function own(id, token) {
  const j = (await db.query("SELECT * FROM trial_jobs WHERE id = $1", [String(id || "")])).rows[0];
  return j && safeEqual(j.token, token) ? j : null;
}
/** The visitor's own job, refreshed from the provider. */
async function get(id, token) {
  const j = await own(id, token);
  return j ? refresh(j) : null;
}

/** Finishes jobs whose visitor closed the page (keeps usage and spend accurate). */
async function sweep() {
  const open = (await db.query(
    "SELECT * FROM trial_jobs WHERE status IN ('queued','running') AND (checked_at IS NULL OR checked_at < now() - interval '20 seconds') ORDER BY created_at LIMIT 20"
  )).rows;
  for (const j of open) await refresh(j).catch((e) => console.error("trial sweep:", e.message));
  // finished results not yet copied / reported (older jobs, or a restart in between)
  const unsaved = (await db.query(
    "SELECT * FROM trial_jobs WHERE status = 'done' AND notified_at IS NULL AND finished_at < now() - interval '1 minute' ORDER BY created_at LIMIT 10"
  )).rows;
  for (const j of unsaved) await archive(j).catch((e) => console.error("trial archive:", e.message));
  await backfill(); // results made before the mark existed
}
function startSweeper() {
  if (!enabled()) return;
  const tick = () => sweep().catch((e) => console.error("trial sweep:", e.message));
  setTimeout(tick, 5000).unref(); // stamp older results right after a restart
  setInterval(tick, 30e3).unref();
}

module.exports = { enabled, status, start, get, own, view, list, byTicket, setOnDone, sweep, backfill, startSweeper, refsFrom, ipHash, TrialError, LIMIT, DAILY_BUDGET };
