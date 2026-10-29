#!/usr/bin/env node
/**
 * VI Iraq – Trained Model (see trained.js).
 *
 *   node tools/trained-model.js cycle [--videos N]     one study cycle (the systemd timer runs this every 3 hours)
 *   node tools/trained-model.js pending [--limit N]    drafts waiting for review, with their reality check (JSON)
 *   node tools/trained-model.js approve <id...> [--by name] [--edit edits.json]   into prompt_library (source 'trained')
 *   node tools/trained-model.js reject <id...> [--note "why"] [--by name]
 *   node tools/trained-model.js stats
 *   node tools/trained-model.js report [--hours 24] [--out file.html]   the study report (frames, reality check, sound
 *                                                       and voices, drafts, what entered the library), also kept in storage
 *
 * On the server: cd /opt/vi-iraq && sudo -u viiraq -H node --env-file=.env tools/trained-model.js stats
 * TRAINED_MODEL=0 in the environment stops the cycles (review commands still work).
 */
try { require("dotenv").config({ quiet: true }); } catch {}
const fs = require("fs");
const db = require("../db");
const trained = require("../trained");

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const ids = args.slice(1).filter((a, i, all) => /^\d+$/.test(a) && !String(all[i - 1] || "").startsWith("--")).map(Number);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);

(async () => {
  if (!db.configured) throw new Error("DATABASE_URL is not set");
  await db.initDb();
  if (cmd === "cycle") {
    if (String(process.env.TRAINED_MODEL || "").trim() === "0") { log("TRAINED_MODEL=0 – skipped"); return; }
    log("cycle start");
    const r = await trained.cycle(db, { videos: Number(opt("videos", 0)) || undefined, log });
    log("cycle done", JSON.stringify(r));
  } else if (cmd === "pending") {
    console.log(JSON.stringify(await trained.pending(db, Number(opt("limit", 30))), null, 1));
  } else if (cmd === "approve") {
    const edits = opt("edit") ? JSON.parse(fs.readFileSync(opt("edit"), "utf8")) : {};
    console.log(JSON.stringify({ approved: await trained.approve(db, ids, { reviewer: opt("by", "claude"), edits }) }));
  } else if (cmd === "reject") {
    console.log(JSON.stringify({ rejected: await trained.reject(db, ids, { reviewer: opt("by", "claude"), note: opt("note", "") }) }));
  } else if (cmd === "report") {
    const html = await trained.report(db, { hours: Number(opt("hours", 24)) });
    const key = `trained/reports/${new Date().toISOString().slice(0, 13).replace("T", "-")}.html`;
    try { await require("../storage").put(key, Buffer.from(html), { contentType: "text/html; charset=utf-8" }); log("saved", key); } catch (e) { log("storage:", e.message); }
    if (opt("out")) { fs.writeFileSync(opt("out"), html); log("written", opt("out")); }
  } else if (cmd === "stats") {
    console.log(JSON.stringify(await trained.stats(db), null, 1));
  } else {
    console.error("usage: node tools/trained-model.js <cycle|pending|approve|reject|stats|report> …");
    process.exitCode = 1;
  }
})().catch((e) => { log("ERR", e.message); process.exitCode = 1; }).finally(() => db.pool && db.pool.end());
