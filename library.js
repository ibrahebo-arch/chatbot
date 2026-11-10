/**
 * VI Iraq – prompt knowledge library.
 *
 * A large library of reality knowledge (human presence, physics, sounds, voices, places of the world, items, actions,
 * nature) that the planner draws on. Sending all of it with every request would be slow, expensive and badly
 * followed, so each request gets:
 *   - the CORE: entries marked "always" for that kind (video / image), and
 *   - the MATCHES: entries whose names (Arabic or English) appear in what the customer wrote,
 * within a fixed character budget, most specific and highest priority first.
 *
 * Names alone miss a lot (measured 2026-11: they found 57 % of the entries that belong to a scene and none of the
 * learned ones, whose names are long phrases) and sometimes fire wrongly («حية» inside «لحية»). So with an OpenAI
 * key a request is answered in two steps (retrieve): the candidates – name matches plus the entries closest in
 * MEANING (embeddings kept in prompt_library.embedding) – are shown as short cards to the prompt model, which marks
 * the ones that are clearly part of the scene (MATCHED) or very likely part of it (RELATED). Any failure falls back
 * to the names alone. LIBRARY_SEMANTIC=0 switches the second step off.
 *
 * Source of truth: prompts/library/*.json (+ prompts/locations.json), synced into the prompt_library table at start
 * (source='file'). Rows added by hand in the database (source='db' or 'generated') are kept and used too.
 * Without a database the files are used directly.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, "prompts", "library");
const CORE_CHARS = Number(process.env.LIBRARY_CORE_CHARS) || 9000;
const MATCH_CHARS = Number(process.env.LIBRARY_MATCH_CHARS) || 14000;
const MAX_MATCHES = Number(process.env.LIBRARY_MAX_MATCHES) || 16;
const REFRESH_MS = 5 * 60 * 1000;

const KINDS = ["video", "image"];
const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const EMBED_MODEL = clean(process.env.LIBRARY_EMBED_MODEL) || "text-embedding-3-large";
const EMBED_DIM = Number(process.env.LIBRARY_EMBED_DIM) || 1024;
const NAME_CANDIDATES = 20, MEANING_CANDIDATES = Number(process.env.LIBRARY_MEANING_CANDIDATES) || 24, MAX_RELATED = Number(process.env.LIBRARY_MAX_RELATED) || 6;
const selectModel = () => clean(process.env.LIBRARY_SELECT_MODEL) || clean(process.env.PROMPT_MODEL) || clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const semanticOn = () => clean(process.env.LIBRARY_SEMANTIC) !== "0" && Boolean(OPENAI_KEY);
/** Arabic normalisation: no diacritics/tatweel, one alef, ya and ta marbuta folded (same as the location matcher). */
const norm = (s) => String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

function validEntry(e) {
  return e && /^[a-z0-9][a-z0-9._-]{1,80}$/.test(e.id) && clean(e.domain) && clean(e.body).length >= 20;
}
function normalise(e, source) {
  return {
    id: e.id, domain: clean(e.domain), names: (e.names || []).map(clean).filter(Boolean),
    kinds: (e.kinds || KINDS).filter((k) => KINDS.includes(k)), always: Boolean(e.always),
    priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 50, body: clean(e.body), source, enabled: e.enabled !== false,
  };
}

/** Every entry from prompts/library/*.json and the older prompts/locations.json. Duplicated ids: the first file wins. */
function loadFiles() {
  const out = new Map();
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];
  for (const f of files) {
    let list; try { list = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { console.error(`library ${f}:`, e.message); continue; }
    for (const e of Array.isArray(list) ? list : []) if (validEntry(e) && !out.has(e.id)) out.set(e.id, normalise(e, "file"));
  }
  try {
    for (const l of JSON.parse(fs.readFileSync(path.join(__dirname, "prompts", "locations.json"), "utf8"))) {
      const id = `place.iq.${l.id}`;
      if (!out.has(id) && l.look) out.set(id, normalise({ id, domain: "place", names: l.names, body: l.look, priority: 60 }, "file"));
    }
  } catch {}
  return [...out.values()];
}

let entries = loadFiles();
let loadedAt = 0;
let dbRef = null;

