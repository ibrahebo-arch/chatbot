const test = require("node:test");
const assert = require("node:assert/strict");

// both providers "configured" so the whole catalog is available (no request is sent in these tests)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.FAL_KEY = process.env.FAL_KEY || "test-key";
const voices = require("../voices");
const planner = require("../planner");
const wm = require("../watermark");

test("catalog: unique ids, a default for every gender × age, defaults match their type", () => {
  const ids = voices.CATALOG.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const g of voices.GENDERS) for (const a of voices.AGES) {
    const d = voices.byId(voices.DEFAULTS[`${g}.${a}`]);
    assert.ok(d, `default for ${g}.${a}`);
    assert.equal(d.gender, g); assert.equal(d.age, a);
  }
  const pub = voices.publicCatalog();
  assert.equal(pub.types.length, 8);
  assert.ok(pub.voices.every((v) => !("provider" in v) && !("voice" in v)), "no provider names reach the page");
});

test("pick: explicit preset, then gender+age default, then a sensible fallback", () => {
  assert.equal(voices.pick({ preset: "young-woman-warm" }).id, "young-woman-warm");
  assert.equal(voices.pick({ gender: "female", age: "child" }).id, voices.DEFAULTS["female.child"]);
  assert.equal(voices.pick({ preset: "nope", gender: "male", age: "old" }).id, voices.DEFAULTS["male.old"]);
  assert.equal(voices.pick({}).id, voices.DEFAULTS["male.adult"]);
});

test("typeFromSpeech: old plans (voice male|female|child) and new ones (gender, age)", () => {
  assert.deepEqual(voices.typeFromSpeech({ voice: "female" }), { gender: "female", age: "adult" });
  assert.deepEqual(voices.typeFromSpeech({ voice: "child" }).age, "child");
  assert.deepEqual(voices.typeFromSpeech({ voice: "male", gender: "female", age: "young" }), { gender: "female", age: "young" });
});

test("fitPlan: a voice is fitted to the video – slightly faster, else cut; the customer's own voice is only cut", () => {
  assert.deepEqual(voices.fitPlan(6, 10), { tempo: 1, cut: false, pad: false });
  assert.deepEqual(voices.fitPlan(11, 10), { tempo: 1.1, cut: false, pad: false });
  assert.deepEqual(voices.fitPlan(14, 10), { tempo: 1.15, cut: true, pad: false });
  assert.deepEqual(voices.fitPlan(11, 10, false), { tempo: 1, cut: true, pad: false });
  assert.equal(voices.fitPlan(1.5, 10).pad, true, "under 2 s is padded for the video model");
});

test("judge: the recording check names what is wrong, in Arabic", () => {
  const good = voices.judge({ duration: 6, maxDb: -3, meanDb: -20, speechShare: 0.8 }, { text: "هلا بيكم شلونكم" }, { clarity: "good", background_noise: "low", dialect: "iraqi" }, 10);
  assert.equal(good.ok, true);
  assert.ok(good.items.some((i) => /عراقية/.test(i.text)));
  assert.equal(voices.judge({ duration: 0.8, maxDb: -3, speechShare: 1 }, { text: "هلا" }, null, 10).ok, false, "too short");
  assert.equal(voices.judge({ duration: 5, maxDb: -30, speechShare: 1 }, { text: "هلا" }, null, 10).ok, false, "too quiet");
  assert.equal(voices.judge({ duration: 5, maxDb: -3, speechShare: 1 }, { text: "" }, null, 10).ok, false, "no words heard");
  const long = voices.judge({ duration: 14, maxDb: -3, speechShare: 0.9 }, { text: "كلام" }, { background_noise: "high", music: true, several_speakers: true }, 10);
  assert.equal(long.ok, true, "warnings do not block");
  assert.equal(long.items.filter((i) => i.level === "warn").length, 4);
});

test("speakerOf: the audio model's answer becomes a character type", () => {
  assert.deepEqual(voices.speakerOf({ gender: "female", age_group: "child", age_estimate: 9.4 }), { gender: "female", age: "child", ageEstimate: 9 });
  assert.deepEqual(voices.speakerOf({ gender: "robot", age_group: "?" }), { gender: null, age: null, ageEstimate: null });
  assert.deepEqual(voices.speakerOf(null), { gender: null, age: null, ageEstimate: null });
});

test("planner.applyVoice: the customer's voice choice always wins", () => {
  const base = () => ({ prompt: "x".repeat(20), speech: { lang: "ar-IQ", text: "كلام من الخطة", voice: "male", tone: "" } });
  const own = planner.applyVoice(base(), { kind: "video", voiceLang: "ar-IQ", voice: { mode: "own", gender: "female", age: "child", fixedText: "آني بنت عراقية" } });
  assert.equal(own.speech.text, "آني بنت عراقية");
  assert.equal(own.speech.gender, "female"); assert.equal(own.speech.age, "child");
  assert.equal(planner.applyVoice(base(), { kind: "video", voiceLang: "ar-IQ", voice: { mode: "none" } }).speech, null);
  assert.equal(planner.applyVoice(base(), { kind: "image", voiceLang: "ar-IQ" }).speech, null);
  const fromNothing = planner.applyVoice({ prompt: "y".repeat(20), speech: null }, { kind: "video", voiceLang: "ar-IQ", voice: { mode: "convert", fixedText: "هلا" } });
  assert.equal(fromNothing.speech.text, "هلا", "fixed words appear even when the model wrote no speech");
  assert.match(planner.voiceNote({ mode: "own", gender: "male", age: "old", fixedText: "هلا", audioSeconds: 4 }), /elderly.*FIXED.*4\.0 s/s);
});

test("toMp3 + fit: a 13-second recording becomes a 10-second soundtrack", { skip: !wm.ready && "ffmpeg not available" }, async () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(wm.FFMPEG, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=13", "-ac", "1", "-c:a", "libmp3lame", "-f", "mp3", "-"], { maxBuffer: 20 * 1048576 });
  assert.equal(r.status, 0);
  const { mp3, duration } = await voices.toMp3(r.stdout);
  assert.ok(Math.abs(duration - 13) < 0.3, `converted duration ${duration}`);
  const own = await voices.fit(mp3, 10, false);
  assert.equal(own.cut, true);
  const m = await voices.measure(own.mp3);
  assert.ok(m.duration <= 10.3 && m.duration >= 9.5, `fitted duration ${m.duration}`);
  assert.ok(m.maxDb > -20, "audible");
});
