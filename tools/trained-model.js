#!/usr/bin/env node
/**
 * VI Iraq – Trained Model (see trained.js).
 *
 *   node tools/trained-model.js cycle [--videos N]     one study cycle (the systemd timer runs this every 3 hours)
 *   node tools/trained-model.js pending [--limit N]    drafts waiting for review, with their reality check (JSON)
 *   node tools/trained-model.js approve <id...> [--by name] [--edit edits.json]   into prompt_library (source 'trained')
 *   node tools/trained-model.js reject <id...> [--note "why"] [--by name]
 *   node tools/trained-model.js stats
 *   node tools/trained-model.js review                 the automatic editor reviews the waiting drafts now
 *   node tools/trained-model.js inbox                  studies the videos in the owner's folder now ("study my folder":
 *                                                       STORAGE_DIR/trained/inbox – own clips or clips used with permission)
 *   node tools/trained-model.js report [--day YYYY-MM-DD] [--out file.html]   the day's report (frames, reality check,
 *                                                       sound and voices, drafts and decisions, what entered the library)
 *
 * After every cycle the automatic editor reviews the new drafts (TRAIN_AUTO_REVIEW=0 turns that off, then drafts wait
 * for approve/reject) and the day's report is rewritten: STORAGE_DIR/trained/reports/<Iraq day>.html, also shown at
 * https://www.vi-iraq.com/admin/trained (admin password).
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
    try { const f = await trained.studyInbox(db, { log }); if (f.studied || f.failed) log("my folder", JSON.stringify(f)); } catch (e) { log("my folder:", e.message); }
    if (String(process.env.TRAIN_AUTO_REVIEW || "").trim() !== "0") {
      try { log("auto-review", JSON.stringify(await trained.autoReview(db, { log }))); } catch (e) { log("auto-review failed:", e.message); }
    }
    try { log("report saved", await trained.saveDayReport(db)); } catch (e) { log("report:", e.message); }
  } else if (cmd === "pending") {
    console.log(JSON.stringify(await trained.pending(db, Number(opt("limit", 30))), null, 1));
  } else if (cmd === "approve") {
    const edits = opt("edit") ? JSON.parse(fs.readFileSync(opt("edit"), "utf8")) : {};
    console.log(JSON.stringify({ approved: await trained.approve(db, ids, { reviewer: opt("by", "claude"), edits }) }));
  } else if (cmd === "reject") {
    console.log(JSON.stringify({ rejected: await trained.reject(db, ids, { reviewer: opt("by", "claude"), note: opt("note", "") }) }));
  } else if (cmd === "inbox") {
    log("my folder", trained.INBOX(), JSON.stringify(await trained.studyInbox(db, { log })));
    if (String(process.env.TRAIN_AUTO_REVIEW || "").trim() !== "0") log("auto-review", JSON.stringify(await trained.autoReview(db, { log })));
    log("report saved", await trained.saveDayReport(db));
  } else if (cmd === "review") {
    log("auto-review", JSON.stringify(await trained.autoReview(db, { log })));
    log("report saved", await trained.saveDayReport(db));
  } else if (cmd === "report") {
    const day = opt("day", trained.iraqDay());
    log("saved", await trained.saveDayReport(db, day));
    if (opt("out")) { fs.writeFileSync(opt("out"), await trained.report(db, { day })); log("written", opt("out")); }
  } else if (cmd === "stats") {
    console.log(JSON.stringify(await trained.stats(db), null, 1));
  } else {
    console.error("usage: node tools/trained-model.js <cycle|inbox|review|pending|approve|reject|stats|report> …");
    process.exitCode = 1;
  }
})().catch((e) => { log("ERR", e.message); process.exitCode = 1; }).finally(() => db.pool && db.pool.end());