/** Writes the file entries into the database and removes file rows that no longer exist. Hand-made rows stay. */
async function sync(db) {
  dbRef = db;
  const list = loadFiles();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of list) {
      await client.query(
        `INSERT INTO prompt_library (id, domain, names, kinds, always, priority, body, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'file',now())
         ON CONFLICT (id) DO UPDATE SET domain=$2, names=$3, kinds=$4, always=$5, priority=$6, body=$7, updated_at=now()
         WHERE prompt_library.source = 'file'`,
        [e.id, e.domain, e.names, e.kinds, e.always, e.priority, e.body]);
    }
    const gone = await client.query("DELETE FROM prompt_library WHERE source = 'file' AND NOT (id = ANY($1)) RETURNING id", [list.map((e) => e.id)]);
    await client.query("COMMIT");
    await refresh(true);
    return { files: list.length, removed: gone.rowCount, total: entries.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/** Read-only start for tools: uses the entries and vectors of this database without writing the files into it. */
async function attach(db) { dbRef = db; await refresh(true); return entries.length; }

/** Reloads the enabled entries from the database (at most every 5 minutes unless forced). */
async function refresh(force = false) {
  if (!dbRef?.configured || (!force && Date.now() - loadedAt < REFRESH_MS)) return;
  try {
    const r = await dbRef.query("SELECT id, domain, names, kinds, always, priority, body, source FROM prompt_library WHERE enabled");
    if (r.rows.length) entries = r.rows.map((x) => normalise(x, x.source));
    loadedAt = Date.now();
    await loadVectors();
  } catch (e) { console.error("library refresh:", e.message); loadedAt = Date.now(); }
}

// ---- meaning vectors: one embedding per entry (names + body), kept in the database and in memory ----------------
const vectors = new Map(); // id → { sig, vec: Float32Array }
const embedText = (e) => `${(e.names || []).join(" · ")}\n${e.body}`.slice(0, 1500);
const sigOf = (e) => crypto.createHash("sha1").update(`${EMBED_MODEL}:${EMBED_DIM}:${embedText(e)}`).digest("hex").slice(0, 16);

async function openai(pathname, body, ms) {
  const r = await fetch(`${OPENAI_BASE}/v1/${pathname}`, { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathname} ${r.status} ${String(j.error?.message || "").slice(0, 160)}`);
  return j;
}
const embed = async (inputs, ms = 60000) => (await openai("embeddings", { model: EMBED_MODEL, input: inputs, dimensions: EMBED_DIM }, ms)).data.map((d) => d.embedding);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Loads the vectors that are new or changed in the database (only those – the rest stay in memory). */
async function loadVectors() {
  if (!dbRef?.configured || !semanticOn()) return;
  const sigs = (await dbRef.query("SELECT id, embed_sig FROM prompt_library WHERE enabled AND NOT always AND embedding IS NOT NULL")).rows;
  const live = new Set(sigs.map((r) => r.id));
  for (const id of vectors.keys()) if (!live.has(id)) vectors.delete(id);
  const todo = sigs.filter((r) => vectors.get(r.id)?.sig !== r.embed_sig).map((r) => r.id);
  for (let i = 0; i < todo.length; i += 500) {
    const rows = (await dbRef.query("SELECT id, embedding, embed_sig FROM prompt_library WHERE id = ANY($1)", [todo.slice(i, i + 500)])).rows;
    for (const r of rows) if (Array.isArray(r.embedding) && r.embedding.length === EMBED_DIM) vectors.set(r.id, { sig: r.embed_sig, vec: Float32Array.from(r.embedding) });
  }
}

/** Makes the vectors that are missing or whose entry text changed (at start and after new entries are learned). */
async function embedMissing(db = dbRef) {
  if (!db?.configured || !semanticOn()) return 0;
  const rows = (await db.query("SELECT id, names, body, embed_sig FROM prompt_library WHERE enabled AND NOT always")).rows;
  const todo = rows.filter((e) => e.embed_sig !== sigOf(e));
  for (let i = 0; i < todo.length; i += 100) {
    const part = todo.slice(i, i + 100);
    const vecs = await embed(part.map(embedText));
    for (const [k, e] of part.entries()) await db.query("UPDATE prompt_library SET embedding=$2, embed_sig=$3 WHERE id=$1", [e.id, vecs[k], sigOf(e)]);
  }
  if (todo.length && db === dbRef) await loadVectors();
  return todo.length;
}

/** How strongly an entry matches the text: length of its longest name found (0 = no match). */
// Everyday words that are also some entry's name: they would trigger it in unrelated requests, so they never count.
const IGNORE = new Set(["نفس", "ناس", "سحاب", "ظهر", "عصر", "حر", "مي", "شعر", "وجه", "كتب", "حب", "يد", "ايد", "عين", "بر", "سما", "صني",
  "box", "hot", "orange", "png", "drc", "fsm", "ad", "pc", "tap", "run", "eat", "sun", "sky", "kid", "boy", "wow", "sad", "cry", "buy", "pen", "bed"].map(norm));

function matchScore(e, t) {
  let best = 0;
  for (const n of e.names) {
    const k = norm(n).trim();
    if (k.length < 2 || IGNORE.has(k)) continue;
    if (nameRe(k).test(t) && k.length > best) best = k.length;
  }
  return best;
}

const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Arabic names match whole words, allowing the usual attached prefixes (و ف ب ل ك + ال/لل) and endings (pronouns,
// plurals, nisba), so «تحاليل» does not trigger «ليل» and «زرنة» does not trigger «رنة».
const AR_PRE = "(?:[وفبلك])?(?:ال|لل)?";
const AR_SUF = "(?:ها|هم|هن|ات|ين|ون|ان|ي|يه|يات|ك|كم|نا|ته|تها|تي)?";
const reCache = new Map();
// one Arabic word with its prefixes and endings; a final ة (normalised to ه) turns into ت before an ending or
// into ات in the plural: قطة → قطتها، سيارة → سيارتي / سيارات
const arWord = (w) => AR_PRE + "(?:" + esc(w) + AR_SUF + (w.endsWith("ه") ? "|" + esc(w.slice(0, -1)) + "(?:ات|ت(?:ها|ه|هم|ي|ك|كم|نا|ين|ان))" : "") + ")";
function nameRe(k) {
  let re = reCache.get(k);
  if (!re) {
    re = /^[a-z0-9 .'&-]+$/.test(k)
      ? new RegExp("(^|[^a-z0-9])" + esc(k) + "(s|es)?([^a-z0-9]|$)")
      // every word of a multi-word name may carry its own prefix/ending: «سيارة شرطة» matches «سيارات الشرطة»
      : new RegExp("(^|\\s)" + k.split(" ").map(arWord).join("\\s") + "(\\s|$)");
    reCache.set(k, re);
  }
  return re;
}
/** Text prepared for matching: normalised, punctuation turned into spaces, padded with spaces. */
const prep = (text) => " " + norm(text).replace(/[^\p{L}\p{N}'&-]+/gu, " ").replace(/\s+/g, " ") + " ";

// what a request of this kind may get besides the core: a picture has no soundtrack, so it never gets sound entries
const usable = (e, kind) => e.enabled !== false && !e.always && e.kinds.includes(kind) && !(kind === "image" && e.domain === "sound");

/** Picks the core and the entries whose names appear in the request (pure – tested). */
function select(text, kind, list = entries, budget = {}) {
  const t = prep(text);
  const core = [], matches = [];
  let used = 0;
  for (const e of list.filter((x) => x.enabled !== false && x.always && x.kinds.includes(kind)).sort((a, b) => b.priority - a.priority)) {
    if (used + e.body.length > (budget.core || CORE_CHARS)) continue;
    core.push(e); used += e.body.length;
  }
  const found = list.filter((x) => usable(x, kind))
    .map((e) => ({ e, s: matchScore(e, t) })).filter((x) => x.s > 0)
    .sort((a, b) => b.e.priority - a.e.priority || b.s - a.s);
  used = 0;
  for (const { e } of found) {
    if (matches.length >= (budget.max || MAX_MATCHES) || used + e.body.length > (budget.match || MATCH_CHARS)) continue;
    matches.push(e); used += e.body.length;
  }
  return { core, matches };
}

const TITLES = { reality: "Reality & physics", human: "Human presence", sound: "Sound & voices", place: "Places", item: "Items & objects", action: "Actions & activities", nature: "Nature & weather", animal: "Animals", style: "Look & camera" };

/** Fills the budget in the given order (pure). */
function fit(list, max, chars, used = { n: 0, c: 0 }) {
  const out = [];
  for (const e of list) {
    if (used.n >= max || used.c + e.body.length > chars) continue;
    out.push(e); used.n++; used.c += e.body.length;
  }
  return out;
}

/** The prompt model reads short cards of the candidates and marks which belong to the scene: 2, 1 or 0 per card. */
async function choose(text, kind, cands) {
  const model = selectModel();
  const body = { model, response_format: { type: "json_object" }, messages: [
    { role: "system", content: `You pick knowledge for an AI ${kind} studio. A customer request and numbered knowledge cards are given. For each card decide whether its knowledge would make THIS request's ${kind} more real and correct. 2 = the thing, place, action${kind === "video" ? ", sound" : ""} or look it describes is clearly part of this scene. 1 = not named, but very likely part of this scene or directly useful for it. 0 = not part of this scene, or it would pull the scene in a wrong direction. Be strict: a similar topic is not enough, and a card that only shares a word with the request is 0. Return JSON only: {"scores":{"<n>":0|1|2}} with every card number.` },
    { role: "user", content: `REQUEST (${kind}): ${text.slice(-1800)}\n\nCARDS:\n${JSON.stringify(cands.map((e, i) => ({ n: i + 1, names: e.names.slice(0, 4), text: e.body.slice(0, 240) })))}` }] };
  if (/^(gpt-[5-9]|o\d)/.test(model)) { body.max_completion_tokens = 2500; body.reasoning_effort = "low"; } else { body.max_tokens = 700; body.temperature = 0; }
  const j = await openai("chat/completions", body, Number(process.env.LIBRARY_SELECT_TIMEOUT_MS) || 20000);
  const scores = JSON.parse(j.choices?.[0]?.message?.content || "{}").scores || {};
  return cands.map((_, i) => Number(scores[i + 1]));
}

