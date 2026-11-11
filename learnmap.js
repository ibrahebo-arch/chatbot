/**
 * VI Iraq – the learning map: one live picture of everything the studio has studied and learned.
 *
 *   GET /admin/trained/map       the page (3D map + tables), same login as the daily reports
 *   GET /admin/trained/map.json  its data, rebuilt from the database at most once a minute
 *
 * What is shown: the library in the middle; the knowledge domains around it (how many entries, how many of them were
 * learned from real footage, how often they were used); the areas of real life the self-learning covers (clips
 * studied, how many of each area's searches are covered); the sources that feed it (stock footage, Commons, YouTube,
 * our own videos, hand-written and generated files, lessons, AI-mistake fixes); the days; and two tables – every
 * entry learned and every clip studied. Read-only.
 */
const trained = require("./trained");

const iraq = (t) => (t ? new Date(new Date(t).getTime() + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const SOURCE_NAMES = { pixabay: "Pixabay footage", commons: "Wikimedia Commons", "youtube-gemini": "YouTube (watched by Gemini)", "youtube-cc": "YouTube Creative Commons", inbox: "Our own videos (inbox)", pexels: "Pexels footage" };
// where a library entry came from, read from its id and source
function origin(e) {
  if (e.source === "trained") return "learned";
  if (/^core\./.test(e.id)) return "core";
  if (/\.fix\./.test(e.id)) return "fixes";
  if (/\.gen\.|^place\.(world|city|iq2|landmark)\./.test(e.id)) return "generated";
  return "written";
}
const ORIGIN_NAMES = { learned: "Learned from real footage", written: "Hand-written and reel lessons", generated: "Written by the prompt model", fixes: "AI-mistake fixes", core: "Core rules (always on)" };

let cache = null, cachedAt = 0;
async function data(db, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 60000) return cache;
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const [lib, vids, cands, queries, dayClips, dayAdded] = await Promise.all([
    q("SELECT id, domain, names, left(body, 190) AS body, source, enabled, always, uses, updated_at, (embedding IS NOT NULL) AS vec FROM prompt_library"),
    q("SELECT id, source, query, trend, title, page_url, status, score, studied_at, created_at, duration_sec FROM trained_videos ORDER BY created_at DESC"),
    q("SELECT entry->>'id' AS eid, video_id, status, reviewer, note FROM trained_candidates"),
    q("SELECT query, count(*)::int AS n FROM trained_videos WHERE status='studied' GROUP BY 1"),
    q("SELECT to_char(studied_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD') AS d, count(*)::int AS n FROM trained_videos WHERE status='studied' GROUP BY 1 ORDER BY 1"),
    q("SELECT to_char(reviewed_at AT TIME ZONE 'Asia/Baghdad', 'YYYY-MM-DD') AS d, count(*)::int AS n FROM trained_candidates WHERE status='approved' AND reviewed_at IS NOT NULL GROUP BY 1 ORDER BY 1"),
  ]);
  const live = lib.filter((e) => e.enabled);
  const vById = new Map(vids.map((v) => [v.id, v]));
  const perVideo = new Map(); const clipOf = new Map();
  for (const c of cands) {
    const s = perVideo.get(c.video_id) || { approved: 0, rejected: 0, duplicate: 0, pending: 0 }; s[c.status] = (s[c.status] || 0) + 1; perVideo.set(c.video_id, s);
    if (c.status === "approved") clipOf.set(c.eid, c.video_id);
  }

  // the knowledge domains
  const domains = trained.DOMAINS.map((d) => {
    const es = live.filter((e) => e.domain === d);
    return { id: `domain:${d}`, name: d, entries: es.length, learned: es.filter((e) => e.source === "trained").length, used: es.filter((e) => e.uses > 0).length, uses: es.reduce((n, e) => n + (e.uses || 0), 0) };
  });
  // the areas of real life the self-learning studies
  const studied = Object.fromEntries(queries.map((r) => [r.query, r.n]));
  const areas = Object.entries(trained.COVERAGE).map(([name, qs]) => ({
    id: `area:${name}`, name, searches: qs.length, covered: qs.filter((x) => studied[x] > 0).length, clips: qs.reduce((n, x) => n + (studied[x] || 0), 0),
    top: qs.map((x) => ({ q: x, n: studied[x] || 0 })).sort((a, b) => b.n - a.n).slice(0, 4),
  }));
  // what feeds the library: footage sources and written sources
  const bySource = {};
  for (const v of vids) { const s = (bySource[v.source] ||= { studied: 0, failed: 0, score: 0, secs: 0, entries: 0 }); if (v.status === "studied") { s.studied++; s.score += Number(v.score) || 0; s.secs += Number(v.duration_sec) || 0; } else if (v.status === "failed") s.failed++; }
  const liveIds = new Set(live.map((e) => e.id));
  for (const [eid, vid] of clipOf) { const v = vById.get(vid); if (v && bySource[v.source] && liveIds.has(eid)) bySource[v.source].entries++; }
  const sources = Object.entries(bySource).map(([k, s]) => ({ id: `source:${k}`, kind: "footage", name: SOURCE_NAMES[k] || k, clips: s.studied + s.failed, studied: s.studied, failed: s.failed, avg: s.studied ? +(s.score / s.studied).toFixed(1) : 0, minutes: Math.round(s.secs / 60), entries: s.entries }));
  const byOrigin = {};
  for (const e of live) { const o = origin(e); if (o !== "learned") (byOrigin[o] ||= { entries: 0, used: 0 }), byOrigin[o].entries++, (e.uses > 0 && byOrigin[o].used++); }
  for (const [k, s] of Object.entries(byOrigin)) sources.push({ id: `source:${k}`, kind: "written", name: ORIGIN_NAMES[k], entries: s.entries, used: s.used });

  const days = [...new Set([...dayClips.map((r) => r.d), ...dayAdded.map((r) => r.d)])].filter(Boolean).sort().map((d) => ({ d, clips: dayClips.find((r) => r.d === d)?.n || 0, added: dayAdded.find((r) => r.d === d)?.n || 0 }));
  const today = trained.iraqDay();
  const learned = live.filter((e) => e.source === "trained");
  const st = vids.filter((v) => v.status === "studied");
  cache = {
    at: iraq(Date.now()), today,
    totals: {
      entries: live.length, learned: learned.length, written: live.length - learned.length, vectors: live.filter((e) => e.vec).length, core: live.filter((e) => e.always).length,
      used: live.filter((e) => e.uses > 0).length, uses: live.reduce((n, e) => n + (e.uses || 0), 0), switchedOff: lib.length - live.length,
      clips: st.length, failed: vids.filter((v) => v.status === "failed").length, minutes: Math.round(st.reduce((n, v) => n + (Number(v.duration_sec) || 0), 0) / 60),
      avgScore: st.length ? +(st.reduce((n, v) => n + (Number(v.score) || 0), 0) / st.length).toFixed(1) : 0,
      approved: cands.filter((c) => c.status === "approved").length, rejected: cands.filter((c) => c.status === "rejected").length, duplicates: cands.filter((c) => c.status === "duplicate").length,
      waiting: cands.filter((c) => c.status === "pending").length, lastStudy: iraq(st.reduce((m, v) => (v.studied_at > m ? v.studied_at : m), 0) || null),
      clipsToday: days.find((x) => x.d === today)?.clips || 0, addedToday: days.find((x) => x.d === today)?.added || 0,
    },
    domains, areas, sources, days,
    // every entry learned from footage, newest first
    entries: learned.sort((a, b) => b.updated_at - a.updated_at).map((e) => { const v = vById.get(clipOf.get(e.id)); return { id: e.id, domain: e.domain, names: e.names.slice(0, 4), body: e.body, uses: e.uses || 0, at: iraq(e.updated_at), clip: v ? String(v.title).slice(0, 90) : "", src: v ? v.source : "" }; }),
    // every clip the model looked at, newest first
    clips: vids.map((v) => { const s = perVideo.get(v.id) || {}; return { id: v.id, src: v.source, title: String(v.title).slice(0, 110), q: v.query || "", url: /^https:\/\//.test(v.page_url || "") ? v.page_url : "", status: v.status, score: v.status === "studied" ? Number(v.score) || 0 : null, at: iraq(v.studied_at || v.created_at), added: s.approved || 0, rejected: (s.rejected || 0) + (s.duplicate || 0) }; }),
  };
  cachedAt = Date.now();
  return cache;
}

const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function page(v = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VI-Iraq – learning map</title>
<style>
html,body{margin:0;background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
a{color:#58a6ff}
#wrap{position:relative;height:min(82vh,860px);min-height:520px;margin:14px;border:1px solid #1f2937;border-radius:14px;overflow:hidden;background:radial-gradient(ellipse at 50% 38%,#131c2b 0%,#0d1117 62%)}
canvas#c{display:block;width:100%;height:100%;cursor:grab} canvas#c.drag{cursor:grabbing}
.hud{position:absolute;pointer-events:none;font-size:12px;line-height:1.45}
#title{left:18px;top:14px;max-width:52%} #title h1{margin:0 0 2px;font-size:18px;font-weight:650} #title p{margin:0;color:#8b98a5}
#title b{color:#d8b25a}
#stats{left:18px;top:78px;display:flex;gap:8px;flex-wrap:wrap;max-width:66%}
.tile{background:rgba(13,17,23,.74);border:1px solid #243041;border-radius:10px;padding:7px 11px;min-width:104px}
.tile b{display:block;font-size:17px;font-weight:650;font-variant-numeric:tabular-nums} .tile span{color:#8b98a5;font-size:11px}
#legend{left:18px;bottom:14px;background:rgba(13,17,23,.74);border:1px solid #243041;border-radius:10px;padding:9px 12px;max-width:330px}
#legend div{margin:2px 0;color:#c9d4df} #legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:-1px} #legend small{display:block;color:#8b98a5;margin-top:5px}
#live{right:18px;top:14px;text-align:right;max-width:38%} #live .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#8b98a5}
#live.on .dot{background:#3fb950;box-shadow:0 0 8px #3fb950} #live span{color:#8b98a5} #live a{pointer-events:auto}
#btns{position:absolute;right:18px;bottom:44px;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
button{background:rgba(13,17,23,.8);color:#c9d4df;border:1px solid #2a3a4d;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;font-family:inherit}
button:hover,button.on{border-color:#58a6ff;color:#fff}
#hint{right:18px;bottom:14px;color:#6b7785;font-size:11px}
#tip{position:absolute;display:none;pointer-events:none;max-width:340px;background:rgba(10,14,20,.95);border:1px solid #2f3e52;border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.5;z-index:5;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#tip b{font-size:13px} #tip .k{color:#8b98a5} #tip .bar{height:5px;background:#1c2634;border-radius:3px;margin:6px 0 4px} #tip .bar i{display:block;height:5px;border-radius:3px}
#err{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#8b98a5;font-size:14px;padding:30px;text-align:center}
section{margin:22px 14px;font-size:13px} section h2{font-size:17px;margin:0 0 4px} section p{color:#8b98a5;margin:0 0 12px}
#days{display:flex;align-items:flex-end;gap:5px;height:150px;padding:10px;border:1px solid #1f2937;border-radius:10px;overflow-x:auto}
#days .d{flex:0 0 26px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;font-size:10px;color:#8b98a5}
#days .d i{display:block;width:10px;border-radius:3px 3px 0 0} #days .d .two{display:flex;gap:2px;align-items:flex-end;height:100%}
.tabs{display:flex;gap:6px;margin-bottom:10px} input#q{background:#0d1117;color:#e6edf3;border:1px solid #2a3a4d;border-radius:8px;padding:7px 10px;width:340px;max-width:100%;margin-bottom:10px;font-size:13px;font-family:inherit}
.scroll{overflow:auto;max-height:78vh;border:1px solid #1f2937;border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:980px}
th{position:sticky;top:0;background:#161d29;text-align:left;padding:8px 10px;color:#aab6c3;font-weight:600;border-bottom:1px solid #243041;cursor:pointer;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #18202c;vertical-align:top} td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap} td.f{color:#aab6c3;max-width:520px}
tr:hover td{background:#121a26} td .ar{direction:rtl;unicode-bidi:plaintext} .pill{display:inline-block;border-radius:20px;padding:1px 8px;font-size:11px;border:1px solid #2a3a4d;color:#c9d4df}
#count{color:#8b98a5;margin-left:8px}
</style></head><body>
<div id="wrap"><canvas id="c"></canvas>
 <div class="hud" id="title"><h1><b>VI</b>-Iraq · everything the studio has learned</h1><p>The library is the core. Inner ring: knowledge domains. Outer ring: the areas of real life it studies. Above: the sources that feed it.</p></div>
 <div class="hud" id="stats"></div><div class="hud" id="live"></div><div class="hud" id="legend"></div>
 <div id="btns"><button id="b-rot" class="on" title="Turn the slow rotation on or off">⟳ rotate</button><button id="b-lab" class="on" title="Show or hide the names">Aa names</button><button id="b-flow" class="on" title="Show or hide the flow of knowledge">∴ flow</button><button id="b-top" title="Look from above">⬒ top</button><button id="b-home" title="Back to the starting view">⌂ reset</button></div>
 <div class="hud" id="hint">drag to rotate · scroll to zoom · hover for details · click a pillar to filter the tables</div>
 <div id="tip"></div><div id="err">This picture needs WebGL, which this browser has switched off. The tables below still work.</div></div>
<section><h2>Day by day</h2><p>Clips studied (teal) and entries added to the library (gold) per Iraqi day. Click a day to open its report.</p><div id="days"></div></section>
<section id="learn"><h2>What was learned and what was studied</h2><p id="sum"></p>
 <div class="tabs"><button id="t-entries" class="on">Entries learned</button><button id="t-clips">Clips studied</button><button id="t-areas">Areas of real life</button><button id="t-sources">Sources</button></div>
 <input id="q" placeholder="Filter the table… (Arabic or English)"><span id="count"></span>
 <div class="scroll"><table><thead></thead><tbody></tbody></table></div></section>
<script src="/vendor/three.min.js?v=128"></script><script src="/admin-map.js?v=${v}"></script></body></html>`;
}

module.exports = { data, page, CSP, origin };
