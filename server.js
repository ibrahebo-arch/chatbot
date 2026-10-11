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
const tg = require("./telegram");

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
const SYSTEM_PROMPT = `أنت "مساعد VI Iraq"، مستشار إبداعي في استوديو عراقي يصنع فيديوهات بالذكاء الاصطناعي حسب الطلب.
تتحدث بالعربية (يمكنك استخدام لمسة من اللهجة العراقية إذا كتب الزبون بها)، بأسلوب ودود وواثق، وبدون حشو.
مهمتك:
- فهم فكرة الزبون وتطويرها: اقترح أفكاراً، زوايا تصوير، أسلوباً بصرياً، سيناريو مختصراً أو نصاً للتعليق الصوتي عندما يكون ذلك مفيداً أو يطلبه الزبون.
- اسأل عمّا ينقص الطلب (الفكرة، المدة، الدقة، اللغة، عدد الشخصيات، الجمهور/الهدف) بسؤال أو سؤالين كحد أقصى في كل رسالة.
- عندما يرفق الزبون صوراً: علّق عليها باختصار (الشكل، الألوان، الأجواء) وتعامل معها حسب دورها المذكور: "شخصية 1/2/3" تعني شخصية تظهر في الفيديو، و"مرجع" يعني أسلوباً أو مكاناً أو منتجاً وليس شخصية. الفيديوهات المرفقة اعتبرها مرجعاً للأسلوب.
- السعر التقديري معروض للزبون في اللوحة؛ إذا سأل عنه أعطِ الرقم الموجود في "خيارات الزبون الحالية" فقط، ولا تخترع أسعاراً أخرى.
- أنت لا تُنتج الفيديو بنفسك ولا تدّعي ذلك؛ فريق VI Iraq ينتجه بعد إرسال الطلب ويتواصل مع الزبون عبر تيليغرام أو الهاتف.
- لإرسال الطلب يجب أن يملأ الزبون معرّف تيليغرام ورقم هاتفه العراقي في اللوحة؛ ذكّره بذلك بلطف عندما تكتمل الفكرة.
الطول: 2–6 أسطر عادةً؛ أطول فقط عند كتابة سيناريو أو نص مطلوب. لا تكرر ما قاله الزبون حرفياً.`;

const ROLE_LABELS = { char1: "شخصية 1", char2: "شخصية 2", char3: "شخصية 3", ref: "مرجع (ليس شخصية)" };
const roleLabel = (r) => ROLE_LABELS[r] || ROLE_LABELS.ref;

