/**
 * VI Iraq – Telegram delivery bot (@MyAIVideoDeliveryBot). State lives in Postgres (orders.js).
 *
 * Customer side
 *   - The site shows "open the bot" after an order: https://t.me/<bot>?start=<request_id>
 *   - /start <request_id> links the customer's chat to that order (Telegram bots can only
 *     message people who pressed Start). The sender's username must match the order.
 *
 * Owner (admin) side – in the bot chat
 *   - /admin <ADMIN_TOKEN>      register this chat as admin (or set TELEGRAM_ADMIN_CHAT_IDS)
 *   - new orders arrive here automatically with the brief as a .txt document
 *   - /confirm <request_id>     approve the order, customer is told work has started
 *   - /deliver <request_id>     send as the caption of a video/document → forwarded to the customer
 *   - /deliver <request_id> <https://url.mp4>   deliver a video by URL
 *   - /status <request_id> · /pending
 *
 * HTTP (header x-admin-token) – see server.js: GET /api/requests, POST /api/requests/:id/confirm|deliver
 */
const crypto = require("crypto");
const orders = require("./orders");
const storage = require("./storage");

const clean = (v) => String(v || "").trim();
const TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN);
const API = `https://api.telegram.org/bot${TOKEN}`;
const ENV_ADMINS = clean(process.env.TELEGRAM_ADMIN_CHAT_IDS).split(",").map((s) => s.trim()).filter(Boolean);
const ID_RE = /^VI-\d{6}-[A-Z0-9]{4}$/i;

let BOT_USERNAME = clean(process.env.TELEGRAM_BOT_USERNAME) || "MyAIVideoDeliveryBot";
const configured = Boolean(TOKEN);
let mode = "off"; // off | webhook | polling | idle
let adminCount = ENV_ADMINS.length;

const admins = async () => {
  const ids = [...new Set([...ENV_ADMINS, ...(await orders.telegramAdmins().catch(() => []))])];
  adminCount = ids.length;
  return ids;
};
const isAdmin = async (chatId) => (await admins()).includes(String(chatId));

