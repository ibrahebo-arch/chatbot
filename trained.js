/**
 * VI Iraq – "Trained Model": keeps studying real footage and what is trending, and turns it into library knowledge.
 *
 * One cycle (systemd timer → tools/trained-model.js cycle):
 *   1. trends  – Google Trends daily searches (keyless RSS, TRAIN_GEOS) + YouTube most popular titles/tags (only with
 *                YOUTUBE_API_KEY, official API, nothing downloaded)
 *   2. topics  – the prompt model turns the trends + a rotating list of realism basics into short footage searches
 *   3. footage – freely licensed real videos: Wikimedia Commons (keyless) and Pexels (PEXELS_API_KEY)
 *   4. study   – frames of each clip → the prompt model writes a reality check (what makes it real, what AI usually
 *                gets wrong) and 0–2 draft library entries
 *   5. record  – every clip with its licence and author, the reality check and the drafts (trained_* tables)
 * Drafts never reach the planner on their own: a reviewer approves them (tools/trained-model.js approve), which writes
 * them into prompt_library with source='trained'; the library reloads its rows within 5 minutes.
 * Downloaded clips and frames are deleted right after the study – only our own words and the provenance are kept.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const watermark = require("./watermark");
const library = require("./library");

const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = clean(process.env.TRAIN_MODEL) || clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const GEOS = (clean(process.env.TRAIN_GEOS) || "IQ,SA,AE,EG,US").split(",").map(clean).filter(Boolean);
const MAX_MB = Number(process.env.TRAIN_MAX_MB) || 60;
const UA = `VI-Iraq-trained-model/1.0 (+${clean(process.env.PUBLIC_URL) || "https://www.vi-iraq.com"})`;
const DOMAINS = ["reality", "human", "sound", "place", "item", "action", "nature", "animal", "style"];

// Realism basics the model keeps coming back to, one slice per cycle, whatever is trending.
const BASICS = [
  "person talking to camera close up", "people laughing together", "hands pouring tea", "pouring milk", "coffee pouring",
  "water splash", "cooking in a kitchen", "market crowd", "street traffic", "car driving city night", "child playing",
  "walking in the street", "wedding dance", "rain on street", "wind in palm trees", "desert sand wind", "river boat",
  "cat", "horse running", "birds flying", "fire burning", "smoke", "bread baking", "eating food", "phone in hand",
  "hair in wind", "fabric moving", "running", "football", "night city lights", "sunset sea waves", "snow falling",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const stripTags = (s) => decode(s).replace(/<[^>]+>/g, "").trim();

/** Google Trends RSS → [{topic, traffic, news}] (pure – tested). */
function parseTrends(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const topic = decode((/<title>([\s\S]*?)<\/title>/.exec(item) || [])[1]);
    if (!topic) continue;
    const traffic = decode((/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(item) || [])[1]);
    const news = [...item.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((x) => decode(x[1])).filter(Boolean).slice(0, 3);
    out.push({ topic, traffic, news });
  }
  return out;
}

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 30000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

