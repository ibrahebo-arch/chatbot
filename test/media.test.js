// Free-trial video model (Wan 3.0 since 2026-11-15) – pure parts, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const media = require("../media");

test("free videos are made by Wan 3.0; MiniMax only follows a customer's own recording", () => {
  assert.equal(media.MODELS.video, "alibaba/wan-3.0/text-to-video");
  assert.equal(media.MODELS.i2v, "alibaba/wan-3.0/image-to-video");
  assert.match(media.MODELS.lipsync, /minimax/);
  assert.equal(media.videoCost(true), media.COST.lipsync, "a recording → MiniMax price");
  assert.equal(media.videoCost(false, true), media.COST.video, "a spoken line → Wan price");
  assert.ok(media.COST.video >= media.COST.lipsync);
});

test("spokenLine: who speaks, the Iraqi accent, the exact words once", () => {
  const p = media.spokenLine({ text: "احچي على كيفك لأن ما جاي أسمعك", lang: "ar-IQ", gender: "female", age: "young", tone: "soft" });
  assert.match(p, /^A young Iraqi woman speaks/);
  assert.match(p, /Iraqi Arabic \(Baghdadi accent\)/);
  assert.ok(p.includes('"احچي على كيفك لأن ما جاي أسمعك"'));
  assert.match(p, /exactly once/);
  assert.match(p, /Tone: soft\./);
  assert.equal(media.spokenLine({ text: "  " }), "", "no words, no line");
});
