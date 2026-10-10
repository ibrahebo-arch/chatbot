/**
 * VI Iraq – server
 * ---------------------------------------------------------------
 * - Serves the Arabic iPhone-style front end from /public
 * - /api/chat   → forwards the customer's message to the OpenAI API
 * - /api/order  → emails the order (chat + options) to MAIL_TO via Brevo or Resend (mail.js)
 * - /api/videos → lists background videos found in /public/videos
 *
 * All secrets live in the hidden .env file (never committed).
 */
// override: values in .env win over stale system environment variables (e.g. a placeholder OPENAI_API_KEY set in Windows).
require("dotenv").config({ override: true, quiet: true });

const path = require("path");
const fs = require("fs");
const express = require("express");
const mail = require("./mail");

const app = express();
const PORT = process.env.PORT || 3000;

const clean = (v) => String(v || "").trim();
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const ADMIN_TOKEN = clean(process.env.ADMIN_TOKEN);
// Render/Railway expose the public address automatically; PUBLIC_URL in .env overrides it.
const PUBLIC_URL = (
  clean(process.env.PUBLIC_URL) ||
  clean(process.env.RENDER_EXTERNAL_URL) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");

const VIDEOS_DIR = path.join(__dirname, "public", "videos");
const ORDERS_DIR = path.join(__dirname, "orders");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const ATTACH_LIMIT = process.env.ATTACH_LIMIT || "200mb";
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"]);
const isVideo = (type, name) => type.startsWith("video/") || VIDEO_EXT.has(path.extname(name).toLowerCase());
const isImage = (type, name) => type.startsWith("image/") || IMAGE_EXT.has(path.extname(name).toLowerCase());


// Price per second (USD) per quality – derived from the price sheet:
// 1080p: 15s=$20 30s=$40 60s=$80 | 720p: $11/$22/$44 | 480p: $6/$11/$22
const RATES = { 1080: 80 / 60, 720: 44 / 60, 480: 22 / 60 };
const priceFor = (quality, seconds) =>
  Math.ceil((RATES[quality] || RATES[1080]) * seconds);

// Behind a tunnel / hosting proxy the real visitor IP is in X-Forwarded-For.
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Customer uploads: only images/videos play inline; anything else is forced to download
// so an uploaded .html/.svg file can never run as a page on this site.
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders: (res, file) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      const ext = path.extname(file).toLowerCase();
      if (!(VIDEO_EXT.has(ext) || (IMAGE_EXT.has(ext) && ext !== ".svg"))) res.setHeader("Content-Disposition", "attachment");
    },
  })
);

// Simple in-memory rate limit per visitor IP (protects the OpenAI bill, disk and mail quota).
function rateLimit(max, windowMs, msg) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || now - h.t > windowMs) { hits.set(req.ip, { t: now, n: 1 }); return next(); }
    if (++h.n > max) return res.status(429).json({ ok: false, error: msg, reply: msg, message: msg });
    next();
  };
}
const chatLimit = rateLimit(30, 10 * 60 * 1000, "رسائل كثيرة خلال وقت قصير، انتظر قليلاً ثم حاول مرة ثانية.");
const attachLimit = rateLimit(20, 60 * 60 * 1000, "عدد المرفقات تجاوز الحد المسموح، حاول لاحقاً.");
const orderLimit = rateLimit(5, 60 * 60 * 1000, "تم إرسال طلبات كثيرة، حاول بعد ساعة.");

// ---------- helpers ----------
const SYSTEM_PROMPT = `أنت موظف استقبال طلبات في منصة "VI Iraq".
تتحدث بالعربية فقط وبجمل قصيرة جداً (سطر أو سطرين).
دورك محصور في استلام ما يكتبه الزبون وتأكيده: أعد صياغة ما فهمته من طلبه باختصار،
وإذا نقصت معلومة أساسية (الفكرة، المدة، الدقة، اللغة، عدد الشخصيات) اسأل عنها بسؤال واحد فقط.
ممنوع تماماً: اقتراح أفكار، إعطاء نصائح، تحسين الوصف، كتابة سيناريو أو نص، توليد أي محتوى، أو ذكر الأسعار.
لا تُنتج أي فيديو ولا تدّعي ذلك. عندما تكتمل المعلومات قل فقط: "تمام، اضغط زر إرسال الطلب".`;

