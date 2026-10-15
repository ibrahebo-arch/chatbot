/**
 * VI Iraq – object storage on Cloudflare R2 (S3 API). The bucket stays private:
 * files are read only through short-lived presigned GET URLs.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Keys
 *   uploads/pending/<upload_id>.<ext>              customer upload before the order exists
 *   uploads/<request_id>/<role>-<upload_id>.<ext>  after the order is created
 *   videos/<request_id>.mp4                        finished video
 *
 * Without R2 (and not on Render): objects go to a local folder and are served by /api/dev-storage
 * with a signed, expiring link. STORAGE_DIR sets that folder – on a VPS point it at a permanent
 * path (the default temp folder is wiped on reboot). On Render a missing R2 config is an error –
 * nothing customer-related is ever kept on the instance disk.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const clean = (v) => String(v || "").trim();
const ACCOUNT = clean(process.env.R2_ACCOUNT_ID);
const KEY_ID = clean(process.env.R2_ACCESS_KEY_ID);
const SECRET = clean(process.env.R2_SECRET_ACCESS_KEY);
const BUCKET = clean(process.env.R2_BUCKET);

const r2 = Boolean(ACCOUNT && KEY_ID && SECRET && BUCKET);
const onHost = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);
const mode = r2 ? "r2" : onHost ? "off" : "local-dev";

let s3, S3;
if (r2) {
  S3 = require("@aws-sdk/client-s3");
  s3 = new S3.S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
  });
}

// ---------- local-dev fallback ----------
const DEV_DIR = path.resolve(clean(process.env.STORAGE_DIR) || path.join(os.tmpdir(), "vi-iraq-dev-storage"));
const DEV_SECRET = crypto.randomBytes(32);
const devPath = (key) => {
  const p = path.join(DEV_DIR, ...String(key).split("/"));
  if (!p.startsWith(DEV_DIR + path.sep)) throw new Error("bad key");
  return p;
};
const devSig = (key, exp) => crypto.createHmac("sha256", DEV_SECRET).update(`${key}\n${exp}`).digest("hex");

function assertOn() {
  if (mode === "off") throw new Error("التخزين غير مفعّل: أضف R2_ACCOUNT_ID و R2_ACCESS_KEY_ID و R2_SECRET_ACCESS_KEY و R2_BUCKET.");
}

/** body: Buffer | Readable. contentLength is required for streams. */
async function put(key, body, { contentType = "application/octet-stream", contentLength } = {}) {
  assertOn();
  if (mode === "r2") {
    await s3.send(new S3.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType, ...(contentLength != null ? { ContentLength: contentLength } : {}) }));
  } else {
    const p = devPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) fs.writeFileSync(p, body);
    else await pipeline(body, fs.createWriteStream(p));
    fs.writeFileSync(p + ".type", contentType);
  }
  return key;
}

/** Reads a whole object (refuses objects bigger than maxBytes). */
async function getBuffer(key, maxBytes = 50 * 1024 * 1024) {
  assertOn();
  if (mode === "r2") {
    const out = await s3.send(new S3.GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (out.ContentLength > maxBytes) { out.Body.destroy?.(); throw new Error("object too large"); }
    return Buffer.from(await out.Body.transformToByteArray());
  }
  const p = devPath(key);
  if (fs.statSync(p).size > maxBytes) throw new Error("object too large");
  return fs.readFileSync(p);
}

async function size(key) {
  assertOn();
  if (mode === "r2") return (await s3.send(new S3.HeadObjectCommand({ Bucket: BUCKET, Key: key }))).ContentLength;
  return fs.statSync(devPath(key)).size;
}

async function remove(key) {
  assertOn();
  if (mode === "r2") await s3.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  else for (const p of [devPath(key), devPath(key) + ".type"]) fs.rmSync(p, { force: true });
}

async function move(from, to) {
  if (from === to) return to;
  assertOn();
  if (mode === "r2") {
    await s3.send(new S3.CopyObjectCommand({ Bucket: BUCKET, Key: to, CopySource: `${BUCKET}/${from.split("/").map(encodeURIComponent).join("/")}` }));
    await s3.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key: from }));
  } else {
    fs.mkdirSync(path.dirname(devPath(to)), { recursive: true });
    fs.renameSync(devPath(from), devPath(to));
    if (fs.existsSync(devPath(from) + ".type")) fs.renameSync(devPath(from) + ".type", devPath(to) + ".type");
  }
  return to;
}

/** Short-lived read link (default 1 hour). */
async function presignGet(key, seconds = 3600, { contentType } = {}) {
  assertOn();
  if (mode === "r2") {
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    return getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: "inline", ...(contentType ? { ResponseContentType: contentType } : {}) }), { expiresIn: seconds });
  }
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `/api/dev-storage/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${devSig(key, exp)}`;
}

/** Express handler for the local-dev links (registered only in local-dev mode). */
function devHandler(req, res) {
  const key = [].concat(req.params.key || []).join("/");
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || "");
  const ok = key && exp > Date.now() / 1000 && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(devSig(key, exp)));
  if (!ok) return res.sendStatus(403);
  let p;
  try { p = devPath(key); } catch { return res.sendStatus(400); }
  if (!fs.existsSync(p)) return res.sendStatus(404);
  let type = "application/octet-stream";
  try { type = fs.readFileSync(p + ".type", "utf8"); } catch {}
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(p, { headers: { "Content-Type": type } });
}

/** Downloads an https URL into storage (admin delivery by link). */
async function putFromUrl(key, url, maxBytes = 300 * 1024 * 1024) {
  if (!/^https:\/\//i.test(url)) throw new Error("the video link must start with https://");
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  const len = Number(r.headers.get("content-length")) || 0;
  if (len > maxBytes) throw new Error("video too large");
  const type = /^video\//.test(r.headers.get("content-type") || "") ? r.headers.get("content-type") : "video/mp4";
  if (len) return put(key, Readable.fromWeb(r.body), { contentType: type, contentLength: len });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("video too large");
  return put(key, buf, { contentType: type });
}

module.exports = { mode, put, getBuffer, size, remove, move, presignGet, putFromUrl, devHandler, get ready() { return mode !== "off"; } };
