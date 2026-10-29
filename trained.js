/**
 * VI Iraq – "Trained Model": keeps studying real footage and what is trending, and turns it into library knowledge.
 *
 * One cycle (systemd timer → tools/trained-model.js cycle):
 *   1. trends  – Google Trends daily searches (keyless RSS, TRAIN_GEOS) + YouTube most popular titles/tags (only with
 *                YOUTUBE_API_KEY, official API, nothing downloaded)
 *   2. topics  – the prompt model turns the trends + a rotating list of realism basics into short footage searches
 *   3. footage – freely licensed real videos: Pexels (PEXELS_API_KEY), Pixabay (PIXABAY_API_KEY), Wikimedia Commons (keyless)
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
const storage = require("./storage");

const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = clean(process.env.TRAIN_MODEL) || clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const GEOS = (clean(process.env.TRAIN_GEOS) || "IQ,SA,AE,EG,US").split(",").map(clean).filter(Boolean);
const MAX_MB = Number(process.env.TRAIN_MAX_MB) || 60;
const UA = `VI-Iraq-trained-model/1.0 (+${clean(process.env.PUBLIC_URL) || "https://www.vi-iraq.com"})`;
const DOMAINS = ["reality", "human", "sound", "place", "item", "action", "nature", "animal", "style"];

// The coverage map: everything a customer could ask a video of, so the library covers all of real life evenly. Every
// cycle studies the areas studied least so far (one search each, Iraqi/Arab variants mixed in); trends are only a share
// of each cycle (TRAIN_TREND_SHARE, default 0.3). No religion, no games – real everyday life.
const COVERAGE = {
  "people & emotions": ["man laughing", "woman crying", "surprised face", "angry man shouting", "old man smiling", "friends hugging", "nervous woman", "tired man yawning"],
  "voices & conversation": ["two people talking", "arabic speech", "phone call talking", "street interview", "woman talking", "man telling story", "people arguing", "crowd cheering"],
  "family & home": ["iraqi family", "family dinner", "mother and child", "grandmother kitchen", "living room family", "kids playing home", "cleaning house", "father baby"],
  "food & cooking": ["iraqi kitchen cooking", "kebab grill", "bread baking", "frying food", "chopping vegetables", "rice cooking", "street food", "iraqi bakery"],
  "drinks & liquids": ["pouring milk", "coffee pouring", "pouring tea", "water splash", "juice pouring", "boiling water", "arabic coffee", "iraqi tea"],
  "streets & cities": ["baghdad street", "city traffic", "busy sidewalk", "street vendor", "night city lights", "baghdad traffic", "arab old town", "mosul street"],
  "work & jobs": ["barber shop", "carpenter working", "car mechanic", "tailor sewing", "construction worker", "farmer field", "office work", "delivery driver"],
  "shopping & markets": ["iraqi market", "bazaar", "supermarket shopping", "gold shop", "fruit market", "clothes shop", "spice market", "erbil market"],
  "transport": ["car driving", "baghdad taxi", "bus passengers", "motorcycle riding", "train station", "airport travelers", "boat river", "truck highway"],
  "sport & play": ["football match", "iraqi football fans", "kids football street", "gym workout", "running", "swimming pool", "basketball", "cycling"],
  "celebrations & music": ["iraqi wedding", "dabke dance", "arab wedding", "birthday party", "oud music", "drummers", "fireworks", "graduation"],
  "nature & weather": ["rain street", "dust storm", "wind palm trees", "sunset sky", "thunderstorm", "desert dunes", "river flowing", "snow falling"],
  "animals": ["cat", "horse running", "camel desert", "birds flying", "dog playing", "sheep herd", "chickens farm", "fish aquarium"],
  "children & school": ["children classroom", "child drawing", "school kids", "kids playground", "baby crawling", "teenagers laughing"],
  "fashion & beauty": ["woman makeup", "hair salon", "man shaving", "fabric moving", "trying clothes", "jewelry", "perfume", "tailor fitting"],
  "phones & technology": ["phone in hand", "selfie", "laptop typing", "video call", "taking photo phone", "tech store", "headphones music", "charging phone"],
  "light & camera": ["golden hour", "neon lights night", "candle light", "car headlights night", "sunlight window", "street lamps", "fluorescent light", "backlight"],
  "physics & materials": ["fire burning", "smoke", "glass breaking", "paper falling", "balloon", "sand pouring", "ice melting", "fabric wind"],
  "places": ["tigris river", "basra corniche", "erbil citadel", "kurdistan mountains", "iraqi marshes", "iraq desert", "dates palm", "baghdad cafe"],
  "health & care": ["doctor clinic", "pharmacy", "dentist", "nurse", "elderly care", "exercise stretching"],
  "travel & leisure": ["hotel lobby", "beach tourists", "suitcase airport", "picnic park", "road trip", "camping"],
  "life stages": ["old woman", "baby", "teenagers", "young couple", "grandfather", "newborn"],
};
const COVER_OF = new Map(Object.entries(COVERAGE).flatMap(([area, qs]) => qs.map((q) => [q, area])));

/** The next coverage searches (pure – tested): least-studied areas first, inside an area its least-used search. */
function pickCoverage(n, studied = {}) {
  const areaCount = (a) => COVERAGE[a].reduce((sum, q) => sum + (studied[q] || 0), 0);
  const areas = Object.keys(COVERAGE).sort((a, b) => areaCount(a) - areaCount(b) || a.localeCompare(b));
  const out = [];
  for (const a of areas.slice(0, n)) {
    const q = [...COVERAGE[a]].sort((x, y) => (studied[x] || 0) - (studied[y] || 0))[0];
    out.push({ q, trend: "", area: a });
  }
  return out;
}

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
        // the key is restricted to our website in Google Cloud, so the request says where it comes from
        const referer = clean(process.env.YOUTUBE_REFERER) || `${(clean(process.env.PUBLIC_URL) || "https://www.vi-iraq.com").replace(/\/+$/, "")}/`;
        const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=15&regionCode=${geo}&key=${encodeURIComponent(yt)}`, { headers: { Referer: referer } });
        for (const v of d.items || []) {
          const words = `${v.snippet?.title || ""} ${(v.snippet?.tags || []).join(" ")} ${v.snippet?.channelTitle || ""}`;
          if (NOT_REAL_YT.has(String(v.snippet?.categoryId)) || NOT_REAL.test(words) || RELIGIOUS.test(words)) continue;
          const views = Number(v.statistics?.viewCount) || 0;
          all.push({ source: "youtube", region: geo, topic: clean(v.snippet?.title).slice(0, 160), traffic: views ? `${views.toLocaleString("en-US")} views` : "", news: (v.snippet?.tags || []).slice(0, 6),
            video: { id: clean(v.id).slice(0, 20), channel: clean(v.snippet?.channelTitle).slice(0, 80), views, thumb: clean(v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url) } });
        }
      } catch (e) { console.error(`youtube ${geo}:`, e.message); }
    }
  }
  return realOnly(all);
}

/**
 * Many game, cartoon and animation channels file their videos as "Entertainment", so titles and categories are not
 * enough: the prompt model looks at the whole YouTube list and only real life (real people, places, events, food,
 * sport, real music performances) is kept. If the check fails, the title filter alone decides.
 */
async function realOnly(all) {
  const yt = all.map((t, i) => ({ t, i })).filter((x) => x.t.source === "youtube");
  if (!yt.length || !OPENAI_KEY) return all;
  try {
    const v = await askJson(`For each YouTube video below decide: is it REAL LIFE filmed by a camera (real people, real places, real events, cooking, sport, vlogs, real music performances, news-free everyday life) – or NOT wanted: religious content (recitations, latmiyat, nasheeds, sermons, Quran, religious lectures or ceremonies) – or NOT real (video games, Minecraft/Roblox/mobile games, game challenges, cartoons, animation, anime, CGI, AI videos, film or game trailers, music visualizers, slideshows, screen recordings)?
