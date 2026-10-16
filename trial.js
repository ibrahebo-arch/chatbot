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

const clean = (v) => String(v || "").trim();
const LIMIT = { image: Number(process.env.TRIAL_IMAGES ?? 3), video: Number(process.env.TRIAL_VIDEOS ?? 1) };
const WINDOW_DAYS = Number(process.env.TRIAL_WINDOW_DAYS) || 30;
const DAILY_BUDGET = Number(process.env.TRIAL_DAILY_BUDGET_USD ?? 5);
const SALT = clean(process.env.TRIAL_SALT) || clean(process.env.ADMIN_TOKEN) || "vi-iraq-trial";
// ChatGPT pictures come back as files, so they need storage (the VPS has it; Render without R2 does not)
const openaiOk = () => media.openaiReady && storage.ready;
const enabled = () => (media.configured || openaiOk()) && clean(process.env.TRIAL_ENABLED).toLowerCase() !== "false";

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

/**
 * Keeps our own copy of a finished result (provider links can expire) as trial/<ticket>.<ext>,
 * then reports the job once (notified_at) – used for both providers.
 */
async function archive(job) {
  let j = job;
  try {
    if (!j.stored_key && storage.ready) {
      let key = null;
      if (String(j.result_url).startsWith("store:")) key = j.result_url.slice(6);
      else {
        const url = new URL(j.result_url);
        if (url.protocol === "https:" && /(^|\.)fal\.(media|run|ai)$/i.test(url.hostname)) {
          const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            key = `trial/${j.ticket}.${j.kind === "video" ? "mp4" : "jpg"}`;
            await storage.put(key, buf, { contentType: j.kind === "video" ? "video/mp4" : "image/jpeg" });
          }
        }
      }
      if (key) j = (await db.query("UPDATE trial_jobs SET stored_key = $2 WHERE id = $1 RETURNING *", [j.id, key])).rows[0] || j;
    }
  } catch (e) { console.error(`trial archive ${j.ticket}:`, e.message); }
  const first = (await db.query("UPDATE trial_jobs SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING id", [j.id])).rows[0];
  if (first) await onDone(j).catch((e) => console.error("trial notify:", e.message));
  return j;
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

/** Pictures kept on our storage are served through the job (id + token); provider links are used as they are. */
const view = (j, token = null) => {
  const done = j.status === "done";
  const own = done && (j.stored_key || String(j.result_url || "").startsWith("store:"));
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return {
    id: j.id, ticket: j.ticket, kind: j.kind, style: j.style, prompt: j.prompt, status: j.status,
    speech: j.speech_text ? { text: j.speech_text, lang: j.speech_lang } : null,
    url: done ? (own ? `/api/trial/jobs/${j.id}/media${q}` : j.result_url) : null,
    download: done && token ? `/api/trial/jobs/${j.id}/download${q}` : null,
    error: j.status === "failed" ? j.error : null,
    sourceJob: j.source_job, createdAt: j.created_at,
  };
};

/** ChatGPT picture in the background: generated, saved to storage, then the job is done. */
async function runOpenAI(job) {
  try {
    const buf = await media.openaiImage(job.model_prompt || job.prompt, job.style);
    const key = `trial/${job.ticket || job.id}.jpg`;
    await storage.put(key, buf, { contentType: "image/jpeg" });
    const done = (await db.query(
      "UPDATE trial_jobs SET status = 'done', result_url = $2, stored_key = $3, finished_at = now() WHERE id = $1 AND status = 'running' RETURNING *",
      [job.id, `store:${key}`, key]
    )).rows[0];
    if (done) await archive(done);
  } catch (e) {
    console.error(`trial openai ${job.id}:`, e.message);
    await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'", [job.id, e.message.slice(0, 300)])
      .catch((e2) => console.error(`trial openai ${job.id} (saving the failure):`, e2.message)); // e.g. during a shutdown
  }
}
async function startOpenAI(job) {
  const row = (await db.query(
    "UPDATE trial_jobs SET provider = 'openai', model = $2, provider_job_id = $3, cost_usd = $4, status = 'running' WHERE id = $1 RETURNING *",
    [job.id, media.OPENAI_IMAGE_MODEL, `openai:${job.id}`, media.COST.openaiImage]
  )).rows[0];
  runOpenAI(row).catch(() => {}); // not awaited: the visitor's page polls the job
  return row;
}

/**
 * Reserves a slot and starts the job.
 * opts: { ip, kind: "image"|"video", style, prompt, modelPrompt, sourceJobId, sourceToken, termsSections }
 */
