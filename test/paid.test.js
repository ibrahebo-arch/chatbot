// Paid orders made automatically: how a length is split into parts and how the order's language is read.
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const paid = require("../paid");

test("a length becomes 10-second parts, with a 5-second one when it fits", () => {
  assert.deepEqual(paid.partsFor(5), { total: 5, parts: [5] });
  assert.deepEqual(paid.partsFor(10), { total: 10, parts: [10] });
  assert.deepEqual(paid.partsFor(15), { total: 15, parts: [10, 5] });
  assert.deepEqual(paid.partsFor(30), { total: 30, parts: [10, 10, 10] });
  assert.deepEqual(paid.partsFor(7), { total: 7, parts: [10] }, "one longer part, cut to 7 s at the end");
  assert.equal(paid.partsFor(120).parts.length, 12);
  assert.equal(paid.partsFor(900).total, 120, "never more than the longest order");
  assert.equal(paid.partsFor("x").total, 10);
});

test("the order's language decides the voice-over", () => {
  assert.equal(paid.langOf("العربية"), "ar-IQ");
  assert.equal(paid.langOf("English"), "en");
  assert.equal(paid.langOf("بدون كلام"), "none");
  assert.equal(paid.langOf("كردي"), "ku");
  assert.equal(paid.langOf("الفصحى"), "ar");
});

test("off unless PAID_AUTO=1", () => {
  const was = process.env.PAID_AUTO; delete process.env.PAID_AUTO;
  assert.equal(paid.ON(), false); assert.equal(paid.start("VI-000000-TEST"), false);
  process.env.PAID_AUTO = "1"; assert.equal(paid.ON(), true);
  if (was === undefined) delete process.env.PAID_AUTO; else process.env.PAID_AUTO = was;
});
