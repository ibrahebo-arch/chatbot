// Prompt knowledge library: file validity, core budget, whole-word Arabic matching, database sync.
// The database part needs TEST_DATABASE_URL and runs inside a throw-away schema.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
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
});

test("the note lists core and matches and stays a reasonable size", () => {
  const n = lib.note([{ role: "user", content: "اعلان لمختبر تحاليل في البصرة" }, { role: "assistant", content: "ليل نهار" }], "video");
  assert.match(n.text, /REALITY LIBRARY/);
  assert.match(n.text, /CORE \(always\)/);
  assert.match(n.text, /MATCHED TO THIS REQUEST/);
  assert.ok(n.ids.includes("action.medical-lab"));
  assert.ok(!n.ids.includes("reality.night"), "only the customer's words are matched, not the assistant's");
  assert.ok(n.text.length < 30000);
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