// Telegram: @name, name, t.me/name or https://t.me/name → "name" (5–32 chars, letters/digits/_).
function parseTelegram(v) {
  const m = String(v || "").trim().replace(/^(https?:\/\/)?(www\.)?t\.me\//i, "").replace(/^@+/, "").match(/^[A-Za-z][A-Za-z0-9_]{4,31}$/);
  return m ? m[0] : "";
}
// Iraqi mobile: 07723682257 / 7723682257 / +9647723682257 / 009647723682257 → "+9647723682257".
function parsePhone(v) {
  let d = String(v || "").replace(/[^\d]/g, "");
  if (d.startsWith("00964")) d = d.slice(5);
  else if (d.startsWith("964")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^7\d{9}$/.test(d) ? `+964${d}` : "";
}
const newRequestId = () => {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `VI-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
};
const requesterIdFor = (telegram, phone) => `${telegram}-${phone.replace("+", "")}`;

function orderSummary(order) {
  return [
    order.requestId ? `رقم الطلب (request_id): ${order.requestId}` : null,
    order.requesterId ? `معرّف الزبون (requester_id): ${order.requesterId}` : null,
    `تيليغرام: ${order.telegram ? "@" + order.telegram : "-"}`,
    `الهاتف: ${order.phone || "-"}`,
    `الجودة: ${order.quality}p`,
    `المدة: ${order.seconds} ثانية`,
    `اللغة: ${order.language}`,
    `عدد الشخصيات: ${order.characters}`,
    `السعر: $${order.price}`,
  ].filter(Boolean).join("\n");
}

function transcript(messages = []) {
  return messages
    .map((m) => {
      const files = (Array.isArray(m.files) ? m.files : []).map((f) => `[${f.video ? "🎬" : f.image ? "🖼️" : "📄"} ${f.name} – ${roleLabel(f.role)}]`).join(" ");
      return `${m.role === "user" ? "👤 الزبون" : "🤖 المساعد"}: ${m.content}${files ? "\n" + files : ""}`;
    })
    .join("\n\n");
}

async function openai(body) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Images the customer attached (≤ 5 MB each, newest 4) are shown to the model so it can "see" them.
const VISION_MAX = 5 * 1024 * 1024;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
function toModelMessages(messages) {
  let budget = 4;
  const out = [];
  for (const m of messages.slice(-20).reverse()) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const files = Array.isArray(m.files) ? m.files : [];
    let text = String(m.content || "").slice(0, 4000);
    if (files.length) text += `\n[مرفقات: ${files.map((f) => `${f.name} (${roleLabel(f.role)})`).join("، ")}]`;
    const parts = [{ type: "text", text }];
    if (role === "user") {
      for (const f of files) {
        const stored = path.basename(String(f.stored || ""));
        const ext = path.extname(stored).toLowerCase();
        if (!f.image || !MIME[ext] || budget <= 0) continue;
        const abs = path.join(UPLOADS_DIR, stored);
        try {
          if (fs.statSync(abs).size > VISION_MAX) continue;
          parts.push({ type: "image_url", image_url: { url: `data:${MIME[ext]};base64,${fs.readFileSync(abs).toString("base64")}`, detail: "low" } });
          budget--;
        } catch {}
      }
    }
    out.unshift({ role, content: parts.length === 1 ? text : parts });
  }
  return out;
}

// Where the per-order Markdown brief is written. Default: D:\VI-Iraq when that drive exists, else orders/briefs.
const BRIEFS_DIR = clean(process.env.BRIEFS_DIR) || (fs.existsSync("D:\\") ? "D:\\VI-Iraq" : path.join(ORDERS_DIR, "briefs"));

async function buildBrief(full, messages, files) {
  const head = `# طلب فيديو ${full.requestId}

| الحقل | القيمة |
|---|---|
| request_id | \`${full.requestId}\` |
| requester_id | \`${full.requesterId}\` |
| تيليغرام | [@${full.telegram}](https://t.me/${full.telegram}) |
| الهاتف | ${full.phone} |
| الجودة | ${full.quality}p |
| المدة | ${full.seconds} ثانية |
| اللغة | ${full.language} |
| عدد الشخصيات | ${full.characters} |
| السعر التقديري | $${full.price} |
| التاريخ | ${full.createdAt} |

## المرفقات
${files.length ? files.map((a) => `- ${a.kind} **${roleLabel(a.role)}** – \`${a.f}\` (${(a.size / 1048576).toFixed(1)} MB)`).join("\n") : "- لا توجد مرفقات"}
`;
  let ai = "";
  if (OPENAI_API_KEY) {
    try {
      ai = await openai({
        temperature: 0.6,
        max_tokens: 1800,
        messages: [
          {
            role: "system",
            content: `أنت منتج إبداعي في استوديو VI Iraq. اكتب "ملف إنتاج" (production brief) بصيغة Markdown بالعربية لفريق صناعة الفيديو، اعتماداً على محادثة الزبون وخياراته.
اكتب العناوين التالية بالضبط بمستوى ##: ملخص الفكرة، الهدف والجمهور، الشخصيات (استخدم أدوار المرفقات: شخصية 1/2/3 ومرجع)، الأسلوب البصري، السيناريو مشهداً بمشهد (جدول: المشهد، المدة بالثواني، الوصف البصري، النص/الصوت) بحيث يساوي المجموع مدة الفيديو، النص الكامل للتعليق الصوتي أو الحوار بلغة الفيديو المطلوبة، الموسيقى والمؤثرات، ملاحظات ونقاط غير واضحة يجب تأكيدها مع الزبون.
كن محدداً وعملياً، ولا تذكر أسعاراً، ولا تكتب أي مقدمة قبل أول عنوان.`,
          },
          {
            role: "user",
            content: `خيارات الزبون:\n${orderSummary(full)}\n\nالمرفقات:\n${files.map((a) => `- ${a.name}: ${roleLabel(a.role)}`).join("\n") || "-"}\n\nالمحادثة:\n${transcript(messages)}`,
          },
        ],
      });
    } catch (err) {
      console.error("brief error:", err.message);
      ai = `## ملاحظة\nتعذّر توليد الملف الإبداعي تلقائياً (${err.message}). راجع المحادثة أدناه.`;
    }
  }
  return `${head}\n${ai}\n\n## المحادثة الكاملة\n\n${transcript(messages)}\n`;
}