function orderSummary(order) {
  return [
    `الجودة: ${order.quality}p`,
    `المدة: ${order.seconds} ثانية`,
    `اللغة: ${order.language}`,
    `عدد الشخصيات: ${order.characters}`,
    `السعر: $${order.price}`,
    `الاسم / التواصل: ${order.contact || "-"}`,
  ].join("\n");
}

function transcript(messages = []) {
  return messages
    .map((m) => `${m.role === "user" ? "👤 الزبون" : "🤖 المساعد"}: ${m.content}`)
    .join("\n\n");
}

// ---------- routes ----------
app.get("/api/config", (_req, res) => {
  res.json({
    ai: Boolean(OPENAI_API_KEY),
    mail: mail.state.ok,
    mailProvider: mail.state.provider,
    mailError: mail.state.ok ? "" : mail.state.error,
    attachLimit: ATTACH_LIMIT,
    rates: RATES,
    brand: "VI Iraq",
  });
});

function listVideos() {
  try {
    return fs
      .readdirSync(VIDEOS_DIR)
      .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(VIDEOS_DIR, f));
        return {
          name: f.replace(/\.[^.]+$/, ""),
          file: f,
          url: `/videos/${encodeURIComponent(f)}`,
          size: st.size,
          mtime: st.mtimeMs,
        };
      });
  } catch {
    return [];
  }
}

app.get("/api/videos", (_req, res) => res.json({ videos: listVideos() }));

// Gallery videos are read-only: add/remove files in public/videos on the server only.

app.get("/api/price", (req, res) => {
  const quality = Number(req.query.quality) || 1080;
  const seconds = Math.max(1, Number(req.query.seconds) || 15);
  res.json({ quality, seconds, price: priceFor(quality, seconds) });
});

// Customer attachments from the chat: PUT /api/attach/<filename> (raw body).
app.put("/api/attach/:file", attachLimit, express.raw({ type: () => true, limit: ATTACH_LIMIT }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: "الملف فارغ." });
  const original = path.basename(String(req.params.file));
  const safe = original.replace(/[^\w.\-\u0600-\u06FF ]+/g, "_").slice(-120);
  const stored = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, stored), req.body);
  const type = req.get("content-type") || "";
  res.json({
    ok: true,
    name: original,
    stored,
    url: `/uploads/${encodeURIComponent(stored)}`,
    size: req.body.length,
    image: isImage(type, original),
    video: isVideo(type, original),
  });
});

// Mail diagnostics: GET /api/mail/test re-checks the provider key; POST (header x-admin-token) sends a real test email.
app.get("/api/mail/test", async (_req, res) => res.json(await mail.check()));
app.post("/api/mail/test", orderLimit, async (req, res) => {
  if (!ADMIN_TOKEN || req.get("x-admin-token") !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "كلمة المرور غير صحيحة." });
  try {
    await mail.send({ subject: "✅ اختبار بريد VI Iraq", text: `البريد يعمل عبر ${mail.PROVIDER}. ${new Date().toISOString()}` });
    res.json({ ok: true, provider: mail.PROVIDER, from: mail.MAIL_FROM, to: mail.MAIL_TO });
  } catch (err) {
    res.status(502).json({ ok: false, provider: mail.PROVIDER, error: err.message });
  }
});

app.post("/api/chat", chatLimit, async (req, res) => {
  const { messages = [], order = {} } = req.body || {};
  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: "no_key",
      reply:
        "المساعد الذكي غير مفعّل حالياً (لم يتم ضبط مفتاح OpenAI في ملف .env). اكتب وصف الفيديو واضغط إرسال الطلب وسنتواصل معك.",
    });
  }
  const context = order.quality
    ? `\n\nخيارات الزبون الحالية:\n${orderSummary({ ...order, price: priceFor(order.quality, order.seconds) })}`
    : "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.7,
        max_tokens: 400,
        messages: [
          { role: "system", content: SYSTEM_PROMPT + context },
          ...messages.slice(-20).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: String(m.content || "").slice(0, 4000),
          })),
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
    res.json({ reply: data.choices?.[0]?.message?.content?.trim() || "…" });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({
      error: "ai_failed",
      reply: "صار خلل بسيط بالاتصال مع المساعد، جرّب مرة ثانية أو أرسل طلبك مباشرة.",
    });
  }
});

