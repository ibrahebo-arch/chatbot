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

const clean = (v) => String(v || "").trim();
const LIMIT = { image: Number(process.env.TRIAL_IMAGES ?? 3), video: Number(process.env.TRIAL_VIDEOS ?? 1) };
const WINDOW_DAYS = Number(process.env.TRIAL_WINDOW_DAYS) || 30;
const DAILY_BUDGET = Number(process.env.TRIAL_DAILY_BUDGET_USD ?? 5);
const SALT = clean(process.env.TRIAL_SALT) || clean(process.env.ADMIN_TOKEN) || "vi-iraq-trial";
const enabled = () => media.configured && clean(process.env.TRIAL_ENABLED).toLowerCase() !== "false";

class TrialError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const ipHash = (ip) => crypto.createHmac("sha256", SALT).update(String(ip || "?")).digest("hex").slice(0, 32);

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
  return { enabled: true, paused, left: u.left, limit: LIMIT, windowDays: WINDOW_DAYS, videoSeconds: media.VIDEO_SECONDS };
}

const view = (j) => ({
  id: j.id, kind: j.kind, style: j.style, prompt: j.prompt, status: j.status,
  url: j.status === "done" ? j.result_url : null, error: j.status === "failed" ? j.error : null,
  sourceJob: j.source_job, createdAt: j.created_at,
});

/**
 * Reserves a slot and starts the job.
 * opts: { ip, kind: "image"|"video", style, prompt, modelPrompt, sourceJobId, sourceToken, termsSections }
 */
async function start({ ip, kind, style, prompt, modelPrompt, sourceJobId = null, sourceToken = null, termsSections = [] }) {
  if (!enabled()) throw new TrialError("off", "التجربة المجانية غير متاحة حالياً.");
  if (!["image", "video"].includes(kind)) throw new TrialError("invalid", "نوع غير معروف.");
  if (!["realistic", "cartoon"].includes(style)) throw new TrialError("invalid", "اختر واقعي أو كرتون.");
  const text = clean(prompt).slice(0, 800);
  if (text.length < 3) throw new TrialError("invalid", "اكتب وصفاً لما تريد إنشاءه.");
  const hash = ipHash(ip);
  const cost = media.COST[kind];

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
    return (await c.query(
      `INSERT INTO trial_jobs (id, token, ip_hash, kind, style, prompt, model_prompt, source_job, model, cost_usd, terms_sections)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10) RETURNING *`,
      [id, token, hash, kind, style, text, modelPrompt || text, sourceJobId, cost, termsSections.length ? termsSections : null]
    )).rows[0];
  });

  try {
    const r = await media.submit(kind, { prompt: modelPrompt || text, style, imageUrl });
    const row = (await db.query(
      "UPDATE trial_jobs SET provider = $2, model = $3, provider_job_id = $4, cost_usd = $5, status = 'running' WHERE id = $1 RETURNING *",
      [job.id, r.provider, r.model, r.jobId, r.cost]
    )).rows[0];
    return { job: row, token: job.token };
  } catch (e) {
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
  if (job.checked_at && Date.now() - new Date(job.checked_at).getTime() < 3000) return job;
  let r;
  try { r = await media.poll(job); } catch (e) { r = { status: "running", note: e.message }; }
  // a job that never finishes is closed after 30 minutes (and not counted)
  if (r.status === "running" && Date.now() - new Date(job.created_at).getTime() > 30 * 60e3) r = { status: "failed", error: "timed out" };
  return (await db.query(
    `UPDATE trial_jobs SET checked_at = now(), status = $2, result_url = coalesce($3, result_url), error = $4,
            finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END
      WHERE id = $1 AND status IN ('queued','running') RETURNING *`,
    [job.id, r.status, r.url || null, r.error || null]
  )).rows[0] || job;
}

/** The visitor's own job (id + token). */
async function get(id, token) {
  const j = (await db.query("SELECT * FROM trial_jobs WHERE id = $1", [String(id || "")])).rows[0];
  if (!j || !safeEqual(j.token, token)) return null;
  return refresh(j);
}

/** Finishes jobs whose visitor closed the page (keeps usage and spend accurate). */
async function sweep() {
  const open = (await db.query(
    "SELECT * FROM trial_jobs WHERE status IN ('queued','running') AND (checked_at IS NULL OR checked_at < now() - interval '20 seconds') ORDER BY created_at LIMIT 20"
  )).rows;
  for (const j of open) await refresh(j).catch((e) => console.error("trial sweep:", e.message));
}
function startSweeper() {
  if (enabled()) setInterval(() => sweep().catch((e) => console.error("trial sweep:", e.message)), 30e3).unref();
}

module.exports = { enabled, status, start, get, view, sweep, startSweeper, ipHash, TrialError, LIMIT, DAILY_BUDGET };
