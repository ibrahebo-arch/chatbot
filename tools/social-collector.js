#!/usr/bin/env node
/**
 * VI Iraq – social collector (social.js) from the command line. Run on the VPS:
 *
 *   cd /opt/vi-iraq && sudo -u viiraq -H node --env-file=.env tools/social-collector.js <command>
 *
 *   analyze <url> [<url> …] | --file urls.txt   YouTube/Shorts links (watched by Gemini, nothing downloaded) and the
 *                                               studio's own Instagram reels; other links are skipped with a reason
 *   own [--limit 25]                            all of the studio's own Instagram reels + insights (INSTAGRAM_TOKEN)
 *   best [--last N]                             best hooks and lowest-skip structures (the last N analysed, or all)
 *   direct "<idea>" [--seconds 15]              a reel plan for VI Iraq from those patterns (Reel Director)
 */
const fs = require("fs");
const db = require("../db");
const social = require("../social");
const reels = require("../reels");
const library = require("../library");
const args = process.argv.slice(2), cmd = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
(async () => {
  if (cmd === "analyze") {
    const urls = opt("file") ? fs.readFileSync(opt("file"), "utf8").split(/\s+/) : args.slice(1).filter((a) => !a.startsWith("--"));
    const out = await social.analyze(urls);
    for (const r of out) console.log(r.ok ? `OK       ${r.url}` : r.skipped ? `SKIPPED  ${r.url} – ${r.skipped}` : `FAILED   ${r.url} – ${r.failed}`);
    const ids = out.filter((r) => r.ok).map((r) => r.ok);
    if (ids.length >= 3) console.log("\n" + JSON.stringify(await social.best(ids), null, 1));
  } else if (cmd === "own") {
    console.log(JSON.stringify({ studied: await social.mineOwn({ limit: Number(opt("limit", 25)) }) }));
  } else if (cmd === "best") {
    const n = Number(opt("last", 0));
    const ids = n ? (await db.query("SELECT id FROM reel_patterns ORDER BY created_at DESC LIMIT $1", [n])).rows.map((r) => r.id) : null;
    console.log(JSON.stringify(await social.best(ids), null, 1));
  } else if (cmd === "direct") {
    await library.attach(db).catch(() => {});
    console.log(JSON.stringify(await reels.direct(args[1] || "", { seconds: Number(opt("seconds", 15)) }), null, 1));
  } else { console.error("usage: social-collector.js analyze <urls…> | --file f | own | best [--last N] | direct \"idea\""); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("social-collector:", e.message); process.exit(1); });
