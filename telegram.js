/**
 * VI Iraq – Telegram delivery bot (@MyAIVideoDeliveryBot)
 *
 * Customer side
 *   - The site shows "open the bot" after an order: https://t.me/<bot>?start=<request_id>
 *   - /start <request_id> links the customer's chat to that order (Telegram bots can only
 *     message people who pressed Start, so this step is required before delivery).
 *
 * Owner (admin) side – in the bot chat
 *   - /admin <ADMIN_TOKEN>      register this chat as admin (or set TELEGRAM_ADMIN_CHAT_IDS in .env)
 *   - new orders arrive here automatically with the brief attached
 *   - /confirm <request_id>     mark confirmed, customer is told work has started
 *   - /deliver <request_id>     send as the caption of a video/document → forwarded to the customer
 *   - /deliver <request_id> <https://url.mp4>   deliver a video by URL
 *   - /status <request_id> · /pending
 *
 * HTTP (header x-admin-token) – used by automation
 *   GET  /api/requests                     list orders + status
 *   POST /api/requests/:id/confirm
 *   POST /api/requests/:id/deliver         { url } or { file: "<stored upload name>" }, optional caption
 *
 * .env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_IDS (optional, comma separated)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const clean = (v) => String(v || "").trim();
const TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN);
const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_FILE = path.join(__dirname, "data", "telegram.json");
const ENV_ADMINS = clean(process.env.TELEGRAM_ADMIN_CHAT_IDS).split(",").map((s) => s.trim()).filter(Boolean);

let BOT_USERNAME = clean(process.env.TELEGRAM_BOT_USERNAME) || "MyAIVideoDeliveryBot";
const configured = Boolean(TOKEN);
let mode = "off"; // off | webhook | polling

// ---------- tiny persistent store ----------
let db = { admins: [], users: {}, requests: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; } catch {}
function save() {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error("telegram store:", e.message); }
}
const admins = () => [...new Set([...ENV_ADMINS, ...db.admins.map(String)])];
const isAdmin = (chatId) => admins().includes(String(chatId));
const req = (id) => db.requests[id] || null;
function upsert(id, patch) { db.requests[id] = { ...(db.requests[id] || { id, status: "new", createdAt: new Date().toISOString() }), ...patch }; save(); return db.requests[id]; }

// ---------- Telegram API ----------
async function call(method, body, file) {
  if (!configured) throw new Error("TELEGRAM_BOT_TOKEN غير موجود في .env");
  let r;
  if (file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) fd.append(k, String(v));
    fd.append(file.field, new Blob([fs.readFileSync(file.path)]), file.name);
    r = await fetch(`${API}/${method}`, { method: "POST", body: fd });
  } else {
    r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || r.status}`);
  return data.result;
}
const send = (chatId, text, extra = {}) => call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const linkFor = (requestId) => `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(requestId)}`;

async function notifyAdmins(text, doc) {
  const ids = admins();
  if (!configured || !ids.length) return false;
  for (const id of ids) {
    try {
      await send(id, text);
      if (doc && fs.existsSync(doc.path)) await call("sendDocument", { chat_id: id, caption: doc.caption || "" }, { field: "document", path: doc.path, name: doc.name });
    } catch (e) { console.error("telegram notify:", e.message); }
  }
  return true;
}

// ---------- order lifecycle ----------
function registerRequest(order) {
  const r = upsert(order.requestId, { username: order.telegram, phone: order.phone, requesterId: order.requesterId, status: "new" });
  // if this customer already pressed Start before (same username), link right away
  const known = db.users[order.telegram.toLowerCase()];
  if (known && !r.chatId) upsert(order.requestId, { chatId: known });
  return req(order.requestId);
}

async function confirm(requestId, by = "admin") {
  const r = req(requestId);
  if (!r) throw new Error(`الطلب ${requestId} غير موجود`);
  upsert(requestId, { status: "confirmed", confirmedAt: new Date().toISOString(), confirmedBy: by });
  if (r.chatId) {
    await send(r.chatId, `✅ تم تأكيد طلبك <b>${esc(requestId)}</b>.\nبدأنا العمل على الفيديو، وستصلك النسخة النهائية هنا بمجرد اكتمالها.`).catch(() => {});
  }
  return req(requestId);
}

/** deliver({ url } | { path, name } | { copyFrom: {chatId, messageId} }) */
async function deliver(requestId, media, caption = "") {
  const r = req(requestId);
  if (!r) throw new Error(`الطلب ${requestId} غير موجود`);
  if (!r.chatId) throw new Error(`الزبون @${r.username} لم يضغط Start في البوت بعد، أرسل له الرابط: ${linkFor(requestId)}`);
  const text = caption || `🎬 فيديوك جاهز – طلب ${requestId}\nشكراً لاختيارك VI Iraq. إذا تحتاج تعديلاً، رد هنا أو من الموقع بنفس رقم الطلب.`;
  if (media.copyFrom) {
    await call("copyMessage", { chat_id: r.chatId, from_chat_id: media.copyFrom.chatId, message_id: media.copyFrom.messageId, caption: text });
  } else if (media.url) {
    await call("sendVideo", { chat_id: r.chatId, video: media.url, caption: text, supports_streaming: true });
  } else if (media.path) {
    const size = fs.statSync(media.path).size;
    if (size > 50 * 1024 * 1024) throw new Error("الملف أكبر من 50 MB (حد تيليغرام للبوتات) – ارفعه على رابط وأرسل الرابط");
    await call("sendVideo", { chat_id: r.chatId, caption: text, supports_streaming: true }, { field: "video", path: media.path, name: media.name || `${requestId}.mp4` });
  } else throw new Error("لا يوجد فيديو للتسليم");
  upsert(requestId, { status: "delivered", deliveredAt: new Date().toISOString() });
  return req(requestId);
}

