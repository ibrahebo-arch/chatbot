// Veo speaks the line itself (TRIAL_VEO_VOICE=1): the spoken words go into the prompt, no audio track is sent.
// Against a fake fal queue – no network, no money, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const jobs = new Map();
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const id = "r" + jobs.size;
    jobs.set(id, { model: req.url.slice(1), input: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ request_id: id }));
  });
});

let media;
test.before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.FAL_KEY = "test-fal-key";
  process.env.FAL_QUEUE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.TRIAL_VEO_VOICE = "1";
  process.env.TRIAL_VIDEO_SECONDS = "10";
  process.env.FAL_VEO_COST_PER_SEC = "0.4";
  media = require("../media");
});
test.after(() => fake.close());

const speech = { text: "هلا بيكم بمطعمنا، تعالوا جرّبوا المشاوي", lang: "ar-IQ", gender: "male", age: "adult", tone: "warm" };

test("who speaks: Veo only with a line, never for the customer's own recording", () => {
  assert.equal(media.veoSpeaks(speech), true);
  assert.equal(media.veoSpeaks(speech, { mode: "convert" }), true);
  assert.equal(media.veoSpeaks(speech, { mode: "own" }), false);
  assert.equal(media.veoSpeaks(speech, { mode: "none" }), false);
  assert.equal(media.veoSpeaks(null), false);
  assert.equal(media.veoSpeaks({ text: "" }), false);
});

test("a video with a spoken line goes to Veo: 8 s, audio on, the exact words and the Iraqi dialect in the prompt, no track", async () => {
  const r = await media.submit("video", { prompt: "A man in a dishdasha in front of a Baghdad restaurant.", style: "realistic", negative: "blurry", speech });
  assert.equal(r.model, "fal-ai/veo3.1/fast");
  assert.equal(r.cost, 0.4 * 8);
  const sent = jobs.get(r.jobId).input;
  assert.equal(sent.duration, "8s");
  assert.equal(sent.generate_audio, true);
  assert.equal(sent.resolution, "720p");
  assert.equal(sent.target_audio_url, undefined);
  assert.ok(sent.prompt.includes(`"${speech.text}"`), "the exact words are quoted");
  assert.match(sent.prompt, /Iraqi Arabic, Baghdadi/);
  assert.match(sent.prompt, /^Photorealistic .*Baghdad restaurant\./);
  assert.match(sent.prompt, /The man looks at the camera and says/);
  assert.match(sent.negative_prompt, /^blurry, .*subtitles/);
});

test("the spoken line survives the prompt length limit; the description is what gets shortened", async () => {
  const long = "A very long description. ".repeat(120);
  const r = await media.submit("video", { prompt: long, style: "realistic", speech });
  const sent = jobs.get(r.jobId).input;
  assert.ok(sent.prompt.length <= 1900 + 10);
  assert.ok(sent.prompt.endsWith("no other speech."));
  assert.ok(sent.prompt.includes(speech.text));
});

test("from a picture: Veo image-to-video with the same line", async () => {
  const r = await media.submit("video", { prompt: "She smiles.", style: "realistic", imageUrl: "data:image/jpeg;base64,AAAA", speech: { ...speech, gender: "female", age: "young" } });
  assert.equal(r.model, "fal-ai/veo3.1/fast/image-to-video");
  const sent = jobs.get(r.jobId).input;
  assert.equal(sent.image_url, "data:image/jpeg;base64,AAAA");
  assert.match(sent.prompt, /The young woman looks at the camera/);
});

test("a voice track of our own (the customer's recording) still goes to MiniMax with the track", async () => {
  const r = await media.submit("video", { prompt: "He talks.", style: "realistic", audioUrl: "data:audio/mpeg;base64,AAAA", speech });
  assert.match(r.model, /minimax/);
  const sent = jobs.get(r.jobId).input;
  assert.equal(sent.target_audio_url, "data:audio/mpeg;base64,AAAA");
  assert.ok(!sent.prompt.includes(speech.text));
  assert.equal(r.cost, media.COST.video);
});

test("no line: the usual video model, unchanged", async () => {
  const r = await media.submit("video", { prompt: "Waves at night.", style: "realistic" });
  assert.match(r.model, /minimax/);
  assert.equal(jobs.get(r.jobId).input.duration, 10);
});

test("the line text: Veo's words, dialect and speaker", () => {
  const l = media.veoLine({ text: 'قال "هلا"', lang: "ar-IQ", gender: "female", age: "old", tone: "kind" });
  assert.match(l, /^The elderly woman looks at the camera and says, in Iraqi Arabic.*, kind tone: "قال 'هلا'"\./);
  assert.match(media.veoLine({ text: "hi", lang: "en" }), /The person .* in natural conversational English: "hi"/);
});