app.post("/api/order", orderLimit, async (req, res) => {
  const { messages = [], order = {} } = req.body || {};
  const quality = Number(order.quality) || 1080;
  const seconds = Math.max(1, Number(order.seconds) || 15);
  const full = {
    quality,
    seconds,
    language: String(order.language || "العربية").slice(0, 60),
    characters: String(order.characters || "1").slice(0, 10),
    contact: String(order.contact || "").slice(0, 200),
    price: priceFor(quality, seconds),
    createdAt: new Date().toISOString(),
    description: String(order.description || "").slice(0, 5000),
    attachments: (Array.isArray(order.attachments) ? order.attachments : [])
      .map((a) => path.basename(String(a.stored || "")))
      .filter((f) => f && fs.existsSync(path.join(UPLOADS_DIR, f)))
      .slice(0, 30),
  };

  // Attach files while they fit in Gmail's size limit; the rest are linked by URL.
  const files = full.attachments.map((f) => {
    const abs = path.join(UPLOADS_DIR, f);
    const size = fs.statSync(abs).size;
    const name = f.replace(/^\d+-[a-z0-9]+-/, "");
    return { f, abs, size, name, kind: isVideo("", f) ? "🎬" : isImage("", f) ? "🖼️" : "📄", url: `${PUBLIC_URL || ""}/uploads/${encodeURIComponent(f)}` };
  });
  let used = 0;
  const mailed = [];
  const linked = [];
  for (const a of files) {
    if (used + a.size <= mail.ATTACH_BUDGET) { used += a.size; mailed.push(a); } else linked.push(a);
  }
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

  const subject = `🎬 طلب فيديو جديد – VI Iraq – ${full.quality}p / ${full.seconds}s / $${full.price}`;
  const attachLines = files.length
    ? `\n\nالمرفقات (${files.length}):\n${files.map((a) => `- ${a.kind} ${a.name} (${mb(a.size)})${linked.includes(a) ? ` – كبير، غير مرفق بالبريد: ${a.url}` : ""}`).join("\n")}`
    : "";
  const text = `طلب جديد من منصة VI Iraq\n\n${orderSummary(full)}\n\nوصف الفيديو:\n${full.description || "-"}${attachLines}\n\n--- المحادثة ---\n${transcript(messages)}\n\nالوقت: ${full.createdAt}`;

  // Always keep a local copy (orders/ is gitignored).
  try {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ORDERS_DIR, `${Date.now()}.json`),
      JSON.stringify({ ...full, messages }, null, 2)
    );
  } catch (e) {
    console.error("could not save order:", e.message);
  }

  if (!mail.configured) {
    return res.json({
      ok: true,
      mailed: false,
      message: "تم حفظ الطلب (البريد غير مفعّل بعد – أضف BREVO_API_KEY أو RESEND_API_KEY في .env).",
    });
  }

  try {
    await mail.send({
      subject,
      text,
      files: mailed,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8"><h2>🎬 طلب جديد – VI Iraq</h2><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</pre>${
        linked.length ? `<h3>مرفقات كبيرة (روابط)</h3><ul>${linked.map((a) => `<li><a href="${escapeHtml(a.url)}">${a.kind} ${escapeHtml(a.name)}</a> (${mb(a.size)})</li>`).join("")}</ul>` : ""
      }</div>`,
    });
    res.json({ ok: true, mailed: true, message: "تم إرسال طلبك بنجاح، سنتواصل معك قريباً 🎉" });
  } catch (err) {
    console.error("mail error:", err.message);
    res.status(502).json({
      ok: false,
      mailed: false,
      message: "تم حفظ الطلب لكن تعذّر إرسال البريد، سنراجعه يدوياً.",
    });
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

app.get("/{*path}", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, async () => {
  console.log(`VI Iraq running → http://localhost:${PORT}`);
  console.log(`AI: ${OPENAI_API_KEY ? `on (${OPENAI_MODEL})` : "OFF (set OPENAI_API_KEY in .env)"}`);
  const m = await mail.check();
  console.log(`Mail: ${m.ok ? `on (${mail.PROVIDER}: ${mail.MAIL_FROM} → ${mail.MAIL_TO})` : `OFF – ${m.error}`}`);
});