${yt.map((x, k) => `${k}. ${x.t.topic} — ${x.t.video?.channel || ""}`).join("\n")}
Return JSON only: {"real":[numbers of the REAL-LIFE videos]}`, [], 1500);
    const keep = new Set((Array.isArray(v.real) ? v.real : []).map(Number));
    const drop = new Set(yt.filter((x, k) => !keep.has(k)).map((x) => x.i));
    return all.filter((_, i) => !drop.has(i));
  } catch (e) { console.error("youtube real-only check:", e.message); return all; }
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
async function planTopics(trends, count, studied = {}) {
  // most of every cycle covers real life evenly; trends are only a share of it
  const share = Math.min(1, Math.max(0, Number(process.env.TRAIN_TREND_SHARE ?? 0.3)));
  const basics = pickCoverage(count - Math.round(count * share), studied);
  if (!trends.length) return basics.slice(0, count);
  try {
    // Iraq first, then the Arab world, then the rest – YouTube and Google side by side within each region
    const rank = (r) => (r === "IQ" ? 0 : ["SA", "AE", "EG", "KW", "JO", "SY", "LB"].includes(r) ? 1 : 2);
    const ordered = [...trends].sort((a, b) => rank(a.region) - rank(b.region) || (a.source === b.source ? 0 : a.source === "youtube" ? -1 : 1));
    const list = ordered.slice(0, 80).map((t) => `- [${t.region}/${t.source}] ${t.topic}${t.news?.length ? ` (${t.news.join(" | ")})` : ""}`).join("\n");
    const v = await askJson(`You plan what an AI video studio for Iraqi and Arab customers should study in REAL footage this week.
