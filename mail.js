/**
 * VI Iraq – email sender (Brevo or Resend, over their HTTPS APIs).
 *
 * .env:
 *   MAIL_PROVIDER = brevo | resend      (optional – picked automatically from whichever key is set)
 *   BREVO_API_KEY = xkeysib-...          (Brevo → SMTP & API → API keys)
 *   RESEND_API_KEY = re_...              (Resend → API Keys)
 *   MAIL_FROM     = sender address       (Brevo: a sender verified in Brevo; Resend: onboarding@resend.dev or your domain)
 *   MAIL_TO       = where orders arrive
 */
const fs = require("fs");

const clean = (v) => String(v || "").trim();
const BREVO_API_KEY = clean(process.env.BREVO_API_KEY);
const RESEND_API_KEY = clean(process.env.RESEND_API_KEY);
const PROVIDER = (clean(process.env.MAIL_PROVIDER).toLowerCase() || (BREVO_API_KEY ? "brevo" : RESEND_API_KEY ? "resend" : ""));
const MAIL_TO = clean(process.env.MAIL_TO) || "ibrahim2dms@gmail.com";
const MAIL_FROM = clean(process.env.MAIL_FROM) || (PROVIDER === "resend" ? "onboarding@resend.dev" : "ibrahebo@gmail.com");
const FROM_NAME = clean(process.env.MAIL_FROM_NAME) || "VI Iraq";
// Total size of files attached to one email; bigger files are sent as links instead.
const ATTACH_BUDGET = (Number(process.env.MAIL_ATTACH_MB) || 10) * 1024 * 1024;

const KEY = PROVIDER === "brevo" ? BREVO_API_KEY : PROVIDER === "resend" ? RESEND_API_KEY : "";
const configured = Boolean(PROVIDER && KEY);
let state = {
  ok: false,
  provider: PROVIDER || "none",
  error: configured ? "لم يتم الفحص بعد" : "البريد غير مفعّل: أضف BREVO_API_KEY أو RESEND_API_KEY في .env",
};

async function api(url, opts = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (PROVIDER === "brevo") headers["api-key"] = KEY;
  else headers.Authorization = `Bearer ${KEY}`;
  const r = await fetch(url, { ...opts, headers });
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, data };
}

const errText = (res) => `${PROVIDER} ${res.status}: ${res.data?.message || res.data?.name || res.data?.code || "خطأ غير معروف"}`;

/** Checks the API key (and, for Brevo, that MAIL_FROM is a verified sender). */
async function check() {
  if (!configured) return state;
  try {
    if (PROVIDER === "brevo") {
      const acc = await api("https://api.brevo.com/v3/account");
      if (!acc.ok) {
        const msg = String(acc.data?.message || "");
        if (/unrecogni[sz]ed IP/i.test(msg)) {
          const ip = (msg.match(/\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,}/i) || [""])[0];
          throw new Error(`Brevo حظر عنوان IP غير معروف ${ip}: أضفه من https://app.brevo.com/security/authorised_ips أو عطّل حظر الـ IP هناك.`);
        }
        throw new Error(acc.status === 401 ? `مفتاح Brevo مرفوض (401): ${msg || "غير صحيح"}` : errText(acc));
      }
      const s = await api("https://api.brevo.com/v3/senders");
      const sender = (s.data?.senders || []).find((x) => x.email?.toLowerCase() === MAIL_FROM.toLowerCase());
      if (!sender) throw new Error(`المرسل ${MAIL_FROM} غير مضاف في Brevo (Senders, Domains & Dedicated IPs → Senders → Add a sender).`);
      if (sender.active === false) throw new Error(`المرسل ${MAIL_FROM} لم يُفعَّل بعد في Brevo – افتح رسالة التأكيد في بريده.`);
    } else if (PROVIDER === "resend") {
      const d = await api("https://api.resend.com/domains");
      // A "sending access" key cannot list domains but is still valid for sending.
      if (!d.ok && d.data?.name !== "restricted_api_key") throw new Error(d.status === 401 || d.status === 403 ? "مفتاح Resend غير صحيح." : errText(d));
    } else {
      throw new Error(`MAIL_PROVIDER غير معروف: ${PROVIDER} (استخدم brevo أو resend)`);
    }
    state = { ok: true, provider: PROVIDER, error: "" };
  } catch (err) {
    state = { ok: false, provider: PROVIDER, error: err.message };
  }
  return state;
}

