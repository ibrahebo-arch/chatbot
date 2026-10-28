// Free trial against fake fal.ai / OpenAI servers (no real money, no network), with real ffmpeg stamping.
// Needs TEST_DATABASE_URL; runs inside a throw-away schema that is dropped at the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");
const watermark = require("../watermark");

const URL_ = process.env.TEST_DATABASE_URL;
const skip = (!URL_ && "set TEST_DATABASE_URL to run the database tests") || (!watermark.ready && "ffmpeg is not available");
const schema = `vi_test_${crypto.randomBytes(4).toString("hex")}`;
const ssl = () => { try { return new URL(URL_).hostname.includes(".render.com") ? { rejectUnauthorized: false } : false; } catch { return false; } };

// ---- real (tiny) media the fake provider hands out ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), "vi-trial-media-"));
const fixtures = {};
function makeFixtures() {
  const ff = (args) => spawnSync(watermark.FFMPEG, ["-v", "error", "-y", ...args]);
  ff(["-f", "lavfi", "-i", "color=c=0x707070:s=1024x768", "-frames:v", "1", path.join(work, "img.jpg")]);
  ff(["-f", "lavfi", "-i", "color=c=0x305070:s=1024x768", "-frames:v", "1", path.join(work, "real.jpg")]);
  fixtures.real = fs.readFileSync(path.join(work, "real.jpg"));
  ff(["-f", "lavfi", "-i", "color=c=0x707070:s=640x360:d=1:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(work, "vid.mp4")]);
  fixtures.jpg = fs.readFileSync(path.join(work, "img.jpg"));
  fixtures.mp4 = fs.readFileSync(path.join(work, "vid.mp4"));
}

// ---- fake fal queue: jobs finish when the test says so ----
const jobs = new Map(); // request_id → { model, input, state: "IN_QUEUE"|"COMPLETED", output }
let failNextSubmit = false;
const openaiCalls = [];
const editCalls = []; // /v1/images/edits (multipart): { type, body }
const ttsCalls = [];
const realismCalls = [];
let base = "";
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/f/img.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(fixtures.jpg); }
    if (req.url === "/f/vid.mp4") { res.writeHead(200, { "Content-Type": "video/mp4" }); return res.end(fixtures.mp4); }
    if (req.url === "/f/real.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(fixtures.real); }
    if (req.method === "POST" && req.url === "/fal-ai/nano-banana-pro/edit") { // the realism pass (fal's direct, synchronous endpoint)
      if (req.headers.authorization !== "Key test-fal-key") return send(401, { detail: "bad key" });
      realismCalls.push(JSON.parse(body));
      return send(200, { images: [{ url: `${base}/f/real.jpg` }], has_nsfw_concepts: [false] });
    }
    if (req.url === "/v1/audio/speech") {
      ttsCalls.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "audio/mpeg" }); return res.end(Buffer.alloc(4000, 1)); // 4 KB of "mp3"
    }
    if (req.url === "/v1/images/edits") {
      editCalls.push({ type: String(req.headers["content-type"] || ""), body });
      return send(200, { data: [{ b64_json: fixtures.jpg.toString("base64") }] });
    }
    if (req.url === "/v1/images/generations") {
      openaiCalls.push(JSON.parse(body));
      return send(200, { data: [{ b64_json: fixtures.jpg.toString("base64") }] });
    }
    if (req.headers.authorization !== "Key test-fal-key") return send(401, { detail: "bad key" });
    // like fal: status/result live under the app id (first two parts of the model id) only
    const st = req.url.match(/^\/[^/]+\/[^/]+\/requests\/([^/]+)\/status$/);
    const rs = req.url.match(/^\/[^/]+\/[^/]+\/requests\/([^/]+)$/);
    if (req.method === "GET" && /\/requests\//.test(req.url) && !st && !rs) return send(405, { detail: "Method Not Allowed" });
    if (req.method === "POST") {
      if (failNextSubmit) { failNextSubmit = false; return send(500, { detail: "boom" }); }
      const id = "r" + crypto.randomBytes(4).toString("hex");
      jobs.set(id, { model: req.url.slice(1), input: JSON.parse(body), state: "IN_QUEUE" });
      return send(200, { request_id: id, status_url: "x", response_url: "y" });
    }
    if (st) { const j = jobs.get(st[1]); return j ? send(200, { status: j.state }) : send(404, {}); }
    if (rs) { const j = jobs.get(rs[1]); return j ? send(200, j.output) : send(404, {}); }
    send(404, {});
  });
});
const finish = (requestId, output) => Object.assign(jobs.get(requestId), { state: "COMPLETED", output });
const finishImage = (requestId, nsfw = false) => finish(requestId, { images: [{ url: `${base}/f/img.jpg` }], has_nsfw_concepts: [nsfw] });
const finishVideo = (requestId) => finish(requestId, { video: { url: `${base}/f/vid.mp4` } });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

