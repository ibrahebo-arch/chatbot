/**
 * VI Iraq – server
 * ---------------------------------------------------------------
 * - Serves the Arabic iPhone-style front end from /public
 * - /api/chat   → forwards the customer's message to the OpenAI API
 * - /api/attach → customer upload (image/video) → Cloudflare R2 + assets row
 * - /api/order  → validates contact, creates the order in Postgres (1/hour, idempotent),
 *                 writes the production brief into orders.brief_md and tells admins on Telegram
 * - /api/orders/:id/status → the customer's own order status (+ payment state) + presigned video link
 * - /api/orders/:id/pay → Wayl payment link for the customer's unpaid order (payments.js)
 * - /api/wayl/webhook → Wayl status callback; triggers a check with the verification key
 * - /api/videos → lists background videos found in /public/videos
 *
 * All secrets live in the environment (.env locally, Render dashboard in production).
 */
// override: values in .env win over stale system environment variables (e.g. a placeholder OPENAI_API_KEY set in Windows).
require("dotenv").config({ override: true, quiet: true });

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const db = require("./db");
const orders = require("./orders");
const storage = require("./storage");
const tg = require("./telegram");
const mail = require("./mail");
const payments = require("./payments");
const media = require("./media");
const trial = require("./trial");
const voices = require("./voices");
const planner = require("./planner");
const { normalizeTelegram, normalizePhone } = require("./validate");

const app = express();
const PORT = process.env.PORT || 3000;

const clean = (v) => String(v || "").trim();
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const ADMIN_TOKEN = clean(process.env.ADMIN_TOKEN);
// Public WhatsApp contact (digits only, international format) – floating button + contact tab.
const WHATSAPP = (clean(process.env.WHATSAPP_NUMBER) || "9647723682289").replace(/\D/g, "");
// Free test stage: every order moves one step per second and gets a random showcase loop as its "video".
// Set DEMO_DELIVERY=false when payments start, to return to the admin /confirm flow.
const DEMO = clean(process.env.DEMO_DELIVERY).toLowerCase() === "true";
// Render/Railway expose the public address automatically; PUBLIC_URL in .env overrides it.
const PUBLIC_URL = (
  clean(process.env.PUBLIC_URL) ||
  clean(process.env.RENDER_EXTERNAL_URL) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");
// Wayl calls back (webhook) and returns the customer (redirect) to this address – the store's registered domain.
const PAY_PUBLIC_URL = (clean(process.env.PAY_PUBLIC_URL) || PUBLIC_URL).replace(/\/+$/, "");
const publicBase = (req) => PAY_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const VIDEOS_DIR = path.join(__dirname, "public", "videos");
const ATTACH_LIMIT = process.env.ATTACH_LIMIT || "200mb";
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);

// Uploads accepted from customers: extension → [media type, content type]. Everything else is rejected.
const UPLOAD_TYPES = {
  ".png": ["image", "image/png"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"], ".gif": ["image", "image/gif"], ".heic": ["image", "image/heic"],
  ".mp4": ["video", "video/mp4"], ".mov": ["video", "video/quicktime"], ".webm": ["video", "video/webm"], ".m4v": ["video", "video/x-m4v"],
};
const toBytes = (s) => { const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i); return m ? Number(m[1]) * { kb: 1024, mb: 1048576, gb: 1073741824 }[(m[2] || "mb").toLowerCase()] : 200 * 1048576; };
const VIDEO_MAX = toBytes(ATTACH_LIMIT);
const IMAGE_MAX = Math.min(VIDEO_MAX, 20 * 1048576);

// Price per second (USD) per quality – derived from the price sheet:
// 1080p: 15s=$20 30s=$40 60s=$80 | 720p: $11/$22/$44 | 480p: $6/$11/$22
const RATES = { 1080: 80 / 60, 720: 44 / 60, 480: 22 / 60 };
const priceFor = (quality, seconds) =>
  Math.ceil((RATES[quality] || RATES[1080]) * seconds);

// Visitor IP for rate limits. Both sites sit behind Cloudflare, which always overwrites CF-Connecting-IP
// with the real client address (the VPS firewall only lets Cloudflare reach nginx). X-Forwarded-For is
// NOT trusted beyond the local proxy: its first value is whatever the client typed, which let anyone
// skip every rate limit by sending a different fake IP. TRUST_PROXY can override (express "trust proxy").
app.set("trust proxy", clean(process.env.TRUST_PROXY) || "loopback");
const net = require("net");
const clientIp = (req) => {
  const cf = clean(req.get("cf-connecting-ip"));
  return net.isIP(cf) ? cf : req.ip;
};
app.disable("x-powered-by");

// Security headers for every response (both sites). The page loads its own script/styles plus Google Fonts;
// videos and pictures can also come from short-lived storage links (https).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com", // Cloudflare Web Analytics, injected by Cloudflare
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=()", // the chat records voice notes
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  });
  next();
});
app.use(express.json({ limit: "1mb" }));

// Cache busting: index.html asks for /app.js?v=<content hash> and /style.css?v=<hash>, so after a deploy
// every browser (and Cloudflare's 4-hour cache) loads the new files. The page itself is never cached.
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSET_V = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC_DIR, "app.js"))).update(fs.readFileSync(path.join(PUBLIC_DIR, "style.css"))).digest("hex").slice(0, 10);
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
  .replace('src="/app.js"', `src="/app.js?v=${ASSET_V}"`)
  .replace('href="/style.css"', `href="/style.css?v=${ASSET_V}"`);
const sendIndex = (_req, res) => res.set("Cache-Control", "no-cache").type("html").send(INDEX_HTML);
app.get(["/", "/index.html"], sendIndex);
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, file) => {
    if (/\.(js|css)$/.test(file)) res.set("Cache-Control", res.req.query.v ? "public, max-age=31536000, immutable" : "no-cache");
  },
}));

// Simple in-memory rate limit per visitor IP (protects the OpenAI bill and storage).
function rateLimit(max, windowMs, msg) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) { hits.set(ip, { t: now, n: 1 }); return next(); }
    if (++h.n > max) return res.status(429).json({ ok: false, error: msg, reply: msg, message: msg });
    next();
  };
}
const chatLimit = rateLimit(30, 10 * 60 * 1000, "رسائل كثيرة خلال وقت قصير، انتظر قليلاً ثم حاول مرة ثانية.");
const attachLimit = rateLimit(20, 60 * 60 * 1000, "عدد المرفقات تجاوز الحد المسموح، حاول لاحقاً.");
const orderLimit = rateLimit(5, 60 * 60 * 1000, "تم إرسال طلبات كثيرة، حاول بعد ساعة.");
const statusLimit = rateLimit(1500, 10 * 60 * 1000, "طلبات كثيرة، انتظر قليلاً.");