/**
 * Sends one email to MAIL_TO.
 * files: [{ name, buffer }] (from memory) or [{ name, abs }] (read from disk), attached as base64.
 */
async function send({ subject, text, html, files = [], replyTo }) {
  if (!configured) throw new Error(state.error);
  const attachments = files.map((f) => ({ name: f.name, content: (f.buffer || fs.readFileSync(f.abs)).toString("base64") }));
  let res;
  if (PROVIDER === "brevo") {
    res = await api("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: MAIL_FROM },
        to: [{ email: MAIL_TO }],
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        subject,
        textContent: text,
        htmlContent: html || `<pre>${text}</pre>`,
        ...(attachments.length ? { attachment: attachments } : {}),
      }),
    });
  } else {
    res = await api("https://api.resend.com/emails", {
      method: "POST",
      body: JSON.stringify({
        from: `${FROM_NAME} <${MAIL_FROM}>`,
        to: [MAIL_TO],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        text,
        ...(html ? { html } : {}),
        ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.name, content: a.content })) } : {}),
      }),
    });
  }
  if (!res.ok) {
    state = { ok: false, provider: PROVIDER, error: errText(res) };
    throw new Error(state.error);
  }
  state = { ok: true, provider: PROVIDER, error: "" };
  return res.data;
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wrap = (title, text) => `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8"><h2>${escHtml(title)}</h2><pre style="white-space:pre-wrap;font-family:inherit">${escHtml(text)}</pre></div>`;
const optLine = (o) => { const p = o.options || {}; return `${p.quality}p · ${p.seconds}s · ${p.language || ""} · ${p.characters || ""} شخصية · $${p.price}`; };

/** Email 1 – a new order arrived (brief attached as .txt; Brevo rejects .md). */
async function orderEmail(o, brief) {
  if (!configured) return false;
  const title = `🎬 ${o.request_id} – طلب فيديو جديد – @${o.telegram_username}`;
  const text = `طلب جديد من منصة VI Iraq\n\nرقم الطلب: ${o.request_id}\nمعرّف الزبون: ${o.requester_id}\nتيليغرام: @${o.telegram_username}\nالهاتف: ${o.phone}\n${optLine(o)}\nالحالة: ${o.status}\n\nوصف الفيديو:\n${(o.options || {}).description || "-"}\n\nملف الإنتاج مرفق (${o.request_id}-brief.txt).`;
  await send({ subject: title, text, html: wrap(title, text), files: brief ? [{ name: `${o.request_id}-brief.txt`, buffer: Buffer.from(brief, "utf8") }] : [] });
  return true;
}

/** Email 2 – the customer received the video (attached when it fits the size budget). */
async function deliveredEmail(o, video) {
  if (!configured) return false;
  const title = `✅ ${o.request_id} – تم تسليم الفيديو – @${o.telegram_username}`;
  const where = o.telegram_chat_id ? "في صفحة الدردشة وعلى تيليغرام" : "في صفحة الدردشة (لم يربط تيليغرام بعد)";
  const text = `وصل الفيديو إلى الزبون ${where}.\n\nرقم الطلب: ${o.request_id}\nتيليغرام: @${o.telegram_username}\nالهاتف: ${o.phone}\n${optLine(o)}\nالحالة: ${o.status}${video?.buffer && video.buffer.length <= ATTACH_BUDGET ? "\n\nالفيديو مرفق." : ""}`;
  const files = video?.buffer && video.buffer.length <= ATTACH_BUDGET ? [{ name: video.name || `${o.request_id}.mp4`, buffer: video.buffer }] : [];
  await send({ subject: title, text, html: wrap(title, text), files });
  return true;
}

module.exports = {
  check,
  send,
  orderEmail,
  deliveredEmail,
  get state() { return state; },
  configured,
  PROVIDER,
  MAIL_TO,
  MAIL_FROM,
  ATTACH_BUDGET,
};