let trial, db, storage, orders, admin;
test.before(async () => {
  if (skip) return;
  makeFixtures();
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    FAL_KEY: "test-fal-key", FAL_QUEUE_URL: base,
    TRIAL_IMAGES: "3", TRIAL_VIDEOS: "1", TRIAL_DAILY_BUDGET_USD: "0.55", TRIAL_SALT: "test-salt",
    OPENAI_API_KEY: "test-openai-key", OPENAI_BASE_URL: base, OPENAI_IMAGE_COST_USD: "0.04",
    STORAGE_DIR: path.join(os.tmpdir(), `vi-trial-test-${process.pid}`),
  });
  admin = new Client({ connectionString: URL_, ssl: ssl() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  db = require("../db");
  storage = require("../storage");
  orders = require("../orders");
  trial = require("../trial");
  await db.initDb();
});
test.after(async () => {
  if (skip) return;
  fake.close();
  await db.pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  fs.rmSync(work, { recursive: true, force: true });
});

const start = (ip, extra = {}) => trial.start({ ip, kind: "image", style: "realistic", prompt: "a cat on a beach", modelPrompt: "a cat on a beach", ...extra });
/** Waits until the job is done or failed (the stamped copy is made in the background). */
async function settle(id, token, ms = 20000) {
  for (let t = 0; t < ms; t += 100) {
    const j = await trial.own(id, token);
    if (j.status === "done" || j.status === "failed") return j;
    await nap(100);
  }
  throw new Error("job did not finish");
}
const probeBuffer = async (buf) => {
  const f = path.join(work, `probe-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(f, buf);
  return watermark.probe(f);
};

test("3 images per IP; the 4th is refused; another IP has its own allowance", { skip }, async () => {
  for (let i = 0; i < 3; i++) await start("198.51.100.1");
  await assert.rejects(start("198.51.100.1"), { code: "limit" });
  assert.equal((await trial.status("198.51.100.1")).left.image, 0);
  assert.equal((await trial.status("198.51.100.2")).left.image, 3);
});

test("a video the provider cannot start is not counted", { skip }, async () => {
  failNextSubmit = true;
  await assert.rejects(trial.start({ ip: "198.51.100.3", kind: "video", style: "realistic", prompt: "waves at night" }), { code: "provider" });
  assert.equal((await trial.status("198.51.100.3")).left.video, 1);
  require("../media").resetFal(); // the failure marked fal as down for 10 minutes
});

test("finished image: stamped with the mark before the visitor sees it; the clean original is kept privately", { skip }, async () => {
  const { job, token } = await start("198.51.100.4", { style: "realistic" });
  const sent = jobs.get(job.provider_job_id);
  assert.match(sent.input.prompt, /photorealistic/i);
  assert.equal(sent.input.enable_safety_checker, true);
  assert.equal(trial.view(await trial.get(job.id, token)).status, "running");
  finishImage(job.provider_job_id);
  await nap(3100); // the provider is asked at most every 3 s per job
  const first = trial.view(await trial.get(job.id, token), token); // the provider has finished, the stamped copy is not ready yet
  assert.equal(first.status, "running");
  assert.equal(first.url, null, "nothing is linked before the stamped copy exists");
  const done = await settle(job.id, token);
  assert.equal(done.status, "done");
  assert.equal(done.watermarked, true);
  const stored = await storage.getBuffer(done.stored_key);
  assert.equal(stored.subarray(0, 2).toString("hex"), "ffd8");
  assert.ok(!stored.equals(fixtures.jpg), "the stored result is the stamped copy, not the provider's file");
  assert.ok((await storage.getBuffer(`trial/src/${job.ticket}.jpg`)).equals(fixtures.jpg), "the clean original is kept for animating it");
  const v = trial.view(done, token);
  assert.equal(v.status, "done");
  assert.ok(v.url.startsWith(`/api/trial/jobs/${job.id}/media?token=`), v.url);
  assert.ok(!JSON.stringify(v).includes("127.0.0.1"), "the provider's unstamped link never reaches the visitor");
  assert.equal(await trial.get(job.id, "wrong-token"), null, "another browser cannot read the job");
});

test("an image flagged by the safety filter fails and gives the slot back", { skip }, async () => {
  const { job, token } = await start("198.51.100.5");
  finishImage(job.provider_job_id, true);
  await nap(50);
  const v = trial.view(await trial.get(job.id, token));
  assert.equal(v.status, "failed");
  assert.equal((await trial.status("198.51.100.5")).left.image, 3);
});

test("animate: only the visitor's own finished image, sent clean (no mark) as the first frame", { skip }, async () => {
  const ip = "198.51.100.6";
  const img = await start(ip);
  finishImage(img.job.provider_job_id);
  await nap(3100);
  await trial.get(img.job.id, img.token);
  await settle(img.job.id, img.token);
  await assert.rejects(trial.start({ ip: "198.51.100.7", kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: img.token }), { code: "invalid" });
  await assert.rejects(trial.start({ ip, kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: "nope" }), { code: "invalid" });
  const vid = await trial.start({ ip, kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: img.token });
  const sent = jobs.get(vid.job.provider_job_id);
  assert.match(vid.job.model, /image-to-video/);
  assert.equal(sent.input.image_url, `data:image/jpeg;base64,${fixtures.jpg.toString("base64")}`, "the clean original, so the mark is not stamped twice");
  await assert.rejects(trial.start({ ip, kind: "video", style: "realistic", prompt: "another" }), { code: "limit" });
});

test("the daily budget pauses the trial for everyone", { skip }, async () => {
  // budget 0.55 USD, starting from 0 today: two 10 s videos fit (2 × 0.25), a third would pass the cap
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  await trial.start({ ip: "198.51.100.8", kind: "video", style: "realistic", prompt: "dancing robot" });
  await trial.start({ ip: "198.51.100.11", kind: "video", style: "realistic", prompt: "dancing robot" });
  await assert.rejects(trial.start({ ip: "198.51.100.9", kind: "video", style: "realistic", prompt: "dancing robot" }), { code: "paused" });
  assert.equal((await trial.status("198.51.100.10")).paused, false, "cheap images still fit");
});

test("cartoon pictures are made by the ChatGPT image model, stamped, and kept on our storage", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  const { job, token } = await trial.start({ ip: "198.51.100.20", kind: "image", style: "cartoon", prompt: "a cat", modelPrompt: "a small cat" });
  assert.equal(job.provider, "openai");
  const j = await settle(job.id, token);
  assert.equal(j.status, "done");
  assert.match(job.ticket, /^FT-\d{6}-[A-Z2-9]{4}$/, "every free job gets a ticket");
  assert.equal(j.result_url, `store:trial/${job.ticket}.jpg`);
  assert.equal(j.stored_key, `trial/${job.ticket}.jpg`);
  assert.equal(j.watermarked, true);
  const stored = await storage.getBuffer(`trial/${job.ticket}.jpg`);
  assert.ok(!stored.equals(fixtures.jpg) && stored.subarray(0, 2).toString("hex") === "ffd8", "ChatGPT's picture is stamped");
  assert.ok((await storage.getBuffer(`trial/src/${job.ticket}.jpg`)).equals(fixtures.jpg));
  assert.match(openaiCalls.at(-1).prompt, /cartoon/i);
  const v = trial.view(j, token);
  assert.ok(v.url.startsWith(`/api/trial/jobs/${job.id}/media?token=`), v.url);
  assert.ok(v.download.startsWith(`/api/trial/jobs/${job.id}/download?token=`), v.download);
});

test("fal out of credit: pictures switch to ChatGPT automatically, the free video is paused", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  failNextSubmit = true; // fal refuses (e.g. balance exhausted)
  const { job, token } = await trial.start({ ip: "198.51.100.21", kind: "image", style: "realistic", prompt: "a street in Erbil" });
  assert.equal(job.provider, "openai", "fell back to ChatGPT");
  assert.equal((await settle(job.id, token)).status, "done");
  assert.equal((await trial.status("198.51.100.21")).videoAvailable, false);
  await assert.rejects(trial.start({ ip: "198.51.100.22", kind: "video", style: "realistic", prompt: "waves" }), { code: "video_off" });
});

test("video with a spoken line: Iraqi voice recorded and sent as the soundtrack; the finished video is stamped and keeps its voice", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  require("../media").resetFal();
  const speech = { lang: "ar-IQ", text: "هلا بيكم بمطعمنا، تعالوا جرّبوا المشاوي", voice: "male", tone: "warm" };
  const plan = { prompt: "A man speaks to the camera", negative: "blurry", speech, onScreenText: null, shots: [] };
  const { job, token } = await trial.start({ ip: "198.51.100.30", kind: "video", style: "realistic", prompt: "اعلان مطعم", modelPrompt: plan.prompt, plan, speech });
  const sent = jobs.get(job.provider_job_id);
  assert.equal(sent.input.duration, 10);
  assert.ok(sent.input.target_audio_url.startsWith("data:audio/mpeg;base64,"), "voice track sent as a data URI");
  assert.equal(sent.input.prompt_expansion_mode, "disabled", "our own prompt is sent as written");
  assert.match(ttsCalls.at(-1).instructions, /Iraqi/);
  assert.equal(ttsCalls.at(-1).input, speech.text);
  const row = (await db.query("SELECT speech_text, speech_lang, audio_key, plan FROM trial_jobs WHERE id = $1", [job.id])).rows[0];
  assert.equal(row.speech_text, speech.text);
  assert.equal(row.speech_lang, "ar-IQ");
  assert.equal(row.audio_key, `trial/${job.ticket}.mp3`);
  assert.equal((await storage.getBuffer(row.audio_key)).length, 4000);
  assert.equal(row.plan.negative, "blurry");
  assert.equal(trial.view(await trial.get(job.id, token), token).speech.text, speech.text);

  finishVideo(job.provider_job_id);
  await nap(3100);
  await trial.get(job.id, token);
  const done = await settle(job.id, token);
  assert.equal(done.status, "done");
  assert.equal(done.watermarked, true);
  assert.equal(done.stored_key, `trial/${job.ticket}.mp4`);
  const stored = await storage.getBuffer(done.stored_key);
  const p = await probeBuffer(stored);
  assert.deepEqual([p.width, p.height], [640, 360]);
  assert.equal(p.hasAudio, true, "the stamped video keeps its voice");
  assert.ok(!stored.equals(fixtures.mp4));
});

test("a picture with writing in it goes to the ChatGPT image model", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  const plan = { prompt: 'a shop sign that reads exactly "مرحباً"', negative: "", speech: null, onScreenText: { text: "مرحباً", lang: "ar", placement: "sign" }, shots: [] };
  const { job } = await trial.start({ ip: "198.51.100.31", kind: "image", style: "realistic", prompt: "لافتة", modelPrompt: plan.prompt, plan });
  assert.equal(job.provider, "openai");
});

/** A chat upload as the page keeps it: an assets row + the stored file; returns the message file entry. */
async function chatPicture(role, { image = true, mime = "image/jpeg", buf = fixtures.jpg } = {}) {
  const uploadId = crypto.randomUUID();
  const key = `uploads/pending/${uploadId}.jpg`;
  await storage.put(key, buf, { contentType: mime });
  await orders.createPendingAsset({ uploadId, role, mediaType: image ? "image" : "video", mime, originalName: `${role}.jpg`, key, size: buf.length });
  return { name: `${role}.jpg`, stored: uploadId, image, video: !image, role };
}

test("chat pictures: Character 1 first, then references; only real pictures; at most three", { skip }, async () => {
  const ref = await chatPicture("ref");
  const c2 = await chatPicture("char2");
  const c1 = await chatPicture("char1");
  const video = await chatPicture("ref", { image: false, mime: "video/mp4", buf: fixtures.mp4 });
  const extra = await chatPicture("ref");
  const messages = [
    { role: "assistant", content: "hi", files: [c1] },                    // only the customer's own messages count
    { role: "user", content: "my friends", files: [ref, c2, video] },
    { role: "user", content: "and me", files: [c1, extra, { image: true, stored: "does-not-exist", role: "char3" }] },
  ];
  const refs = await trial.refsFrom(messages);
  assert.deepEqual(refs.map((r) => r.role), ["char1", "char2", "ref"], "ordered by role, deduplicated, video and missing files skipped, max 3");
  for (const r of refs) assert.equal(r.buf.subarray(0, 2).toString("hex"), "ffd8", "each is a JPEG");
  assert.deepEqual(await trial.refsFrom([]), []);
});

test("picture request with chat pictures becomes a ChatGPT edit of the photos (faces kept), stamped", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  const refs = await trial.refsFrom([{ role: "user", content: "x", files: [await chatPicture("char1"), await chatPicture("ref")] }]);
  const { job, token } = await trial.start({ ip: "198.51.100.40", kind: "image", style: "realistic", prompt: "me on a roof", modelPrompt: "A man on a rooftop in Baghdad", refs });
  assert.equal(job.provider, "openai", "fal's FLUX cannot use photos");
  assert.equal(Number(job.cost_usd), 0.10, "an edit costs more than a plain picture");
  const done = await settle(job.id, token);
  assert.equal(done.status, "done");
  assert.equal(done.watermarked, true);
  const call = editCalls.at(-1);
  assert.match(call.type, /^multipart\/form-data/);
  assert.equal((call.body.match(/name="image\[\]"/g) || []).length, 2, "both photos were sent");
  assert.match(call.body, /Picture 1 is Character 1/);
  assert.match(call.body, /Picture 2 is style\/place\/product reference/);
  assert.match(call.body, /name="input_fidelity"/);
  assert.match(call.body, /A man on a rooftop in Baghdad/);
});

test("video request with a chat picture starts from that photo (image-to-video); Character 1 first", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  require("../media").resetFal();
  const refs = await trial.refsFrom([{ role: "user", content: "x", files: [await chatPicture("ref"), await chatPicture("char1")] }]);
  const { job } = await trial.start({ ip: "198.51.100.41", kind: "video", style: "realistic", prompt: "he waves", modelPrompt: "He waves at the camera", refs });
  const sent = jobs.get(job.provider_job_id);
  assert.match(job.model, /image-to-video/);
  assert.equal(sent.input.image_url, `data:image/jpeg;base64,${refs[0].buf.toString("base64")}`, "the first frame is the Character 1 photo");
  assert.equal(refs[0].role, "char1");
});

test("animating a trial picture keeps its own first frame – chat pictures are ignored there", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  require("../media").resetFal();
  const ip = "198.51.100.42";
  const img = await start(ip);
  finishImage(img.job.provider_job_id);
  await nap(3100);
  await trial.get(img.job.id, img.token);
  await settle(img.job.id, img.token);
  const refs = await trial.refsFrom([{ role: "user", content: "x", files: [await chatPicture("char1")] }]);
  const vid = await trial.start({ ip, kind: "video", style: "realistic", prompt: "move", sourceJobId: img.job.id, sourceToken: img.token, refs });
  assert.equal(jobs.get(vid.job.provider_job_id).input.image_url, `data:image/jpeg;base64,${fixtures.jpg.toString("base64")}`);
});

test("realism pass: a realistic ChatGPT picture goes through Nano Banana Pro with the customer's faces; cartoons do not", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  Object.assign(process.env, { IMAGE_REALISM_PASS: "1", FAL_RUN_URL: base });
  try {
    const refs = await trial.refsFrom([{ role: "user", content: "x", files: [await chatPicture("char1"), await chatPicture("ref")] }]);
    const { job, token } = await trial.start({ ip: "198.51.100.50", kind: "image", style: "realistic", prompt: "us at dinner", modelPrompt: "A couple at dinner", refs });
    assert.equal(Number(job.cost_usd), 0.25, "edit + realism pass");
    const done = await settle(job.id, token);
    assert.equal(done.status, "done");
    assert.ok((await storage.getBuffer(`trial/src/${job.ticket}.jpg`)).equals(fixtures.real), "the realism result is what the visitor gets");
    const call = realismCalls.at(-1);
    assert.equal(call.image_urls.length, 2, "the picture + the Character 1 photo (a reference picture is not a face)");
    assert.match(call.prompt, /Keep it EXACTLY/);
    const before = realismCalls.length;
    const c = await trial.start({ ip: "198.51.100.51", kind: "image", style: "cartoon", prompt: "a cat", modelPrompt: "a cat" });
    assert.equal((await settle(c.job.id, c.token)).status, "done");
    assert.equal(realismCalls.length, before, "a cartoon stays a cartoon");
  } finally { delete process.env.IMAGE_REALISM_PASS; delete process.env.FAL_RUN_URL; }
});

test("video start frame: the opening moment is made as a picture first, the video animates it, and it is kept", { skip }, async () => {
  await db.query("UPDATE trial_jobs SET cost_usd = 0");
  require("../media").resetFal();
  process.env.VIDEO_START_FRAME = "1";
  try {
    const { job } = await trial.start({ ip: "198.51.100.52", kind: "video", style: "realistic", prompt: "a man in a café", modelPrompt: "A man drinks tea in a Baghdad café" });
    const gen = openaiCalls.at(-1);
    assert.equal(gen.size, "1536x1024");
    assert.match(gen.prompt, /first frame of a video/i);
    assert.match(gen.prompt, /Baghdad café/);
    const sent = jobs.get(job.provider_job_id);
    assert.match(job.model, /image-to-video/);
    assert.equal(sent.input.image_url, `data:image/jpeg;base64,${fixtures.jpg.toString("base64")}`, "the made picture is the first frame");
    assert.equal(job.image_first_frame, true);
    assert.ok((await storage.getBuffer(`trial/frame/${job.ticket}.jpg`)).equals(fixtures.jpg), "kept for a quality-check remake");
  } finally { delete process.env.VIDEO_START_FRAME; }
});

test("results made before the mark existed are stamped in place, and are not shown until then", { skip }, async () => {
  const key = "trial/FT-000000-TEST.jpg";
  await storage.put(key, fixtures.jpg, { contentType: "image/jpeg" });
  await db.query(
    `INSERT INTO trial_jobs (id, token, ticket, ip_hash, kind, style, prompt, model, status, stored_key, result_url, watermarked)
     VALUES ('Told', 'tok', 'FT-000000-TEST', 'old-hash', 'image', 'realistic', 'old', 'm', 'done', $1, $2, false)`, [key, `store:${key}`]
  );
  const before = (await db.query("SELECT * FROM trial_jobs WHERE id = 'Told'")).rows[0];
  const v = trial.view(before, "tok");
  assert.equal(v.status, "running", "an unstamped result is not presented as finished");
  assert.equal(v.url, null);
  await trial.backfill();
  const after = (await db.query("SELECT * FROM trial_jobs WHERE id = 'Told'")).rows[0];
  assert.equal(after.watermarked, true);
  const stored = await storage.getBuffer(key);
  assert.ok(!stored.equals(fixtures.jpg), "the stored file now carries the mark");
  assert.ok((await storage.getBuffer("trial/src/FT-000000-TEST.jpg")).equals(fixtures.jpg), "the clean original is kept");
  assert.equal(trial.view(after, "tok").status, "done");
});

test("the visitor IP is never stored, only a salted hash", { skip }, async () => {
  const rows = (await db.query("SELECT ip_hash FROM trial_jobs")).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!r.ip_hash.includes("198.51.100"), "raw IP stored");
  assert.equal(trial.ipHash("198.51.100.1"), trial.ipHash("198.51.100.1"));
  assert.notEqual(trial.ipHash("198.51.100.1"), trial.ipHash("198.51.100.2"));
});