// ---------- helpers ----------
const SYSTEM_PROMPT = `أنت "مساعد VI Iraq"، مستشار إبداعي في استوديو عراقي يصنع فيديوهات بالذكاء الاصطناعي حسب الطلب.
تتحدث بلغة الزبون: بالعربية (يمكنك استخدام لمسة من اللهجة العراقية إذا كتب الزبون بها)، أو بالإنجليزية إذا كتب بالإنجليزية، بأسلوب ودود وواثق، وبدون حشو.
مهمتك:
- فهم فكرة الزبون وتطويرها: اقترح أفكاراً، زوايا تصوير، أسلوباً بصرياً، سيناريو مختصراً أو نصاً للتعليق الصوتي عندما يكون ذلك مفيداً أو يطلبه الزبون.
- اسأل عمّا ينقص الطلب (الفكرة، المدة، الدقة، اللغة، عدد الشخصيات، الجمهور/الهدف) بسؤال أو سؤالين كحد أقصى في كل رسالة.
- عندما يرفق الزبون صوراً: علّق عليها باختصار (الشكل، الألوان، الأجواء) وتعامل معها حسب دورها المذكور: "شخصية 1/2/3" تعني شخصية تظهر في الفيديو، و"مرجع" يعني أسلوباً أو مكاناً أو منتجاً وليس شخصية. الفيديوهات المرفقة اعتبرها مرجعاً للأسلوب.
- السعر التقديري معروض للزبون في اللوحة؛ إذا سأل عنه أعطِ الرقم الموجود في "خيارات الزبون الحالية" فقط، ولا تخترع أسعاراً أخرى.
- أنت لا تُنتج الفيديو بنفسك ولا تدّعي ذلك؛ فريق VI Iraq ينتجه بعد إرسال الطلب ويتواصل مع الزبون عبر تيليغرام أو الهاتف.
- لإرسال الطلب يجب أن يملأ الزبون معرّف تيليغرام ورقم هاتفه العراقي في اللوحة؛ ذكّره بذلك بلطف عندما تكتمل الفكرة.
- الصوت في الفيديو: يختار الزبون الشخصية المتكلمة (بنت/ولد/شابة/شاب/امرأة/رجل/كبير بالعمر) وصوتها من اللوحة، أو يكتبها لك ("خلي الصوت بنت صغيرة"). ويستطيع تسجيل صوته بزر المايك 🎙️ في الدردشة أو رفع ملف صوتي: نفحصه أولاً (المدة، الوضوح، الضجيج، العمر والجنس) ثم يختار: صوته كما هو داخل الفيديو، أو نفس كلامه بصوت الشخصية. إذا كتب الكلمات التي يريدها حرفياً تُقال كما هي. اشرح له هذا باختصار إذا سأل عن الصوت.
الطول: 2–6 أسطر عادةً؛ أطول فقط عند كتابة سيناريو أو نص مطلوب. لا تكرر ما قاله الزبون حرفياً.
LANGUAGE RULE (highest priority): always reply in the language of the customer's LAST message – Arabic (Iraqi touch welcome) if it is Arabic, English if it is English.`;

// Terms (public/policy.json). Requests are NOT blocked: when a message may conflict with the content rules
// (sections 1–2), the page shows the full terms in the customer's language with a note that continuing
// means accepting them; the order keeps a record (options.termsNotice + a "terms_notice" event) and the
// admins see a ⚠️ line in the Telegram alert before /confirm.
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "policy.json"), "utf8"));
const FORBIDDEN_SECTIONS = [1, 2];
const policyRules = POLICY.en.sections
  .filter((s) => FORBIDDEN_SECTIONS.includes(s.n))
  .map((s) => `Section ${s.n} – ${s.title}:\n${s.items.map((i) => `- ${i}`).join("\n")}`)
  .join("\n");

/**
 * One short check of the customer's own messages against sections 1–2.
 * Returns the section numbers the request may conflict with ([] = none). Never blocks anything;
 * returns [] (and logs) if the model is unavailable.
 */
async function policyCheck(messages, { lastOnly = false } = {}) {
  if (!OPENAI_API_KEY) return [];
  const own = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role === "user");
  const text = (lastOnly ? own.slice(-1) : own).map((m) => String(m.content || "")).join("\n").slice(-6000);
  if (!text.trim()) return [];
  try {
    const out = await openai({
      temperature: 0,
      max_tokens: 60,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You review video requests for VI Iraq against these rules:\n${policyRules}\nDepicting poor public services or living conditions is allowed when it is not abusive. Answer only JSON: {"violates": [section numbers]} – an empty array when the request is acceptable. Judge the request itself, not the language it is written in.` },
        { role: "user", content: text },
      ],
    });
    const v = JSON.parse(out).violates;
    return Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => FORBIDDEN_SECTIONS.includes(n)))].sort() : [];
  } catch (e) {
    console.error("policy check:", e.message);
    return [];
  }
}

const ROLE_LABELS = { char1: "شخصية 1", char2: "شخصية 2", char3: "شخصية 3", ref: "مرجع (ليس شخصية)" };
const roleLabel = (r) => ROLE_LABELS[r] || ROLE_LABELS[orders.ROLE_UI[r]] || ROLE_LABELS.ref;

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
  const model = body.model || OPENAI_MODEL;
  const req = { ...body, model };
  // GPT-5/6 and o-series take max_completion_tokens (which includes their reasoning) and no temperature
  if (/^(gpt-[5-9]|o\d)/.test(model)) {
    if (req.max_tokens) req.max_completion_tokens = Math.max(800, req.max_tokens * 4);
    delete req.max_tokens; delete req.temperature;
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(req),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// Images the customer attached (≤ 5 MB each, newest 4) are shown to the model so it can "see" them.
const VISION_MAX = 5 * 1024 * 1024;
const VISION_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
async function toModelMessages(messages) {
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
        if (!f.image || budget <= 0) continue;
        try {
          const a = await orders.getAsset(f.stored);
          if (!a || a.media_type !== "image" || !VISION_MIME.has(a.mime) || a.size_bytes > VISION_MAX) continue;
          const buf = await storage.getBuffer(a.r2_key, VISION_MAX);
          parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${buf.toString("base64")}`, detail: "low" } });
          budget--;
        } catch {}
      }
    }
    out.unshift({ role, content: parts.length === 1 ? text : parts });
  }
  return out;
}

