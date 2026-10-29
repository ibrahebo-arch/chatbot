#!/usr/bin/env node
/**
 * Face lock: checks a picture against the reference faces and, while the faces drifted, corrects ONLY the faces with
 * Nano Banana Pro (the checker's notes + the real photos), then checks again – up to --rounds times (2).
 *
 *   node tools/face-fix.js <picture.jpg> <out.jpg> --refs a.jpg,b.jpg,… [--names "man,woman"] [--rounds 2]
 *
 * Writes the best version to out.jpg and prints one JSON line per round. Needs OPENAI_API_KEY and FAL_KEY.
 */
try { require("dotenv").config({ quiet: true }); } catch {}
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const KEY = String(process.env.FAL_KEY || "").trim();
const MIN = Number(process.env.FACE_MIN_SCORE) || 8;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const [input, output] = args;
const refs = String(opt("refs", "")).split(",").filter(Boolean);
const names = opt("names", "");
const rounds = Number(opt("rounds", 2));
if (!input || !output || !refs.length) { console.error("usage: node tools/face-fix.js <picture.jpg> <out.jpg> --refs a.jpg,b.jpg [--names \"man,woman\"] [--rounds 2]"); process.exit(1); }

// one check, tried twice – a failed check must never count as "score 0" (that would replace a good picture with a worse one)
function check(file) {
  for (let i = 0; i < 2; i++) {
    const r = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "face-check.js"), file, ...refs, ...(names ? ["--names", names] : [])], { encoding: "utf8", env: process.env });
    try { const v = JSON.parse(String(r.stdout).trim().split("\n").pop()); if (v && v.score > 0) return v; } catch {}
  }
  return null;
}
async function upload(file) {
  const iu = await (await fetch("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", { method: "POST", headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ content_type: "image/jpeg", file_name: path.basename(file) }) })).json();
  await fetch(iu.upload_url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: fs.readFileSync(file) });
  return iu.file_url;
}
async function fix(file, notes, out) {
  const prompt = `Picture 1 is the photo. Keep EVERYTHING exactly – pose, gaze, expression, clothes, hands, place, light, colours, framing and the real skin texture. Change ONLY the faces so they match the real people in the other pictures exactly (same face shape and proportions – do not slim, lengthen or beautify).
Correct these differences: ${notes.join(" ")}
Real camera photo, no airbrushing, no text, no watermark.`;
  const urls = [await upload(file), ...(await Promise.all(refs.map(upload)))];
  const r = await fetch("https://fal.run/fal-ai/nano-banana-pro/edit", { method: "POST", headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_urls: urls, aspect_ratio: "auto", resolution: "4K", num_images: 1, output_format: "jpeg" }), signal: AbortSignal.timeout(600000) });
  const d = await r.json();
  if (!r.ok) throw new Error(`nano ${JSON.stringify(d).slice(0, 200)}`);
  fs.writeFileSync(out, Buffer.from(await (await fetch(d.images[0].url)).arrayBuffer()));
}
(async () => {
  const first = check(input);
  if (!first) throw new Error("the face check did not answer – nothing changed");
  let best = { file: input, ...first };
  console.log(JSON.stringify({ round: 0, score: best.score, notes: best.notes }));
  for (let i = 1; i <= rounds && best.score < MIN; i++) {
    const next = output.replace(/\.jpe?g$/i, `-r${i}.jpg`);
    await fix(best.file, best.notes || [], next);
    const c = check(next);
    console.log(JSON.stringify({ round: i, score: c ? c.score : null, notes: c ? c.notes : ["check failed"] }));
    if (c && c.score > best.score) best = { file: next, ...c }; // only a better face replaces the picture
  }
  fs.copyFileSync(best.file, output);
  console.log(JSON.stringify({ final: output, score: best.score, locked: best.score >= MIN }));
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; });
