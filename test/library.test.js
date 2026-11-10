// Prompt knowledge library: file validity, core budget, whole-word Arabic matching, database sync.
// The database part needs TEST_DATABASE_URL and runs inside a throw-away schema.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
process.env.OPENAI_API_KEY = "test-key"; // the meaning step is exercised with a stubbed fetch below – nothing is sent
const lib = require("../library");

test("library files: valid JSON, unique ids, names and bodies present", () => {
  const dir = path.join(__dirname, "..", "prompts", "library");
  const seen = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(Array.isArray(list), `${f} is an array`);
    for (const e of list) {
      assert.match(e.id, /^[a-z0-9][a-z0-9._-]{1,80}$/, `${f}: id ${e.id}`);
      assert.ok(!seen.has(e.id), `duplicate id ${e.id}`);
      seen.add(e.id);
      assert.ok(e.body && e.body.length >= 20, `${e.id} has a body`);
      assert.ok(e.always || (e.names || []).length, `${e.id} needs names or always`);
    }
  }
  assert.ok(lib.loadFiles().length >= seen.size, "locations.json entries are included too");
});

test("the core fits its budget and is the same for every request of a kind", () => {
  const v = lib.select("", "video"), i = lib.select("", "image");
  assert.ok(v.core.length >= 5 && i.core.length >= 2);
  assert.ok(v.core.reduce((n, e) => n + e.body.length, 0) <= 9000);
  assert.deepEqual(v.matches, [], "nothing matched for an empty request");
  assert.ok(v.core.every((e) => e.kinds.includes("video")) && i.core.every((e) => e.kinds.includes("image")));
});

test("Arabic matching is whole-word with prefixes and endings", () => {
  const ids = (t, k = "video") => lib.select(t, k).matches.map((e) => e.id);
  assert.ok(ids("لاندكروزر بيضة تمشي بالبر وقت الغروب").includes("item.land-cruiser"));
  assert.ok(ids("عرس عراقي بيه دبكة").includes("action.dabke"));
  assert.ok(ids("بالليل على الشط").includes("reality.night"), "prefix بال");
  assert.ok(!ids("مختبر تحاليل طبية").includes("reality.night"), "«ليل» inside «تحاليل» does not count");
  assert.ok(!ids("طبل وزرنة").includes("sound.phone"), "«رنة» inside «زرنة» does not count");
  assert.ok(ids("a barista making latte in Dubai").includes("item.coffee-machine"));
  assert.ok(ids("two cats playing").includes("animal.cat"), "English plural");
  assert.ok(ids("بنت تلعب ويه قطتها").includes("animal.cat"), "ة becomes ت before an ending");
  assert.ok(!ids("حفلة تخرج بالجامعة").includes("sound.adhan"), "«جامعة» (university) is not «جامع» (mosque)");
  assert.ok(ids("صوت الاذان من الجامع").includes("sound.adhan"));
  assert.ok(ids("سيارات الشرطة وراها").includes("item.gen.police-car"), "plural of the first word of a two-word name");
  assert.ok(ids("سيارات شرطة وراها").includes("action.car-chase"));
  assert.ok(!ids("اريد نفس الشي بس الناس").some((id) => id.startsWith("sound.breath")), "everyday words are ignored");
});

test("the reel lessons reach the requests they belong to, and only those", () => {
  const ids = (t, k = "video") => lib.select(t, k).matches.map((e) => e.id);
  const reel = ids("ريل كوميدي حرامي ملثم يدخل يسرق رزمة فلوس والتلفزيون شغال ويكول لحد يتحرك");
  for (const id of ["style.daylight-phone-on-table", "action.short-clip-one-action", "action.quick-theft-skit", "reality.few-items-in-hands", "reality.tv-screen-in-frame", "human.hands-up-reaction", "sound.spoken-lines-iraqi"]) {
    assert.ok(reel.includes(id), `${id} matches the robbery reel`);
  }
  assert.ok(ids("تهمس بأذنه وتقرص خده").includes("human.whisper-close"));
  assert.ok(ids("صورة من صورتي بالحديقة", "image").includes("human.keep-same-face"));
  const other = ids("مختبر تحاليل طبية في البصرة");
  assert.ok(!["style.daylight-phone-on-table", "action.quick-theft-skit", "reality.few-items-in-hands", "human.whisper-close"].some((id) => other.includes(id)));
});