/** The order's pictures (up to 4, ≤ 5 MB each) as vision parts, each preceded by its role. */
async function briefPictures(files) {
  const parts = [];
  for (const a of files) {
    if (parts.length >= 8) break;
    if (a.media_type !== "image" || !VISION_MIME.has(a.mime) || Number(a.size_bytes) > VISION_MAX) continue;
    try {
      const buf = await storage.getBuffer(a.r2_key, VISION_MAX);
      parts.push({ type: "text", text: `الصورة التالية: ${roleLabel(a.role)}${a.original_name ? ` (${a.original_name})` : ""}` });
      parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${buf.toString("base64")}`, detail: "auto" } });
    } catch (e) { console.error("brief picture skipped:", e.message); }
  }
  return parts;
}

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
| الصوت | ${voiceText(full.voice)} |
| السعر التقديري | $${full.price} |
| التاريخ | ${full.createdAt} |

## المرفقات
${files.length ? files.map((a) => `- ${a.media_type === "video" ? "🎬" : "🖼️"} **${roleLabel(a.role)}** – \`${a.r2_key}\` (${(Number(a.size_bytes) / 1048576).toFixed(1)} MB)`).join("\n") : "- لا توجد مرفقات"}
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
إذا كانت هناك صور مرفقة فانظر إليها فعلاً: صِف ملامح كل شخصية (الوجه، الشعر، الملابس، العمر التقريبي) تحت «الشخصيات» واكتب أن الصورة هي المرجع المعتمد لشكلها، وخذ من صور المرجع الأسلوب أو المكان أو المنتج تحت «الأسلوب البصري»، ولا تنسخ أشخاصاً ظهروا في صورة مرجع.
كن محدداً وعملياً، ولا تذكر أسعاراً، ولا تكتب أي مقدمة قبل أول عنوان.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: `خيارات الزبون:\n${orderSummary(full)}\n\nالمرفقات:\n${files.map((a) => `- ${a.original_name || a.upload_id}: ${roleLabel(a.role)}`).join("\n") || "-"}\n\nالمحادثة:\n${transcript(messages)}` },
              ...(await briefPictures(files)),
            ],
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
    db: db.configured,
    storage: storage.mode,
    demo: DEMO,
    attachLimit: ATTACH_LIMIT,
    bot: tg.configured ? tg.username : null,
    payments: payments.configured ? { provider: "wayl", env: payments.ENV, iqdPerUsd: payments.IQD_PER_USD } : null,
    whatsapp: WHATSAPP,
    trial: trial.enabled(),
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

// Customer attachments from the chat: PUT /api/attach/<filename>?role=char1 (raw body, streamed to R2).
app.put("/api/attach/:file", attachLimit, async (req, res) => {
  const original = path.basename(String(req.params.file)).slice(-120);
  const ext = path.extname(original).toLowerCase();
  const kind = UPLOAD_TYPES[ext];
  const declared = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!kind || (declared && declared !== "application/octet-stream" && !declared.startsWith(kind[0] + "/"))) {
    return res.status(415).json({ error: "نوع الملف غير مدعوم. ارفع صورة (jpg, png, webp, gif, heic) أو فيديو (mp4, mov, webm)." });
  }
  const len = Number(req.get("content-length"));
  if (!len) return res.status(411).json({ error: "الملف فارغ." });
  const max = kind[0] === "video" ? VIDEO_MAX : IMAGE_MAX;
  if (len > max) return res.status(413).json({ error: `الملف أكبر من الحد المسموح (${Math.round(max / 1048576)} MB).` });
  if (!storage.ready) return res.status(503).json({ error: "رفع الملفات غير متاح حالياً." });

  const uploadId = crypto.randomUUID();
  const key = `uploads/pending/${uploadId}${ext}`;
  try {
    await storage.put(key, req, { contentType: kind[1], contentLength: len });
    const role = ROLE_LABELS[req.query.role] ? String(req.query.role) : kind[0] === "image" ? "char1" : "ref";
    await orders.createPendingAsset({ uploadId, role, mediaType: kind[0], mime: kind[1], originalName: original, key, size: len });
    res.json({ ok: true, name: original, stored: uploadId, url: `/api/uploads/${uploadId}`, size: len, image: kind[0] === "image", video: kind[0] === "video" });
  } catch (err) {
    console.error("attach error:", err.message);
    storage.remove(key).catch(() => {});
    res.status(502).json({ error: "تعذّر حفظ الملف، حاول مرة ثانية." });
  }
});

// The upload id is a random 128-bit value known only to the browser that uploaded the file.
app.get("/api/uploads/:id", async (req, res) => {
  const a = await orders.getAsset(req.params.id).catch(() => null);
  if (!a) return res.sendStatus(404);
  try { res.redirect(302, await storage.presignGet(a.r2_key, 3600, { contentType: a.mime })); } catch { res.sendStatus(503); }
});

if (storage.mode === "local-dev") app.get("/api/dev-storage/*key", storage.devHandler);

app.post("/api/chat", chatLimit, async (req, res) => {
  const { messages = [], order = {} } = req.body || {};
  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: "no_key",
      reply:
        "المساعد الذكي غير مفعّل حالياً (لم يتم ضبط مفتاح OpenAI في ملف .env). اكتب وصف الفيديو واضغط إرسال الطلب وسنتواصل معك.",
    });
  }
  const telegram = normalizeTelegram(order.telegram);
  const phone = normalizePhone(order.phone);
  const ctx = order.quality
    ? `\n\nخيارات الزبون الحالية:\n${orderSummary({ ...order, telegram, phone, price: priceFor(order.quality, order.seconds) })}` +
      (telegram && phone ? "" : "\n(لم يكمل الزبون بعد معرّف تيليغرام ورقم الهاتف المطلوبين لإرسال الطلب.)")
    : "";
  const sent = order.requestId
    ? `\n\nهذا الزبون أرسل طلباً بالفعل: request_id=${order.requestId}، requester_id=${order.requesterId}. أي رسالة الآن هي متابعة أو تعديل على هذا الطلب؛ اذكر رقم الطلب عند الحاجة وأخبره أن التعديلات تُرفق بالطلب نفسه.`
    : "";
  try {
    // reply language follows the customer's newest message: Latin letters and no Arabic → English
    const lastText = String([...messages].reverse().find((m) => m && m.role === "user")?.content || "");
    const english = !/[؀-ۿ]/.test(lastText) && /[A-Za-z]/.test(lastText);
    const langRule = english ? "\n\nThe customer wrote in English: reply ONLY in English." : "\n\nالزبون كتب بالعربية: رد بالعربية فقط.";
    // the reply and a terms check of the newest message run side by side (no extra wait). The check never
    // changes the reply: it only tells the page to show the terms with the "you accept them" note.
    const [text, sections] = await Promise.all([
      openai({
        temperature: 0.8,
        max_tokens: 700,
        messages: [{ role: "system", content: SYSTEM_PROMPT + ctx + sent + langRule }, ...(await toModelMessages(messages))],
      }),
      policyCheck(messages, { lastOnly: true }),
    ]);
    res.json({ reply: text || "…", ...(sections.length ? { policy: { sections } } : {}) });
    // follow-up messages after an order are kept on that order
    if (order.requestId && order.accessToken && Array.isArray(messages)) {
      const owned = await orders.getOwnedOrder(order.requestId, order.requesterId, order.accessToken).catch(() => null);
      if (owned) orders.saveMessages(owned.request_id, [...messages, { role: "assistant", content: text }]).catch(() => {});
    }
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({
      error: "ai_failed",
      reply: "صار خلل بسيط بالاتصال مع المساعد، جرّب مرة ثانية أو أرسل طلبك مباشرة.",
    });
  }
});

