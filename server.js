/**
 * VI Iraq – server
 * ---------------------------------------------------------------
 * - Serves the Arabic iPhone-style front end from /public
 * - /api/chat   → forwards the customer's message to the OpenAI API
 * - /api/order  → emails the order (chat + options) from GMAIL_USER to MAIL_TO
 * - /api/videos → lists background videos found in /public/videos
 *
 * All secrets live in the hidden .env file (never committed).
 */
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GMAIL_USER = process.env.GMAIL_USER || "ibrahebo@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const MAIL_TO = process.env.MAIL_TO || "ibrahim2dms@gmail.com";

const VIDEOS_DIR = path.join(__dirname, "public", "videos");
const ORDERS_DIR = path.join(__dirname, "orders");
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);

// Price per second (USD) per quality – derived from the price sheet:
// 1080p: 15s=$20 30s=$40 60s=$80 | 720p: $11/$22/$44 | 480p: $6/$11/$22
const RATES = { 1080: 80 / 60, 720: 44 / 60, 480: 22 / 60 };
const priceFor = (quality, seconds) =>
  Math.ceil((RATES[quality] || RATES[1080]) * seconds);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const SYSTEM_PROMPT = `أنت مساعد منصة "VI Iraq" لإنتاج الفيديوهات بالذكاء الاصطناعي.
تحدّث دائماً بالعربية بأسلوب ودود ومختصر (لهجة عراقية خفيفة مقبولة).
مهمتك: مساعدة الزبون على وصف الفيديو الذي يريده بدقة:
الفكرة، الأجواء، عدد الشخصيات، اللغة المنطوقة، المدة، والجودة.
اسأل سؤالاً واحداً في كل مرة إذا كان الوصف ناقصاً، واقترح أفكاراً تحسّن الفيديو.
لا تُنتج أي فيديو ولا تدّعي أنك أنتجته، فقط ساعده في تجهيز الطلب،
وعندما يكتمل الوصف اطلب منه الضغط على زر "إرسال الطلب".
الأسعار بالدولار: 1080p ≈ 1.33$/ثانية، 720p ≈ 0.73$/ثانية، 480p ≈ 0.37$/ثانية.`;

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
    mail: Boolean(GMAIL_APP_PASSWORD),
    rates: RATES,
    brand: "VI Iraq",
  });
});

app.get("/api/videos", (_req, res) => {
  let files = [];
  try {
    files = fs
      .readdirSync(VIDEOS_DIR)
      .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .sort()
      .map((f) => `/videos/${encodeURIComponent(f)}`);
  } catch {
    /* folder missing – no videos */
  }
  res.json({ videos: files });
});

app.get("/api/price", (req, res) => {
  const quality = Number(req.query.quality) || 1080;
  const seconds = Math.max(1, Number(req.query.seconds) || 15);
  res.json({ quality, seconds, price: priceFor(quality, seconds) });
});

app.post("/api/chat", async (req, res) => {
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

app.post("/api/order", async (req, res) => {
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
  };

  const subject = `🎬 طلب فيديو جديد – VI Iraq – ${full.quality}p / ${full.seconds}s / $${full.price}`;
  const text = `طلب جديد من منصة VI Iraq\n\n${orderSummary(full)}\n\nوصف الفيديو:\n${full.description || "-"}\n\n--- المحادثة ---\n${transcript(messages)}\n\nالوقت: ${full.createdAt}`;

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

  if (!GMAIL_APP_PASSWORD) {
    return res.json({
      ok: true,
      mailed: false,
      message: "تم حفظ الطلب (البريد غير مفعّل بعد – أضف GMAIL_APP_PASSWORD في .env).",
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"VI Iraq" <${GMAIL_USER}>`,
      to: MAIL_TO,
      replyTo: GMAIL_USER,
      subject,
      text,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8"><h2>🎬 طلب جديد – VI Iraq</h2><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</pre></div>`,
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

app.listen(PORT, () => {
  console.log(`VI Iraq running → http://localhost:${PORT}`);
  console.log(`AI: ${OPENAI_API_KEY ? "on" : "OFF (set OPENAI_API_KEY)"} | Mail: ${GMAIL_APP_PASSWORD ? "on" : "OFF (set GMAIL_APP_PASSWORD)"}`);
});