// ---------- Telegram API ----------
/** file: { field, buffer, name } */
async function call(method, body, file) {
  if (!configured) throw new Error("TELEGRAM_BOT_TOKEN غير موجود");
  let r;
  if (file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) fd.append(k, String(v));
    fd.append(file.field, new Blob([file.buffer]), file.name);
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

/** doc: { buffer, name, caption } – sent from memory, nothing touches the disk. */
async function notifyAdmins(text, doc) {
  const ids = await admins();
  if (!configured || !ids.length) return false;
  for (const id of ids) {
    try {
      await send(id, text);
      if (doc && doc.buffer?.length) await call("sendDocument", { chat_id: id, caption: doc.caption || "" }, { field: "document", buffer: doc.buffer, name: doc.name });
    } catch (e) { console.error("telegram notify:", e.message); }
  }
  return true;
}

// ---------- order lifecycle ----------
async function confirm(requestId, by = "admin") {
  const o = await orders.getOrder(requestId);
  if (!o) throw new Error(`الطلب ${requestId} غير موجود`);
  if (o.status === "queued") throw new Error(`الزبون @${o.telegram_username} لم يضغط Start في البوت بعد، لا يمكن التأكيد قبل الربط. الرابط: ${linkFor(o.request_id)}`);
  if (o.status !== "awaiting_admin") return { order: o, changed: false };
  const r = await orders.setStatus(o.request_id, "awaiting_admin", "prompt_ready", { by, action: "confirm" });
  if (!r) return { order: await orders.getOrder(o.request_id), changed: false };
  if (o.telegram_chat_id) {
    await send(o.telegram_chat_id, `✅ تم تأكيد طلبك <b>${esc(o.request_id)}</b>.\nبدأنا العمل على الفيديو، وستصلك النسخة النهائية هنا بمجرد اكتمالها.`).catch(() => {});
  }
  return { order: await orders.getOrder(o.request_id), changed: true };
}

/** Downloads a file the admin sent to the bot (bots can download up to 20 MB). */
async function downloadTelegramFile(fileId) {
  const f = await call("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error(`telegram download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * deliver(id, { url } | { key } | { copyFrom: { chatId, messageId, fileId, fileSize } }, caption)
 * Stores the video in R2 (videos/<id>.mp4) when possible, marks the order completed,
 * sends it to the customer's linked chat, then marks it delivered.
 */
async function deliver(requestId, media, caption = "") {
  const o = await orders.getOrder(requestId);
  if (!o) throw new Error(`الطلب ${requestId} غير موجود`);
  if (o.status === "cancelled") throw new Error(`الطلب ${o.request_id} ملغى`);
  if (!o.telegram_chat_id) throw new Error(`الزبون @${o.telegram_username} لم يضغط Start في البوت بعد، أرسل له الرابط: ${linkFor(o.request_id)}`);
  const id = o.request_id;
  const videoKey = `videos/${id}.mp4`;

  // 1) keep a copy in storage so the customer can also play it on the website
  let stored = false;
  try {
    if (storage.ready) {
      if (media.key) { await storage.move(String(media.key), videoKey); stored = true; }
      else if (media.url) { await storage.putFromUrl(videoKey, String(media.url)); stored = true; }
      else if (media.copyFrom?.fileId && (media.copyFrom.fileSize || 0) <= 20 * 1024 * 1024) {
        await storage.put(videoKey, await downloadTelegramFile(media.copyFrom.fileId), { contentType: "video/mp4" }); stored = true;
      }
    }
  } catch (e) {
    console.error("deliver store:", e.message);
    if (media.key) throw e; // nothing else to send in that case
  }
  if (stored) await orders.setVideo(id, videoKey);
  await orders.setStatus(id, ["awaiting_admin", "prompt_ready", "generating", "failed"], "completed", { by: "admin", action: "deliver" });

  // 2) send it on Telegram
  const text = caption || `🎬 فيديوك جاهز – طلب ${id}\nشكراً لاختيارك VI Iraq. إذا تحتاج تعديلاً، رد هنا أو من الموقع بنفس رقم الطلب.`;
  if (media.copyFrom) {
    await call("copyMessage", { chat_id: o.telegram_chat_id, from_chat_id: media.copyFrom.chatId, message_id: media.copyFrom.messageId, caption: text });
  } else if (stored) {
    let buf = null;
    try { buf = await storage.getBuffer(videoKey, 50 * 1024 * 1024); } catch {}
    if (buf) await call("sendVideo", { chat_id: o.telegram_chat_id, caption: text, supports_streaming: true }, { field: "video", buffer: buf, name: `${id}.mp4` });
    else await call("sendVideo", { chat_id: o.telegram_chat_id, video: media.url || (await storage.presignGet(videoKey, 3600)), caption: text, supports_streaming: true });
  } else if (media.url) {
    await call("sendVideo", { chat_id: o.telegram_chat_id, video: media.url, caption: text, supports_streaming: true });
  } else throw new Error("لا يوجد فيديو للتسليم");

  await orders.setStatus(id, "completed", "delivered", { by: "admin", channel: "telegram" });
  return orders.getOrder(id);
}

/** Admins: new order + brief as a .txt document (no 4096-character limit issue). */
async function announceOrder(o, brief) {
  const opt = o.options || {};
  const linked = o.telegram_chat_id ? "" : "\n⏳ الزبون لم يضغط Start بعد – الطلب ينتظر الربط.";
  return notifyAdmins(
    `🎬 <b>طلب جديد ${esc(o.request_id)}</b>\n@${esc(o.telegram_username)} · ${esc(o.phone)}\n${opt.quality}p · ${opt.seconds}s · ${esc(opt.language || "")} · ${esc(opt.characters || "")} شخصية · $${opt.price}\n${opt.attachments ? `مرفقات: ${opt.attachments}` : "بدون مرفقات"}\n\n${esc((opt.description || "-").slice(0, 600))}${linked}\n\nللتأكيد: /confirm ${esc(o.request_id)}`,
    brief ? { buffer: Buffer.from(brief, "utf8"), name: `${o.request_id}-brief.txt`, caption: `ملف الإنتاج ${o.request_id}` } : null
  );
}

// ---------- incoming updates ----------
async function handleUpdate(u) {
  const m = u.message || u.edited_message;
  if (!m || !m.chat) return;
  const chatId = m.chat.id;
  const username = (m.from?.username || "").toLowerCase();
  const text = (m.text || m.caption || "").trim();
  const [cmd = "", ...args] = text.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@.*$/, "");

  const linkOne = async (id) => {
    const res = await orders.linkTelegram(id, chatId, username);
    if (res.reason === "not_found") return send(chatId, `لم أجد الطلب ${esc(id)}. تأكد من الرقم الموجود في الموقع.`);
    if (res.reason === "username_mismatch") return send(chatId, `هذا الطلب مسجّل باسم تيليغرام آخر. افتح الرابط من حساب @${esc(res.order.telegram_username)} أو تواصل معنا.`);
    await send(chatId, `أهلاً بك في VI Iraq 👋\nتم ربط هذه المحادثة بطلبك <b>${esc(res.order.request_id)}</b>.\nسنرسل لك الفيديو النهائي هنا عند اكتماله، وستصلك رسالة عند تأكيد الطلب.`);
    await notifyAdmins(`🔗 الزبون @${esc(username || "?")} ربط محادثته بالطلب <b>${esc(res.order.request_id)}</b> (الحالة: ${res.order.status}).`);
  };

  if (c === "/start") {
    const id = (args[0] || "").toUpperCase();
    if (id && ID_RE.test(id)) return linkOne(id);
    const linked = await orders.linkByUsername(username, chatId);
    await send(chatId, linked.length
      ? `أهلاً بك 👋 تم ربط طلباتك: ${linked.map((r) => `<b>${esc(r)}</b>`).join("، ")}. سنرسل لك الفيديو هنا عند اكتماله.`
      : `أهلاً بك في بوت تسليم VI Iraq 👋\nاطلب فيديوك من الموقع ثم اضغط زر "افتح بوت التسليم"، أو أرسل هنا رقم طلبك (مثل VI-261011-K3F9).`);
    return;
  }

  if (ID_RE.test(text)) return linkOne(text.toUpperCase());

  if (c === "/admin") {
    const token = clean(process.env.ADMIN_TOKEN);
    const given = Buffer.from(String(args[0] || ""));
    if (token && given.length === Buffer.byteLength(token) && crypto.timingSafeEqual(given, Buffer.from(token))) {
      await orders.addTelegramAdmin(chatId, username);
      await send(chatId, `✅ تم تسجيلك كمشرف. ستصلك الطلبات الجديدة هنا.\nالأوامر: /pending · /confirm ID · /deliver ID (مع فيديو) · /status ID`);
    } else await send(chatId, "كلمة المرور غير صحيحة.");
    return;
  }

  if (!(await isAdmin(chatId))) {
    await send(chatId, "هذا البوت يرسل لك فيديوك عند اكتماله. لإنشاء طلب جديد استخدم الموقع.");
    return;
  }

  // ----- admin commands -----
  try {
    if (c === "/pending") {
      const list = await orders.listOrders({ openOnly: true, limit: 20 });
      await send(chatId, list.length ? list.map((r) => `• <b>${esc(r.request_id)}</b> – @${esc(r.telegram_username)} – ${r.status}${r.telegram_chat_id ? "" : " (لم يضغط Start)"}`).join("\n") : "لا توجد طلبات معلقة.");
    } else if (c === "/status") {
      const o = await orders.getOrder((args[0] || "").toUpperCase());
      if (!o) return void (await send(chatId, "غير موجود."));
      const view = { request_id: o.request_id, status: o.status, telegram: "@" + o.telegram_username, phone: o.phone, linked: Boolean(o.telegram_chat_id), options: o.options, video: Boolean(o.video_key), error: o.error, created_at: o.created_at, updated_at: o.updated_at };
      await send(chatId, `<pre>${esc(JSON.stringify(view, null, 2))}</pre>`);
    } else if (c === "/confirm") {
      const { order, changed } = await confirm((args[0] || "").toUpperCase(), `telegram:${username || chatId}`);
      await send(chatId, changed ? `✅ ${esc(order.request_id)} مؤكد وتم إبلاغ الزبون.` : `ℹ️ ${esc(order.request_id)} حالته الآن: ${order.status}`);
    } else if (c === "/deliver") {
      const id = (args[0] || "").toUpperCase();
      const url = args[1];
      const file = m.video || m.document || m.animation;
      const o = file
        ? await deliver(id, { copyFrom: { chatId, messageId: m.message_id, fileId: file.file_id, fileSize: file.file_size } }, text.replace(/^\/deliver\s+\S+\s*/i, "") || "")
        : url ? await deliver(id, { url }) : null;
      await send(chatId, o ? `📤 تم تسليم ${esc(o.request_id)} إلى @${esc(o.telegram_username)}.` : "أرسل الفيديو مع التعليق /deliver ID، أو /deliver ID رابط-الفيديو");
    } else {
      await send(chatId, "الأوامر: /pending · /confirm ID · /deliver ID (مع فيديو أو رابط) · /status ID");
    }
  } catch (e) {
    await send(chatId, `⚠️ ${esc(e.message)}`).catch(() => {});
  }
}

// ---------- transport: webhook on https, long polling otherwise ----------
let pollTimer = null;
async function init(app, publicUrl) {
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
  if (mode !== "webhook" && clean(process.env.TELEGRAM_POLL) !== "1") { mode = "idle"; return { mode, username: BOT_USERNAME, admins: (await admins()).length }; }
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
  return { mode, username: BOT_USERNAME, admins: (await admins()).length };
}

module.exports = { configured, init, notifyAdmins, announceOrder, confirm, deliver, linkFor, handleUpdate, get mode() { return mode; }, get username() { return BOT_USERNAME; }, adminsCount: () => adminCount };
