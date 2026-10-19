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
 * Source of truth: prompts/library/*.json (+ prompts/locations.json), synced into the prompt_library table at start
 * (source='file'). Rows added by hand in the database (source='db' or 'generated') are kept and used too.
 * Without a database the files are used directly.
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "prompts", "library");
const CORE_CHARS = Number(process.env.LIBRARY_CORE_CHARS) || 9000;
const MATCH_CHARS = Number(process.env.LIBRARY_MATCH_CHARS) || 14000;
const MAX_MATCHES = Number(process.env.LIBRARY_MAX_MATCHES) || 16;
const REFRESH_MS = 5 * 60 * 1000;

const KINDS = ["video", "image"];
const clean = (v) => String(v || "").trim();
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

/** Reloads the enabled entries from the database (at most every 5 minutes unless forced). */
async function refresh(force = false) {
  if (!dbRef?.configured || (!force && Date.now() - loadedAt < REFRESH_MS)) return;
  try {
    const r = await dbRef.query("SELECT id, domain, names, kinds, always, priority, body, source FROM prompt_library WHERE enabled");
    if (r.rows.length) entries = r.rows.map((x) => normalise(x, x.source));
    loadedAt = Date.now();
  } catch (e) { console.error("library refresh:", e.message); loadedAt = Date.now(); }
}

/** How strongly an entry matches the text: length of its longest name found (0 = no match). */
// Everyday words that are also some entry's name: they would trigger it in unrelated requests, so they never count.
const IGNORE = new Set(["نفس", "ناس", "ظهر", "عصر", "حر", "مي", "شعر", "وجه", "كتب", "حب", "يد", "ايد", "عين", "بر", "سما", "صني",
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
function nameRe(k) {
  let re = reCache.get(k);
  if (!re) {
    re = /^[a-z0-9 .'&-]+$/.test(k)
      ? new RegExp("(^|[^a-z0-9])" + esc(k) + "(s|es)?([^a-z0-9]|$)")
      // a final ة (normalised to ه) turns into ت before an ending: قطة → قطتها، سيارة → سيارتي
      : new RegExp("(^|\\s)" + AR_PRE + "(?:" + esc(k) + AR_SUF + (k.endsWith("ه") ? "|" + esc(k.slice(0, -1)) + "ت(?:ها|ه|هم|ي|ك|كم|نا|ين|ان)" : "") + ")(\\s|$)");
    reCache.set(k, re);
  }
  return re;
}
/** Text prepared for matching: normalised, punctuation turned into spaces, padded with spaces. */
const prep = (text) => " " + norm(text).replace(/[^\p{L}\p{N}'&-]+/gu, " ").replace(/\s+/g, " ") + " ";

/** Picks the core and the matching entries for one request (pure – tested). */
function select(text, kind, list = entries, budget = {}) {
  const t = prep(text);
  const core = [], matches = [];
  let used = 0;
  for (const e of list.filter((x) => x.enabled !== false && x.always && x.kinds.includes(kind)).sort((a, b) => b.priority - a.priority)) {
    if (used + e.body.length > (budget.core || CORE_CHARS)) continue;
    core.push(e); used += e.body.length;
  }
  const found = list.filter((x) => x.enabled !== false && !x.always && x.kinds.includes(kind))
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

/** The text block the planner adds to its request. */
function note(conversation, kind) {
  refresh().catch(() => {});
  const own = (conversation || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const { core, matches } = select(own, kind);
  if (!core.length && !matches.length) return { text: "", ids: [] };
  let s = "\n\nREALITY LIBRARY – binding knowledge for this request. Use every point that fits the scene; write it into the prompt as concrete visible (and, for video, audible) details, never as a list of rules.";
  if (core.length) s += "\n\nCORE (always):\n" + core.map((e) => `- ${e.body}`).join("\n");
  if (matches.length) {
    s += "\n\nMATCHED TO THIS REQUEST (the customer named these – show them exactly like this):";
    const byDomain = {};
    for (const e of matches) (byDomain[e.domain] ||= []).push(e);
    for (const [d, list] of Object.entries(byDomain)) s += `\n[${TITLES[d] || d}]\n` + list.map((e) => `- ${e.body}`).join("\n");
  }
  const ids = [...core, ...matches].map((e) => e.id);
  if (dbRef?.configured && matches.length) dbRef.query("UPDATE prompt_library SET uses = uses + 1 WHERE id = ANY($1)", [matches.map((e) => e.id)]).catch(() => {});
  return { text: s, ids };
}

function stats() {
  const byDomain = {};
  let words = 0;
  for (const e of entries) { byDomain[e.domain] = (byDomain[e.domain] || 0) + 1; words += e.body.split(/\s+/).length; }
  return { entries: entries.length, words, byDomain };
}

module.exports = { loadFiles, sync, refresh, select, note, matchScore, stats, norm, prep };
