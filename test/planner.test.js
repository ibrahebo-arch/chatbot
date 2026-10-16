// planner.js parsing – no network.
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.OPENAI_API_KEY = "";
const planner = require("../planner");

test("parsePlan: accepts JSON (also inside code fences), normalises speech and on-screen text", () => {
  const p = planner.parsePlan('```json\n{"prompt":"A man in a dishdasha walks along the Tigris at sunset, slow push-in","negative":"blurry","speech":{"lang":"ar-IQ","text":"هلا بيكم","voice":"male","tone":"warm"},"onScreenText":null,"shots":["walks","waves"]}\n```');
  assert.equal(p.speech.lang, "ar-IQ");
  assert.equal(p.speech.text, "هلا بيكم");
  assert.equal(p.onScreenText, null);
  assert.deepEqual(p.shots, ["walks", "waves"]);
  const q = planner.parsePlan('{"prompt":"x","speech":{"lang":"klingon","text":"hi","voice":"robot"}}');
  assert.equal(q, null, "a prompt shorter than 10 characters is rejected");
  const r = planner.parsePlan('{"prompt":"A long enough prompt here","speech":{"lang":"klingon","text":"hi","voice":"robot"}}');
  assert.equal(r.speech.lang, "ar-IQ", "unknown language falls back to Iraqi");
  assert.equal(r.speech.voice, "male");
  assert.match(r.negative, /deformed hands/);
});

test("the customer's pictures are attached to the planner request with their roles", () => {
  const refs = [{ role: "char1", buf: Buffer.from("a") }, { role: "ref", buf: Buffer.from("b") }];
  assert.equal(planner.userContent("hello"), "hello", "no pictures → plain text");
  const parts = planner.userContent("hello", refs);
  assert.equal(parts[0].type, "text");
  assert.equal(parts.filter((p) => p.type === "image_url").length, 2);
  assert.ok(parts[1].image_url.url.startsWith("data:image/jpeg;base64,"));
  const video = planner.task({ kind: "video", style: "realistic", seconds: 10, voiceLang: "ar-IQ", refs });
  assert.match(video, /Picture 1 = Character 1/);
  assert.match(video, /Picture 2 = a reference for style/);
  assert.match(video, /FIRST FRAME/, "a video starts from the photo");
  const image = planner.task({ kind: "image", style: "cartoon", seconds: 10, voiceLang: "ar-IQ", refs });
  assert.match(image, /edit that puts the people/);
  assert.doesNotMatch(planner.task({ kind: "video", style: "realistic", seconds: 10, voiceLang: "ar-IQ" }), /CUSTOMER PICTURES/);
});

test("without an OpenAI key the customer's own words become the prompt", async () => {
  const { plan, by } = await planner.plan([{ role: "user", content: "اعلان لمطعم" }], { kind: "video", style: "realistic", seconds: 10, voiceLang: "ar-IQ" });
  assert.equal(by, "customer");
  assert.equal(plan.prompt, "اعلان لمطعم");
  assert.equal(plan.speech, null);
});

test("places the customer names bring their real look into the request", () => {
  const ids = (t) => planner.locationsIn(t).map((l) => l.id);
  assert.ok(ids("فيديو لشخص يمشي في الكرادة قرب نهر دجلة").includes("karrada"));
  assert.ok(ids("a man in Erbil near the citadel").includes("erbil"));
  assert.deepEqual(ids("your car is red"), [], "a latin alias only matches as a whole word");
  const note = planner.locationNote([{ role: "user", content: "اعلان في شارع المتنبي" }]);
  assert.match(note, /LOCATION REFERENCE/);
  assert.match(note, /bookshops/);
  assert.equal(planner.locationNote([{ role: "user", content: "hello" }]), "");
});
