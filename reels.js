/**
 * VI Iraq – social intelligence layer.
 *
 *   SOURCES   trending short videos of Iraq and the Arab region (official YouTube API: titles, length, views, likes,
 *             comments) watched through their public link by Gemini (nothing is downloaded); later the studio's own
 *             Instagram reels with their insights. Other people's Instagram / TikTok videos are not collected: there
 *             is no public API for them and scraping breaks their terms.
 *   ANALYSIS  per video: the hook of the first 1–3 seconds, scene changes and pace, on-screen text, what is said,
 *             duration, look, what keeps people watching, engagement.
 *   DATABASE  reel_patterns (+ a meaning vector per pattern).
 *   DIRECTOR  note()   – for a customer who asks for a reel: what holds viewers in videos like theirs, added to the
 *                        plan of the free video, the paid order and the paid brief;
 *             direct() – a complete reel plan from an idea: hook, shot list with timing, script, on-screen line,
 *                        caption, hashtags, loop ending and the skip risks (tools/reel-director.js).
 * Patterns are learned, never copied: no people, words, music or brands of the analysed videos are reused.
 */
const db = require("./db");
const library = require("./library");

const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = () => clean(process.env.REEL_MODEL) || clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const HOOKS = ["question", "result-first", "shock", "problem", "joke", "challenge", "beauty", "story", "other"];

/** Does the customer ask for a short social video? (pure – tested) */
const isReel = (text) => /ريل|ريلز|رييل|تيك ?توك|انستا|إنستا|انستغرام|إنستغرام|ستوري|شورتس|سناب|ترند|reels?\b|tik ?tok|instagram|shorts?\b|story|stories|viral|snap/i.test(String(text || ""));

/** What Gemini wrote about a video's reel craft, as one tidy pattern (pure – tested). Null when there is nothing. */
function normalise(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const h = r.hook && typeof r.hook === "object" ? r.hook : {};
  const s = (v, n) => clean(v).replace(/\s+/g, " ").slice(0, n);
  const p = {
    hook: { seconds: Math.max(1, Math.min(5, Number(h.seconds) || 2)), type: HOOKS.includes(clean(h.type).toLowerCase()) ? clean(h.type).toLowerCase() : "other", visual: s(h.visual, 300), words: s(h.words, 300), text: s(h.text, 160) },
    cuts: Math.max(0, Math.min(200, Math.round(Number(r.cuts) || 0))), pace: ["slow", "medium", "fast"].includes(clean(r.pace).toLowerCase()) ? clean(r.pace).toLowerCase() : "medium",
    captions: s(r.captions, 240), transcript: s(r.transcript, 600), style: s(r.style, 300), retention: s(r.retention, 400), concept: s(r.concept, 240),
  };
  return p.hook.visual || p.hook.words || p.retention || p.concept ? p : null;
}
/** One number for how well a video performed: reach (log of views) plus the share of viewers who liked it. (pure) */
function strength({ views = 0, likes = 0 }) {
  const v = Math.max(0, Number(views) || 0), l = Math.max(0, Number(likes) || 0);
  return v ? +(Math.log10(v + 1) + Math.min(2, v ? (40 * l) / v : 0)).toFixed(3) : 0;
}
const embedText = (title, p) => `${title}\n${p.hook.type} hook: ${p.hook.visual} ${p.hook.words}\n${p.concept}\n${p.retention}\n${p.style}`.slice(0, 1400);

/** Stores (or refreshes) one analysed video. meta: { id, source, region, kind, title, url, secs, views, likes, comments } */
async function save(meta, raw) {
  const p = normalise(raw);
  if (!p || !meta?.id) return false;
  let vec = null;
  if (library.semanticOn()) { try { vec = (await library.embed([embedText(meta.title, p)], 20000))[0]; } catch (e) { console.error("reel vector:", e.message); } }
  await db.query(
    `INSERT INTO reel_patterns (id, source, region, kind, title, url, duration_sec, views, likes, comments, strength, pattern, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET views=$8, likes=$9, comments=$10, strength=$11, pattern=$12, embedding=coalesce($13, reel_patterns.embedding)`,
    [meta.id, meta.source || "youtube", meta.region || null, meta.kind || null, clean(meta.title).slice(0, 200), meta.url || null, Number(meta.secs) || 0,
     Number(meta.views) || 0, Number(meta.likes) || 0, Number(meta.comments) || 0, strength(meta), p, vec]);
  cachedAt = 0;
  return true;
}

async function ask(system, user, max = 8000, images = []) {
  const model = MODEL();
  user = String(user).toWellFormed(); system = String(system).toWellFormed(); // half an emoji (a cut title) makes the API refuse the request
  const content = images.length ? [{ type: "text", text: user }, ...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}`, detail: "low" } }))] : user;
  const body = { model, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content }] };
  if (/^(gpt-[5-9]|o\d)/.test(model)) body.max_completion_tokens = max; else { body.max_tokens = Math.min(max, 4000); body.temperature = 0.6; }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`reel model ${r.status} ${String(j.error?.message || "").slice(0, 160)}`);
  return JSON.parse(j.choices?.[0]?.message?.content || "{}");
}

const REEL_SHAPE = `{"hook":{"seconds":1-3,"type":"${HOOKS.join("|")}","visual":"what is on screen in the first 1-3 seconds","words":"what is said or heard then (English, with the original words in brackets)","text":"on-screen text in those seconds, if any"},"cuts":<number of scene changes in the whole video>,"pace":"slow|medium|fast","captions":"how on-screen text or captions are used","transcript":"the spoken words in order, short, original language","style":"camera, framing, light, vertical or wide","retention":"what keeps a viewer to the end, when the payoff comes, whether the end loops back","concept":"the reusable idea in one sentence"}`;

/** Videos Gemini already watched (timeline + sound are stored) get their reel pattern from those notes – no new watching. */
async function backfill({ limit = 40, log = console.log } = {}) {
  const rows = (await db.query(`SELECT v.id, v.title, v.page_url, v.duration_sec, v.check_result AS c,
      (SELECT info->'video' FROM trained_trends t WHERE t.source='youtube' AND 'youtube:' || (t.info->'video'->>'id') = v.id ORDER BY t.id DESC LIMIT 1) AS yt
    FROM trained_videos v WHERE v.source='youtube-gemini' AND v.status='studied' AND v.score >= 4
      AND jsonb_array_length(coalesce(v.check_result->'timeline','[]'::jsonb)) > 0 AND NOT EXISTS (SELECT 1 FROM reel_patterns p WHERE p.id = v.id)
    ORDER BY v.studied_at DESC LIMIT $1`, [limit])).rows;
  let done = 0;
  for (let i = 0; i < rows.length; i += 6) {
    const part = rows.slice(i, i + 6);
    const out = await ask(`You analyse short social videos for a studio that makes reels for Iraqi and Arab customers. For each video you get the notes of someone who watched it second by second (timeline, sound, voices). Write its REEL PATTERN – how it catches and keeps viewers – as JSON {"videos":[{"n":<number>,"reel":${REEL_SHAPE}}]}. Use only what the notes say; describe craft, not the people; nothing about violence, religion or politics.`,
      part.map((r, k) => `VIDEO ${k}: "${r.title}" · ${Math.round(r.duration_sec)} s · ${r.yt?.views || 0} views · ${r.c.kind || ""} · ${r.c.region || ""}\nabout: ${clean(r.yt?.about).slice(0, 200)}\ntimeline: ${JSON.stringify((r.c.timeline || []).slice(0, 14))}\nvoices: ${JSON.stringify((r.c.sound?.voices || []).slice(0, 4))}\nsounds: ${JSON.stringify((r.c.sound?.layers || []).slice(0, 5))}`).join("\n\n"));
    for (const v of Array.isArray(out.videos) ? out.videos : []) {
      const r = part[Number(v.n)]; if (!r) continue;
      if (await save({ id: r.id, source: "youtube", region: r.c.region, kind: r.c.kind, title: r.title, url: r.page_url, secs: r.duration_sec, views: r.yt?.views, likes: r.yt?.likes, comments: r.yt?.comments }, v.reel)) done++;
    }
    log(`reel patterns: ${done} of ${Math.min(i + 6, rows.length)}`);
  }
  return done;
}

/**
 * A video FILE the owner put into the studio's inbox (his own reel, or one he has permission to study): frames of the
 * first three seconds and of the rest, the number of scene changes (ffmpeg), the spoken words (Whisper) → its reel
 * pattern. Numbers the owner knows can stand in a text file beside the video: "views: 120000 likes: 9000".
 * Nothing is fetched from the internet here, and the inbox deletes the video after the study.
 */
async function fromFile(file, { id, title, secs = 0, note = "", source = "inbox", url = null, kind = "Own reel" }) {
  const fs = require("fs"), os = require("os"), path = require("path"), watermark = require("./watermark"), voices = require("./voices");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-file-"));
  try {
    const cutsOut = await watermark.run(["-i", file, "-vf", "select='gt(scene,0.32)',showinfo", "-an", "-f", "null", "-"], 180000);
    const cuts = (cutsOut.stderr.match(/pts_time:/g) || []).length;
    const times = [0.1, 0.8, 1.6, 2.4, 3.2, ...[0.3, 0.45, 0.6, 0.75, 0.92].map((f) => Math.max(3.6, secs * f))].filter((t, i) => i < 5 || t < secs);
    const shots = [];
    for (const [i, t] of times.entries()) {
      const out = path.join(dir, `f${i}.jpg`);
      const r = await watermark.run(["-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "4", out]);
      if (r.code === 0 && fs.existsSync(out)) shots.push({ t, buf: fs.readFileSync(out) });
    }
    let said = "";
    try {
      const mp3 = path.join(dir, "a.mp3");
      const r = await watermark.run(["-y", "-i", file, "-vn", "-t", "90", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3]);
      if (r.code === 0 && fs.existsSync(mp3)) { const t = await voices.transcribe(fs.readFileSync(mp3)); said = clean(typeof t === "string" ? t : t?.text).slice(0, 900); }
    } catch (e) { console.error("reel transcript:", e.message); }
    if (!shots.length) return false;
    const out = await ask(`You analyse one short social video for a studio that makes reels for Iraqi and Arab customers. You get frames (their seconds are listed – the first ones cover the opening 3 seconds), the number of scene changes a tool counted, and the spoken words. Write its REEL PATTERN – how it catches and keeps viewers – as JSON {"reel":${REEL_SHAPE}}. Describe craft, not the people.`,
      `VIDEO: "${title}" · ${Math.round(secs)} s · scene changes counted: ${cuts}\nframes at seconds: ${shots.map((s) => s.t.toFixed(1)).join(", ")}\nspoken words: ${said || "(none heard)"}`, 3000, shots.map((s) => s.buf));
    const reel = { ...(out.reel || {}), cuts: Number(out.reel?.cuts) || cuts, transcript: clean(out.reel?.transcript) || said };
    const n = (k) => Number((new RegExp(`${k}\\s*[:=]\\s*([\\d,.]+)`, "i").exec(note) || [])[1]?.replace(/[,.]/g, "")) || 0;
    return save({ id, source, url, region: "IQ", kind, title, secs, views: n("views") || n("مشاهدات"), likes: n("likes") || n("لايكات"), comments: n("comments") }, reel);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- the patterns in memory (refreshed every 5 minutes) ------------------------------------------------------------
let cache = [], cachedAt = 0;
async function all() {
  if (Date.now() - cachedAt < 5 * 60000 && cache.length) return cache;
  if (!db.configured) return cache;
  cache = (await db.query("SELECT id, region, kind, title, duration_sec, views, likes, strength, pattern, embedding FROM reel_patterns ORDER BY strength DESC LIMIT 1500")).rows
    .map((r) => ({ ...r, vec: Array.isArray(r.embedding) ? Float32Array.from(r.embedding) : null, embedding: undefined }));
  cachedAt = Date.now();
  return cache;
}
/** The patterns closest to an idea, the stronger ones first. */
async function nearest(text, n = 5) {
  const list = await all();
  if (!list.length) return [];
  const top = list[0].strength || 1;
  let q = null;
  if (library.semanticOn() && clean(text).length > 2) { try { q = (await library.embed([clean(text).slice(-1500)], 8000))[0]; } catch {} }
  return list.map((p) => ({ p, s: (q && p.vec ? library.dot(q, p.vec) : 0.3) * 0.7 + (p.strength / top) * 0.3 })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p);
}
/** What the strong half of the collection has in common (pure on a list – tested). */
function summary(list) {
  const strong = [...list].sort((a, b) => b.strength - a.strength).slice(0, Math.max(1, Math.ceil(list.length / 2)));
  const median = (xs) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const hooks = {}; for (const p of strong) hooks[p.pattern.hook.type] = (hooks[p.pattern.hook.type] || 0) + 1;
  const short = strong.filter((p) => p.duration_sec > 0 && p.duration_sec <= 90);
  return { videos: list.length, seconds: Math.round(median(short.map((p) => p.duration_sec))), hookSeconds: median(strong.map((p) => p.pattern.hook.seconds)) || 2,
    cutsPer10s: +(median(short.map((p) => (p.pattern.cuts * 10) / p.duration_sec)) || 0).toFixed(1), hooks: Object.entries(hooks).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).slice(0, 5) };
}
const line = (p) => `- [${p.views ? Number(p.views).toLocaleString("en-US") + " views" : "trending"}, ${Math.round(p.duration_sec)} s, ${p.pattern.hook.type} hook, ${p.pattern.pace} pace] opens with: ${p.pattern.hook.visual}${p.pattern.hook.words ? ` – heard: ${p.pattern.hook.words}` : ""}. Keeps viewers: ${p.pattern.retention}`;

/** For the planner, the paid storyboard and the brief: how to hold viewers, when the customer asks for a reel. */
async function note(text) {
  try {
    if (!isReel(text)) return { text: "", ids: [] };
    const list = await all();
    if (!list.length) return { text: "", ids: [] };
    const s = summary(list), near = await nearest(text, 4);
    return { ids: near.map((p) => p.id), text: `\n\nREEL DIRECTION – this is a short social video; build it so viewers do not swipe away (learned from ${s.videos} trending short videos of Iraq and the Arab region – learn the craft, never copy their people, words, music or brands):
- THE FIRST ${s.hookSeconds} SECONDS decide: open already inside the action or with the result, the question or the surprise – no slow start, no title card, no logo first. The strongest openings here: ${s.hooks.join(", ")}.
- One idea, one payoff near the end; cut or move often enough to stay alive (about ${s.cutsPer10s || 2} scene changes per 10 seconds in the strong videos) and never hold a dead second.
- End on the payoff or so the last moment flows back into the first (a loop), not on a fade-out.
- A person speaking or reacting on screen in the first seconds holds better than an empty scene.
Openings and reasons that worked for videos like this one:\n${near.map(line).join("\n")}` };
  } catch (e) { console.error("reel note:", e.message); return { text: "", ids: [] }; }
}

/** The Reel Director: a complete reel plan for an idea, built on the patterns that hold viewers. */
async function direct(idea, { seconds = 15, lang = "Iraqi Arabic dialect (Baghdadi)" } = {}) {
  const list = await all(), near = await nearest(idea, 6), s = list.length ? summary(list) : null;
  const lib = await library.note([{ role: "user", content: idea }], "video").catch(() => ({ text: "" }));
  const out = await ask(`You are the Reel Director of VI Iraq, an AI video studio for Iraqi and Arab customers. Write a complete plan for ONE Instagram reel of ${seconds} seconds that viewers do not skip. Use the patterns below (what trending short videos of the region do) as craft only – never copy their people, words, music or brands. Everything must be producible by an AI video generator: real people in real places, one location, few characters, no readable text inside the picture (captions are added on top afterwards), no brand logos, nothing sexual, violent, political or religious.
Return JSON only:
{"title":"working title",
 "hook":{"seconds":1-3,"visual":"exactly what the first frame and second show","line":"the words heard, in ${lang}","on_screen":"one short caption line in ${lang}, max 6 words"},
 "shots":[{"t":"0-2","shot":"framing and camera","action":"what happens","line":"spoken words in ${lang} or empty","on_screen":"caption or empty"}],
 "voice":"who speaks and how (gender, age, mood)",
 "ending":"the payoff and how the last moment loops into the first",
 "caption":"the post caption in ${lang} with search words",
 "hashtags":["3-5 tags"],
 "skip_risks":["what could make viewers swipe away in this plan and how it is avoided"],
 "video_prompt":"one English paragraph, max 150 words, ready for the video generator: people, clothes, place, light, the actions in order, the sounds",
 "based_on":["the numbers of the patterns used"]}
The shots cover 0 to ${seconds} seconds without gaps.`,
    `IDEA: ${idea}\n\n${s ? `WHAT THE STRONG VIDEOS SHARE: typical length ${s.seconds} s · hook in the first ${s.hookSeconds} s · about ${s.cutsPer10s} scene changes per 10 s · strongest openings: ${s.hooks.join(", ")}\n\n` : ""}PATTERNS:\n${near.map((p, i) => `${i + 1}. ${line(p).slice(2)} | look: ${p.pattern.style} | idea: ${p.pattern.concept}`).join("\n") || "(none yet)"}${lib.text || ""}`, 9000);
  return { ...out, patterns: near.map((p) => ({ id: p.id, title: p.title, views: Number(p.views) || 0 })) };
}

module.exports = { ask, isReel, normalise, strength, summary, save, fromFile, backfill, all, nearest, note, direct, REEL_SHAPE, HOOKS };
