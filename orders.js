/**
 * VI Iraq – order data access (Postgres).
 *
 * Status flow
 *   queued ──(paid: Wayl confirms the link, when WAYL_API_KEY is set)──▶ awaiting_admin ──/confirm──▶ prompt_ready
 *          ──(otherwise: customer linked Telegram via /start)──────────▶ awaiting_admin
 *                                         └─(AUTO_GENERATE=true)──────────────────────────────────▶ prompt_ready
 *   prompt_ready → generating → completed → delivered          (failed / cancelled on errors)
 *   Customer labels: queued = مسجّل · awaiting_admin = مراجعة · prompt_ready/generating = قيد الإنجاز · completed/delivered = جاهز
 *
 * Every status change writes an events row.
 */
const crypto = require("crypto");
const db = require("./db");
const { requesterIdFor } = require("./validate");

// Wait between two orders of the same customer (default 20 min). An order that is already
// completed/delivered (or failed/cancelled) does not block: after receiving the video they can order again.
const cooldownMs = () => (Number(process.env.ORDER_COOLDOWN_MINUTES) || 20) * 60 * 1000;
const ROLE_DB = { char1: "character1", char2: "character2", char3: "character3", ref: "reference" };
const ROLE_UI = Object.fromEntries(Object.entries(ROLE_DB).map(([k, v]) => [v, k]));
const autoGenerate = () => String(process.env.AUTO_GENERATE || "false").trim().toLowerCase() === "true";
// with a payment provider configured, payment (not the Telegram link) is what confirms an order
const paymentsRequired = () => Boolean(String(process.env.WAYL_API_KEY || "").trim());

class OrderError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const newRequestId = () => {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = [...crypto.randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join("");
  return `VI-${ymd}-${rnd}`;
};

async function addEvent(client, requestId, kind, detail = null) {
  await (client || db).query("INSERT INTO events (request_id, kind, detail) VALUES ($1, $2, $3)", [requestId, kind, detail]);
}

/**
 * Creates an order for (telegram, phone). Inside one transaction:
 *   - an existing idempotency_key returns the earlier order (created=false)
 *   - the requester row is locked (SELECT … FOR UPDATE) and advisory locks serialise the same
 *     phone / username across different requester ids
 *   - at most one order per hour across requester_id, phone and telegram username
 */
async function createOrder({ telegram, phone, idempotencyKey = null, options = {}, messages = [] }) {
  if (!telegram) throw new OrderError("invalid", "telegram is required", { field: "telegram" });
  if (!phone) throw new OrderError("invalid", "phone is required", { field: "phone" });
  const requesterId = requesterIdFor(telegram, phone);
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 100) : null;