Today's trends:\n${list}
Pick the trends people could order a short video about (events, places, foods, sports, celebrations, products, everyday life, how people talk and react) and turn each into ONE short English search for real stock footage (2–4 words, things a camera can film: "football stadium crowd", "lamb grilling", "rain flood street"). Iraqi trends come first, then the rest of the Arab world, then global ones – at least half of your searches must be about Iraqi or Arab life (put "iraqi", "baghdad", "arab" or a city in the search when it fits). Prefer everyday life (streets, markets, food, cafés, families, work, sport, weddings, music, travel, nature) and leave out religious topics (prayers, sermons, recitations, shrines, religious ceremonies). Only REAL LIFE that a camera films in the real world: never video games, game or film trailers, movies, animation, cartoons, CGI, music visualizers or screen recordings – if a trend is one of those, skip it. Skip politics, war, crime, accidents, tragedies, real people's names, brands and anything sexual.
Return JSON only: {"queries":[{"q":"...","trend":"<the trend it comes from>"}]} with at most ${Math.max(1, count - basics.length)} items.`, [], 1200);
    const picked = (Array.isArray(v.queries) ? v.queries : []).map((x) => ({ q: clean(x.q).toLowerCase().slice(0, 60), trend: clean(x.trend).slice(0, 160) })).filter((x) => /^[a-z0-9 '-]{3,60}$/.test(x.q));
    return [...picked.slice(0, count - basics.length), ...basics].slice(0, count);
  } catch (e) { console.error("trained topics:", e.message); return basics.slice(0, count); }
}

// Commons full-text search is loose: a clip is only studied when its title carries a word of the search, and never
// when the title points to violence, crime, politics or adult content.
const STOP = new Set(["a", "an", "the", "of", "and", "in", "on", "to", "with", "at", "person", "people", "close", "up", "into", "from"]);
const BLOCK = /\b(kill|killed|killing|murder|shoot|shooting|shot dead|tased|taser|war|bomb|attack|terror|protest|riot|police brutality|blood|dead|death|corpse|execution|porn|sex|nude|naked|president|minister|parliament|election|khamenei|khomeini|saddam|isis|daesh|militia|military|army|soldier|troops|airstrike|fighter jet|f-?35|tank|abrams|humvee|convoy|senator|congress|governor|attorney general|affirmative action|campaign|rally|unions?|sanders|trump|biden|obama|clinton|putin|politician|congressman|congresswoman|ai generated|ai-generated|generated by ai|hailuo|sora|runway|midjourney|kling|veo|stable diffusion|deepfake|cgi|3d render|animation)\b|\(ai\)/i;
const keyWords = (q) => q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|s)$/, ""));
// Only real camera footage of the real world: no games, trailers, animation, CGI, music visuals or screen recordings.
const NOT_REAL = /\b(gaming|gameplay|game ?play|gamer|video ?games?|game challenge|game trailer|mobile game|pc game|fortnite|minecraft|roblox|gta|pubg|free ?fire|call of duty|valorant|simulator|ost|soundtrack|trailer|teaser|animation|animated|cartoon|anime|cgi|3d|render|vfx|unreal engine|unity engine|visuali[sz]er|lyric|lyrics|official audio|music video|backrooms|screen ?recording|slideshow|spiderman|superman|hulk|granny|esports?|e-sports|counter-strike|cs2|dota|league of legends|gamerlegion)\b|لعبة|العاب|ألعاب|كرتون|انمي|أنمي|تريلر|اعلان فيلم|ماين ?كرافت|فورتنايت|روبلوكس|ببجي|فري فاير|التحديث الجديد|محاكي/i;
// YouTube categories that are not real life: Film & Animation (1), Gaming (20), Trailers (44)
const NOT_REAL_YT = new Set(["1", "20", "44"]);
// The studio's study focuses on everyday life, not religion: religious ceremonies, sermons, recitations, shrines.
const RELIGIOUS = /\b(shrine|holy shrine|imam|hussainiya|husseiniya|sermon|quran|koran|recitation|latmiya|nasheed|ashura|arbaeen|arbaein|pilgrim|pilgrimage|mosque|masjid|church|temple|monastery|prayer wheels?|prayers?|religious|cleric|sheikh)\b|حسينية|حسينيه|لطمية|لطميه|عزاء|قرآن|قران|خطبة|خطبه|ضريح|مرقد|زيارة|زياره|حرم الامام|حرم الإمام|صلاة|الصلاة|ديني|دينية|نعي|رادود|الحاج باسم|الكربلائي|الخاقاني/i;
/** Pure – tested. */
function relevant(v, q) {
  const t = String(v.title || "").toLowerCase();
  return !BLOCK.test(t) && !NOT_REAL.test(t) && !RELIGIOUS.test(t) && keyWords(q).some((w) => w.length > 2 && t.includes(w));
}

/** Wikimedia Commons video search → candidate clips (free licences, author + licence kept). */
async function searchCommons(q, limit = 12) {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`filetype:video ${q}`)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiextmetadatafilter=LicenseShortName|Artist`;
  const d = await getJson(u);
  return Object.values(d.query?.pages || {}).map((p) => {
    const i = p.imageinfo?.[0] || {};
    return {
      id: `commons:${p.pageid}`, source: "commons", query: q, title: clean(p.title).replace(/^File:/, "").slice(0, 200),
      page_url: i.descriptionurl, media_url: clean(i.url).split("?")[0], license: stripTags(i.extmetadata?.LicenseShortName?.value),
      author: stripTags(i.extmetadata?.Artist?.value).slice(0, 120), duration_sec: Number(i.duration) || 0, size: Number(i.size) || 0,
    };
  }).filter((v) => v.media_url && v.duration_sec >= 3 && v.duration_sec <= 600 && relevant(v, q));
}

/** Clips for one search: Pexels and Pixabay first (HD stock footage of real life), then Commons; a search without hits is retried
 *  with its last words only ("rainy iraqi street" → "iraqi street" → "street"). */
async function findClips(q) {
  const words = q.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const sub = words.slice(i).join(" ");
    if (i > 0 && sub.length < 4) break;
    const found = [...(await searchPexels(sub).catch(() => [])), ...(await searchPixabay(sub).catch(() => [])), ...(await searchCommons(sub).catch(() => []))];
    if (found.length) return found.map((v) => ({ ...v, query: q }));
  }
  return [];
}

