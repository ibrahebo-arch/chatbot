// The three paid models × three qualities (owner, 2026-11-15).
const test = require("node:test");
const assert = require("node:assert/strict");
const tiers = require("../tiers");

test("three models, each a different AI model, more stars each step", () => {
  assert.deepEqual(tiers.KEYS, ["wi", "king", "vip"]);
  assert.deepEqual(tiers.QUALITIES, [480, 720, 1080]);
  assert.equal(tiers.MODELS.wi.engine, "wan");
  assert.equal(tiers.MODELS.king.engine, "kling");
  assert.equal(tiers.MODELS.vip.engine, "kling");
  assert.equal(tiers.MODELS.vip.check, true, "VIP checks every part");
  assert.deepEqual(tiers.KEYS.map((k) => tiers.MODELS[k].step), [0, 1, 2]);
});

test("labels: the customer sees model and quality, the team also the AI model; old orders show their quality", () => {
  assert.equal(tiers.modelOf("VIP"), "vip");
  assert.equal(tiers.modelOf("nope"), "wi");
  assert.equal(tiers.modelLabel("king"), "KING_IRAQ ★★★★");
  assert.equal(tiers.orderLabel("wi", 1080), "WI_IRAQ ★★★ · 1080p");
  assert.equal(tiers.teamLabel("vip", 720), "VIP_IRAQ ★★★★★ · 720p (Kling 3 + quality check)");
  assert.equal(tiers.teamLabel(undefined, 1080), "1080p", "an order from before the models");
});
