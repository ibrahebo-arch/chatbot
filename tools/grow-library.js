#!/usr/bin/env node
/**
 * Grows the prompt library with the prompt model (PROMPT_MODEL, default gpt-6-sol).
 *
 *   node tools/grow-library.js <set> [--limit N] [--batch 8] [--dry]
 *
 * <set> is a topic list from tools/library-topics.js (countries, iraq, landmarks, items, actions, human, sounds,
 * animals, nature). Topics already in prompts/library/gen-<set>.json are skipped, so the script can be stopped and
 * run again. Every entry is validated (id, Arabic + English names, body length) before it is written; nothing goes
 * live until the file is committed and deployed (the server syncs prompts/library into the database at start).
 * Needs OPENAI_API_KEY in the environment (on the server: /opt/vi-iraq/.env).
 */
const fs = require("fs");
const path = require("path");
try { require("dotenv").config({ quiet: true }); } catch {}
const TOPICS = require("./library-topics");

const KEY = String(process.env.OPENAI_API_KEY || "").trim();
const MODEL = String(process.env.PROMPT_MODEL || "gpt-6-sol").trim();
const BASE = (String(process.env.OPENAI_BASE_URL || "").trim() || "https://api.openai.com").replace(/\/+$/, "");
const args = process.argv.slice(2);
const set = args[0];
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const LIMIT = opt("limit", Infinity), BATCH = opt("batch", 8), DRY = args.includes("--dry");

if (!TOPICS[set]) { console.error(`usage: node tools/grow-library.js <${Object.keys(TOPICS).join("|")}> [--limit N] [--batch N] [--dry]`); process.exit(1); }
const { domain, prefix, guide, topics } = TOPICS[set];
const OUT = path.join(__dirname, "..", "prompts", "library", `gen-${set}.json`);
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
const done = new Set(existing.map((e) => e.topic));
const todo = topics.filter((t) => !done.has(t)).slice(0, LIMIT);

const SYSTEM = `You write entries for a reality knowledge library used by an AI video and picture studio for Iraqi and Arab customers.
Each entry tells the prompt writer exactly how something really looks, moves and sounds, so generated videos and pictures are indistinguishable from reality.
Rules:
- English body, 70-130 words, concrete and visual: shapes, materials, colours, proportions, how it moves (physics), the sounds it makes, light, typical people and context. No history lessons, no opinions, no markdown.
- ${guide}
- names: 4-10 trigger words a customer might type: Arabic (Modern Standard and Iraqi dialect spellings) AND English, short, lowercase English. Never generic words that would match unrelated requests (no "city", "big", "the", "شي").
- Respectful of all cultures and religions; weapons only as props or heritage, no violence, no gore.
Return JSON only: {"entries":[{"topic":"<the topic exactly as given>","slug":"<short-ascii-kebab>","names":["..."],"body":"..."}]}`;

const valid = (e) => e && typeof e.topic === "string" && /^[a-z0-9-]{2,60}$/.test(e.slug || "") && Array.isArray(e.names)
  && e.names.length >= 3 && e.names.some((n) => /[؀-ۿ]/.test(n)) && e.names.some((n) => /[a-z]/i.test(n))
  && typeof e.body === "string" && e.body.split(/\s+/).length >= 50;

async function ask(batch) {
  const body = { model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Write one entry for each of these ${batch.length} topics:\n${batch.map((t) => `- ${t}`).join("\n")}` }], response_format: { type: "json_object" } };
  if (/^(gpt-[5-9]|o\d)/.test(MODEL)) body.max_completion_tokens = 12000; else { body.max_tokens = 4000; body.temperature = 0.5; }
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return { entries: JSON.parse(data.choices?.[0]?.message?.content || "{}").entries || [], usage: data.usage || {} };
}

(async () => {
  console.log(`${set}: ${topics.length} topics, ${done.size} done, ${todo.length} to write with ${MODEL}${DRY ? " (dry run)" : ""}`);
  if (DRY || !todo.length) return;
  if (!KEY) { console.error("OPENAI_API_KEY is not set"); process.exit(1); }
  const out = [...existing];
  const ids = new Set(out.map((e) => e.id));
  let tin = 0, tout = 0, bad = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let res;
    try { res = await ask(batch); } catch (e) { console.error(`batch ${i / BATCH + 1}: ${e.message}`); continue; }
    tin += res.usage.prompt_tokens || 0; tout += res.usage.completion_tokens || 0;
    for (const e of res.entries) {
      if (!valid(e) || !batch.includes(e.topic)) { bad++; continue; }
      let id = `${prefix}.${e.slug}`; for (let n = 2; ids.has(id); n++) id = `${prefix}.${e.slug}-${n}`;
      ids.add(id);
      out.push({ id, domain, topic: e.topic, names: [...new Set(e.names.map((n) => String(n).trim().toLowerCase()).filter((n) => n.length >= 2))].slice(0, 10), body: e.body.trim() });
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
    console.log(`batch ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)}: ${out.length} entries · tokens in ${tin} out ${tout} · rejected ${bad}`);
  }
  const words = out.reduce((n, e) => n + e.body.split(/\s+/).length, 0);
  console.log(`done: ${out.length} entries, ${words} words in ${path.relative(process.cwd(), OUT)} · total tokens in ${tin} out ${tout}`);
})();