// ---------- incoming updates ----------
let handlers = { onLinked: null };
async function handleUpdate(u) {
  const m = u.message || u.edited_message;
  if (!m || !m.chat) return;
  const chatId = m.chat.id;
  const username = (m.from?.username || "").toLowerCase();
  const text = (m.text || m.caption || "").trim();
  const [cmd, ...args] = text.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@.*$/, "");

  if (username) { db.users[username] = chatId; save(); }

  if (c === "/start") {
    const id = (args[0] || "").toUpperCase();
    if (id && req(id)) {
      upsert(id, { chatId, status: req(id).status === "new" ? "linked" : req(id).status });
      await send(chatId, `أهلاً بك في VI Iraq 👋\nتم ربط هذه المحادثة بطلبك <b>${esc(id)}</b>.\nسنرسل لك الفيديو النهائي هنا عند اكتماله، وستصلك رسالة عند تأكيد الطلب.`);
      handlers.onLinked && handlers.onLinked(id, chatId, username);
      await notifyAdmins(`🔗 الزبون @${esc(username || "?")} ربط محادثته بالطلب <b>${esc(id)}</b> (chat_id ${chatId}).`);
    } else {
      // link any pending orders of this username
      const mine = Object.values(db.requests).filter((r) => r.username?.toLowerCase() === username && !r.chatId);
      mine.forEach((r) => upsert(r.id, { chatId }));
      await send(chatId, mine.length
        ? `أهلاً بك 👋 تم ربط طلباتك: ${mine.map((r) => `<b>${esc(r.id)}</b>`).join("، ")}. سنرسل لك الفيديو هنا عند اكتماله.`
        : `أهلاً بك في بوت تسليم VI Iraq 👋\nاطلب فيديوك من الموقع ثم اضغط زر "افتح بوت التسليم"، أو أرسل هنا رقم طلبك (مثل VI-261011-K3F9).`);
    }
    return;
  }

  if (/^VI-\d{6}-[A-Z0-9]{4}$/i.test(text)) {
    const id = text.toUpperCase();
    if (req(id)) { upsert(id, { chatId }); await send(chatId, `تم ربط هذه المحادثة بالطلب <b>${esc(id)}</b> ✔`); }
    else await send(chatId, `لم أجد الطلب ${esc(id)}. تأكد من الرقم الموجود في الموقع.`);
    return;
  }

  if (c === "/admin") {
    const token = clean(process.env.ADMIN_TOKEN);
    if (token && args[0] === token) {
      if (!db.admins.includes(chatId)) { db.admins.push(chatId); save(); }
      await send(chatId, `✅ تم تسجيلك كمشرف. ستصلك الطلبات الجديدة هنا.\nالأوامر: /pending · /confirm ID · /deliver ID (مع فيديو) · /status ID`);
    } else await send(chatId, "كلمة المرور غير صحيحة.");
    return;
  }

  if (!isAdmin(chatId)) {
    await send(chatId, "هذا البوت يرسل لك فيديوك عند اكتماله. لإنشاء طلب جديد استخدم الموقع.");
    return;
  }

  // ----- admin commands -----
  try {
    if (c === "/pending") {
      const list = Object.values(db.requests).filter((r) => r.status !== "delivered").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20);
      await send(chatId, list.length ? list.map((r) => `• <b>${esc(r.id)}</b> – @${esc(r.username)} – ${r.status}${r.chatId ? "" : " (لم يضغط Start)"}`).join("\n") : "لا توجد طلبات معلقة.");
    } else if (c === "/status") {
      const r = req((args[0] || "").toUpperCase());
      await send(chatId, r ? `<pre>${esc(JSON.stringify(r, null, 2))}</pre>` : "غير موجود.");
    } else if (c === "/confirm") {
      const r = await confirm((args[0] || "").toUpperCase(), `telegram:${username || chatId}`);
      await send(chatId, `✅ ${esc(r.id)} مؤكد${r.chatId ? " وتم إبلاغ الزبون." : " – الزبون لم يضغط Start بعد، سيُبلَّغ عند الربط."}`);
      handlers.onConfirmed && handlers.onConfirmed(r);
    } else if (c === "/deliver") {
      const id = (args[0] || "").toUpperCase();
      const url = args[1];
      const hasMedia = m.video || m.document || m.animation;
      const r = hasMedia
        ? await deliver(id, { copyFrom: { chatId, messageId: m.message_id } }, text.replace(/^\/deliver\s+\S+\s*/i, "") || "")
        : url ? await deliver(id, { url }) : null;
      await send(chatId, r ? `📤 تم تسليم ${esc(r.id)} إلى @${esc(r.username)}.` : "أرسل الفيديو مع التعليق /deliver ID، أو /deliver ID رابط-الفيديو");
    } else {
      await send(chatId, "الأوامر: /pending · /confirm ID · /deliver ID (مع فيديو أو رابط) · /status ID");
    }
  } catch (e) {
    await send(chatId, `⚠️ ${esc(e.message)}`).catch(() => {});
  }
}

