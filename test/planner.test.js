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

test("without an OpenAI key the customer's own words become the prompt", async () => {
  const { plan, by } = await planner.plan([{ role: "user", content: "اعلان لمطعم" }], { kind: "video", style: "realistic", seconds: 10, voiceLang: "ar-IQ" });
  assert.equal(by, "customer");
  assert.equal(plan.prompt, "اعلان لمطعم");
  assert.equal(plan.speech, null);
});
