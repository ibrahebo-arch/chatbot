// Trained Model: trends parsing, draft validation and duplicate spotting; the database part (record → approve into
// prompt_library → library uses it) needs TEST_DATABASE_URL and runs inside a throw-away schema.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Client } = require("pg");
const trained = require("../trained");
const lib = require("../library");

test("Google Trends RSS: topics, traffic and news titles", () => {
  const xml = `<rss><channel><title>Daily Search Trends</title>
    <item><title>ذكاء اصطناعي</title><ht:approx_traffic>100+</ht:approx_traffic>
      <ht:news_item><ht:news_item_title>AI في المدارس &amp; الجامعات</ht:news_item_title></ht:news_item></item>
    <item><title><![CDATA[Real Madrid]]></title><ht:approx_traffic>2000+</ht:approx_traffic></item>
    <item><title></title></item></channel></rss>`;
  const t = trained.parseTrends(xml);
  assert.equal(t.length, 2, "the channel title and empty items are not trends");
  assert.deepEqual(t[0], { topic: "ذكاء اصطناعي", traffic: "100+", news: ["AI في المدارس & الجامعات"] });
  assert.equal(t[1].topic, "Real Madrid");
});

const good = { slug: "Lamb Grilling!", domain: "item", kinds: ["video"], names: ["تكة", "شوي لحم", "lamb grilling", "kebab grill"],
  body: "Lamb pieces on flat metal skewers over glowing charcoal: fat drips and flares up in short yellow flames, thin blue smoke drifts with the wind, the cook turns the skewers every few seconds and fans the coals with a piece of cardboard." };

test("drafts: valid ones are normalised under trained.<domain>.<slug>", () => {
  const c = trained.validateDraft(good);
  assert.equal(c.ok, true);
  assert.equal(c.entry.id, "trained.item.lamb-grilling");
  assert.deepEqual(c.entry.kinds, ["video"]);
  assert.equal(c.duplicateOf, null);
});

test("drafts: bad ones are refused with a reason", () => {
  const no = (patch, why) => { const c = trained.validateDraft({ ...good, ...patch }); assert.equal(c.ok, false, why); return c.reason; };
  no({ domain: "politics" }, "unknown domain");
  no({ names: ["تكة", "شوي"] }, "too few names");
  no({ names: ["تكة", "شوي لحم", "مشاوي"] }, "no English name");
  no({ names: ["lamb", "grill", "kebab"] }, "no Arabic name");
  no({ body: "too short" }, "short body");
  no({ body: good.body + " See https://example.com for more." }, "links");
  no({ slug: "" }, "no id");
});