async function start({ ip, kind, style, prompt, modelPrompt, plan = null, speech = null, sourceJobId = null, sourceToken = null, termsSections = [] }) {
  if (!enabled()) throw new TrialError("off", "التجربة المجانية غير متاحة حالياً.");
  if (!["image", "video"].includes(kind)) throw new TrialError("invalid", "نوع غير معروف.");
  if (!["realistic", "cartoon"].includes(style)) throw new TrialError("invalid", "اختر واقعي أو كرتون.");
  const text = clean(prompt).slice(0, 800);
  if (text.length < 3) throw new TrialError("invalid", "اكتب وصفاً لما تريد إنشاءه.");
  const hash = ipHash(ip);
  if (kind === "video" && !media.falUp()) throw new TrialError("video_off", "الفيديو المجاني غير متاح حالياً، جرّب صورة 🙏");
  // pictures with writing in them go to the ChatGPT image model (fal's FLUX misspells Arabic text)
  const viaOpenAI = kind === "image" && openaiOk() && (media.useOpenAIImage(style) || Boolean(plan?.onScreenText));
  const cost = (viaOpenAI ? media.COST.openaiImage : media.COST[kind]) + (speech ? media.COST.speech : 0);

  // "animate this image": only one of this visitor's own finished images
  let imageUrl = null;
  if (kind === "video" && sourceJobId) {
    const src = (await db.query("SELECT * FROM trial_jobs WHERE id = $1", [String(sourceJobId)])).rows[0];
    const ok = src && src.kind === "image" && src.status === "done" && src.ip_hash === hash && safeEqual(src.token, sourceToken);
    if (!ok) throw new TrialError("invalid", "الصورة غير موجودة.");
    imageUrl = src.result_url;
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

  if (viaOpenAI) return { job: await startOpenAI(job), token: job.token };
  try {
    // the voice track first (Iraqi by default), then the video with it as the soundtrack
    let audioUrl = null;
    if (kind === "video" && speech?.text) {
      try {
        const mp3 = await media.speak(speech);
        audioUrl = media.audioDataUri(mp3);
        if (storage.ready) {
          const akey = `trial/${job.ticket}.mp3`;
          await storage.put(akey, mp3, { contentType: "audio/mpeg" });
          await db.query("UPDATE trial_jobs SET audio_key = $2 WHERE id = $1", [job.id, akey]);
        }
      } catch (e) { console.error(`trial ${job.ticket}: voice failed (${e.message.slice(0, 120)}) – video without voice`); }
    }
    const r = await media.submit(kind, { prompt: modelPrompt || text, style, imageUrl, audioUrl, negative: plan?.negative || "" });
    const row = (await db.query(
      "UPDATE trial_jobs SET provider = $2, model = $3, provider_job_id = $4, cost_usd = $5, status = 'running' WHERE id = $1 RETURNING *",
      [job.id, r.provider, r.model, r.jobId, r.cost]
    )).rows[0];
    return { job: row, token: job.token };
  } catch (e) {
    // fal out of credit / failing: pictures switch to ChatGPT automatically
    if (kind === "image" && openaiOk()) {
      console.error(`trial ${job.id}: fal failed (${e.message.slice(0, 120)}) – using ChatGPT image`);
      return { job: await startOpenAI(job), token: job.token };
    }
    await db.query("UPDATE trial_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job.id, e.message.slice(0, 300)]);
    throw new TrialError("provider", "تعذّر بدء الإنشاء، حاول مرة ثانية بعد قليل (لم تُحتسب من رصيدك).");
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** Asks the provider (at most every 3 s per job) and stores the outcome. */
async function refresh(job) {
  if (!["queued", "running"].includes(job.status) || !job.provider_job_id) return job;
  if (job.provider === "openai") {
    // generated in this process; if the server restarted meanwhile, close it after 5 minutes (not counted)
    if (Date.now() - new Date(job.created_at).getTime() < 5 * 60e3) return job;
    return (await db.query(
      "UPDATE trial_jobs SET status = 'failed', error = 'interrupted', finished_at = now() WHERE id = $1 AND status = 'running' RETURNING *", [job.id]
    )).rows[0] || job;
  }
  if (job.checked_at && Date.now() - new Date(job.checked_at).getTime() < 3000) return job;
  let r;
  try { r = await media.poll(job); } catch (e) { console.error(`trial poll ${job.id}:`, e.message); r = { status: "running" }; }
  // a job that never finishes is closed after 30 minutes (and not counted)
  if (r.status === "running" && Date.now() - new Date(job.created_at).getTime() > 30 * 60e3) r = { status: "failed", error: "timed out" };
  const row = (await db.query(
    `UPDATE trial_jobs SET checked_at = now(), status = $2, result_url = coalesce($3, result_url), error = $4,
            finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('queued','running') RETURNING *`,
    [job.id, r.status, r.url || null, r.error || null]
  )).rows[0];
  // finished: keep our copy and tell the team (in the background – the visitor sees the provider link at once)
  if (row?.status === "done") archive(row).catch(() => {});
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
}
function startSweeper() {
  if (enabled()) setInterval(() => sweep().catch((e) => console.error("trial sweep:", e.message)), 30e3).unref();
}

module.exports = { enabled, status, start, get, own, view, list, byTicket, setOnDone, sweep, startSweeper, ipHash, TrialError, LIMIT, DAILY_BUDGET };
