/**
 * VI Iraq – social collector: a controlled tool that turns video links into reel patterns (reels.js) and tells the
 * studio which hooks and structures hold viewers. Only permitted routes:
 *   - YouTube / Shorts links: numbers from the official YouTube API, the video watched through its public link by
 *     Gemini (official API) – nothing is downloaded;
 *   - the studio's OWN Instagram reels: the official Instagram API (INSTAGRAM_TOKEN of the studio's Business/Creator
 *     account) gives the video and its insights – the file is downloaded only for the study and deleted after it;
 *   - files the owner puts into the inbox (his own videos or with permission) – see trained.studyInbox.
 * Other people's Instagram / TikTok links are skipped with the reason: those platforms offer no permitted way to
 * collect them, and scraping or downloading breaks their terms. Every downloaded file is gone after 5 days at most
 * (trained.pruneStorage).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const reels = require("./reels");

const clean = (v) => String(v || "").trim();
const SOCIAL_DIR = () => path.join(clean(process.env.STORAGE_DIR) || "/var/lib/vi-iraq/storage", "social");
const IG_BASE = () => (clean(process.env.INSTAGRAM_GRAPH_URL) || "https://graph.instagram.com/v21.0").replace(/\/+$/, "");

/** What a link is (pure – tested). */
function parseUrl(u) {
  let x; try { x = new URL(clean(u)); } catch { return null; }
  const h = x.hostname.replace(/^(www|m)\./, "");
  if (h === "youtu.be") return /^[\w-]{11}$/.test(x.pathname.slice(1)) ? { kind: "youtube", id: x.pathname.slice(1) } : null;
  if (h === "youtube.com" || h === "music.youtube.com") {
    const id = x.searchParams.get("v") || (/^\/(shorts|embed|live)\/([\w-]{11})/.exec(x.pathname) || [])[2];
    return id && /^[\w-]{11}$/.test(id) ? { kind: "youtube", id } : null;
  }
  if (h === "instagram.com") { const m = /^\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/([\w-]+)/.exec(x.pathname); return m ? { kind: "instagram", code: m[1] } : null; }
  if (/(^|\.)tiktok\.com$/.test(h)) return { kind: "tiktok" };
  return null;
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status} ${String(j.error?.message || "").slice(0, 140)}`);
  return j;
}

/** YouTube numbers for up to 50 ids (official API). */
async function youtubeInfo(ids) {
  const key = clean(process.env.YOUTUBE_API_KEY);
  if (!key || !ids.length) return {};
  const referer = clean(process.env.YOUTUBE_REFERER) || "https://www.vi-iraq.com/";
  const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}&key=${encodeURIComponent(key)}`, { Referer: referer });
  const iso = require("./trained").isoSeconds;
  return Object.fromEntries((d.items || []).map((v) => [v.id, { title: clean(v.snippet?.title).slice(0, 200), channel: clean(v.snippet?.channelTitle), secs: iso(v.contentDetails?.duration), views: Number(v.statistics?.viewCount) || 0, likes: Number(v.statistics?.likeCount) || 0, comments: Number(v.statistics?.commentCount) || 0, region: clean(v.snippet?.defaultAudioLanguage).slice(0, 5) }]));
}

/** Gemini watches one public YouTube video and writes its reel pattern (nothing downloaded). */
async function watchYouTube(id, info = {}) {
  const prompt = `Watch this public video${info.title ? ` ("${info.title}")` : ""} as an editor of short social videos. Describe how it catches and keeps viewers – its craft, never its people. Return JSON only: {"real_life":true|false,"reel":${reels.REEL_SHAPE}}`.toWellFormed();
  const d = await require("./trained").geminiCall({ contents: [{ parts: [{ file_data: { file_uri: `https://www.youtube.com/watch?v=${id}` } }, { text: prompt }] }], generationConfig: { responseMimeType: "application/json" } });
  const txt = (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
  const out = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  const ok = await reels.save({ id: `youtube:${id}`, source: "youtube", region: info.region || "", kind: "Linked", title: info.title || id, url: `https://www.youtube.com/watch?v=${id}`, secs: info.secs, views: info.views, likes: info.likes, comments: info.comments }, out.reel);
  if (!ok) throw new Error("no pattern came back");
  return `youtube:${id}`;
}

// ---- the studio's own Instagram (official API, own account only) -------------------------------------------------
const igToken = () => clean(process.env.INSTAGRAM_TOKEN);
/** The studio's own reels with their insights (newest first). */
async function ownReels(limit = 25) {
  if (!igToken()) throw new Error("INSTAGRAM_TOKEN is not set – connect the studio's Instagram Business account first");
  const d = await getJson(`${IG_BASE()}/me/media?fields=id,caption,media_type,media_product_type,media_url,permalink,timestamp&limit=${Math.min(50, limit)}&access_token=${encodeURIComponent(igToken())}`);
  const list = (d.data || []).filter((m) => m.media_type === "VIDEO" && m.media_url);
  for (const m of list) {
    m.stats = {};
    // metric names differ between API versions: ask for each one alone and keep what answers
    for (const metric of ["views", "plays", "reach", "likes", "comments", "saved", "shares", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]) {
      try { const r = await getJson(`${IG_BASE()}/${m.id}/insights?metric=${metric}&access_token=${encodeURIComponent(igToken())}`); const v = r.data?.[0]?.values?.[0]?.value ?? r.data?.[0]?.total_value?.value; if (v != null) m.stats[metric] = Number(v) || 0; } catch {}
    }
  }
  return list;
}
/** One own reel: downloaded into storage/social only for the study, analysed from the file, deleted. */
async function studyOwn(m) {
  fs.mkdirSync(SOCIAL_DIR(), { recursive: true });
  const file = path.join(SOCIAL_DIR(), `ig-${m.id}.mp4`);
  try {
    const r = await fetch(m.media_url, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    const { probe } = require("./watermark");
    const info = await probe(file).catch(() => ({}));
    let secs = 0; try { const out = await require("./watermark").run(["-i", file]); const t = /Duration: (\d+):(\d+):([\d.]+)/.exec(out.stderr || ""); if (t) secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]); } catch {}
    const s = m.stats || {};
    const note = `views: ${s.views || s.plays || 0} likes: ${s.likes || 0} comments: ${s.comments || 0} saved: ${s.saved || 0} shares: ${s.shares || 0} avg watch ms: ${s.ig_reels_avg_watch_time || 0}`;
    const ok = await reels.fromFile(file, { id: `instagram:${m.id}`, title: clean(m.caption).split("\n")[0].slice(0, 120) || m.permalink, secs, note, source: "instagram", url: m.permalink, kind: "Own reel", width: info.width });
    if (!ok) throw new Error("no pattern came back");
    return `instagram:${m.id}`;
  } finally { fs.rmSync(file, { force: true }); }
}