test("drafts the library already covers are marked as duplicates", () => {
  const known = trained.knownNames([{ id: "item.coffee-pot", names: ["دلة", "قهوة عربية", "arabic coffee", "dallah"] }]);
  const c = trained.validateDraft({ ...good, names: ["دلة", "قهوة عربية", "arabic coffee", "pouring coffee"] }, known);
  assert.equal(c.ok, true);
  assert.equal(c.duplicateOf, "item.coffee-pot");
  assert.equal(trained.validateDraft(good, known).duplicateOf, null, "different names are new knowledge");
});

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && "set TEST_DATABASE_URL to run the database tests";
test("a reviewed draft goes into prompt_library as source 'trained' and the library uses it", { skip }, async () => {
  const schema = `vi_test_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: URL_ });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  const db = require("../db");
  try {
    await db.initDb();
    await lib.sync(db);
    await db.query("INSERT INTO trained_videos (id, source, title, status, score) VALUES ('commons:1', 'commons', 'test clip', 'studied', 8)");
    const entry = trained.validateDraft(good).entry;
    const ids = (await db.query("INSERT INTO trained_candidates (video_id, entry) VALUES ('commons:1', $1), ('commons:1', $1) RETURNING id", [entry])).rows.map((r) => Number(r.id));
    assert.equal((await trained.pending(db)).length, 2);
    assert.deepEqual(await trained.approve(db, [ids[0]], { reviewer: "test" }), ["trained.item.lamb-grilling"]);
    assert.equal((await trained.reject(db, [ids[1]], { note: "same as the first" })).length, 1);
    const row = (await db.query("SELECT source, enabled FROM prompt_library WHERE id='trained.item.lamb-grilling'")).rows[0];
    assert.deepEqual(row, { source: "trained", enabled: true });
    assert.equal((await trained.pending(db)).length, 0);
    await lib.refresh(true);
    assert.ok(lib.select("ابي فيديو شوي لحم بالحديقة", "video").matches.some((e) => e.id === "trained.item.lamb-grilling"), "the planner gets it");
    await lib.sync(db);
    assert.ok((await db.query("SELECT 1 FROM prompt_library WHERE id='trained.item.lamb-grilling'")).rows.length, "the file sync keeps trained rows");
    const s = await trained.stats(db);
    assert.equal(s.library_trained, 1);
    const html = await trained.report(db, { day: trained.iraqDay() });
    assert.equal((await trained.reportDays(db))[0].added, 1, "today lists one entry added");
    assert.match(html, /Added to the VI-Iraq library[\s\S]*trained\.item\.lamb-grilling/, "the report lists what entered the library");
  } finally {
    await db.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("footage search: only clips whose title fits the search, never violence or adult titles", () => {
  assert.equal(trained.relevant({ title: "Princeton vs yale football game 1903.ogg" }, "football stadium crowd"), true);
  assert.equal(trained.relevant({ title: "Fan Tased at Florida vs Georgia Game.webm" }, "football game crowd"), false, "blocked word");
  assert.equal(trained.relevant({ title: "Pimlico Strollers CC v I Don't Like CC.webm" }, "person talking to camera close up"), false, "no search word in the title");
  assert.equal(trained.relevant({ title: "Woman pouring milk into coffee.webm" }, "pouring milk"), true, "pouring → pour");
  assert.equal(trained.relevant({ title: "Ali Khamenei speech at the Hussainiya of Lovers of Karbala.webm" }, "karbala"), false, "politics is not studied");
  assert.equal(trained.relevant({ title: "F35 Lighting II Aerial Refuel.webm" }, "car refueling station"), false, "military");
  assert.equal(trained.relevant({ title: "Cyberpunk Rainy Street (Hailuo AI).webm" }, "rainy street"), false, "AI-made clips are not reality");
  for (const t of ["Escape the Backrooms OST - Platonic Purgatory.webm", "Fortnite Treasure Hunters | Live Action Trailer", "Granny Game Challenge With Spiderman", "Dune: Part Three | Final Trailer", "Rahma Riad [Official Visualizer]", "لعبة الاختباء في مدينة معلقة", "محل الايفون ضد محل سامسونك في ماين كرافت !", "دخلت القصر السري و سرقت أندر بيضة في التحديث الجديد!", "[FIL] GamerLegion vs Legion (BO3)"])
    assert.ok(trained.NOT_REAL.test(t), `not real: ${t}`);
  for (const t of ["Afgan Bread Production.webm", "New Year's Eve in Najaf, Al Rawan St .webm", "A man pours Arabic coffee.ogv", "Revitalizing Commerce in Mosul"])
    assert.ok(!trained.NOT_REAL.test(t), `real: ${t}`);
});

test("sound study: layers, voices with emotion and a tone line, nothing invented", () => {
  const s = trained.parseSound({ has_sound: true, music: 0, layers: ["wind gusting in waves", ""], voices: [{ language: "iraqi arabic", emotion: "ANGRY", delivery: "fast, loud, rising pitch", tts_tone: "shout like a fed-up Baghdadi uncle" }, { language: "", emotion: "", delivery: "" }], lesson: "anger rises in bursts" });
  assert.deepEqual(s.layers, ["wind gusting in waves"]);
  assert.equal(s.music, false);
  assert.equal(s.voices.length, 1, "empty voices are dropped");
  assert.equal(s.voices[0].emotion, "angry");
  assert.equal(trained.parseSound(null), null);
});

test("report days are Iraqi days (UTC+3, no daylight saving)", () => {
  const r = trained.dayRange("2026-10-29");
  assert.equal(r.since.toISOString(), "2026-10-28T21:00:00.000Z");
  assert.equal(r.until.toISOString(), "2026-10-29T21:00:00.000Z");
  assert.equal(trained.iraqDay(new Date("2026-10-28T21:30:00Z")), "2026-10-29", "00:30 in Baghdad is already the next day");
  assert.throws(() => trained.dayRange("29/10/2026"));
});