test("the note lists core and matches and stays a reasonable size", async () => {
  const n = await lib.note([{ role: "user", content: "اعلان لمختبر تحاليل في البصرة" }, { role: "assistant", content: "ليل نهار" }], "video");
  assert.match(n.text, /REALITY LIBRARY/);
  assert.match(n.text, /CORE \(always\)/);
  assert.match(n.text, /MATCHED TO THIS REQUEST/);
  assert.ok(n.ids.includes("action.medical-lab"));
  assert.ok(!n.ids.includes("reality.night"), "only the customer's words are matched, not the assistant's");
  assert.ok(n.text.length < 30000);
  assert.equal(n.by, "names", "without vectors the names alone decide");
});

test("a picture never gets sound entries", () => {
  const t = "سيارة بشارع والمطر ينزل وصوت الرعد";
  assert.ok(lib.select(t, "video").matches.some((e) => e.domain === "sound"));
  assert.ok(!lib.select(t, "image").matches.some((e) => e.domain === "sound"));
});

test("meaning step: candidates by name and by meaning, the model picks, failures fall back to the names", async () => {
  const all = lib.loadFiles().filter((e) => !e.always && e.kinds.includes("video"));
  const lab = all.find((e) => e.id === "action.medical-lab"), far = all.find((e) => e.domain === "animal"), near = all.find((e) => e.domain === "place" && e.id !== lab.id);
  const unit = (i) => { const v = new Float32Array(lib.EMBED_DIM); v[i] = 1; return v; };
  lib._vectors.clear();
  lib._vectors.set(lab.id, { sig: "x", vec: unit(0) }); lib._vectors.set(near.id, { sig: "x", vec: unit(1) }); lib._vectors.set(far.id, { sig: "x", vec: unit(2) });
  const real = global.fetch; let cards = null, mode = "ok";
  global.fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    if (String(url).endsWith("/embeddings")) return { ok: true, json: async () => ({ data: [{ embedding: Array.from(unit(1)) }] }) };
    if (mode === "down") return { ok: false, status: 503, json: async () => ({ error: { message: "overloaded" } }) };
    cards = JSON.parse(body.messages[1].content.split("CARDS:\n")[1]);
    const scores = Object.fromEntries(cards.map((c) => [c.n, c.names.join(" ") === near.names.slice(0, 4).join(" ") ? 1 : c.names.join(" ") === lab.names.slice(0, 4).join(" ") ? 2 : 0]));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scores }) } }] }) };
  };
  try {
    const r = await lib.retrieve("اعلان لمختبر تحاليل", "video");
    assert.equal(r.by, "meaning");
    assert.deepEqual(r.matches.map((e) => e.id), [lab.id], "the entry the model marked 2");
    assert.deepEqual(r.related.map((e) => e.id), [near.id], "the entry the model marked 1 – found by meaning, not by name");
    assert.ok(cards.length >= 3 && cards.every((c) => c.text.length <= 240), "short cards, name matches and nearest entries");
    const n = await lib.note([{ role: "user", content: "اعلان لمختبر تحاليل" }], "video");
    assert.match(n.text, /MATCHED TO THIS REQUEST/); assert.match(n.text, /RELATED TO THIS SCENE/);
    assert.ok(n.ids.includes(lab.id) && n.ids.includes(near.id) && !n.ids.includes(far.id));
    mode = "down";
    const f = await lib.retrieve("اعلان لمختبر تحاليل", "video");
    assert.equal(f.by, "names"); assert.ok(f.matches.some((e) => e.id === lab.id), "name matches survive a failed selector");
  } finally { global.fetch = real; lib._vectors.clear(); }
});

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && "set TEST_DATABASE_URL to run the database tests";
test("sync writes the files into prompt_library and keeps hand-made rows", { skip }, async () => {
  const schema = `vi_test_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: URL_ });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  const db = require("../db");
  try {
    await db.initDb();
    await db.query("INSERT INTO prompt_library (id, domain, names, body, source) VALUES ('item.custom-test', 'item', '{زقنبوت}', 'A hand-made entry that the sync must keep.', 'db')");
    const r = await lib.sync(db);
    assert.ok(r.files > 100);
    const count = Number((await db.query("SELECT count(*) FROM prompt_library")).rows[0].count);
    assert.equal(count, r.files + 1);
    assert.ok(lib.select("ابي زقنبوت", "video").matches.some((e) => e.id === "item.custom-test"), "database rows are used");
    await lib.sync(db);
    assert.equal(Number((await db.query("SELECT count(*) FROM prompt_library")).rows[0].count), count, "sync is idempotent");
  } finally {
    await db.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
