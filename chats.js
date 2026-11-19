/**
 * VI Iraq – saved chats (free and paid). The browser keeps a random device id and a chat id; every change of a chat
 * is saved here, so a refresh or a later visit brings the chat back with its results, and the history list opens older
 * chats. Only the device that made a chat can read it (the device id is a 128-bit secret kept in that browser).
 */
const db = require("./db");

const clean = (v) => String(v ?? "").trim();
const KEEP_DAYS = Math.max(1, Number(process.env.CHAT_KEEP_DAYS) || 90);
const DEVICE_RE = /^[a-f0-9]{32}$/;
const CHAT_RE = /^C[a-f0-9]{20}$/;
const MAX_MESSAGES = 300;

const deviceOf = (req) => { const d = clean(req.get("x-device")).toLowerCase(); return DEVICE_RE.test(d) ? d : null; };
const validId = (id) => CHAT_RE.test(clean(id));

/** The chat as sent by the page, trimmed to what is kept (pure – tested). */
function normalise(body = {}) {
  const files = (list) => (Array.isArray(list) ? list : []).slice(0, 12).map((f) => ({
    name: clean(f?.name).slice(0, 120), stored: clean(f?.stored).slice(0, 64), url: clean(f?.url).slice(0, 200),
    image: Boolean(f?.image), video: Boolean(f?.video), role: clean(f?.role).slice(0, 12),
  })).filter((f) => /^\/api\/uploads\/[\w-]{8,64}$/.test(f.url)); // only our own upload links come back into the page
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-MAX_MESSAGES)
    .filter((m) => m && ["user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: clean(m.content).slice(0, 4000), ...(m.files?.length ? { files: files(m.files) } : {}) }));
  const jobs = (Array.isArray(body.jobs) ? body.jobs : []).slice(-40)
    .map((j) => ({ id: clean(j?.id).slice(0, 64), token: clean(j?.token).slice(0, 128), at: Math.max(0, Math.min(MAX_MESSAGES, Number(j?.at) || 0)), ticket: clean(j?.ticket).slice(0, 20) }))
    .filter((j) => j.id && j.token);
  const o = body.order && typeof body.order === "object" ? body.order : null;
  const order = o && clean(o.requestId) ? { requestId: clean(o.requestId).slice(0, 40), requesterId: clean(o.requesterId).slice(0, 40), accessToken: clean(o.accessToken).slice(0, 128), at: Number(o.at) || messages.length } : null;
  const firstUser = messages.find((m) => m.role === "user" && m.content)?.content || (messages.some((m) => m.files?.length) ? "صور مرفقة" : "");
  const title = (clean(body.title) || firstUser).replace(/\s+/g, " ").slice(0, 80);
  const uploads = [...new Set(messages.flatMap((m) => (m.files || []).map((f) => f.stored)).filter(Boolean))];
  return { title, mode: body.mode === "order" ? "order" : "free", messages, jobs, order, uploads, tickets: [...new Set(jobs.map((j) => j.ticket).filter(Boolean))] };
}

async function save(device, id, body, ipHash) {
  const c = normalise(body);
  if (!c.messages.some((m) => m.role === "user")) return null; // a chat with only the welcome message is not kept
  const r = await db.query(
    `INSERT INTO chats (id, device, title, mode, messages, jobs, order_ref, uploads, tickets, ip_hashes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10]::text[])
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, mode = EXCLUDED.mode, messages = EXCLUDED.messages, jobs = EXCLUDED.jobs,
       order_ref = COALESCE(EXCLUDED.order_ref, chats.order_ref), uploads = EXCLUDED.uploads, tickets = EXCLUDED.tickets,
       ip_hashes = CASE WHEN $10 = ANY(chats.ip_hashes) THEN chats.ip_hashes ELSE (chats.ip_hashes || $10)[greatest(1, cardinality(chats.ip_hashes) - 18):] END,
       updated_at = now()
     WHERE chats.device = $2
     RETURNING id`,
    [id, device, c.title, c.mode, JSON.stringify(c.messages), JSON.stringify(c.jobs), c.order ? JSON.stringify(c.order) : null, c.uploads, c.tickets, ipHash]
  );
  return r.rows[0]?.id || null;
}

const list = async (device) => (await db.query(
  "SELECT id, title, mode, updated_at, jsonb_array_length(jobs) AS results, order_ref IS NOT NULL AS ordered FROM chats WHERE device = $1 ORDER BY updated_at DESC LIMIT 50",
  [device]
)).rows.map((r) => ({ id: r.id, title: r.title, mode: r.mode, updatedAt: r.updated_at, results: Number(r.results), ordered: r.ordered }));

async function get(device, id) {
  const r = (await db.query("SELECT id, title, mode, messages, jobs, order_ref, updated_at FROM chats WHERE id = $1 AND device = $2", [id, device])).rows[0];
  return r ? { id: r.id, title: r.title, mode: r.mode, messages: r.messages, jobs: r.jobs, order: r.order_ref, updatedAt: r.updated_at } : null;
}

const remove = async (device, id) => (await db.query("DELETE FROM chats WHERE id = $1 AND device = $2", [id, device])).rowCount > 0;
const sweep = async () => (await db.query(`DELETE FROM chats WHERE updated_at < now() - make_interval(days => $1)`, [KEEP_DAYS])).rowCount;

module.exports = { deviceOf, validId, normalise, save, list, get, remove, sweep, KEEP_DAYS };
