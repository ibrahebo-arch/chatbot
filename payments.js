/**
 * VI Iraq – payments through Wayl payment links (https://api.thewayl.com, amounts in IQD).
 *
 *   WAYL_API_KEY     creates payment links (POST /api/v1/links)
 *   WAYL_VERIFY_KEY  reads a link back to check it was paid (GET /api/v1/links/:referenceId);
 *                    falls back to WAYL_API_KEY when unset
 *
 * Payment is never taken from what the browser or the webhook says: the webhook and the customer's
 * status polling only *trigger* a check, and the order is marked paid only when Wayl itself returns
 * Complete/Delivered for one of the order's own links with the expected amount.
 */
const crypto = require("crypto");
const db = require("./db");
const orders = require("./orders");

const clean = (v) => String(v || "").trim();
const API = (clean(process.env.WAYL_API_URL) || "https://api.thewayl.com").replace(/\/+$/, "") + "/api/v1";
const CREATE_KEY = clean(process.env.WAYL_API_KEY);
const VERIFY_KEY = clean(process.env.WAYL_VERIFY_KEY) || CREATE_KEY;
const ENV = clean(process.env.WAYL_ENV).toLowerCase() === "live" ? "live" : "test";
// Prices are kept in USD; Wayl takes IQD. Rounded up to a multiple of 250 IQD (Wayl minimum 1000).
const IQD_PER_USD = Number(process.env.PAY_IQD_PER_USD) || 1310;
const LINK_TTL = /^\d+[mhd]$/.test(clean(process.env.WAYL_LINK_EXPIRES)) ? clean(process.env.WAYL_LINK_EXPIRES) : "24h";
// Wayl can only call back the domain the store was registered with; PAY_PUBLIC_URL overrides PUBLIC_URL for that.
const WEBHOOK_SECRET = clean(process.env.WAYL_WEBHOOK_SECRET) || (CREATE_KEY ? crypto.createHash("sha256").update("vi-wayl:" + CREATE_KEY).digest("hex").slice(0, 40) : "");

const PAID = new Set(["Complete", "Delivered"]);
const DEAD = new Set(["Cancelled", "Rejected", "Returned"]);

const configured = Boolean(CREATE_KEY);
const iqdFor = (usd) => Math.max(1000, Math.ceil((Number(usd) * IQD_PER_USD) / 250) * 250);
const ttlMs = (s) => Number(s.slice(0, -1)) * { m: 60e3, h: 3600e3, d: 86400e3 }[s.slice(-1)];

let onPaid = async () => {};
const setOnPaid = (fn) => { onPaid = fn; };

async function wayl(key, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { "X-WAYL-AUTHENTICATION": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`wayl ${method} ${path.split("/")[1]}: ${r.status} ${data.message || ""}`.trim());
  return data.data;
}

const latestPayment = async (requestId) =>
  (await db.query("SELECT * FROM payments WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1", [requestId])).rows[0] || null;

const usable = (p) => p && p.url && !p.paid_at && !DEAD.has(p.status) && (!p.expires_at || new Date(p.expires_at).getTime() - Date.now() > 5 * 60e3);

