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
const { normalizeTelegram, normalizePhone } = require("./validate");

const app = express();
const PORT = process.env.PORT || 3000;

const clean = (v) => String(v || "").trim();
const OPENAI_API_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_MODEL = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const ADMIN_TOKEN = clean(process.env.ADMIN_TOKEN);
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

// Behind a tunnel / hosting proxy the real visitor IP is in X-Forwarded-For.
app.set("trust proxy", true);
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
    const h = hits.get(req.ip);
    if (!h || now - h.t > windowMs) { hits.set(req.ip, { t: now, n: 1 }); return next(); }
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
كن محدداً وعملياً، ولا تذكر أسعاراً، ولا تكتب أي مقدمة قبل أول عنوان.`,
          },
          {
            role: "user",
            content: `خيارات الزبون:\n${orderSummary(full)}\n\nالمرفقات:\n${files.map((a) => `- ${a.original_name || a.upload_id}: ${roleLabel(a.role)}`).join("\n") || "-"}\n\nالمحادثة:\n${transcript(messages)}`,
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
    const reply = await openai({
      temperature: 0.8,
      max_tokens: 700,
      messages: [{ role: "system", content: SYSTEM_PROMPT + ctx + sent }, ...(await toModelMessages(messages))],
    });
    res.json({ reply: reply || "…" });
    // follow-up messages after an order are kept on that order
    if (order.requestId && order.accessToken && Array.isArray(messages)) {
      const owned = await orders.getOwnedOrder(order.requestId, order.requesterId, order.accessToken).catch(() => null);
      if (owned) orders.saveMessages(owned.request_id, [...messages, { role: "assistant", content: reply }]).catch(() => {});
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
  };
  const idempotencyKey = clean(req.get("idempotency-key") || order.idempotencyKey) || null;

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
        if (tg.configured) await tg.announceOrder(fresh, brief).catch((e) => console.error("telegram notify:", e.message));
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
    message: `تم تسجيل طلبك 🎉 رقم الطلب: ${o.request_id} – ${
      payments.configured ? (fresh.paid_at ? "تم استلام الدفع ✔" : "اضغط «ادفع» لتأكيد الطلب")
      : DEMO ? "تابع الحالة في الدردشة، سيظهر الفيديو خلال ثوانٍ"
      : view.linked || !tg.configured ? "سنتواصل معك على تيليغرام @" + telegram
      : "خطوة أخيرة: افتح بوت التسليم واضغط Start لتأكيد الطلب"}`,
  });
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
const adminOnly = (req, res, next) => {
  const given = Buffer.from(String(req.get("x-admin-token") || ""));
  if (!ADMIN_TOKEN || given.length !== Buffer.byteLength(ADMIN_TOKEN) || !crypto.timingSafeEqual(given, Buffer.from(ADMIN_TOKEN))) {
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
    if (payments.configured) {
      const k = await payments.verifyKeys();
      console.log(`Payments: wayl ${payments.ENV} · ${payments.IQD_PER_USD} IQD/USD · callbacks → ${PAY_PUBLIC_URL || "(request host)"} · keys ${k.ok ? "valid" : "INVALID – " + k.error}`);
      payments.startSweeper();
    } else console.log("Payments: OFF (set WAYL_API_KEY)");
  });
}

if (require.main === module) start();

module.exports = { app, start };
