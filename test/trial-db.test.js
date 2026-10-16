// Free trial against a fake fal.ai queue (no real money, no network).
// Needs TEST_DATABASE_URL; runs inside a throw-away schema that is dropped at the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const { Client } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && "set TEST_DATABASE_URL to run the database tests";
const schema = `vi_test_${crypto.randomBytes(4).toString("hex")}`;
const ssl = () => { try { return new URL(URL_).hostname.includes(".render.com") ? { rejectUnauthorized: false } : false; } catch { return false; } };

// ---- fake fal queue: jobs finish when the test says so ----
const jobs = new Map(); // request_id → { model, input, state: "IN_QUEUE"|"COMPLETED", output, error, fail }
let failNextSubmit = false;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
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
    if (st) { const j = jobs.get(st[1]); return j ? send(200, { status: j.state, ...(j.error ? { error: j.error } : {}) }) : send(404, {}); }
    if (rs) { const j = jobs.get(rs[1]); return j ? send(200, j.output) : send(404, {}); }
    send(404, {});
  });
});
const finish = (requestId, output) => Object.assign(jobs.get(requestId), { state: "COMPLETED", output });

let trial, db, admin;
test.before(async () => {
  if (skip) return;
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    FAL_KEY: "test-fal-key", FAL_QUEUE_URL: `http://127.0.0.1:${fake.address().port}`,
    TRIAL_IMAGES: "3", TRIAL_VIDEOS: "1", TRIAL_DAILY_BUDGET_USD: "0.3", TRIAL_SALT: "test-salt",
  });
  admin = new Client({ connectionString: URL_, ssl: ssl() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  db = require("../db");
  trial = require("../trial");
  await db.initDb();
});
test.after(async () => {
  if (skip) return;
  fake.close();
  await db.pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const start = (ip, extra = {}) => trial.start({ ip, kind: "image", style: "realistic", prompt: "a cat on a beach", modelPrompt: "a cat on a beach", ...extra });

test("3 images per IP; the 4th is refused; another IP has its own allowance", { skip }, async () => {
  for (let i = 0; i < 3; i++) await start("198.51.100.1");
  await assert.rejects(start("198.51.100.1"), { code: "limit" });
  assert.equal((await trial.status("198.51.100.1")).left.image, 0);
  assert.equal((await trial.status("198.51.100.2")).left.image, 3);
});

test("a job the provider cannot start is not counted", { skip }, async () => {
  failNextSubmit = true;
  await assert.rejects(start("198.51.100.3"), { code: "provider" });
  assert.equal((await trial.status("198.51.100.3")).left.image, 3);
});

test("finished image: the visitor gets the URL; style text and safety checker are sent", { skip }, async () => {
  const { job, token } = await start("198.51.100.4", { style: "cartoon" });
  const sent = jobs.get(job.provider_job_id);
  assert.match(sent.input.prompt, /cartoon/i);
  assert.equal(sent.input.enable_safety_checker, true);
  assert.equal(trial.view(await trial.get(job.id, token)).status, "running");
  finish(job.provider_job_id, { images: [{ url: "https://cdn.example/cat.jpg" }], has_nsfw_concepts: [false] });
  await new Promise((r) => setTimeout(r, 3100)); // provider is asked at most every 3 s per job
  const v = trial.view(await trial.get(job.id, token));
  assert.equal(v.status, "done");
  assert.equal(v.url, "https://cdn.example/cat.jpg");
  assert.equal(await trial.get(job.id, "wrong-token"), null, "another browser cannot read the job");
});

test("an image flagged by the safety filter fails and gives the slot back", { skip }, async () => {
  const { job, token } = await start("198.51.100.5");
  finish(job.provider_job_id, { images: [{ url: "https://cdn.example/x.jpg" }], has_nsfw_concepts: [true] });
  await new Promise((r) => setTimeout(r, 50));
  const v = trial.view(await trial.get(job.id, token));
  assert.equal(v.status, "failed");
  assert.equal((await trial.status("198.51.100.5")).left.image, 3);
});

test("animate: only the visitor's own finished image, sent as the first frame", { skip }, async () => {
  const ip = "198.51.100.6";
  const img = await start(ip);
  finish(img.job.provider_job_id, { images: [{ url: "https://cdn.example/me.jpg" }], has_nsfw_concepts: [false] });
  await trial.get(img.job.id, img.token);
  await assert.rejects(trial.start({ ip: "198.51.100.7", kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: img.token }), { code: "invalid" });
  await assert.rejects(trial.start({ ip, kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: "nope" }), { code: "invalid" });
  const vid = await trial.start({ ip, kind: "video", style: "realistic", prompt: "make it move", sourceJobId: img.job.id, sourceToken: img.token });
  const sent = jobs.get(vid.job.provider_job_id);
  assert.match(vid.job.model, /image-to-video/);
  assert.equal(sent.input.image_url, "https://cdn.example/me.jpg");
  await assert.rejects(trial.start({ ip, kind: "video", style: "realistic", prompt: "another" }), { code: "limit" });
});

test("the daily budget pauses the trial for everyone", { skip }, async () => {
  // budget 0.30 USD: so far ≈ 0.14 (images + one video) → one more 0.125 video fits, the next does not
  await trial.start({ ip: "198.51.100.8", kind: "video", style: "cartoon", prompt: "dancing robot" });
  await assert.rejects(trial.start({ ip: "198.51.100.9", kind: "video", style: "cartoon", prompt: "dancing robot" }), { code: "paused" });
  assert.equal((await trial.status("198.51.100.10")).paused, false, "cheap images still fit");
});

test("the visitor IP is never stored, only a salted hash", { skip }, async () => {
  const rows = (await db.query("SELECT ip_hash FROM trial_jobs")).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!r.ip_hash.includes("198.51.100"), "raw IP stored");
  assert.equal(trial.ipHash("198.51.100.1"), trial.ipHash("198.51.100.1"));
  assert.notEqual(trial.ipHash("198.51.100.1"), trial.ipHash("198.51.100.2"));
});