const STATUS_TEXT = {
  queued: payments.configured
    ? "طلبك مسجّل ✔ اضغط «ادفع» لتأكيده – نبدأ المراجعة مباشرة بعد تأكيد الدفع."
    : "طلبك مسجّل ✔ لتأكيده افتح بوت التسليم على تيليغرام واضغط Start – لا نبدأ العمل قبل ذلك.",
  awaiting_admin: payments.configured ? "تم استلام الدفع ✔ طلبك قيد المراجعة من فريق VI Iraq." : "طلبك قيد المراجعة من فريق VI Iraq.",
  prompt_ready: "تمت الموافقة على طلبك ونجهّز الفيديو الآن.",
  generating: "جارٍ إنتاج الفيديو…",
  completed: "الفيديو جاهز 🎉",
  delivered: "تم تسليم الفيديو 🎉 (وصلك أيضاً على تيليغرام)",
  failed: "تعذّر إكمال الطلب، سيتواصل معك الفريق.",
  cancelled: "تم إلغاء الطلب.",
};

// Test stage (DEMO_DELIVERY=true): one status step per second, then a random showcase loop is the "video".
// Nothing paid runs; the customer gets it in the chat, on Telegram if linked, and email 2 goes out.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runDemo(requestId, briefDone) {
  for (const [from, to] of [["queued", "awaiting_admin"], ["awaiting_admin", "prompt_ready"], ["prompt_ready", "generating"]]) {
    await sleep(1000);
    await orders.setStatus(requestId, from, to, { by: "demo" });
  }
  await sleep(1000);
  const loops = fs.readdirSync(LOOPS_DIR).filter((f) => f.endsWith(".mp4"));
  const pick = loops[crypto.randomInt(loops.length)];
  await orders.setVideo(requestId, `public:loops/${pick}`);
  await orders.setStatus(requestId, "generating", "completed", { by: "demo", video: pick });
  let o = await orders.getOrder(requestId);
  if (o.telegram_chat_id) await tg.sendVideo(o).catch((e) => console.error("demo telegram:", e.message));
  await briefDone.catch(() => {}); // email 2 after email 1
  o = await orders.getOrder(requestId);
  await mail.deliveredEmail(o, { buffer: await tg.videoBuffer(o, mail.ATTACH_BUDGET), name: pick }).catch((e) => console.error("mail delivered:", e.message));
}

function orderView(o, payment = null) {
  const view = { requestId: o.request_id, requesterId: o.requester_id, status: o.status, message: STATUS_TEXT[o.status], linked: Boolean(o.telegram_chat_id), botLink: tg.configured ? tg.linkFor(o.request_id) : null };
  if (payments.configured) {
    const p = payments.view(payment);
    view.payment = {
      required: true,
      paid: Boolean(o.paid_at),
      amountIqd: p?.amountIqd || payments.iqdFor(o.options?.price),
      status: p?.status || null,
      method: p?.method || null,
      env: payments.ENV,
    };
  }
  return view;
}

// Payment confirmed by Wayl (payments.check): notify, then in the test stage run the automatic steps.
payments.setOnPaid(async (o) => {
  const p = await payments.latestPayment(o.request_id);
  if (tg.configured) await tg.announcePaid(o, p).catch((e) => console.error("telegram paid:", e.message));
  if (DEMO) runDemo(o.request_id, Promise.resolve()).catch((e) => console.error("demo:", e.message));
});

app.post("/api/order", orderLimit, async (req, res) => {
  const { messages = [], order = {} } = req.body || {};
  // Hard requirement: no valid Telegram username + Iraqi phone → nothing is created or sent anywhere.
  const telegram = normalizeTelegram(order.telegram);
  const phone = normalizePhone(order.phone);
  if (!String(order.telegram || "").trim() || !telegram) {
    return res.status(400).json({ ok: false, field: "telegram", message: "اكتب معرّف تيليغرام صحيح (مثال: @ahmed_vi) قبل إرسال الطلب." });
  }
  if (!String(order.phone || "").trim() || !phone) {
    return res.status(400).json({ ok: false, field: "phone", message: "اكتب رقم هاتف عراقي صحيح (مثال: 07501234567) قبل إرسال الطلب." });
  }
  if (!Array.isArray(messages) || !messages.some((m) => m && m.role === "user" && (String(m.content || "").trim() || (m.files || []).length))) {
    return res.status(400).json({ ok: false, field: "chat", message: "اكتب وصف الفيديو في الدردشة أولاً." });
  }
  if (!db.configured) return res.status(503).json({ ok: false, message: "الخدمة غير متاحة حالياً، حاول لاحقاً." });

  const quality = [480, 720, 1080].includes(Number(order.quality)) ? Number(order.quality) : 1080;
  const seconds = Math.min(120, Math.max(5, Number(order.seconds) || 15));
  const attachments = Array.isArray(order.attachments) ? order.attachments : [];
  const options = {
    quality,
    seconds,
    language: String(order.language || "العربية").slice(0, 60),
    characters: String(order.characters || "1").slice(0, 10),
    price: priceFor(quality, seconds),
    description: String(order.description || "").slice(0, 5000),
    attachments: Math.min(attachments.length, 30),
    voice: orderVoice(order.voice),
  };
  const idempotencyKey = clean(req.get("idempotency-key") || order.idempotencyKey) || null;

  // requests that may conflict with the terms go through; the order records that the terms were shown
  // and accepted, and the admins see it in the Telegram alert
  const termsSections = await policyCheck(messages);
  if (termsSections.length) {
    const lastText = String([...messages].reverse().find((m) => m && m.role === "user")?.content || "");
    options.termsNotice = { sections: termsSections, lang: /[؀-ۿ]/.test(lastText) ? "ar" : "en", accepted: true, at: new Date().toISOString() };
  }

  let created;
  try {
    created = await orders.createOrder({ telegram, phone, idempotencyKey, options, messages: messages.slice(-200) });
  } catch (e) {
    if (e.code === "rate_limited") return res.status(429).json({ ok: false, field: "rate", retryAfter: e.retryAfterSec, message: e.message });
    if (e.code === "conflict") return res.status(409).json({ ok: false, message: "تم استخدام هذا الطلب من قبل، أعد تحميل الصفحة." });
    console.error("order error:", e.message);
    return res.status(500).json({ ok: false, message: "تعذّر حفظ الطلب، حاول مرة ثانية." });
  }
  const o = created.order;
  const ids = { requestId: o.request_id, requesterId: o.requester_id, accessToken: o.access_token, telegram, phone };
  if (created.created && options.termsNotice) orders.addEvent(null, o.request_id, "terms_notice", options.termsNotice).catch(() => {});

  if (created.created) {
    // the customer gets the answer (and the bot link) right away; uploads, brief and admin notice follow
    const briefDone = (async () => {
      try {
        // attach the draft uploads and move them under uploads/<request_id>/
        for (const mv of await orders.claimAssets(o.request_id, o.requester_id, attachments)) {
          try { await storage.move(mv.from, mv.to); await orders.setAssetKey(mv.asset.id, mv.to); } catch (e) { console.error("asset move:", e.message); }
        }
        const files = await orders.orderAssets(o.request_id);
        const brief = await buildBrief({ ...options, requestId: o.request_id, requesterId: o.requester_id, telegram, phone, createdAt: o.created_at.toISOString() }, messages, files);
        await orders.saveBrief(o.request_id, brief);
        const fresh = await orders.getOrder(o.request_id);
        if (tg.configured) {
          await tg.announceOrder(fresh, brief).catch((e) => console.error("telegram notify:", e.message));
          await tg.sendAssets(fresh, files).catch((e) => console.error("telegram assets:", e.message)); // the customer's pictures, by role
        }
        await mail.orderEmail(fresh, brief).catch((e) => console.error("mail order:", e.message)); // email 1
      } catch (e) {
        console.error("order follow-up:", e.message);
        await orders.addEvent(null, o.request_id, "error", { step: "follow-up", message: e.message }).catch(() => {});
      }
    })();
    // with payments on, nothing moves until Wayl confirms the payment (payments.setOnPaid above)
    if (!payments.configured) {
      if (DEMO) runDemo(o.request_id, briefDone).catch((e) => console.error("demo:", e.message));
      else await orders.advance(o.request_id); // moves on only when Telegram is already linked
    }
  }

  const fresh = await orders.getOrder(o.request_id);
  const view = orderView(fresh, payments.configured ? await payments.latestPayment(o.request_id) : null);
  res.json({
    ...ids,
    ...view,
    ok: true,
    duplicate: !created.created,
    ...(o.options?.termsNotice ? { policy: { sections: o.options.termsNotice.sections } } : {}),
    message: `تم تسجيل طلبك 🎉 رقم الطلب: ${o.request_id} – ${
      payments.configured ? (fresh.paid_at ? "تم استلام الدفع ✔" : "اضغط «ادفع» لتأكيد الطلب")
      : DEMO ? "تابع الحالة في الدردشة، سيظهر الفيديو خلال ثوانٍ"
      : view.linked || !tg.configured ? "سنتواصل معك على تيليغرام @" + telegram
      : "خطوة أخيرة: افتح بوت التسليم واضغط Start لتأكيد الطلب"}`,
  });
});

