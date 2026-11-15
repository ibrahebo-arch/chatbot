// The three paid models shown to customers (owner, 2026-11-15).
const test = require("node:test");
const assert = require("node:assert/strict");
const tiers = require("../tiers");

test("each quality has its model name and stars; the team also sees the resolution", () => {
  assert.equal(tiers.tierLabel(480), "WI_IRAQ ★★★");
  assert.equal(tiers.tierLabel(720), "KING_IRAQ ★★★★");
  assert.equal(tiers.tierLabel(1080), "VIP_IRAQ ★★★★★");
  assert.equal(tiers.tierTeam(1080), "VIP_IRAQ ★★★★★ (1080p)");
  assert.equal(tiers.tierLabel(360), "360p", "an unknown quality shows its resolution");
});