/** Today's trends: Google Trends per region + YouTube most popular (titles/tags only) when a key is set. */
async function fetchTrends() {
  const all = [];
  for (const geo of GEOS) {
    try {
      const r = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) for (const t of parseTrends(await r.text()).slice(0, 12)) all.push({ source: "google-trends", region: geo, ...t });
    } catch (e) { console.error(`trends ${geo}:`, e.message); }
  }
  const yt = clean(process.env.YOUTUBE_API_KEY);
  if (yt) {
    for (const geo of GEOS.slice(0, 3)) {
      try {
        const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=15&regionCode=${geo}&key=${encodeURIComponent(yt)}`);
        for (const v of d.items || []) all.push({ source: "youtube", region: geo, topic: clean(v.snippet?.title).slice(0, 160), traffic: "", news: (v.snippet?.tags || []).slice(0, 6) });
      } catch (e) { console.error(`youtube ${geo}:`, e.message); }
    }
  }
  return all;
}

/** One OpenAI JSON call (text + optional images). */
async function askJson(text, images = [], maxTokens = 2500) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not set");
  const content = [{ type: "text", text }, ...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}`, detail: "high" } }))];
  const body = { model: MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" } };
  if (/^(gpt-[5-9]|o\d)/.test(MODEL)) body.max_completion_tokens = maxTokens; else { body.max_tokens = maxTokens; body.temperature = 0.3; }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `OpenAI ${r.status}`);
  return JSON.parse(String(d.choices?.[0]?.message?.content || "{}").replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

/** Trends + a slice of the basics → footage searches (English, filmable), each tagged with its trend. */
async function planTopics(trends, count, cycleNo = 0) {
  const basics = Array.from({ length: Math.ceil(count / 2) }, (_, i) => BASICS[(cycleNo * 4 + i) % BASICS.length]).map((q) => ({ q, trend: "" }));
  if (!trends.length) return basics.slice(0, count);
  try {
    const list = trends.slice(0, 60).map((t) => `- [${t.region}/${t.source}] ${t.topic}${t.news?.length ? ` (${t.news.join(" | ")})` : ""}`).join("\n");
    const v = await askJson(`You plan what an AI video studio for Iraqi and Arab customers should study in REAL footage this week.
Today's trends:\n${list}
Pick the trends people could order a short video about (events, places, foods, sports, celebrations, products, everyday life) and turn each into ONE short English search for real stock footage (2–4 words, things a camera can film: "football stadium crowd", "lamb grilling", "rain flood street"). Skip politics, war, crime, accidents, tragedies, real people's names, brands and anything sexual.
Return JSON only: {"queries":[{"q":"...","trend":"<the trend it comes from>"}]} with at most ${Math.max(1, count - basics.length)} items.`, [], 1200);
    const picked = (Array.isArray(v.queries) ? v.queries : []).map((x) => ({ q: clean(x.q).toLowerCase().slice(0, 60), trend: clean(x.trend).slice(0, 160) })).filter((x) => /^[a-z0-9 '-]{3,60}$/.test(x.q));
    return [...picked.slice(0, count - basics.length), ...basics].slice(0, count);
  } catch (e) { console.error("trained topics:", e.message); return basics.slice(0, count); }
}

/** Wikimedia Commons video search → candidate clips (free licences, author + licence kept). */
async function searchCommons(q, limit = 6) {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`filetype:video ${q}`)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiextmetadatafilter=LicenseShortName|Artist`;
  const d = await getJson(u);
  return Object.values(d.query?.pages || {}).map((p) => {
    const i = p.imageinfo?.[0] || {};
    return {
      id: `commons:${p.pageid}`, source: "commons", query: q, title: clean(p.title).replace(/^File:/, "").slice(0, 200),
      page_url: i.descriptionurl, media_url: clean(i.url).split("?")[0], license: stripTags(i.extmetadata?.LicenseShortName?.value),
      author: stripTags(i.extmetadata?.Artist?.value).slice(0, 120), duration_sec: Number(i.duration) || 0, size: Number(i.size) || 0,
    };
  }).filter((v) => v.media_url && v.duration_sec >= 3 && v.duration_sec <= 600);
}

/** Pexels video search (only with PEXELS_API_KEY; the Pexels licence allows this use). */
async function searchPexels(q, limit = 4) {
  const key = clean(process.env.PEXELS_API_KEY);
  if (!key) return [];
  const d = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${limit}&size=small`, { headers: { Authorization: key } });
  return (d.videos || []).map((v) => {
    const file = (v.video_files || []).filter((f) => f.link && (f.width || 0) <= 1280).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return file && { id: `pexels:${v.id}`, source: "pexels", query: q, title: clean(v.url).split("/").filter(Boolean).pop()?.slice(0, 200) || `pexels ${v.id}`,
      page_url: v.url, media_url: file.link, license: "Pexels License", author: clean(v.user?.name).slice(0, 120), duration_sec: Number(v.duration) || 0, size: 0 };
  }).filter(Boolean).filter((v) => v.duration_sec >= 3 && v.duration_sec <= 600);
}

/** A big Commons original → its 480p transcode (same path under /transcoded/). */
const commonsSmall = (url) => url.replace("/wikipedia/commons/", "/wikipedia/commons/transcoded/") + "/" + url.split("/").pop() + ".480p.vp9.webm";

/** Downloads a clip (size-capped) into dir; returns the file path. */
async function download(v, dir) {
  const urls = v.source === "commons" && v.size > MAX_MB * 1e6 ? [commonsSmall(v.media_url)] : [v.media_url, ...(v.source === "commons" ? [commonsSmall(v.media_url)] : [])];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(180000) });
      if (!r.ok) continue;
      const len = Number(r.headers.get("content-length") || 0);
      if (len > MAX_MB * 1e6) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_MB * 1e6 || buf.length < 1000) continue;
      const f = path.join(dir, "clip" + (path.extname(new URL(url).pathname) || ".mp4"));
      fs.writeFileSync(f, buf);
      return f;
    } catch {}
  }
  throw new Error("download failed or too big");
}