/** Analyse a list of links. Returns one line per link: ok (pattern id) or the reason it was skipped. */
async function analyze(urls, { log = console.log } = {}) {
  const items = urls.map((u) => ({ url: clean(u), p: parseUrl(u) })).filter((x) => x.url);
  const out = [];
  const yt = items.filter((x) => x.p?.kind === "youtube").map((x) => x.p.id);
  let info = {}; try { info = await youtubeInfo([...new Set(yt)].slice(0, 50)); } catch (e) { log(`youtube numbers: ${e.message}`); }
  let own = null;
  for (const x of items) {
    try {
      if (!x.p) { out.push({ url: x.url, skipped: "not a video link we know" }); continue; }
      if (x.p.kind === "youtube") { out.push({ url: x.url, ok: await watchYouTube(x.p.id, info[x.p.id] || {}) }); }
      else if (x.p.kind === "instagram") {
        if (!igToken()) { out.push({ url: x.url, skipped: "Instagram: only the studio's own reels can be studied (official API) – INSTAGRAM_TOKEN is not set yet" }); continue; }
        own ||= await ownReels(50);
        const m = own.find((r) => String(r.permalink || "").includes(`/${x.p.code}`));
        out.push(m ? { url: x.url, ok: await studyOwn(m) } : { url: x.url, skipped: "Instagram: not one of the studio's own reels – there is no permitted way to collect other accounts' reels" });
      } else out.push({ url: x.url, skipped: "TikTok offers no permitted way to collect videos" });
    } catch (e) { out.push({ url: x.url, failed: String(e.message).slice(0, 200) }); }
    log(`${out.length}/${items.length} ${out[out.length - 1].ok ? "ok" : out[out.length - 1].skipped ? "skipped" : "failed"}`);
  }
  return out;
}

/** All the studio's own reels with their insights → reel patterns (official API). */
async function mineOwn({ limit = 25, log = console.log } = {}) {
  const list = await ownReels(limit), done = [];
  for (const m of list) { try { done.push(await studyOwn(m)); log(`own reel ${m.id} ok`); } catch (e) { log(`own reel ${m.id}: ${e.message}`); } }
  return done;
}

/** Which hooks and structures hold viewers best, across the given patterns (or the whole collection). */
async function best(ids = null) {
  const list = (await reels.all()).filter((p) => !ids || ids.includes(p.id));
  if (!list.length) throw new Error("no patterns to compare");
  const top = [...list].sort((a, b) => b.strength - a.strength).slice(0, 60);
  return reels.ask(`You advise VI Iraq, an AI video studio for Iraqi and Arab customers, on Instagram reels. From the analysed videos below (strongest first – strength mixes reach and like rate), find what holds viewers. Return JSON only: {"best_hooks":[{"hook":"the kind of opening","why":"why it stops the swipe","example":"which video showed it (number)","use_for_vi_iraq":"how VI Iraq can use it in its own reels"}],"lowest_skip_structures":[{"structure":"the shape of the video second by second","why":"","use_for_vi_iraq":""}],"avoid":["what made weaker videos lose viewers"],"length":"the best length range","cuts":"how often to change the picture"} – 5-8 hooks, 3-5 structures.`,
    top.map((p, i) => `${i + 1}. [${Number(p.views).toLocaleString("en-US")} views · ${Math.round(p.duration_sec)} s · strength ${p.strength}] ${p.title.slice(0, 80)} | hook (${p.pattern.hook.type}, ${p.pattern.hook.seconds} s): ${p.pattern.hook.visual} – ${p.pattern.hook.words} | cuts ${p.pattern.cuts}, ${p.pattern.pace} | keeps: ${p.pattern.retention} | idea: ${p.pattern.concept}`).join("\n"), 7000);
}

module.exports = { parseUrl, analyze, mineOwn, ownReels, best, youtubeInfo, watchYouTube, SOCIAL_DIR };