/**
 * The entries for one request: the core, the entries that are part of the scene (matches) and the ones very likely
 * part of it (related). Candidates = name matches + the closest in meaning; the prompt model picks. Without a key,
 * without vectors or on any failure: the name matches alone, exactly as select() gives them.
 */
async function retrieve(text, kind, budget = {}) {
  const base = select(text, kind, entries, budget);
  if (!semanticOn() || !vectors.size || clean(text).length < 3) return { ...base, related: [], by: "names" };
  try {
    const t = prep(text);
    const pool = entries.filter((e) => usable(e, kind));
    const named = pool.map((e) => ({ e, s: matchScore(e, t) })).filter((x) => x.s > 0).sort((a, b) => b.e.priority - a.e.priority || b.s - a.s).slice(0, NAME_CANDIDATES).map((x) => x.e);
    const q = (await embed([text.slice(-2000)], Number(process.env.LIBRARY_EMBED_TIMEOUT_MS) || 8000))[0];
    const seen = new Set(named.map((e) => e.id));
    const near = pool.filter((e) => !seen.has(e.id) && vectors.has(e.id)).map((e) => ({ e, s: dot(q, vectors.get(e.id).vec) })).sort((a, b) => b.s - a.s).slice(0, MEANING_CANDIDATES).map((x) => x.e);
    const cands = [...named, ...near];
    if (!cands.length) return { ...base, related: [], by: "names" };
    const scores = await choose(text, kind, cands);
    if (!scores.some((s) => s === 0 || s === 1 || s === 2)) throw new Error("the selector returned no scores");
    const used = { n: 0, c: 0 }, max = budget.max || MAX_MATCHES, chars = budget.match || MATCH_CHARS;
    const matches = fit(cands.filter((_, i) => scores[i] === 2), max, chars, used);
    const related = fit(cands.filter((_, i) => scores[i] === 1).slice(0, MAX_RELATED), max, chars, used);
    return { core: base.core, matches, related, by: "meaning" };
  } catch (e) {
    console.error("library retrieve (names only):", String(e.message).slice(0, 200));
    return { ...base, related: [], by: "names" };
  }
}