/** n JPEG frames (base64) spread over the clip (first 90 s at most). */
async function frames(file, duration, n = 6) {
  const span = Math.min(duration || 10, 90), out = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(path.dirname(file), `f${i}.jpg`);
    try {
      await watermark.run(["-y", "-ss", (span * (i + 0.5) / n).toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", f], 60000);
      if (fs.existsSync(f)) out.push(fs.readFileSync(f).toString("base64"));
    } catch {}
  }
  return out;
}

/** Existing names, for spotting drafts the library already covers. */
function knownNames(list = library.loadFiles()) {
  const m = new Map();
  for (const e of list) for (const n of e.names || []) m.set(library.norm(n).trim(), e.id);
  return m;
}

/**
 * A draft entry from the model, checked and normalised (pure – tested): id under "trained.", known domain, 3–12 short
 * names, an English body of 60–900 characters without links. Returns { ok, entry, reason, duplicateOf }.
 */
function validateDraft(raw, known = new Map()) {
  const e = raw && typeof raw === "object" ? raw : {};
  const slug = clean(e.slug || e.id).toLowerCase().replace(/^trained\./, "").replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const domain = clean(e.domain).toLowerCase();
  const names = [...new Set((Array.isArray(e.names) ? e.names : []).map((n) => clean(n).toLowerCase()).filter((n) => n.length >= 2 && n.length <= 40))].slice(0, 12);
  const body = clean(e.body).replace(/\s+/g, " ");
  const kinds = (Array.isArray(e.kinds) ? e.kinds : ["video", "image"]).filter((k) => k === "video" || k === "image");
  const fail = (reason) => ({ ok: false, reason });
  if (slug.length < 3) return fail("no id");
  if (!DOMAINS.includes(domain)) return fail(`unknown domain ${domain}`);
  if (names.length < 3) return fail("needs 3+ trigger names");
  if (!names.some((n) => /[؀-ۿ]/.test(n)) || !names.some((n) => /^[a-z]/.test(n))) return fail("needs Arabic and English names");
  if (body.length < 60 || body.length > 900) return fail("body length");
  if (/https?:\/\/|www\./i.test(body)) return fail("link in body");
  const entry = { id: `trained.${domain}.${slug}`.slice(0, 80), domain, names, kinds: kinds.length ? kinds : ["video", "image"], priority: 55, body };
  const hits = names.map((n) => known.get(library.norm(n).trim())).filter(Boolean);
  const top = hits.sort((a, b) => hits.filter((x) => x === b).length - hits.filter((x) => x === a).length)[0];
  const duplicateOf = top && hits.filter((x) => x === top).length >= Math.ceil(names.length / 2) ? top : null;
  return { ok: true, entry, duplicateOf };
}

/** The reality check of one clip: frames → what makes it real, what AI gets wrong, 0–2 draft entries. */
async function study(v, imgs) {
  const out = await askJson(`These ${imgs.length} frames (in order) come from a REAL video: "${v.title}" (searched as "${v.query}"${v.trend ? `, studied because "${v.trend}" is trending` : ""}).
You train an AI video studio for Iraqi and Arab customers so its generated videos become indistinguishable from real footage. Study the frames like a cinematographer and a physicist:
1. reality: concrete visible facts that make this footage real – motion and physics (how liquids, fabric, hair, smoke, bodies, vehicles really move), light and shadow, camera behaviour (handheld, lens, focus, exposure), materials and textures, how people behave, sound you can infer.
2. ai_mistakes: what AI video generators usually get WRONG for this kind of scene.
3. score: 0–10, how much this clip teaches about reality (10 = rich, clear real-world detail; 0 = useless: slideshow, text, animation, graphics, blurry).
4. entries: 0–2 NEW library entries (only if the clip teaches something specific and reusable). Each: {"slug":"short-ascii-kebab","domain":one of ${DOMAINS.join("|")},"kinds":["video"] or ["video","image"],"names":[4–10 trigger words a customer might type: Iraqi/Arabic AND English, specific, never generic words],"body":"70–130 words, English, concrete visible and audible details that a prompt writer can copy into a video prompt; no history, no opinions, no real people's names, no brands, no links"}.
Return JSON only: {"score":0-10,"reality":["..."],"ai_mistakes":["..."],"entries":[...]}`, imgs, 3000);
  return {
    score: Math.max(0, Math.min(10, Number(out.score) || 0)),
    reality: (Array.isArray(out.reality) ? out.reality : []).map((x) => clean(x).slice(0, 300)).filter(Boolean).slice(0, 12),
    ai_mistakes: (Array.isArray(out.ai_mistakes) ? out.ai_mistakes : []).map((x) => clean(x).slice(0, 300)).filter(Boolean).slice(0, 10),
    entries: (Array.isArray(out.entries) ? out.entries : []).slice(0, 2),
  };
}

/** One full cycle. Returns a short report. */
async function cycle(db, { videos = Number(process.env.TRAIN_VIDEOS_PER_CYCLE) || 8, log = console.log } = {}) {
  const report = { trends: 0, queries: 0, studied: 0, failed: 0, drafts: 0, duplicates: 0, rejected: 0 };
  const trends = await fetchTrends();
  report.trends = trends.length;
  for (const t of trends) await db.query("INSERT INTO trained_trends (source, region, topic, traffic, info) VALUES ($1,$2,$3,$4,$5)", [t.source, t.region, t.topic.slice(0, 300), t.traffic || null, { news: t.news || [] }]);
  const cycleNo = Number((await db.query("SELECT count(DISTINCT date_trunc('hour', created_at)) AS n FROM trained_videos")).rows[0].n) || 0;
  const queries = await planTopics(trends, Math.max(2, Math.ceil(videos / 2)), cycleNo);
  report.queries = queries.length;
  const known = knownNames([...library.loadFiles(), ...(await db.query("SELECT id, names FROM prompt_library")).rows]);
  let left = videos;
  for (const { q, trend } of queries) {
    if (left <= 0) break;
    let found = [];
    try { found = [...(await searchPexels(q)), ...(await searchCommons(q))]; } catch (e) { log(`search "${q}": ${e.message}`); }
    const seen = new Set((await db.query("SELECT id FROM trained_videos WHERE id = ANY($1)", [found.map((v) => v.id)])).rows.map((r) => r.id));
    for (const v of found.filter((x) => !seen.has(x.id)).slice(0, 2)) {
      if (left <= 0) break;
      left--;
      await db.query(`INSERT INTO trained_videos (id, source, query, trend, title, page_url, media_url, license, author, duration_sec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.source, q, trend || null, v.title, v.page_url, v.media_url, v.license, v.author, v.duration_sec]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trained-"));
      try {
        const file = await download(v, dir);
        const imgs = await frames(file, v.duration_sec);
        if (imgs.length < 3) throw new Error("could not read frames");
        const s = await study(v, imgs);
        await db.query("UPDATE trained_videos SET status='studied', score=$2, check_result=$3, studied_at=now(), error=NULL WHERE id=$1", [v.id, s.score, { reality: s.reality, ai_mistakes: s.ai_mistakes }]);
        report.studied++;
        if (s.score >= 5) {
          for (const raw of s.entries) {
            const c = validateDraft(raw, known);
            if (!c.ok) { report.rejected++; continue; }
            const status = c.duplicateOf ? "duplicate" : "pending";
            await db.query("INSERT INTO trained_candidates (video_id, entry, status, note) VALUES ($1,$2,$3,$4)", [v.id, c.entry, status, c.duplicateOf ? `library already has ${c.duplicateOf}` : null]);
            if (status === "pending") { report.drafts++; for (const n of c.entry.names) known.set(library.norm(n).trim(), c.entry.id); } else report.duplicates++;
          }
        }
        log(`studied ${v.id} "${v.title}" score ${s.score}`);
      } catch (e) {
        report.failed++;
        await db.query("UPDATE trained_videos SET status='failed', error=$2 WHERE id=$1", [v.id, String(e.message).slice(0, 300)]);
        log(`failed ${v.id}: ${e.message}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      await sleep(1500);
    }
  }
  return report;
}

/** Drafts waiting for review, with the reality check of their clip. */
async function pending(db, limit = 30) {
  return (await db.query(`SELECT c.id, c.entry, c.created_at, v.title, v.page_url, v.license, v.trend, v.score, v.check_result
    FROM trained_candidates c LEFT JOIN trained_videos v ON v.id = c.video_id WHERE c.status = 'pending' ORDER BY c.created_at LIMIT $1`, [limit])).rows;
}

/** Approves drafts: written into prompt_library (source 'trained'); an edited entry may replace the draft. */
async function approve(db, ids, { reviewer = "claude", edits = {} } = {}) {
  const done = [];
  for (const id of ids) {
    const r = (await db.query("SELECT entry FROM trained_candidates WHERE id=$1 AND status='pending'", [id])).rows[0];
    if (!r) continue;
    const c = validateDraft({ ...r.entry, slug: r.entry.id.split(".").slice(2).join("."), ...(edits[id] || {}) });
    if (!c.ok) { await db.query("UPDATE trained_candidates SET status='rejected', note=$2, reviewer=$3, reviewed_at=now() WHERE id=$1", [id, `invalid after edit: ${c.reason}`, reviewer]); continue; }
    const e = c.entry;
    await db.query(`INSERT INTO prompt_library (id, domain, names, kinds, always, priority, body, source, updated_at) VALUES ($1,$2,$3,$4,false,$5,$6,'trained',now())
      ON CONFLICT (id) DO UPDATE SET names=$3, kinds=$4, priority=$5, body=$6, updated_at=now() WHERE prompt_library.source = 'trained'`, [e.id, e.domain, e.names, e.kinds, e.priority, e.body]);
    await db.query("UPDATE trained_candidates SET status='approved', entry=$2, reviewer=$3, reviewed_at=now() WHERE id=$1", [id, e, reviewer]);
    done.push(e.id);
  }
  return done;
}

async function reject(db, ids, { reviewer = "claude", note = "" } = {}) {
  const r = await db.query("UPDATE trained_candidates SET status='rejected', note=$2, reviewer=$3, reviewed_at=now() WHERE id = ANY($1) AND status='pending' RETURNING id", [ids, note || null, reviewer]);
  return r.rows.map((x) => x.id);
}

async function stats(db) {
  const one = async (sql) => (await db.query(sql)).rows;
  return {
    videos: await one("SELECT status, count(*)::int AS n, round(avg(score)::numeric,1) AS avg_score FROM trained_videos GROUP BY status"),
    candidates: await one("SELECT status, count(*)::int AS n FROM trained_candidates GROUP BY status"),
    library_trained: (await one("SELECT count(*)::int AS n FROM prompt_library WHERE source='trained'"))[0].n,
    last_study: (await one("SELECT max(studied_at) AS t FROM trained_videos"))[0].t,
    trends_today: await one("SELECT region, string_agg(topic, ' · ' ORDER BY id) AS topics FROM (SELECT * FROM trained_trends WHERE seen_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 40) t GROUP BY region"),
  };
}

module.exports = { parseTrends, validateDraft, knownNames, fetchTrends, planTopics, searchCommons, searchPexels, study, cycle, pending, approve, reject, stats, BASICS, DOMAINS };