// ---------- transport: webhook on https, long polling otherwise ----------
let pollTimer = null;
async function init(app, publicUrl, h = {}) {
  handlers = { ...handlers, ...h };
  if (!configured) return { mode };
  try { BOT_USERNAME = (await call("getMe")).username || BOT_USERNAME; } catch (e) { console.error("telegram getMe:", e.message); return { mode: "error", error: e.message }; }
  const secret = crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 40);
  app.post(`/api/telegram/${secret}`, (rq, rs) => {
    if (rq.get("x-telegram-bot-api-secret-token") !== secret) return rs.sendStatus(403);
    rs.sendStatus(200);
    handleUpdate(rq.body || {}).catch((e) => console.error("telegram update:", e.message));
  });
  if (/^https:\/\//i.test(publicUrl)) {
    try {
      await call("setWebhook", { url: `${publicUrl}/api/telegram/${secret}`, secret_token: secret, allowed_updates: ["message", "edited_message"], drop_pending_updates: false });
      mode = "webhook";
    } catch (e) { console.error("telegram webhook:", e.message); }
  }
  // Local dev: poll only when TELEGRAM_POLL=1, otherwise leave the production webhook alone
  // (polling and a webhook cannot coexist on one bot token).
  if (mode !== "webhook" && clean(process.env.TELEGRAM_POLL) !== "1") { mode = "idle"; return { mode, username: BOT_USERNAME, admins: admins().length }; }
  if (mode !== "webhook") {
    await call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    mode = "polling";
    let offset = 0;
    const poll = async () => {
      try {
        const updates = await call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "edited_message"] });
        for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u).catch((e) => console.error("telegram update:", e.message)); }
      } catch (e) { if (!/409/.test(e.message)) console.error("telegram poll:", e.message); await new Promise((r) => setTimeout(r, 3000)); }
      pollTimer = setTimeout(poll, 300);
    };
    poll();
  }
  return { mode, username: BOT_USERNAME, admins: admins().length };
}

const list = () => Object.values(db.requests).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

module.exports = { configured, init, registerRequest, notifyAdmins, confirm, deliver, linkFor, req, list, get mode() { return mode; }, get username() { return BOT_USERNAME; }, adminsCount: () => admins().length };