// ---------- voices (voices.js): character voices, the customer's own recordings, checked before use ----------
const voiceLimit = rateLimit(15, 10 * 60 * 1000, "تسجيلات كثيرة، انتظر قليلاً ثم حاول مرة ثانية.");
const previewLimit = rateLimit(60, 10 * 60 * 1000, "طلبات كثيرة، انتظر قليلاً.");
const VOICE_MAX_BYTES = 12 * 1048576;
const PREVIEW_LINE = "هلا بيكم! آني راح أحچي بالفيديو مالتكم، شلون صوتي؟";

/** The voice part of a paid order (what the customer chose in the panel), cleaned. */
function orderVoice(v) {
  if (!v || typeof v !== "object") return null;
  const mode = ["tts", "own", "convert", "none"].includes(v.mode) ? v.mode : "tts";
  const preset = voices.byId(clean(v.preset));
  const type = voices.typeLabel(clean(v.gender), clean(v.age));
  return {
    mode, preset: preset?.id || null, label: preset?.label || type || "", clip: /^V[\w-]{8,40}$/.test(clean(v.clip)) ? clean(v.clip) : null,
    transcript: clean(v.transcript).slice(0, 600),
  };
}
function voiceText(v) {
  if (!v) return "-";
  const link = v.clip ? ` – التسجيل: ${PUBLIC_URL || ""}/api/voice/clips/${v.clip}/audio` : "";
  if (v.mode === "none") return "بدون صوت";
  if (v.mode === "own") return `صوت الزبون كما سجّله${v.transcript ? `: «${v.transcript}»` : ""}${link}`;
  if (v.mode === "convert") return `كلام الزبون بصوت ${v.label || "الشخصية"}${v.transcript ? `: «${v.transcript}»` : ""}${link}`;
  return v.label ? `صوت جاهز: ${v.label}` : "صوت جاهز يختاره الفريق";
}

app.get("/api/voices", previewLimit, (_req, res) => {
  res.set("Cache-Control", "public, max-age=600").json({ ok: true, ...voices.publicCatalog(), videoSeconds: media.VIDEO_SECONDS, recording: storage.ready && require("./watermark").ready });
});

// a short sample of each voice, made once and kept on our storage
const previewsInFlight = new Map();
app.get("/api/voices/:id/preview", previewLimit, async (req, res) => {
  const v = voices.byId(req.params.id);
  if (!v || !storage.ready) return res.sendStatus(404);
  const key = `voices/preview/${v.id}.mp3`;
  try {
    let buf = await storage.getBuffer(key, 2 * 1048576).catch(() => null);
    if (!buf) {
      if (!previewsInFlight.has(v.id)) {
        previewsInFlight.set(v.id, (async () => {
          const mp3 = await voices.speak(v, { text: PREVIEW_LINE, lang: "ar-IQ" });
          await storage.put(key, mp3, { contentType: "audio/mpeg" });
          return mp3;
        })().finally(() => previewsInFlight.delete(v.id)));
      }
      buf = await previewsInFlight.get(v.id);
    }
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }).send(buf);
  } catch (e) {
    console.error(`voice preview ${v.id}:`, e.message);
    res.status(502).json({ ok: false, message: "تعذّر تشغيل العيّنة الآن." });
  }
});

const clipOf = async (id, req) => {
  const row = (await db.query("SELECT * FROM voice_clips WHERE id = $1", [String(id || "")])).rows[0];
  return row && row.ip_hash === trial.ipHash(clientIp(req)) ? row : null;
};

// The customer's voice (recorded in the chat or uploaded): converted, checked (length, loudness, noise, words,
// speaker gender/age), kept 7 days. PUT raw audio; answers with the check the chat shows.
app.put("/api/voice/clip", voiceLimit, express.raw({ type: () => true, limit: VOICE_MAX_BYTES }), async (req, res) => {
  const type = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!/^(audio\/|video\/(webm|mp4|quicktime)$|application\/octet-stream$)/.test(type)) return res.status(415).json({ ok: false, message: "ارفع ملفاً صوتياً (mp3, m4a, wav, ogg) أو سجّل بزر المايك." });
  if (!req.body?.length) return res.status(400).json({ ok: false, message: "التسجيل فارغ." });
  if (!storage.ready || !db.configured) return res.status(503).json({ ok: false, message: "تسجيل الصوت غير متاح حالياً." });
  try {
    const { mp3 } = await voices.toMp3(req.body);
    const report = await voices.check(mp3, media.VIDEO_SECONDS);
    const id = voices.newClipId();
    const key = `voices/clips/${id}.mp3`;
    await storage.put(key, mp3, { contentType: "audio/mpeg" });
    const row = (await db.query(
      "INSERT INTO voice_clips (id, ip_hash, r2_key, duration_sec, transcript, lang, analysis) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [id, trial.ipHash(clientIp(req)), key, report.duration, report.heard.text, report.heard.lang,
       JSON.stringify({ ok: report.ok, items: report.items, speaker: report.speaker, metrics: report.metrics, ai: report.ai })]
    )).rows[0];
    console.log(`voice clip ${id}: ${report.duration}s · ${report.ok ? "ok" : "rejected"} · speaker ${report.speaker.gender || "?"}/${report.speaker.age || "?"}`);
    res.json({ ok: true, clip: voices.clipView(row) });
  } catch (e) {
    console.error("voice clip:", e.message);
    res.status(400).json({ ok: false, message: /readable|empty/.test(e.message) ? "تعذّرت قراءة التسجيل – جرّب تسجيلاً آخر أو ملف mp3." : "تعذّر فحص التسجيل، حاول مرة ثانية." });
  }
});

