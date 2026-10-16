// The VI-Iraq mark on pictures and videos – real ffmpeg, tiny generated media, no network, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const watermark = require("../watermark");
const media = require("../media");
const skip = !watermark.ready && "ffmpeg is not available";

const ff = (args, opts = {}) => spawnSync(watermark.FFMPEG, ["-v", "error", "-y", ...args], opts);
/** Raw grey pixels of a rectangle of the first frame. */
const crop = (file, w, h, x, y) =>
  ff(["-i", file, "-vf", `crop=${w}:${h}:${x}:${y},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 20e6 }).stdout;
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

let dir, img, vid;
test.before(() => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vi-wm-test-"));
  img = path.join(dir, "flat.jpg");
  vid = path.join(dir, "flat.mp4");
  ff(["-f", "lavfi", "-i", "color=c=0x707070:s=1024x768", "-frames:v", "1", img]);
  ff(["-f", "lavfi", "-i", "color=c=0x707070:s=640x360:d=1:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", vid]);
});
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test("picture: same size, still a JPEG, mark only in the bottom-right corner", { skip }, async () => {
  const original = fs.readFileSync(img);
  const marked = await watermark.apply(original, "image");
  assert.equal(marked.subarray(0, 2).toString("hex"), "ffd8", "JPEG");
  const out = path.join(dir, "marked.jpg");
  fs.writeFileSync(out, marked);
  const p = await watermark.probe(out);
  assert.deepEqual([p.width, p.height], [1024, 768]);
  assert.ok(maxDiff(crop(img, 200, 200, 0, 0), crop(out, 200, 200, 0, 0)) <= 3, "top-left corner untouched");
  assert.ok(maxDiff(crop(img, 200, 200, 412, 284), crop(out, 200, 200, 412, 284)) <= 3, "centre untouched");
  assert.ok(maxDiff(crop(img, 180, 70, 830, 680), crop(out, 180, 70, 830, 680)) > 60, "the mark is in the bottom-right corner");
});

test("video: same size, audio kept, mark only in the bottom-right corner", { skip }, async () => {
  const marked = await watermark.apply(fs.readFileSync(vid), "video");
  const out = path.join(dir, "marked.mp4");
  fs.writeFileSync(out, marked);
  const p = await watermark.probe(out);
  assert.deepEqual([p.width, p.height], [640, 360]);
  assert.equal(p.hasAudio, true, "the voice track survives");
  assert.ok(maxDiff(crop(vid, 150, 100, 0, 0), crop(out, 150, 100, 0, 0)) <= 6, "top-left corner untouched");
  assert.ok(maxDiff(crop(vid, 130, 50, 500, 300), crop(out, 130, 50, 500, 300)) > 60, "the mark is in the bottom-right corner");
});

test("a file ffmpeg cannot read is an error – the caller never gets an unmarked copy", { skip }, async () => {
  await assert.rejects(watermark.apply(Buffer.from("not a picture at all"), "image"));
});

test("provider result links: only fal's CDN over https", () => {
  assert.equal(media.isProviderUrl("https://v3b.fal.media/files/b/x/y.jpg"), true);
  assert.equal(media.isProviderUrl("https://queue.fal.run/x"), true);
  assert.equal(media.isProviderUrl("http://v3b.fal.media/x.jpg"), false);
  assert.equal(media.isProviderUrl("https://fal.media.evil.example/x.jpg"), false);
  assert.equal(media.isProviderUrl("https://evil.example/fal.media/x.jpg"), false);
  assert.equal(media.isProviderUrl("file:///etc/passwd"), false);
  assert.equal(media.isProviderUrl("not a url"), false);
});