/** The text block the planner adds to its request. */
async function note(conversation, kind) {
  refresh().catch(() => {});
  const own = (conversation || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const { core, matches, related, by } = await retrieve(own, kind);
  if (!core.length && !matches.length && !related.length) return { text: "", ids: [], by };
  const grouped = (list) => {
    const byDomain = {};
    for (const e of list) (byDomain[e.domain] ||= []).push(e);
    return Object.entries(byDomain).map(([d, l]) => `\n[${TITLES[d] || d}]\n` + l.map((e) => `- ${e.body}`).join("\n")).join("");
  };
  let s = "\n\nREALITY LIBRARY – binding knowledge for this request. Use every point that fits the scene; write it into the prompt as concrete visible (and, for video, audible) details, never as a list of rules.";
  if (core.length) s += "\n\nCORE (always):\n" + core.map((e) => `- ${e.body}`).join("\n");
  if (matches.length) s += "\n\nMATCHED TO THIS REQUEST (these are part of the scene – show them exactly like this):" + grouped(matches);
  if (related.length) s += "\n\nRELATED TO THIS SCENE (the customer did not name these – use only the points that fit what is on screen):" + grouped(related);
  const picked = [...matches, ...related];
  const ids = [...core, ...picked].map((e) => e.id);
  if (dbRef?.configured && picked.length) dbRef.query("UPDATE prompt_library SET uses = uses + 1 WHERE id = ANY($1)", [picked.map((e) => e.id)]).catch(() => {});
  return { text: s, ids, by };
}

function stats() {
  const byDomain = {};
  let words = 0;
  for (const e of entries) { byDomain[e.domain] = (byDomain[e.domain] || 0) + 1; words += e.body.split(/\s+/).length; }
  return { entries: entries.length, words, byDomain };
}

module.exports = { loadFiles, sync, attach, refresh, select, retrieve, note, matchScore, stats, norm, prep, embed, embedMissing, embedText, semanticOn, dot, EMBED_DIM, _vectors: vectors };
