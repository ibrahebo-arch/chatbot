#!/usr/bin/env node
/**
 * VI Iraq – Reel Director (reels.js) from the command line. Run on the VPS:
 *
 *   cd /opt/vi-iraq && sudo -u viiraq -H node --env-file=.env tools/reel-director.js stats
 *   … tools/reel-director.js backfill [--limit 40]          patterns from the videos Gemini already watched
 *   … tools/reel-director.js direct "<idea>" [--seconds 15] hook, shot list, script, caption for one reel
 *   … tools/reel-director.js near "<idea>"                  the closest analysed videos
 */
const db = require("../db");
const reels = require("../reels");
const library = require("../library");
const args = process.argv.slice(2), cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
(async () => {
  if (cmd === "backfill") console.log(JSON.stringify({ added: await reels.backfill({ limit: Number(opt("limit", 40)) }) }));
  else if (cmd === "stats") { const list = await reels.all(); console.log(JSON.stringify(list.length ? reels.summary(list) : { videos: 0 }, null, 1)); }
  else if (cmd === "near") { for (const p of await reels.nearest(args[1] || "", 8)) console.log(`${String(p.views).padStart(9)} views · ${Math.round(p.duration_sec)} s · ${p.pattern.hook.type} · ${p.title.slice(0, 70)}`); }
  else if (cmd === "direct") { await library.attach(db).catch(() => {}); console.log(JSON.stringify(await reels.direct(args[1] || "", { seconds: Number(opt("seconds", 15)) }), null, 1)); }
  else { console.error("usage: reel-director.js stats | backfill [--limit N] | near \"idea\" | direct \"idea\" [--seconds 15]"); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("reel-director:", e.message); process.exit(1); });
