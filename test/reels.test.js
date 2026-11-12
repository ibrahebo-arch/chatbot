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

test("the social collector knows which links it may study", () => {
  const { parseUrl } = require("../social");
  assert.deepEqual(parseUrl("https://www.youtube.com/shorts/VJqD8BRx8qc"), { kind: "youtube", id: "VJqD8BRx8qc" });
  assert.deepEqual(parseUrl("https://youtu.be/VJqD8BRx8qc?si=x"), { kind: "youtube", id: "VJqD8BRx8qc" });
  assert.deepEqual(parseUrl("https://m.youtube.com/watch?v=VJqD8BRx8qc&t=3"), { kind: "youtube", id: "VJqD8BRx8qc" });
  assert.deepEqual(parseUrl("https://www.instagram.com/reel/DAbc_12-x/"), { kind: "instagram", code: "DAbc_12-x" });
  assert.deepEqual(parseUrl("https://www.instagram.com/vi.iraq/reel/DAbc12x/"), { kind: "instagram", code: "DAbc12x" });
  assert.deepEqual(parseUrl("https://www.tiktok.com/@x/video/1"), { kind: "tiktok" });
  assert.equal(parseUrl("not a link"), null); assert.equal(parseUrl("https://example.com/v.mp4"), null);
});

test("someone else's Instagram or TikTok link is skipped, never fetched", async () => {
  const social = require("../social"); const real = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error("no network in tests"); };
  const was = process.env.INSTAGRAM_TOKEN; delete process.env.INSTAGRAM_TOKEN;
  try {
    const out = await social.analyze(["https://www.instagram.com/reel/ABC123/", "https://www.tiktok.com/@a/video/9", "hello"], { log: () => {} });
    assert.equal(out.length, 3); assert.ok(out.every((r) => r.skipped && !r.ok)); assert.equal(calls, 0, "nothing was requested");
  } finally { global.fetch = real; if (was !== undefined) process.env.INSTAGRAM_TOKEN = was; }
});