/** Pexels video search (only with PEXELS_API_KEY; the Pexels licence allows this use). */
async function searchPexels(q, limit = 4) {
  const key = clean(process.env.PEXELS_API_KEY);
  if (!key) return [];
  const d = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${limit}&size=small`, { headers: { Authorization: key } });
  return (d.videos || []).map((v) => {
    const file = (v.video_files || []).filter((f) => f.link && (f.width || 0) <= 1920).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return file && { id: `pexels:${v.id}`, source: "pexels", query: q, title: clean(v.url).split("/").filter(Boolean).pop()?.slice(0, 200) || `pexels ${v.id}`,
      page_url: v.url, media_url: file.link, license: "Pexels License", author: clean(v.user?.name).slice(0, 120), duration_sec: Number(v.duration) || 0, size: 0 };
  }).filter(Boolean).filter((v) => v.duration_sec >= 3 && v.duration_sec <= 600);
}

/** Pixabay video search (only with PIXABAY_API_KEY; the Pixabay Content License allows this use) – HD files. */
async function searchPixabay(q, limit = 4) {
  const key = clean(process.env.PIXABAY_API_KEY);
  if (!key) return [];
  const d = await getJson(`https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&per_page=${Math.max(3, limit)}&safesearch=true`);
  return (d.hits || []).slice(0, limit).map((v) => {
    const file = [v.videos?.large, v.videos?.medium, v.videos?.small].find((f) => f && f.url && (f.width || 0) <= 1920 && (!f.size || f.size <= MAX_MB * 1e6));
    return file && { id: `pixabay:${v.id}`, source: "pixabay", query: q, title: clean(v.tags).slice(0, 200) || `pixabay ${v.id}`,
      page_url: v.pageURL, media_url: file.url, license: "Pixabay Content License", author: clean(v.user).slice(0, 120), duration_sec: Number(v.duration) || 0, size: Number(file.size) || 0 };
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
  const span = Math.min(duration || 10, 90), out = [], times = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(path.dirname(file), `f${out.length}.jpg`), t = (span * (i + 0.5) / n).toFixed(1);
    try {
      await watermark.run(["-y", "-ss", t, "-i", file, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", f], 60000);
      if (fs.existsSync(f)) { out.push(fs.readFileSync(f).toString("base64")); times.push(Number(t)); }
    } catch {}
  }
  out.times = times;
  return out;
}

/** The frames side by side in one picture (the "screenshot" of the clip for the report). */
async function sheet(dir, count) {
  const f = path.join(dir, "sheet.jpg");
  await watermark.run(["-y", "-framerate", "1", "-i", path.join(dir, "f%d.jpg"), "-frames:v", "1", "-vf", `scale=-2:300,pad=ceil(iw/2)*2:300:(ow-iw)/2:0,tile=${count}x1:padding=6:color=white`, "-q:v", "5", f], 60000);
  return fs.readFileSync(f);
}

/**
 * Listens to the clip's soundtrack (first 30 s): sound layers (wind, rain, crowd, traffic…), music, and every voice –
 * language/dialect, emotion (angry, happy, sad, excited…), how it is delivered and a one-line tone a TTS voice could
 * follow. null when there is no sound or no audio model answered.
 */
async function listenClip(file, dir) {
  if (!OPENAI_KEY) return null;
  const mp3 = path.join(dir, "a.mp3");
  try { await watermark.run(["-y", "-i", file, "-vn", "-t", "30", "-ac", "1", "-ar", "24000", "-b:a", "48k", mp3], 60000); } catch { return null; }
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 4000) return null;
  const ask = `This is the soundtrack of a real video. You help an AI video studio for Iraqi and Arab customers make generated voices and sounds indistinguishable from real ones. Listen closely and answer with ONE JSON object only:
{"has_sound":true|false,"layers":["each background sound with how it behaves, e.g. wind gusting in waves and rattling something metal, crowd murmur rising and falling, cars passing left to right"],"music":true|false,
"voices":[{"language":"iraqi arabic|other arabic dialect|standard arabic|english|other|none","emotion":"angry|happy|sad|excited|calm|scared|tired|annoyed|laughing|crying|neutral|mixed","delivery":"concrete: pace, loudness, pitch movement, breaths, laughter, shouting, pauses, voice cracks","tts_tone":"one sentence a voice actor or TTS could follow to sound exactly like this"}],
"lesson":"the most useful thing this soundtrack teaches about how real sound or real voices behave"}
Describe only what you hear; do not guess anyone's identity.`;
  const data = fs.readFileSync(mp3).toString("base64");
  for (const model of [clean(process.env.TRAIN_AUDIO_MODEL) || clean(process.env.AUDIO_ANALYZE_MODEL) || "gpt-audio", "gpt-audio-mini"]) {
    try {
      const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model, modalities: ["text"], messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "input_audio", input_audio: { data, format: "mp3" } }] }] }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `status ${r.status}`);
      const txt = String(j.choices?.[0]?.message?.content || ""), a = txt.indexOf("{"), b = txt.lastIndexOf("}");
      if (a < 0) throw new Error("no JSON");
      return parseSound(JSON.parse(txt.slice(a, b + 1)));
    } catch (e) { console.error(`trained listen (${model}):`, String(e.message).slice(0, 140)); }
  }
  return null;
}

