#!/usr/bin/env node
/**
 * Face check: does a generated picture (or video frame) still show the same people as the reference faces?
 *
 *   node tools/face-check.js <picture.jpg> <reference1.jpg> [reference2.jpg …] [--names "man,woman"]
 *
 * The prompt model compares every face in the picture with the reference close-ups and answers with one JSON line:
 * { "score": 0–10 (10 = unmistakably the same people), "same": true|false, "notes": ["what drifted"] }.
 * Exit code 2 when the score is below FACE_MIN_SCORE (8) – a script can remake the picture then.
 * Needs OPENAI_API_KEY (on the server: node --env-file=/opt/vi-iraq/.env tools/face-check.js …).
 */
try { require("dotenv").config({ quiet: true }); } catch {}
const fs = require("fs");

const KEY = String(process.env.OPENAI_API_KEY || "").trim();
const MODEL = String(process.env.PROMPT_MODEL || "gpt-6-sol").trim();
const MIN = Number(process.env.FACE_MIN_SCORE) || 8;
const args = process.argv.slice(2);
const at = args.indexOf("--names");
const names = at >= 0 ? String(args.splice(at, 2)[1] || "").split(",").map((x) => x.trim()).filter(Boolean) : [];
const [picture, ...refs] = args;
if (!picture || !refs.length) { console.error("usage: node tools/face-check.js <picture.jpg> <reference.jpg> [more references] [--names \"man,woman\"]"); process.exit(1); }

const img = (f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}`, detail: "high" } });
(async () => {
  const content = [
    { type: "text", text: `The first image is a generated picture. The other ${refs.length} image(s) are reference photos of the real people${names.length ? ` (${names.join(", ")})` : ""}.
Compare each face in the generated picture with the references like a strict casting director: face shape, eyes, eyebrows, nose, lips, jaw, hairline, beard/stubble, skin tone, age. Ignore light, expression, makeup and angle.
Return JSON only: {"score":0-10,"same":true|false,"notes":["each concrete difference that makes a face look like a different person"]} – 10 = unmistakably the same people, 8 = same people with small drift, below 7 = could be someone else.` },
    img(picture), ...refs.map(img),
  ];
  const body = { model: MODEL, messages: [{ role: "user", content }], response_format: { type: "json_object" } };
  if (/^(gpt-[5-9]|o\d)/.test(MODEL)) body.max_completion_tokens = 1500; else body.temperature = 0;
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `OpenAI ${r.status}`);
  const v = JSON.parse(d.choices[0].message.content);
  const out = { score: Number(v.score) || 0, same: Boolean(v.same) && Number(v.score) >= MIN, notes: (v.notes || []).slice(0, 6) };
  console.log(JSON.stringify(out));
  process.exitCode = out.score >= MIN ? 0 : 2;
})().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; });