  try {
    return await db.tx(async (c) => {
      if (key) {
        const prev = (await c.query("SELECT * FROM orders WHERE idempotency_key = $1", [key])).rows[0];
        if (prev) {
          if (prev.requester_id !== requesterId) throw new OrderError("conflict", "idempotency key already used by another order");
          return { order: prev, created: false };
        }
      }
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phone:${phone}`]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tg:${telegram}`]);
      await c.query(
        "INSERT INTO requesters (id, telegram_username, phone) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
        [requesterId, telegram, phone]
      );
      await c.query("SELECT id FROM requesters WHERE id = $1 FOR UPDATE", [requesterId]);

      const last = (await c.query(
        `SELECT max(o.created_at) AS at FROM orders o JOIN requesters r ON r.id = o.requester_id
          WHERE (r.id = $1 OR r.phone = $2 OR r.telegram_username = $3)
            AND o.status NOT IN ('cancelled', 'failed', 'completed', 'delivered')`,
        [requesterId, phone, telegram]
      )).rows[0].at;
      if (last) {
        const waitMs = new Date(last).getTime() + cooldownMs() - Date.now();
        if (waitMs > 0) {
          const minutes = Math.ceil(waitMs / 60000);
          throw new OrderError("rate_limited", `لديك طلب قيد التنفيذ. يمكنك إرسال طلب جديد بعد استلام الفيديو أو بعد ${minutes} دقيقة.`, { retryAfterSec: Math.ceil(waitMs / 1000), minutes });
        }
      }

      let requestId;
      for (let i = 0; i < 5; i++) {
        requestId = newRequestId();
        if (!(await c.query("SELECT 1 FROM orders WHERE request_id = $1", [requestId])).rowCount) break;
      }
      const token = crypto.randomBytes(24).toString("base64url");
      const order = (await c.query(
        `INSERT INTO orders (request_id, requester_id, idempotency_key, access_token, options, messages)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [requestId, requesterId, key, token, options, JSON.stringify(messages)]
      )).rows[0];
      await addEvent(c, requestId, "created", { status: "queued" });
      return { order, created: true };
    });
  } catch (e) {
    // two identical requests racing: the loser hits the UNIQUE(idempotency_key) and gets the winner's order
    if (e.code === "23505" && key) {
      const prev = (await db.query("SELECT * FROM orders WHERE idempotency_key = $1", [key])).rows[0];
      if (prev && prev.requester_id === requesterId) return { order: prev, created: false };
    }
    throw e;
  }
}

/** UPDATE … WHERE status = ANY(from); writes an event when the row changed. */
async function setStatus(requestId, from, to, detail = {}, client = null) {
  const q = client || db;
  const row = (await q.query(
    `UPDATE orders SET status = $3,
            completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
            error = CASE WHEN $3 = 'failed' THEN $4 ELSE error END
      WHERE request_id = $1 AND status = ANY($2) RETURNING *`,
    [requestId, [].concat(from), to, detail.error || null]
  )).rows[0];
  if (row) await addEvent(client, requestId, "status", { to, ...detail });
  return row || null;
}

/**
 * Moves a queued order forward when allowed: paid (payments on) or Telegram linked (payments off).
 * AUTO_GENERATE=false → awaiting_admin (an admin approves spending credits with /confirm).
 */
async function advance(requestId) {
  const o = (await db.query(
    `SELECT o.status, o.paid_at, r.telegram_username, r.phone, r.telegram_chat_id
       FROM orders o JOIN requesters r ON r.id = o.requester_id WHERE o.request_id = $1`,
    [requestId]
  )).rows[0];
  if (!o || o.status !== "queued") return null;
  if (paymentsRequired() ? !o.paid_at : !o.telegram_username || !o.phone || !o.telegram_chat_id) return null;
  return setStatus(requestId, "queued", autoGenerate() ? "prompt_ready" : "awaiting_admin", { by: "system", reason: paymentsRequired() ? "paid" : "telegram linked" });
}

const getOrder = async (requestId) =>
  (await db.query(
    `SELECT o.*, r.telegram_username, r.phone, r.telegram_chat_id
       FROM orders o JOIN requesters r ON r.id = o.requester_id WHERE o.request_id = $1`,
    [String(requestId || "").toUpperCase()]
  )).rows[0] || null;

/** Owner check: request id + requester id + the order's access token must all match. */
async function getOwnedOrder(requestId, requesterId, token) {
  const o = await getOrder(requestId);
  if (!o || !requesterId || !token) return null;
  const a = Buffer.from(String(token)), b = Buffer.from(o.access_token);
  if (o.requester_id !== String(requesterId) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return o;
}

const listOrders = async ({ openOnly = false, limit = 100 } = {}) =>
  (await db.query(
    `SELECT o.request_id, o.requester_id, o.status, o.options, o.video_key, o.error, o.created_at, o.updated_at, o.completed_at, o.paid_at,
            (o.brief_md IS NOT NULL) AS has_brief, r.telegram_username, r.phone, r.telegram_chat_id
       FROM orders o JOIN requesters r ON r.id = o.requester_id
      ${openOnly ? "WHERE o.status NOT IN ('delivered','cancelled')" : ""}
      ORDER BY o.created_at DESC LIMIT $1`,
    [limit]
  )).rows;

async function saveBrief(requestId, briefMd) {
  await db.query("UPDATE orders SET brief_md = $2 WHERE request_id = $1", [requestId, briefMd]);
}

/** Follow-up chat after the order: keep the stored transcript current (capped). */
async function saveMessages(requestId, messages) {
  await db.query("UPDATE orders SET messages = $2 WHERE request_id = $1", [requestId, JSON.stringify(messages.slice(-200))]);
}

async function setVideo(requestId, key) {
  await db.query("UPDATE orders SET video_key = $2 WHERE request_id = $1", [requestId, key]);
  await addEvent(null, requestId, "video_stored", { key });
}

/**
 * Links a Telegram chat to the requester behind an order (/start <id>).
 * The sender's Telegram username must match the one on the order, so knowing a request id
 * is not enough to receive someone else's video.
 */
async function linkTelegram(requestId, chatId, username) {
  const o = await getOrder(requestId);
  if (!o) return { ok: false, reason: "not_found" };
  if (!username || username.toLowerCase() !== o.telegram_username) return { ok: false, reason: "username_mismatch", order: o };
  await db.query("UPDATE requesters SET telegram_chat_id = $2, telegram_linked_at = now() WHERE id = $1", [o.requester_id, chatId]);
  await addEvent(null, requestId, "telegram_linked", { chat_id: String(chatId) });
  const queued = (await db.query("SELECT request_id FROM orders WHERE requester_id = $1 AND status = 'queued'", [o.requester_id])).rows;
  for (const q of queued) await advance(q.request_id);
  return { ok: true, order: await getOrder(requestId) };
}

/** /start without an id: link every requester row with this username, return their open orders. */
async function linkByUsername(username, chatId) {
  if (!username) return [];
  const reqs = (await db.query(
    "UPDATE requesters SET telegram_chat_id = $2, telegram_linked_at = now() WHERE telegram_username = $1 RETURNING id",
    [username.toLowerCase(), chatId]
  )).rows;
  if (!reqs.length) return [];
  const open = (await db.query(
    "SELECT request_id, status FROM orders WHERE requester_id = ANY($1) AND status NOT IN ('delivered','cancelled') ORDER BY created_at",
    [reqs.map((r) => r.id)]
  )).rows;
  for (const o of open) {
    await addEvent(null, o.request_id, "telegram_linked", { chat_id: String(chatId), via: "username" });
    if (o.status === "queued") await advance(o.request_id);
  }
  return open.map((o) => o.request_id);
}

// ---------- uploads ----------
async function createPendingAsset({ uploadId, role, mediaType, mime, originalName, key, size }) {
  await db.query(
    `INSERT INTO assets (upload_id, role, media_type, mime, original_name, r2_key, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uploadId, ROLE_DB[role] || "reference", mediaType, mime, originalName, key, size]
  );
}

const getAsset = async (uploadId) =>
  (await db.query("SELECT * FROM assets WHERE upload_id = $1", [String(uploadId || "")])).rows[0] || null;

const orderAssets = async (requestId) =>
  (await db.query("SELECT * FROM assets WHERE request_id = $1 ORDER BY id", [requestId])).rows;

/** Attaches draft uploads to the new order; returns [{ asset, from, to }] for the caller to move in storage. */
async function claimAssets(requestId, requesterId, items) {
  const moves = [];
  for (const it of items.slice(0, 30)) {
    const role = ROLE_DB[it.role] || "reference";
    const a = (await db.query(
      `UPDATE assets SET request_id = $2, requester_id = $3, role = $4
        WHERE upload_id = $1 AND request_id IS NULL RETURNING *`,
      [String(it.stored || ""), requestId, requesterId, role]
    )).rows[0];
    if (!a) continue;
    const ext = (a.r2_key.match(/\.[a-z0-9]+$/i) || [""])[0];
    moves.push({ asset: a, from: a.r2_key, to: `uploads/${requestId}/${role}-${a.upload_id}${ext}` });
  }
  return moves;
}

async function setAssetKey(id, key) {
  await db.query("UPDATE assets SET r2_key = $2 WHERE id = $1", [id, key]);
}

// ---------- telegram admins ----------
const telegramAdmins = async () => (await db.query("SELECT chat_id FROM telegram_admins")).rows.map((r) => String(r.chat_id));
async function addTelegramAdmin(chatId, username) {
  await db.query("INSERT INTO telegram_admins (chat_id, username) VALUES ($1, $2) ON CONFLICT (chat_id) DO NOTHING", [chatId, username || null]);
}

module.exports = {
  OrderError, ROLE_DB, ROLE_UI, autoGenerate, paymentsRequired,
  createOrder, setStatus, advance, getOrder, getOwnedOrder, listOrders, saveBrief, saveMessages, setVideo, addEvent,
  linkTelegram, linkByUsername,
  createPendingAsset, getAsset, orderAssets, claimAssets, setAssetKey,
  telegramAdmins, addTelegramAdmin,
};