/** The sound verdict, normalised (pure – tested). */
function parseSound(v) {
  if (!v || typeof v !== "object") return null;
  const list = (x, n, len = 220) => (Array.isArray(x) ? x : []).map((y) => clean(y).slice(0, len)).filter(Boolean).slice(0, n);
  return {
    has_sound: v.has_sound !== false, music: Boolean(v.music), layers: list(v.layers, 8),
    voices: (Array.isArray(v.voices) ? v.voices : []).slice(0, 5).map((x) => ({
      language: clean(x?.language).slice(0, 40), emotion: clean(x?.emotion).toLowerCase().slice(0, 30),
      delivery: clean(x?.delivery).slice(0, 300), tts_tone: clean(x?.tts_tone).slice(0, 300),
    })).filter((x) => x.emotion || x.delivery),
    lesson: clean(v.lesson).slice(0, 400),
  };
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
async function study(v, imgs, sound = null) {
  const heard = sound && sound.has_sound ? `\nWhat its soundtrack sounds like (from listening): ${JSON.stringify({ layers: sound.layers, music: sound.music, voices: sound.voices, lesson: sound.lesson })}` : "";
  const out = await askJson(`These ${imgs.length} frames (in order) come from a REAL video: "${v.title}" (searched as "${v.query}"${v.trend ? `, studied because "${v.trend}" is trending` : ""}).${heard}
You train an AI video studio for Iraqi and Arab customers so its generated videos become indistinguishable from real footage. Study the frames like a cinematographer and a physicist:
1. reality: concrete visible facts that make this footage real – motion and physics (how liquids, fabric, hair, smoke, bodies, vehicles really move), light and shadow, camera behaviour (handheld, lens, focus, exposure), materials and textures, how people behave, sound you can infer.
2. ai_mistakes: what AI video generators usually get WRONG for this kind of scene.
3. score: 0–10, how much this clip teaches about real life (if the clip is NOT real camera footage of the real world – a video game, animation, cartoon, CGI, AI-generated video, film trailer effects, music visualizer, slideshow or screen recording – score 0 and write no entries) – reality (10 = rich, clear real-world detail; 0 = useless: slideshow, text, animation, graphics, blurry).
4. entries: 0–3 NEW library entries (only if the clip teaches something specific and reusable; when the soundtrack has voices or strong sounds, one entry may be about that sound or about how a person sounds and looks when angry, happy, sad or excited – domain sound or human, with an Iraqi-dialect tone line a TTS voice can follow). Iraqi and Arab places, food, customs, voices and everyday life are the most valuable. Our customers are Iraqi and Arab: never write about pork or alcohol (if the clip shows them, write the same technique with lamb, beef, chicken or tea/juice); prefer knowledge that transfers to many scenes (physics, light, behaviour, materials) over one niche sport or event; no legible text or logos. Each: {"slug":"short-ascii-kebab","domain":one of ${DOMAINS.join("|")},"kinds":["video"] or ["video","image"],"names":[4–10 trigger words a customer might type: Iraqi/Arabic AND English, specific, never generic words],"body":"70–130 words, English, concrete visible and audible details that a prompt writer can copy into a video prompt; no history, no opinions, no real people's names, no brands, no links"}.
Return JSON only: {"score":0-10,"reality":["..."],"ai_mistakes":["..."],"entries":[...]}`, imgs, 3000);
  return {
    score: Math.max(0, Math.min(10, Number(out.score) || 0)),
    reality: (Array.isArray(out.reality) ? out.reality : []).map((x) => clean(x).slice(0, 300)).filter(Boolean).slice(0, 12),
    ai_mistakes: (Array.isArray(out.ai_mistakes) ? out.ai_mistakes : []).map((x) => clean(x).slice(0, 300)).filter(Boolean).slice(0, 10),
    entries: (Array.isArray(out.entries) ? out.entries : []).slice(0, 3),
  };
}

/** One full cycle. Returns a short report. */
async function cycle(db, { videos = Number(process.env.TRAIN_VIDEOS_PER_CYCLE) || 8, log = console.log } = {}) {
  const report = { trends: 0, queries: 0, studied: 0, failed: 0, drafts: 0, duplicates: 0, rejected: 0 };
  const trends = await fetchTrends();
  report.trends = trends.length;
  for (const t of trends) await db.query("INSERT INTO trained_trends (source, region, topic, traffic, info) VALUES ($1,$2,$3,$4,$5)", [t.source, t.region, t.topic.slice(0, 300), t.traffic || null, { news: t.news || [], ...(t.video ? { video: t.video } : {}) }]);
  const studied = Object.fromEntries((await db.query("SELECT query, count(*)::int AS n FROM trained_videos GROUP BY query")).rows.map((r) => [r.query, r.n]));
  const queries = await planTopics(trends, Math.max(2, videos + 2), studied);
  report.queries = queries.length;
  log("searches:", queries.map((x) => x.q + (x.trend ? ` [${x.trend}]` : "")).join(" · "));
  const known = knownNames([...library.loadFiles(), ...(await db.query("SELECT id, names FROM prompt_library")).rows]);
  let left = videos;
  for (const { q, trend } of queries) {
    if (left <= 0) break;
    let found = [];
    try { found = await findClips(q); } catch (e) { log(`search "${q}": ${e.message}`); }
    if (!found.length) { log(`no clip for "${q}"`); continue; }
    const seen = new Set((await db.query("SELECT id FROM trained_videos WHERE id = ANY($1)", [found.map((v) => v.id)])).rows.map((r) => r.id));
    for (const v of found.filter((x) => !seen.has(x.id)).slice(0, 1)) {
      if (left <= 0) break;
      left--;
      await db.query(`INSERT INTO trained_videos (id, source, query, trend, title, page_url, media_url, license, author, duration_sec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.source, q, trend || null, v.title, v.page_url, v.media_url, v.license, v.author, v.duration_sec]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trained-"));
      try {
        const file = await download(v, dir);
        const imgs = await frames(file, v.duration_sec);
        if (imgs.length < 3) throw new Error("could not read frames");
        let sheetKey = null;
        try {
          const key = `trained/sheets/${v.id.replace(/[^a-z0-9]+/gi, "-")}.jpg`;
          if (storage.ready) { await storage.put(key, await sheet(dir, imgs.length), { contentType: "image/jpeg" }); sheetKey = key; }
        } catch (e) { log(`sheet ${v.id}: ${e.message}`); }
        const sound = await listenClip(file, dir);
        const s = await study(v, imgs, sound);
        await db.query("UPDATE trained_videos SET status='studied', score=$2, check_result=$3, studied_at=now(), error=NULL WHERE id=$1",
          [v.id, s.score, { reality: s.reality, ai_mistakes: s.ai_mistakes, sound, sheet: sheetKey, times: imgs.times }]);
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

const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ARAB = /\b(iraq|iraqi|baghdad|basra|erbil|mosul|najaf|karbala|kurd|tigris|euphrates|arab|arabic|middle east|dabke|oud|mosque|falafel|kebab|dates|camel|desert|gulf|saudi|emirates|dubai|egypt|cairo)\b/i;

/**
 * The study report as one self-contained HTML page: every clip of the period with its frames side by side, its reality
 * check, what was heard (sound layers, each voice's emotion and tone), its drafts and their review, and everything that
 * entered the VI-Iraq library. Iraqi/Arab clips come first.
 */
async function report(db, { hours = 24, day = "" } = {}) {
  const range = day ? dayRange(day) : { since: new Date(Date.now() - (Number(hours) || 24) * 3600e3), until: new Date(Date.now() + 60e3) };
  const R = [range.since, range.until];
  const vids = (await db.query(`SELECT * FROM trained_videos WHERE status='studied' AND studied_at >= $1 AND studied_at < $2 ORDER BY studied_at`, R)).rows;
  const cands = (await db.query(`SELECT * FROM trained_candidates WHERE (created_at >= $1 AND created_at < $2) OR (reviewed_at >= $1 AND reviewed_at < $2) ORDER BY id`, R)).rows;
  const added = cands.filter((c) => c.status === "approved");
  const trends = (await db.query(`SELECT region, topic FROM trained_trends WHERE seen_at >= $1 AND seen_at < $2 ORDER BY (region='IQ') DESC, id DESC`, R)).rows;
  // YouTube's official most-popular list (titles, channels, views, thumbnails – nothing downloaded), latest first
  const ytRows = (await db.query(`SELECT region, topic, info FROM trained_trends WHERE source='youtube' AND seen_at >= $1 AND seen_at < $2 ORDER BY (region='IQ') DESC, id DESC`, R)).rows;
  const yt = {};
  for (const r of ytRows) {
    const v = r.info?.video; if (!v?.id || NOT_REAL.test(r.topic || "") || RELIGIOUS.test(`${r.topic || ""} ${v.channel || ""}`)) continue;
    const list = (yt[r.region] ||= []);
    if (list.length < 10 && !list.some((x) => x.id === v.id)) list.push({ ...v, title: r.topic });
  }
  // Iraqi/Arab by what the clip is (its title, Arabic voices heard in it) – not by the search that found it
  const allQ = Object.fromEntries((await db.query("SELECT query, count(*)::int AS n FROM trained_videos WHERE status='studied' GROUP BY query")).rows.map((r) => [r.query, r.n]));
  const dayQ = {}; for (const v of vids) dayQ[v.query] = (dayQ[v.query] || 0) + 1;
  const areaSum = (qs, m) => qs.reduce((n, q) => n + (m[q] || 0), 0);
  const coverageHtml = `<section class=card><h2>Coverage of real life</h2><p class=muted>Clips studied per area (all time · today). The least-covered areas are studied next.</p><table><tr><th>area</th><th>all time</th><th>today</th></tr>${Object.entries(COVERAGE).map(([a, qs]) => [a, areaSum(qs, allQ), areaSum(qs, dayQ)]).sort((x, y) => x[1] - y[1]).map(([a, n, d]) => `<tr><td>${esc(a)}</td><td>${n}</td><td>${d}</td></tr>`).join("")}</table></section>`;
  const arab = (v) => ARAB.test(v.title || "") || (v.check_result?.sound?.voices || []).some((x) => /arab/i.test(x.language));
  vids.sort((a, b) => Number(arab(b)) - Number(arab(a)));
  const img = async (key) => {
    if (!key) return "";
    try { return `<img src="data:image/jpeg;base64,${(await storage.getBuffer(key, 5 * 1024 * 1024)).toString("base64")}" alt="frames">`; } catch { return ""; }
  };
  const li = (list) => (list || []).length ? `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p class=muted>–</p>";
  const badge = { approved: "ok", pending: "wait", rejected: "no", duplicate: "no" };
  const entryHtml = (c) => `<div class="entry ${badge[c.status] || ""}"><b>${esc(c.entry.id)}</b> <span class=tag>${esc(c.status)}${c.reviewer ? ` · ${esc(c.reviewer)}` : ""}</span>${c.note ? ` <span class=muted>– ${esc(c.note)}</span>` : ""}
    <div class=names>${(c.entry.names || []).map(esc).join(" · ")}</div><div>${esc(c.entry.body)}</div></div>`;
  const cards = [];
  for (const v of vids) {
    const r = v.check_result || {}, snd = r.sound;
    const voices = snd?.voices?.length ? `<table><tr><th>language</th><th>emotion</th><th>delivery</th><th>tone for our voices</th></tr>${snd.voices.map((x) => `<tr><td>${esc(x.language)}</td><td><b>${esc(x.emotion)}</b></td><td>${esc(x.delivery)}</td><td>${esc(x.tts_tone)}</td></tr>`).join("")}</table>` : "";
    cards.push(`<section class=card${arab(v) ? " id=arab" : ""}>
      <h2>${arab(v) ? "🇮🇶 " : ""}${esc(v.title)}</h2>
      <p class=meta>score <b>${esc(v.score)}</b>/10 · search “${esc(v.query)}”${v.trend ? ` · trend: ${esc(v.trend)}` : ""} · ${esc(v.source)} · ${esc(v.license)}${v.author ? ` · by ${esc(v.author)}` : ""} · <a href="${esc(v.page_url)}">source</a>${r.times ? ` · frames at ${r.times.map((t) => t + " s").join(", ")}` : ""}</p>
      ${await img(r.sheet)}
      <div class=cols><div><h3>What makes it real</h3>${li(r.reality)}</div><div><h3>What AI gets wrong here</h3>${li(r.ai_mistakes)}</div></div>
      <h3>Sound and voices</h3>${snd && snd.has_sound ? `${li(snd.layers)}${snd.music ? "<p class=muted>music in the soundtrack</p>" : ""}${voices}${snd.lesson ? `<p><b>Lesson:</b> ${esc(snd.lesson)}</p>` : ""}` : "<p class=muted>no usable sound</p>"}
      <h3>Drafts for the library</h3>${cands.filter((c) => c.video_id === v.id).map(entryHtml).join("") || "<p class=muted>none</p>"}
    </section>`);
  }
  const iq = trends.filter((t) => t.region === "IQ").map((t) => t.topic), other = [...new Set(trends.filter((t) => t.region !== "IQ").map((t) => t.topic))];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VI-Iraq Trained Model report</title>
<style>body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;margin:0;background:#f4f1ea;color:#1d1d1f}main{max-width:1100px;margin:auto;padding:16px}
h1{margin:.2em 0}.sum{display:flex;gap:12px;flex-wrap:wrap}.sum div{background:#fff;border-radius:10px;padding:10px 14px}.sum b{font-size:1.5em;display:block}
.card{background:#fff;border-radius:14px;padding:14px 16px;margin:16px 0;box-shadow:0 1px 3px #0001}.card img{width:100%;border-radius:8px;background:#eee}
.meta,.muted{color:#6b6b70;font-size:.9em}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:700px){.cols{grid-template-columns:1fr}}
table{border-collapse:collapse;width:100%;font-size:.9em}td,th{border:1px solid #e3e0d8;padding:6px;text-align:left;vertical-align:top}
.entry{border-left:4px solid #bbb;padding:6px 10px;margin:8px 0;background:#fafafa}.entry.ok{border-color:#2e9d5b}.entry.no{border-color:#c0392b}.entry.wait{border-color:#d4a017}
.tag{font-size:.8em;background:#eee;border-radius:6px;padding:1px 6px}.yt{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.ytv{display:flex;flex-direction:column;gap:4px;text-decoration:none;color:#1d1d1f;font-size:.85em}.ytv img{width:100%;border-radius:8px}.ytv small{color:#6b6b70}.names{font-size:.85em;color:#555;margin:2px 0 4px}a{color:#0b6e75}</style></head><body><main>
<h1>VI-Iraq · Trained Model</h1><p class=muted>${day ? `Day ${esc(day)} (Iraq time)` : `Last ${esc(hours)} hours`} · updated ${esc(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " "))} Iraq time</p>
${Object.keys(yt).length ? `<section class=card><h2>Trending on YouTube today</h2><p class=muted>YouTube's official most-popular list. The next studies pick their real-footage searches from these topics; the YouTube videos themselves are never downloaded.</p>
${Object.entries(yt).map(([region, list]) => `<h3>${esc(region)}</h3><div class=yt>${list.map((v) => `<a class=ytv href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}">${/^https:\/\/i\.ytimg\.com\//.test(v.thumb || "") ? `<img src="${esc(v.thumb)}" alt="">` : ""}<span>${esc(v.title)}</span><small>${esc(v.channel)}${v.views ? ` · ${esc(Number(v.views).toLocaleString("en-US"))} views` : ""}</small></a>`).join("")}</div>`).join("")}</section>` : ""}
<div class=sum><div><b>${vids.length}</b>clips studied</div><div><b>${vids.filter(arab).length}</b>Iraqi / Arab</div><div><b>${vids.length ? (vids.reduce((n, v) => n + Number(v.score || 0), 0) / vids.length).toFixed(1) : "–"}</b>avg score</div>
<div><b>${vids.filter((v) => v.check_result?.sound?.voices?.length).length}</b>with voices studied</div><div><b>${added.length}</b>added to VI-Iraq</div><div><b>${cands.filter((c) => c.status === "pending").length}</b>waiting for review</div></div>
${coverageHtml}
<section class=card><h2>Added to the VI-Iraq library</h2>${added.map(entryHtml).join("") || "<p class=muted>nothing yet in this period</p>"}</section>
<section class=card><h2>Trends</h2><p><b>Iraq:</b> ${iq.map(esc).join(" · ") || "–"}</p><p class=muted><b>Other regions:</b> ${other.slice(0, 40).map(esc).join(" · ")}</p></section>
${cards.join("\n")}
<p class=muted>Clips are freely licensed (Wikimedia Commons / Pexels); frames are shown for study with their source and licence. The clips themselves are not kept.</p>
</main></body></html>`;
}

/** Iraq has no daylight saving: its day is UTC+3. "2026-10-29" → that day's start and end as Dates (pure – tested). */
function dayRange(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error("day must be YYYY-MM-DD");
  const since = new Date(Date.parse(`${day}T00:00:00Z`) - 3 * 3600e3);
  return { since, until: new Date(since.getTime() + 24 * 3600e3) };
}
const iraqDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);

/** Days that have studies or reviews, newest first, with what happened on each. */
async function reportDays(db, limit = 90) {
  return (await db.query(`SELECT d AS day, sum(clips)::int AS clips, sum(added)::int AS added FROM (
      SELECT to_char(studied_at + interval '3 hours', 'YYYY-MM-DD') AS d, 1 AS clips, 0 AS added FROM trained_videos WHERE status='studied' AND studied_at IS NOT NULL
      UNION ALL SELECT to_char(reviewed_at + interval '3 hours', 'YYYY-MM-DD'), 0, 1 FROM trained_candidates WHERE status='approved' AND reviewed_at IS NOT NULL
    ) x GROUP BY d ORDER BY d DESC NULLS LAST LIMIT $1`, [limit])).rows;
}

/** Writes the day's report into storage (trained/reports/<day>.html) – called after every cycle and review. */
async function saveDayReport(db, day = iraqDay()) {
  const key = `trained/reports/${day}.html`;
  await storage.put(key, Buffer.from(await report(db, { day })), { contentType: "text/html; charset=utf-8" });
  return key;
}

/**
 * The automatic editor (TRAIN_AUTO_REVIEW, on unless "0"): the prompt model reviews the waiting drafts with the same
 * rules a human reviewer uses and approves (optionally with narrower names / a cleaner body) or rejects each one, with
 * a short reason. Every decision is recorded with reviewer "auto-editor" and shown in the day's report.
 */
async function autoReview(db, { log = console.log } = {}) {
  const out = { approved: 0, rejected: 0 };
  const list = await pending(db, 40);
  if (!list.length) return out;
  const trainedNow = (await db.query("SELECT id, names FROM prompt_library WHERE source='trained' ORDER BY updated_at DESC LIMIT 300")).rows;
  const drafts = list.map((c) => ({ id: Number(c.id), entry: c.entry, clip: c.title, trend: c.trend || "", clip_score: c.score }));
  const v = await askJson(`You are the strict editor of the reality library of an AI video studio for Iraqi and Arab customers. Each draft below was written from a real, freely licensed video clip. Decide for EVERY draft.
APPROVE when it is concrete (visible/audible details a prompt writer can copy), transferable to many scenes, and makes generated videos more real: physics of liquids, fabric, hair, smoke, crowds; real human behaviour, voices and emotions; light, camera, materials, sounds; places, food, animals – Iraqi and Arab ones are the most valuable.
REJECT when it: repeats another draft of this batch (approve only the best one) or an entry the library already has (listed below), is niche (one sport match, one building, one event), describes the look of an old/archival or black-and-white clip while its names are general, is about pork or alcohol, violence, war, military, politics or religion-political speeches, names real people or brands, depends on legible text or logos, or is vague.
EDIT when a draft is good but a trigger name is too general (it would fire for unrelated requests – e.g. "children laughing" for a Mosul-wall scene) or the body carries a detail of that one clip that must not apply everywhere: give replacement "names" (3–12, Arabic incl. Iraqi spellings AND English) and/or "body" (70–130 words, English).
Library entries already learned (id: names): ${trainedNow.map((e) => `${e.id}: ${(e.names || []).slice(0, 4).join(", ")}`).join(" | ").slice(0, 9000)}
Drafts: ${JSON.stringify(drafts).slice(0, 60000)}
Return JSON only: {"decisions":[{"id":<draft id>,"decision":"approve"|"reject","note":"short reason","names":[...optional],"body":"...optional"}]}`, [], 6000);
  const decisions = Array.isArray(v.decisions) ? v.decisions : [];
  const ids = new Set(drafts.map((d) => d.id));
  for (const d of decisions) {
    const id = Number(d.id);
    if (!ids.has(id)) continue;
    ids.delete(id);
    if (d.decision === "approve") {
      const edits = {};
      if (Array.isArray(d.names) && d.names.length) edits.names = d.names;
      if (typeof d.body === "string" && d.body.trim()) edits.body = d.body;
      const done = await approve(db, [id], { reviewer: "auto-editor", edits: { [id]: edits } });
      if (done.length) { out.approved++; if (d.note) await db.query("UPDATE trained_candidates SET note=$2 WHERE id=$1", [id, clean(d.note).slice(0, 300)]); }
      else out.rejected++;
    } else if (d.decision === "reject") {
      await reject(db, [id], { reviewer: "auto-editor", note: clean(d.note).slice(0, 300) || "rejected by the editor" });
      out.rejected++;
    }
  }
  if (ids.size) log(`auto-review: no decision for ${[...ids].join(", ")} – they wait for the next review`);
  return out;
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

module.exports = { COVERAGE, pickCoverage, NOT_REAL, RELIGIOUS, searchPixabay, report, reportDays, saveDayReport, autoReview, dayRange, iraqDay, parseTrends, parseSound, validateDraft, knownNames, relevant, findClips, fetchTrends, planTopics, searchCommons, searchPexels, study, cycle, pending, approve, reject, stats, DOMAINS };