// ---------- routes ----------
app.get("/api/config", (_req, res) => {
  res.json({
    ai: Boolean(OPENAI_API_KEY),
    mail: mail.state.ok,
    mailProvider: mail.state.provider,
    mailError: mail.state.ok ? "" : mail.state.error,
    attachLimit: ATTACH_LIMIT,
    bot: tg.configured ? tg.username : null,
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

// Short muted loops for the chat showcase (public/loops/*.mp4 with a matching .jpg poster).
const LOOPS_DIR = path.join(__dirname, "public", "loops");
app.get("/api/loops", (_req, res) => {
  try {
    const loops = fs
      .readdirSync(LOOPS_DIR)
      .filter((f) => f.endsWith(".mp4"))
      .sort()
      .map((f) => ({ name: f.slice(0, -4), src: `/loops/${f}`, poster: fs.existsSync(path.join(LOOPS_DIR, f.slice(0, -4) + ".jpg")) ? `/loops/${f.slice(0, -4)}.jpg` : null }));
    res.json({ loops });
  } catch {
    res.json({ loops: [] });
  }
});

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
  const telegram = parseTelegram(order.telegram);
  const phone = parsePhone(order.phone);
  const ctx = order.quality
    ? `\n\nخيارات الزبون الحالية:\n${orderSummary({ ...order, telegram, phone, price: priceFor(order.quality, order.seconds) })}` +
      (telegram && phone ? "" : "\n(لم يكمل الزبون بعد معرّف تيليغرام ورقم الهاتف المطلوبين لإرسال الطلب.)")
    : "";
  const sent = order.requestId
    ? `\n\nهذا الزبون أرسل طلباً بالفعل: request_id=${order.requestId}، requester_id=${order.requesterId}. أي رسالة الآن هي متابعة أو تعديل على هذا الطلب؛ اذكر رقم الطلب عند الحاجة وأخبره أن التعديلات تُرفق بالطلب نفسه.`
    : "";
  try {
    const reply = await openai({
      temperature: 0.8,
      max_tokens: 700,
      messages: [{ role: "system", content: SYSTEM_PROMPT + ctx + sent }, ...toModelMessages(messages)],
    });
    res.json({ reply: reply || "…" });
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
  // Hard requirement: no Telegram username + Iraqi phone → nothing is sent anywhere.
  const telegram = parseTelegram(order.telegram);
  const phone = parsePhone(order.phone);
  if (!telegram || !phone) {
    return res.status(400).json({
      ok: false,
      mailed: false,
      field: !telegram ? "telegram" : "phone",
      message: !telegram
        ? "اكتب معرّف تيليغرام صحيح (مثال: @ahmed_vi) قبل إرسال الطلب."
        : "اكتب رقم هاتف عراقي صحيح (مثال: 7723682257) قبل إرسال الطلب.",
    });
  }
  if (!Array.isArray(messages) || !messages.some((m) => m && m.role === "user" && (String(m.content || "").trim() || (m.files || []).length))) {
    return res.status(400).json({ ok: false, mailed: false, field: "chat", message: "اكتب وصف الفيديو في الدردشة أولاً." });
  }

  const quality = Number(order.quality) || 1080;
  const seconds = Math.max(1, Number(order.seconds) || 15);
  const requestId = newRequestId();
  const requesterId = requesterIdFor(telegram, phone);
  const roles = new Map();
  const full = {
    requestId,
    requesterId,
    telegram,
    phone,
    quality,
    seconds,
    language: String(order.language || "العربية").slice(0, 60),
    characters: String(order.characters || "1").slice(0, 10),
    price: priceFor(quality, seconds),
    createdAt: new Date().toISOString(),
    description: String(order.description || "").slice(0, 5000),
    attachments: (Array.isArray(order.attachments) ? order.attachments : [])
      .map((a) => {
        const f = path.basename(String(a.stored || ""));
        if (f) roles.set(f, ROLE_LABELS[a.role] ? a.role : "ref");
        return f;
      })
      .filter((f) => f && fs.existsSync(path.join(UPLOADS_DIR, f)))
      .slice(0, 30),
  };

  // Attach files while they fit in the email size budget; the rest are linked by URL.
  const files = full.attachments.map((f) => {
    const abs = path.join(UPLOADS_DIR, f);
    const size = fs.statSync(abs).size;
    const name = f.replace(/^\d+-[a-z0-9]+-/, "");
    return { f, abs, size, name, role: roles.get(f) || "ref", kind: isVideo("", f) ? "🎬" : isImage("", f) ? "🖼️" : "📄", url: `${PUBLIC_URL || ""}/uploads/${encodeURIComponent(f)}` };
  });
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

  // Production brief (.md) – written by the model, saved locally and attached to the email.
  const brief = await buildBrief(full, messages, files);
  let briefPath = "";
  try {
    fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    briefPath = path.join(BRIEFS_DIR, `${requestId}.md`);
    fs.writeFileSync(briefPath, brief, "utf8");
  } catch (e) {
    console.error("could not save brief:", e.message);
    briefPath = "";
  }

  let used = 0;
  const mailed = [];
  const linked = [];
  // Brevo rejects the .md extension, so the email copy is sent as .txt (same Markdown content).
  if (briefPath) { mailed.push({ name: `${requestId}-brief.txt`, abs: briefPath, size: Buffer.byteLength(brief) }); used += Buffer.byteLength(brief); }
  for (const a of files) {
    if (used + a.size <= mail.ATTACH_BUDGET) { used += a.size; mailed.push(a); } else linked.push(a);
  }

  const subject = `🎬 ${requestId} – طلب فيديو – @${telegram} – ${full.quality}p / ${full.seconds}s / $${full.price}`;
  const attachLines = files.length
    ? `\n\nالمرفقات (${files.length}):\n${files.map((a) => `- ${a.kind} ${roleLabel(a.role)} – ${a.name} (${mb(a.size)})${linked.includes(a) ? ` – كبير، غير مرفق بالبريد: ${a.url}` : ""}`).join("\n")}`
    : "";
  const botLine = tg.configured ? `\n\nبوت التسليم: ${tg.linkFor(requestId)} (الزبون يضغط Start ليستلم الفيديو) – للتأكيد أرسل للبوت: /confirm ${requestId}` : "";
  const text = `طلب جديد من منصة VI Iraq\n\n${orderSummary(full)}${botLine}\n\nوصف الفيديو:\n${full.description || "-"}${attachLines}\n\nملف الإنتاج: ${briefPath ? `${requestId}.md (مرفق بالبريد باسم ${requestId}-brief.txt)` : "لم يُحفظ"}\n\n--- المحادثة ---\n${transcript(messages)}\n\nالوقت: ${full.createdAt}`;

  // Always keep a local copy (orders/ is gitignored).
  try {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ORDERS_DIR, `${requestId}.json`), JSON.stringify({ ...full, messages }, null, 2));
  } catch (e) {
    console.error("could not save order:", e.message);
  }

  // Telegram: remember the order, tell the admins, and give the customer the bot link.
  const botLink = tg.configured ? tg.linkFor(requestId) : null;
  if (tg.configured) {
    tg.registerRequest(full);
    tg.notifyAdmins(
      `🎬 <b>طلب جديد ${requestId}</b>\n@${telegram} · ${phone}\n${full.quality}p · ${full.seconds}s · ${full.language} · ${full.characters} شخصية · $${full.price}\n${files.length ? `مرفقات: ${files.length}` : "بدون مرفقات"}\n\n${(full.description || "-").slice(0, 600)}\n\nللتأكيد: /confirm ${requestId}`,
      briefPath ? { path: briefPath, name: `${requestId}.md`, caption: `ملف الإنتاج ${requestId}` } : null
    ).catch((e) => console.error("telegram notify:", e.message));
  }

  const ids = { requestId, requesterId, telegram, phone, botLink };
  if (!mail.configured) {
    return res.json({ ...ids, ok: true, mailed: false, message: "تم حفظ الطلب (البريد غير مفعّل بعد – أضف BREVO_API_KEY أو RESEND_API_KEY في .env)." });
  }

  try {
    await mail.send({
      subject,
      text,
      files: mailed,
      html: `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8"><h2>🎬 طلب جديد – ${requestId}</h2><p><a href="https://t.me/${telegram}">@${telegram}</a> · <a href="tel:${phone}">${phone}</a></p><pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</pre>${
        linked.length ? `<h3>مرفقات كبيرة (روابط)</h3><ul>${linked.map((a) => `<li><a href="${escapeHtml(a.url)}">${a.kind} ${escapeHtml(a.name)}</a> – ${roleLabel(a.role)} (${mb(a.size)})</li>`).join("")}</ul>` : ""
      }</div>`,
    });
    res.json({ ...ids, ok: true, mailed: true, message: `تم إرسال طلبك بنجاح 🎉 رقم الطلب: ${requestId} – سنتواصل معك على تيليغرام @${telegram}` });
  } catch (err) {
    console.error("mail error:", err.message);
    res.status(502).json({ ...ids, ok: false, mailed: false, message: "تم حفظ الطلب لكن تعذّر إرسال البريد، سنراجعه يدوياً." });
  }
});

// ---------- request status / delivery (admin token) ----------
const adminOnly = (req, res, next) => {
  if (!ADMIN_TOKEN || req.get("x-admin-token") !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "كلمة المرور غير صحيحة." });
  next();
};
app.get("/api/requests", adminOnly, (_req, res) => {
  const orders = tg.list().map((r) => {
    let order = null;
    try { order = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, `${r.id}.json`), "utf8")); } catch {}
    return { ...r, order: order && { quality: order.quality, seconds: order.seconds, language: order.language, characters: order.characters, price: order.price, description: order.description, attachments: order.attachments }, brief: fs.existsSync(path.join(BRIEFS_DIR, `${r.id}.md`)) ? `${r.id}.md` : null };
  });
  res.json({ bot: tg.configured ? { username: tg.username, mode: tg.mode, admins: tg.adminsCount() } : null, requests: orders });
});
app.post("/api/requests/:id/confirm", adminOnly, async (req, res) => {
  try { res.json({ ok: true, request: await tg.confirm(String(req.params.id).toUpperCase(), "api") }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/requests/:id/deliver", adminOnly, async (req, res) => {
  const { url, file, caption } = req.body || {};
  try {
    const media = url ? { url: String(url) } : file ? { path: path.join(UPLOADS_DIR, path.basename(String(file))), name: path.basename(String(file)) } : null;
    if (!media) return res.status(400).json({ ok: false, error: "أرسل url أو file" });
    if (media.path && !fs.existsSync(media.path)) return res.status(404).json({ ok: false, error: "الملف غير موجود في uploads" });
    res.json({ ok: true, request: await tg.deliver(String(req.params.id).toUpperCase(), media, caption ? String(caption) : "") });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
  const t = await tg.init(app, PUBLIC_URL);
  console.log(`Telegram: ${tg.configured ? `${t.mode} as @${t.username || "?"} (${t.admins ?? 0} admins)${t.error ? " – " + t.error : ""}` : "OFF (set TELEGRAM_BOT_TOKEN)"}`);
});