/** Payment link for an unpaid order: reuses the open one, otherwise creates a new link at Wayl. */
async function linkFor(order, publicUrl) {
  if (!configured) throw new Error("payments are not configured");
  if (order.paid_at) return { paid: true };
  if (order.status !== "queued") throw new Error(`order ${order.request_id} is ${order.status}`);
  const last = await latestPayment(order.request_id);
  if (usable(last)) return { paid: false, url: last.url, amountIqd: last.amount_iqd, referenceId: last.reference_id };

  const usd = Number(order.options?.price) || 0;
  const amountIqd = iqdFor(usd);
  const n = Number((await db.query("SELECT count(*) FROM payments WHERE request_id = $1", [order.request_id])).rows[0].count) + 1;
  const referenceId = `${order.request_id}-P${n}`;
  const base = publicUrl.replace(/\/+$/, "");
  const o = order.options || {};
  const link = await wayl(CREATE_KEY, "POST", "/links", {
    env: ENV,
    referenceId,
    total: amountIqd,
    currency: "IQD",
    customParameter: order.request_id,
    lineItem: [{ label: `فيديو VI Iraq ${order.request_id} – ${o.quality}p · ${o.seconds} ثانية`.slice(0, 255), amount: amountIqd, type: "increase" }],
    webhookUrl: `${base}/api/wayl/webhook`,
    webhookSecret: WEBHOOK_SECRET,
    redirectionUrl: `${base}/paid`,
    linkExpiresIn: LINK_TTL,
  });
  await db.query(
    `INSERT INTO payments (request_id, reference_id, provider_id, url, env, amount_iqd, amount_usd, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [order.request_id, referenceId, link.id, link.url, ENV, amountIqd, usd, link.status || "Created", new Date(Date.now() + ttlMs(LINK_TTL))]
  );
  await orders.addEvent(null, order.request_id, "payment_link", { reference_id: referenceId, amount_iqd: amountIqd, env: ENV });
  return { paid: false, url: link.url, amountIqd, referenceId };
}

/**
 * Asks Wayl (verification key) for the link's status and stores it. A paid link marks the order paid
 * exactly once (UPDATE … WHERE paid_at IS NULL) and calls onPaid(order).
 */
async function check(referenceId) {
  const p = (await db.query("SELECT * FROM payments WHERE reference_id = $1", [String(referenceId || "")])).rows[0];
  if (!p) return null;
  if (p.paid_at) return { payment: p, paid: true, changed: false };
  const link = await wayl(VERIFY_KEY, "GET", `/links/${encodeURIComponent(p.reference_id)}`);
  const status = String(link?.status || p.status);
  const amountOk = Number(link?.total) === Number(p.amount_iqd);
  const paid = PAID.has(status) && amountOk;
  const row = (await db.query(
    `UPDATE payments SET status = $2, payment_method = COALESCE($3, payment_method), checked_at = now(),
            paid_at = CASE WHEN $4 THEN COALESCE(paid_at, now()) ELSE paid_at END
      WHERE id = $1 RETURNING *`,
    [p.id, status, link?.paymentMethod || null, paid]
  )).rows[0];
  if (PAID.has(status) && !amountOk) {
    console.error(`payment ${p.reference_id}: paid amount ${link?.total} differs from ${p.amount_iqd} IQD – not accepted`);
    await orders.addEvent(null, p.request_id, "payment_mismatch", { reference_id: p.reference_id, wayl_total: link?.total, expected: p.amount_iqd });
  }
  if (!paid) return { payment: row, paid: false, changed: false };

  const order = (await db.query(
    "UPDATE orders SET paid_at = now() WHERE request_id = $1 AND paid_at IS NULL RETURNING request_id",
    [p.request_id]
  )).rows[0];
  if (!order) return { payment: row, paid: true, changed: false };
  await orders.addEvent(null, p.request_id, "paid", { reference_id: p.reference_id, amount_iqd: p.amount_iqd, method: row.payment_method, env: p.env });
  await orders.advance(p.request_id);
  await onPaid(await orders.getOrder(p.request_id)).catch((e) => console.error("onPaid:", e.message));
  return { payment: row, paid: true, changed: true };
}

// The customer's page polls its order every few seconds; Wayl is asked at most every 4 s per order.
const lastCheck = new Map();
async function checkOrder(requestId) {
  const p = await latestPayment(requestId);
  if (!p || p.paid_at || DEAD.has(p.status)) return p;
  const now = Date.now();
  if (now - (lastCheck.get(requestId) || 0) < 4000) return p;
  lastCheck.set(requestId, now);
  try { return (await check(p.reference_id))?.payment || p; } catch (e) { console.error("payment check:", e.message); return p; }
}

/** Safety net for missed webhooks: unpaid links from the last 3 days are re-checked every minute. */
async function sweep() {
  const open = (await db.query(
    `SELECT reference_id FROM payments
      WHERE paid_at IS NULL AND status NOT IN ('Cancelled','Rejected','Returned')
        AND created_at > now() - interval '3 days'
        AND (checked_at IS NULL OR checked_at < now() - interval '50 seconds')
      ORDER BY created_at DESC LIMIT 50`
  )).rows;
  for (const { reference_id } of open) await check(reference_id).catch((e) => console.error("payment sweep:", e.message));
}
function startSweeper() {
  if (!configured) return;
  setInterval(() => sweep().catch((e) => console.error("payment sweep:", e.message)), 60e3).unref();
}

/** Webhook: only the reference id is taken from the body; the status always comes from Wayl's API. */
async function webhook(body) {
  const b = body || {};
  const ref = clean(b.referenceId || b.data?.referenceId || b.reference_id);
  if (!ref) return { ok: false, reason: "no referenceId" };
  const r = await check(ref);
  return { ok: Boolean(r), paid: Boolean(r?.paid) };
}

const view = (p) => p ? {
  status: p.status, paid: Boolean(p.paid_at), amountIqd: p.amount_iqd, method: p.payment_method || null,
  url: usable(p) ? p.url : null, env: p.env,
} : null;

async function verifyKeys() {
  if (!configured) return { ok: false, error: "WAYL_API_KEY not set" };
  try {
    await wayl(CREATE_KEY, "GET", "/verify-auth-key");
    if (VERIFY_KEY !== CREATE_KEY) await wayl(VERIFY_KEY, "GET", "/verify-auth-key");
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  configured, ENV, IQD_PER_USD, iqdFor, linkFor, check, checkOrder, latestPayment, webhook, view,
  startSweeper, setOnPaid, verifyKeys, PAID, DEAD,
};