// "check again": runs the full check once more on the stored recording
app.post("/api/voice/clips/:id/check", voiceLimit, async (req, res) => {
  try {
    const row = await clipOf(req.params.id, req);
    if (!row) return res.status(404).json({ ok: false, message: "التسجيل غير موجود." });
    const report = await voices.check(await storage.getBuffer(row.r2_key, VOICE_MAX_BYTES), media.VIDEO_SECONDS);
    const upd = (await db.query(
      "UPDATE voice_clips SET duration_sec = $2, transcript = $3, lang = $4, analysis = $5 WHERE id = $1 RETURNING *",
      [row.id, report.duration, report.heard.text, report.heard.lang, JSON.stringify({ ok: report.ok, items: report.items, speaker: report.speaker, metrics: report.metrics, ai: report.ai })]
    )).rows[0];
    res.json({ ok: true, clip: voices.clipView(upd) });
  } catch (e) {
    console.error("voice recheck:", e.message);
    res.status(500).json({ ok: false, message: "تعذّر الفحص، حاول مرة ثانية." });
  }
});

// the recording itself (its id is a random value known only to the browser that made it, and the team's brief)
app.get("/api/voice/clips/:id/audio", statusLimit, async (req, res) => {
  const row = (await db.query("SELECT r2_key FROM voice_clips WHERE id = $1", [String(req.params.id || "")]).catch(() => ({ rows: [] }))).rows[0];
  if (!row) return res.sendStatus(404);
  try { res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" }).send(await storage.getBuffer(row.r2_key, VOICE_MAX_BYTES)); }
  catch { res.sendStatus(404); }
});

// ---------- free trial (no account, no payment; limits per visitor IP – see trial.js) ----------
const trialLimit = rateLimit(12, 10 * 60 * 1000, "طلبات كثيرة، انتظر قليلاً ثم حاول مرة ثانية.");

// Prompt builder for the free trial: planner.js (ChatGPT gpt-6-sol writes the plan from the chat with
// prompts/media-prompt-guide.md, Claude reviews it when ANTHROPIC_API_KEY is set).
const PROMPT_MODEL = planner.PROMPT_MODEL;

/** The customer's conversation for the trial: chat messages, or a single typed idea. */
function trialConversation(body) {
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  if (!msgs.some((m) => m.role === "user") && clean(body.prompt)) msgs.push({ role: "user", content: clean(body.prompt).slice(0, 800) });
  return msgs;
}

app.get("/api/trial", statusLimit, async (req, res) => {
  try { res.set("Cache-Control", "no-store").json({ ok: true, ...(await trial.status(clientIp(req))) }); }
  catch (e) { console.error("trial status:", e.message); res.status(500).json({ ok: false, enabled: false }); }
});

app.post("/api/trial/jobs", trialLimit, async (req, res) => {
  if (!trial.enabled()) return res.status(404).json({ ok: false, message: "التجربة المجانية غير متاحة حالياً." });
  if (!db.configured) return res.status(503).json({ ok: false, message: "الخدمة غير متاحة حالياً، حاول لاحقاً." });
  const body = req.body || {};
  const { kind, style, sourceJob, sourceToken } = body;
  const voiceLang = body.voice === "none" ? "none" : planner.normLang(clean(body.voice) || "ar-IQ");
  // the pictures the customer sent in the chat (paid and free versions use the same uploads)
  const refs = sourceJob ? [] : await trial.refsFrom(body.messages);
  const conversation = trialConversation(body);
  if (refs.length && !conversation.some((m) => m.role === "user")) conversation.push({ role: "user", content: "Make something from my attached picture(s)." });
  const userText = conversation.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  // what the visitor sees on the card: their own newest message (or the animate instruction)
  const text = clean(body.prompt) || clean(conversation.filter((m) => m.role === "user").at(-1)?.content) || (refs.length ? "من صوري المرفقة" : "");
  if (text.length < 3) return res.status(400).json({ ok: false, code: "invalid", message: "اكتب فكرتك في الدردشة أولاً، ثم اضغط «أنشئ مجاناً»." });
  // the voice the customer chose (videos only): a character voice, their own recording, or their words in a character's voice
  const vs = body.voiceSpec && typeof body.voiceSpec === "object" ? body.voiceSpec : {};
  let voice = { mode: voiceLang === "none" ? "none" : ["tts", "own", "convert", "none"].includes(vs.mode) ? vs.mode : "tts",
    preset: voices.byId(clean(vs.preset)) ? clean(vs.preset) : "auto",
    gender: voices.GENDERS.includes(vs.gender) ? vs.gender : null, age: voices.AGES.includes(vs.age) ? vs.age : null, clip: null };
  if (kind === "video" && (voice.mode === "own" || voice.mode === "convert")) {
    const row = await clipOf(vs.clip, req).catch(() => null);
    if (!row) return res.status(400).json({ ok: false, code: "invalid", message: "سجّل صوتك أولاً بزر المايك 🎙️ في الدردشة، ثم اختر طريقة استخدامه." });
    if (!row.analysis?.ok) return res.status(400).json({ ok: false, code: "invalid", message: "تسجيلك لم ينجح في الفحص – سجّل مرة ثانية (التفاصيل في بطاقة الفحص)." });
    voice.clip = { id: row.id, transcript: row.transcript || "", lang: voiceLang !== "none" ? voiceLang : "ar-IQ", duration: Number(row.duration_sec), mp3: await storage.getBuffer(row.r2_key, VOICE_MAX_BYTES) };
    // "own": the character on screen must match the real speaker; "convert": the chosen character
    if (voice.mode === "own") { voice.gender = row.analysis?.speaker?.gender || voice.gender; voice.age = row.analysis?.speaker?.age || voice.age; }
    else if (!voice.gender && voice.preset !== "auto") { const p = voices.byId(voice.preset); voice.gender = p.gender; voice.age = p.age; }
  } else if (voice.preset !== "auto" && !voice.gender) { const p = voices.byId(voice.preset); voice.gender = p.gender; voice.age = p.age; }
  const voicePlan = kind === "video" ? { mode: voice.mode, gender: voice.gender, age: voice.age, fixedText: voice.clip?.transcript || null, audioSeconds: voice.clip?.duration || null } : null;
  try {
    // the visitor gets the card at once; the plan is written from the chat and the pictures in the background.
    // Terms are shown (never blocking) like in the chat.
    const sections = await policyCheck([{ role: "user", content: userText }], { lastOnly: true });
    const planFn = async () => {
      const { plan, by } = await planner.plan(conversation, { kind, style, seconds: media.VIDEO_SECONDS, voiceLang, hasReferenceImage: Boolean(sourceJob), refs, voice: voicePlan });
      if (refs.length) plan.refs = refs.map((r) => r.role);
      console.log(`trial plan by ${by}: ${kind}/${style}${refs.length ? ` · ${refs.length} chat picture(s)` : ""}${plan.speech ? ` · speech ${plan.speech.lang} "${plan.speech.text.slice(0, 60)}"` : ""}${plan.onScreenText ? ` · text "${plan.onScreenText.text}"` : ""}`);
      return { plan };
    };
    const { job, token } = await trial.start({ ip: clientIp(req), kind, style, prompt: text.slice(0, 800), modelPrompt: text.slice(0, 800), refs, sourceJobId: sourceJob || null, sourceToken, termsSections: sections, planFn, voice: kind === "video" ? voice : null });
    res.json({ ok: true, job: trial.view(job, token), token, ...(sections.length ? { policy: { sections } } : {}), ...(await trial.status(clientIp(req))) });
  } catch (e) {
    if (e instanceof trial.TrialError) return res.status(["limit", "paused", "video_off"].includes(e.code) ? 429 : e.code === "provider" ? 502 : 400).json({ ok: false, code: e.code, message: e.message });
    console.error("trial start:", e.message);
    res.status(500).json({ ok: false, message: "تعذّر بدء الإنشاء، حاول مرة ثانية." });
  }
});

app.get("/api/trial/jobs/:id", statusLimit, async (req, res) => {
  try {
    const token = req.get("x-trial-token");
    const j = await trial.get(req.params.id, token);
    if (!j) return res.status(404).json({ ok: false, message: "غير موجود." });
    res.set("Cache-Control", "no-store").json({ ok: true, job: trial.view(j, token) });
  } catch (e) {
    console.error("trial job:", e.message);
    res.status(500).json({ ok: false });
  }
});

// Trial media for the visitor's own job (id + token in the link, so <img>/<video> can load it):
//   /media    → shows it
//   /download → saves it ("Content-Disposition: attachment"), through this server so the browser saves the file
// Only the stamped copy on our storage (VI-Iraq mark) is ever served – never the provider's own file.
async function trialMedia(req, res, download) {
  const j = await trial.own(req.params.id, req.query.token).catch(() => null);
  return sendTrialFile(j, res, download);
}
async function sendTrialFile(j, res, download) {
  if (!j || j.status !== "done" || !j.watermarked || !j.stored_key) return res.sendStatus(404);
  const name = `vi-iraq-${j.ticket || j.id}.${j.kind === "video" ? "mp4" : "jpg"}`;
  const type = j.kind === "video" ? "video/mp4" : "image/jpeg";
  try {
    if (!download) return res.redirect(302, await storage.presignGet(j.stored_key, 3600, { contentType: type }));
    const buf = await storage.getBuffer(j.stored_key, 150 * 1048576);
    return res.set({ "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, max-age=3600" }).send(buf);
  } catch (e) {
    console.error("trial media:", e.message);
    if (!res.headersSent) res.sendStatus(502);
  }
}
app.get("/api/trial/jobs/:id/media", statusLimit, (req, res) => trialMedia(req, res, false));
app.get("/api/trial/jobs/:id/download", statusLimit, (req, res) => trialMedia(req, res, true));

// Every finished free job → the Telegram admins get its ticket, the idea and the file.
trial.setOnDone(async (j) => {
  console.log(`free ticket ${j.ticket}: ${j.kind} ${j.style} via ${j.provider} – done`);
  if (!tg.configured) return;
  let buffer = null;
  if (j.stored_key) { try { buffer = await storage.getBuffer(j.stored_key, 45 * 1048576); } catch {} }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  await tg.notifyAdmins(
    `🎁 <b>تذكرة مجانية ${esc(j.ticket)}</b>\n${j.kind === "video" ? "🎬 فيديو" : "🖼️ صورة"} · ${j.style === "cartoon" ? "🎨 كرتون" : "📷 واقعي"} · ${esc(j.provider)}\n${esc(String(j.prompt).slice(0, 500))}${j.terms_sections?.length ? `\n⚠️ قد يخالف الشروط (القسم ${j.terms_sections.join(" و ")})` : ""}`,
    buffer ? { buffer, name: `${j.ticket}.${j.kind === "video" ? "mp4" : "jpg"}`, caption: j.ticket } : null
  );
});

// Payment link for the customer's own unpaid order (same owner check as the status route).
app.post("/api/orders/:id/pay", statusLimit, async (req, res) => {
  if (!payments.configured) return res.status(404).json({ ok: false, message: "الدفع الإلكتروني غير مفعّل حالياً." });
  try {
    const o = await orders.getOwnedOrder(req.params.id, req.get("x-requester-id"), req.get("x-order-token"));
    if (!o) return res.status(404).json({ ok: false, message: "الطلب غير موجود." });
    if (o.paid_at) return res.json({ ok: true, paid: true });
    if (o.status !== "queued") return res.status(409).json({ ok: false, message: "لا يمكن دفع هذا الطلب الآن." });
    const link = await payments.linkFor(o, publicBase(req));
    res.set("Cache-Control", "no-store").json({ ok: true, paid: false, url: link.url, amountIqd: link.amountIqd });
  } catch (e) {
    console.error("pay link:", e.message);
    res.status(502).json({ ok: false, message: "تعذّر تجهيز رابط الدفع، حاول مرة ثانية بعد قليل." });
  }
});

// Wayl status callback. The body is never trusted for the status: payments.webhook re-reads the link
// with the verification key, so a forged call can at most cause a harmless extra check.
app.post("/api/wayl/webhook", async (req, res) => {
  if (!payments.configured) return res.sendStatus(404);
  try {
    const r = await payments.webhook(req.body);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("wayl webhook:", e.message);
    res.status(500).json({ ok: false });
  }
});

// The customer's own order: request id + requester id + access token (headers) must match.
app.get("/api/orders/:id/status", statusLimit, async (req, res) => {
  try {
    let o = await orders.getOwnedOrder(req.params.id, req.get("x-requester-id"), req.get("x-order-token"));
    if (!o) return res.status(404).json({ ok: false, message: "الطلب غير موجود." });
    let payment = null;
    if (payments.configured) {
      // while the customer waits on this page, ask Wayl (throttled) whether the payment went through
      payment = o.paid_at ? await payments.latestPayment(o.request_id) : await payments.checkOrder(o.request_id);
      if (!o.paid_at && payment?.paid_at) o = await orders.getOrder(o.request_id);
    }
    const out = { ok: true, ...orderView(o, payment), videoUrl: null };
    if (o.video_key && ["completed", "delivered"].includes(o.status)) {
      out.videoUrl = o.video_key.startsWith("public:") ? `/${o.video_key.slice(7)}` : await storage.presignGet(o.video_key, 3600, { contentType: "video/mp4" });
    }
    res.set("Cache-Control", "no-store").json(out);
  } catch (e) {
    console.error("status error:", e.message);
    res.status(500).json({ ok: false, message: "تعذّر جلب حالة الطلب." });
  }
});

// ---------- request status / delivery (admin token) ----------
// Wrong admin tokens: 10 per hour per visitor, then everything (even the right token) is refused for the hour.
const adminFails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of adminFails) if (now - v.t > 3600e3) adminFails.delete(k); }, 600e3).unref();
const adminOnly = (req, res, next) => {
  const ip = clientIp(req);
  const f = adminFails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 3600e3) return res.status(429).json({ ok: false, error: "محاولات كثيرة، حاول بعد ساعة." });
  const given = Buffer.from(String(req.get("x-admin-token") || ""));
  if (!ADMIN_TOKEN || given.length !== Buffer.byteLength(ADMIN_TOKEN) || !crypto.timingSafeEqual(given, Buffer.from(ADMIN_TOKEN))) {
    if (!f || Date.now() - f.t >= 3600e3) adminFails.set(ip, { t: Date.now(), n: 1 }); else f.n++;
    return res.status(401).json({ ok: false, error: "كلمة المرور غير صحيحة." });
  }
  next();
};
app.get("/api/requests", adminOnly, async (_req, res) => {
  const rows = await orders.listOrders({ limit: 200 });
  res.json({
    bot: tg.configured ? { username: tg.username, mode: tg.mode, admins: tg.adminsCount() } : null,
    requests: rows.map((r) => ({
      id: r.request_id, requesterId: r.requester_id, status: r.status, username: r.telegram_username, phone: r.phone,
      chatId: r.telegram_chat_id, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at, paidAt: r.paid_at,
      order: r.options, brief: r.has_brief, video: Boolean(r.video_key), error: r.error,
    })),
  });
});
// The team: free tickets and each ticket's file.
app.get("/api/trials", adminOnly, async (req, res) => {
  res.json({ ok: true, tickets: await trial.list(req.query.limit) });
});
app.get("/api/trials/:ticket/file", adminOnly, async (req, res) => {
  sendTrialFile(await trial.byTicket(req.params.ticket), res, true);
});
app.get("/api/requests/:id/brief", adminOnly, async (req, res) => {
  const o = await orders.getOrder(req.params.id);
  if (!o || !o.brief_md) return res.sendStatus(404);
  res.type("text/markdown; charset=utf-8").send(o.brief_md);
});
app.post("/api/requests/:id/confirm", adminOnly, async (req, res) => {
  try { const r = await tg.confirm(String(req.params.id).toUpperCase(), "api"); res.json({ ok: true, changed: r.changed, request: orderView(r.order) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/requests/:id/deliver", adminOnly, async (req, res) => {
  const { url, key, file, caption } = req.body || {};
  const media = url ? { url: String(url) } : key || file ? { key: String(key || file) } : null;
  if (!media) return res.status(400).json({ ok: false, error: "أرسل url أو key (مفتاح الملف في R2)" });
  try { res.json({ ok: true, request: orderView(await tg.deliver(String(req.params.id).toUpperCase(), media, caption ? String(caption) : "")) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get("/{*path}", sendIndex);

async function start() {
  try {
    const m = await db.initDb();
    console.log(`Database: ready (${m.applied.length ? "applied " + m.applied.join(", ") : "up to date"})`);
  } catch (e) {
    console.error(`FATAL: database not ready – ${e.message}`);
    process.exit(1);
  }
  app.listen(PORT, async () => {
    console.log(`VI Iraq running → http://localhost:${PORT}`);
    console.log(`AI: ${OPENAI_API_KEY ? `on (${OPENAI_MODEL})` : "OFF (set OPENAI_API_KEY in .env)"}`);
    console.log(`Storage: ${storage.mode}${storage.mode === "off" ? " – set R2_* to accept uploads" : ""} · AUTO_GENERATE=${orders.autoGenerate()} · DEMO_DELIVERY=${DEMO}`);
    const m = await mail.check();
    console.log(`Mail: ${m.ok ? `on (${mail.PROVIDER}: ${mail.MAIL_FROM} → ${mail.MAIL_TO})` : `OFF – ${m.error}`}`);
    const t = await tg.init(app, PUBLIC_URL);
    console.log(`Telegram: ${tg.configured ? `${t.mode} as @${t.username || "?"} (${t.admins ?? 0} admins)${t.error ? " – " + t.error : ""}` : "OFF (set TELEGRAM_BOT_TOKEN)"}`);
    // abandoned uploads (never attached to an order) are deleted after 24 h, so the disk cannot fill up
    const sweepUploads = async () => {
      if (!storage.ready) return;
      for (const a of await orders.staleDraftAssets(24)) {
        try { await storage.remove(a.r2_key); await orders.deleteAsset(a.id); } catch (e) { console.error("upload cleanup:", e.message); }
      }
      // voice recordings are kept 7 days (long enough to order the full video with them)
      for (const c of (await db.query("SELECT id, r2_key FROM voice_clips WHERE created_at < now() - interval '7 days' LIMIT 200")).rows) {
        try { await storage.remove(c.r2_key); await db.query("DELETE FROM voice_clips WHERE id = $1", [c.id]); } catch (e) { console.error("voice cleanup:", e.message); }
      }
    };
    sweepUploads().catch((e) => console.error("upload cleanup:", e.message));
    setInterval(() => sweepUploads().catch((e) => console.error("upload cleanup:", e.message)), 3600e3).unref();
    if (trial.enabled()) {
      console.log(`Free trial: on (prompts ${PROMPT_MODEL}${planner.reviewEnabled ? " + review " + planner.CLAUDE_MODEL : ""} · voice ${media.TTS_MODEL} · pictures: fal ${media.MODELS.image}${media.openaiReady && storage.ready ? ` + ChatGPT ${media.OPENAI_IMAGE_MODEL} for ${process.env.TRIAL_OPENAI_STYLES ?? "cartoon"} and when fal is out` : ""} · video ${media.MODELS.video} ${media.VIDEO_SECONDS}s · ${trial.LIMIT.image} images + ${trial.LIMIT.video} video per IP · $${trial.DAILY_BUDGET}/day cap)`);
      console.log("Free trial watermark: on (VI-Iraq mark, bottom-right, on every picture and video)");
      trial.startSweeper();
    } else console.log(`Free trial: OFF (needs FAL_KEY or OPENAI_API_KEY, storage${require("./watermark").ready ? "" : ", and ffmpeg"})`);
    if (payments.configured) {
      const k = await payments.verifyKeys();
      console.log(`Payments: wayl ${payments.ENV} · ${payments.IQD_PER_USD} IQD/USD · callbacks → ${PAY_PUBLIC_URL || "(request host)"} · keys ${k.ok ? "valid" : "INVALID – " + k.error}`);
      payments.startSweeper();
    } else console.log("Payments: OFF (set WAYL_API_KEY)");
  });
}

if (require.main === module) start();

module.exports = { app, start };
