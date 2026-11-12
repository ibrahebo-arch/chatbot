// Social intelligence layer: which requests are reels, how an analysis becomes a pattern, how videos are ranked.
const test = require("node:test");
const assert = require("node:assert/strict");
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const reels = require("../reels");

test("a request for a short social video is recognised in Arabic and English", () => {
  for (const t of ["اريد ريلز لمحلي", "فيديو تيك توك مضحك", "ستوري انستغرام", "make me a reel", "an Instagram story", "YouTube Shorts ad", "ترند جديد"]) assert.ok(reels.isReel(t), t);
  for (const t of ["اعلان لمطعم ٣٠ ثانية", "فيديو تعريفي لشركتي", "a wedding video", ""]) assert.ok(!reels.isReel(t), t);
});

test("an analysis becomes one tidy pattern", () => {
  const p = reels.normalise({ hook: { seconds: 9, type: "QUESTION", visual: "a man holds up a squid", words: "why do they hit it?", text: "" }, cuts: 7.6, pace: "FAST", retention: "the answer comes at the end", concept: "question then demo", style: "handheld vertical" });
  assert.equal(p.hook.seconds, 5, "the hook is the first seconds only");
  assert.equal(p.hook.type, "question"); assert.equal(p.cuts, 8); assert.equal(p.pace, "fast");
  assert.equal(reels.normalise({ hook: { type: "dance" }, concept: "x" }).hook.type, "other", "unknown hook types are grouped");
  assert.equal(reels.normalise({}), null); assert.equal(reels.normalise(null), null);
});

test("strength grows with reach and with the share of viewers who liked it", () => {
  assert.equal(reels.strength({ views: 0 }), 0);
  assert.ok(reels.strength({ views: 1e6 }) > reels.strength({ views: 1e4 }));
  assert.ok(reels.strength({ views: 1e5, likes: 8000 }) > reels.strength({ views: 1e5, likes: 100 }));
});

test("the summary describes the strong half of the collection", () => {
  const mk = (strength, secs, cuts, type) => ({ strength, duration_sec: secs, pattern: { hook: { type, seconds: 2 }, cuts } });
  const s = reels.summary([mk(7, 30, 9, "question"), mk(6.5, 20, 4, "question"), mk(3, 200, 1, "story"), mk(2, 60, 2, "joke")]);
  assert.equal(s.videos, 4); assert.equal(s.hooks[0], "question (2)"); assert.equal(s.hookSeconds, 2);
  assert.ok(s.seconds >= 20 && s.seconds <= 30); assert.ok(s.cutsPer10s >= 2 && s.cutsPer10s <= 3);
});

test("without patterns a reel request gets no note and nothing breaks", async () => {
  assert.deepEqual(await reels.note("اريد ريلز لمحلي"), { text: "", ids: [] });
  assert.deepEqual(await reels.note("فيديو تعريفي"), { text: "", ids: [] });
});
