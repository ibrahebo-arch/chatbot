// Video quality check: verdict parsing and the retry decision (no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const qa = require("../qa");

test("parseVerdict: score, issues and the retry decision", () => {
  const bad = qa.parseVerdict('{"score": 3, "issues": ["the red cup disappears at 5 s", "a second car appears from nowhere"]}');
  assert.equal(bad.score, 3);
  assert.equal(bad.issues.length, 2);
  assert.equal(bad.retry, true, "low score with concrete problems → make it again");
  const good = qa.parseVerdict('```json\n{"score": 8, "issues": []}\n```');
  assert.deepEqual(good, { score: 8, issues: [], retry: false });
  assert.equal(qa.parseVerdict('{"score": 2, "issues": []}').retry, false, "no concrete problem → no retry");
  assert.equal(qa.parseVerdict("not json"), null);
  assert.equal(qa.parseVerdict('{"score": "x"}'), null);
  assert.equal(qa.parseVerdict('{"score": 50, "issues": []}').score, 10, "clamped to 0–10");
});

test("retryAvoid joins the problems for the second try", () => {
  assert.equal(qa.retryAvoid(["the cup disappears.", "warped tower;"]), "the cup disappears; warped tower");
});
