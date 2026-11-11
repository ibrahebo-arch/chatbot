// Run on the VPS in a scratch folder: mkdir -p /tmp/grow && node --env-file=/opt/vi-iraq/.env tools/mine-ai-mistakes.js, then copy
// /tmp/grow/ai-fixes.json into prompts/library/lessons-ai-mistakes.json after a review.
// Mines the "what AI gets wrong" notes of every studied real clip (trained_videos.check_result.ai_mistakes) into
// library entries: one per recurring failure mode – the mistake, how it really is, how to write it. Reads the
// database only; writes /tmp/grow/ai-fixes.json for review.
process.chdir("/opt/vi-iraq");
const fs = require("fs"); const db = require("/opt/vi-iraq/db");
const KEY = process.env.OPENAI_API_KEY, MODEL = process.env.PROMPT_MODEL || "gpt-6-sol", O = "/tmp/grow";
const DOMAINS = ["reality", "human", "action", "item", "place", "nature", "animal", "style", "sound"];
async function ask(system, user, max = 12000) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, response_format: { type: "json_object" }, max_completion_tokens: max, messages: [{ role: "system", content: system }, { role: "user", content: user }] }), signal: AbortSignal.timeout(600000) });
      const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${String(j.error?.message).slice(0, 150)}`);
      return JSON.parse(j.choices[0].message.content);
    } catch (e) { console.log("retry:", e.message); await new Promise((s) => setTimeout(s, 8000)); }
  }
  return {};
}
(async () => {
  const rows = (await db.query("SELECT title, check_result->'ai_mistakes' AS m FROM trained_videos WHERE status='studied' AND score >= 6 AND jsonb_array_length(coalesce(check_result->'ai_mistakes','[]'::jsonb)) > 0 ORDER BY id")).rows;
  const lines = rows.flatMap((r) => (r.m || []).map((x) => `[${String(r.title).slice(0, 40)}] ${x}`));
  console.log("clips", rows.length, "mistakes", lines.length);
  // pass 1: failure modes per chunk
  let modes = [];
  const chunks = []; for (let i = 0; i < lines.length; i += 230) chunks.push(lines.slice(i, i + 230));
  for (let i = 0; i < chunks.length; i += 4) {
    const res = await Promise.all(chunks.slice(i, i + 4).map((c) => ask(
      "You analyse notes about what AI video generators get wrong, written while studying real footage. Group the notes into DISTINCT recurring failure modes that apply to many scenes (not one clip). Return JSON {\"modes\":[{\"mode\":\"short title\",\"mistake\":\"what the generator does wrong, one sentence\",\"real\":\"what really happens instead, one concrete sentence\",\"n\":<how many notes>}]} with at most 28 modes, the most frequent first. Skip anything about violence, religion, politics, pork or alcohol.",
      c.join("\n"), 9000)));
    for (const r of res) modes.push(...(r.modes || []));
    console.log("pass 1:", Math.min(i + 4, chunks.length), "/", chunks.length, "modes", modes.length);
  }
  modes = modes.filter((m) => m && m.mode && m.mistake && m.real).map((m, i) => ({ i, ...m }));
  fs.writeFileSync(`${O}/modes.json`, JSON.stringify(modes));
  // pass 2a: clusters
  const cl = await ask(
    `You merge failure modes of AI video generators into a final list. Merge the ones that describe the same fault; keep faults that matter for videos and pictures of everyday life, people, food, shops, streets, vehicles, animals, nature, light, camera and sound. Return JSON {"clusters":[{"slug":"short-ascii-kebab","domain":one of ${DOMAINS.join("|")},"title":"short title","members":[<mode numbers>]}]} with 80 to 100 clusters, the ones with the most members first. Every important mode belongs to one cluster.`,
    modes.map((m) => `${m.i}. ${m.mode} – ${m.mistake}`).join("\n"), 20000);
  const clusters = (cl.clusters || []).filter((c) => c && c.slug && DOMAINS.includes(c.domain) && Array.isArray(c.members) && c.members.length);
  console.log("clusters", clusters.length);
  // pass 2b: entries
  const entries = [];
  for (let i = 0; i < clusters.length; i += 30) {
    const groups = []; for (let k = i; k < Math.min(i + 30, clusters.length); k += 10) groups.push(clusters.slice(k, k + 10));
    const res = await Promise.all(groups.map((g) => ask(
      `You write entries for the reality library of an AI video and picture studio for Iraqi and Arab customers. Each entry fixes ONE failure mode of AI generators. For every cluster given, write: "names" = 6-10 triggers a customer might type for scenes where this fault appears, Iraqi/Arabic AND English, at least two short ones (1-2 words) in each language, lowercase English, never one generic word alone; "kinds" = ["video"] if it is about motion or sound, else ["video","image"]; "body" = 80-130 English words in exactly this shape: "AI MISTAKE: <what generators do wrong>. IN REALITY: <what the eye and ear really get, concrete and physical>. WRITE IT LIKE THIS: <the wording a prompt writer should put into the prompt>." No brands, no real people, no links, nothing about violence, religion, politics, pork or alcohol. Return JSON {"entries":[{"slug":"<the cluster slug>","names":[...],"kinds":[...],"body":"..."}]} with one entry per cluster.`,
      JSON.stringify(g.map((c) => ({ slug: c.slug, domain: c.domain, title: c.title, notes: c.members.map((n) => modes[n]).filter(Boolean).slice(0, 14).map((m) => `${m.mistake} | real: ${m.real}`) }))), 14000)));
    for (const [gi, r] of res.entries()) for (const e of r.entries || []) {
      const c = groups[gi].find((x) => x.slug === e.slug); if (!c) continue;
      const names = [...new Set((e.names || []).map((n) => String(n).trim().toLowerCase()).filter((n) => n.length >= 2 && n.length <= 40))].slice(0, 12);
      const body = String(e.body || "").replace(/\s+/g, " ").trim(); const words = body.split(" ").length;
      const kinds = (e.kinds || []).filter((k) => k === "video" || k === "image");
      if (names.length < 4 || !names.some((n) => /[؀-ۿ]/.test(n)) || !names.some((n) => /^[a-z]/.test(n)) || words < 60 || words > 170 || !/AI MISTAKE:/.test(body) || /https?:/.test(body)) { console.log("rejected", e.slug, words); continue; }
      entries.push({ id: `${c.domain}.fix.${String(c.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 50)}`, domain: c.domain, kinds: kinds.length ? kinds : ["video", "image"], names, priority: 60, body, notes: c.members.length });
    }
    console.log("pass 2:", entries.length, "entries");
  }
  const seen = new Set(); const out = entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
  fs.writeFileSync(`${O}/ai-fixes.json`, JSON.stringify(out, null, 1));
  console.log("DONE", out.length, "entries");
  process.exit(0);
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });
