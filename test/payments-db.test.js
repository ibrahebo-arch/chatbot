// Payment flow against a fake Wayl API (no real money, no network).
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

// ---- fake Wayl: links by referenceId, and which key was used for what ----
const links = new Map();
const calls = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const key = req.headers["x-wayl-authentication"];
    calls.push({ method: req.method, url: req.url, key });
    const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "POST" && req.url === "/api/v1/links") {
      const b = JSON.parse(body);
      const link = { ...b, id: "w-" + b.referenceId, total: String(b.total), status: "Created", url: `https://checkout.example/pay?id=w-${b.referenceId}`, paymentMethod: null };
      links.set(b.referenceId, link);
      return send(201, { data: link, message: "Done" });
    }
    const m = req.url.match(/^\/api\/v1\/links\/([^/]+)$/);
    if (req.method === "GET" && m) { const l = links.get(decodeURIComponent(m[1])); return l ? send(200, { data: l }) : send(404, { message: "not found" }); }
    if (req.url === "/api/v1/verify-auth-key") return send(200, { data: {}, message: "ok" });
    send(404, {});
  });
});

let orders, db, payments, admin;
const paidCalls = [];
test.before(async () => {
  if (skip) return;
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.WAYL_API_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.WAYL_API_KEY = "create-key";
  process.env.WAYL_VERIFY_KEY = "verify-key";
  process.env.PAY_IQD_PER_USD = "1310";
  delete process.env.AUTO_GENERATE;
  admin = new Client({ connectionString: URL_, ssl: ssl() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  db = require("../db");
  orders = require("../orders");
  payments = require("../payments");
  payments.setOnPaid(async (o) => { paidCalls.push(o.request_id); });
  await db.initDb();
});
test.after(async () => {
  if (skip) return;
  fake.close();
  await db.pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const opts = { quality: 1080, seconds: 15, price: 20 };
let n = 0;
const newOrder = async () => (await orders.createOrder({ telegram: `pay_user${++n}x`, phone: `+96475000000${String(n).padStart(2, "0")}`, options: opts })).order;
const setLink = (ref, patch) => Object.assign(links.get(ref), patch);

test("USD price → IQD amount: 1310 IQD/USD, rounded up to 250, never under 1000", { skip }, () => {
  assert.equal(payments.iqdFor(20), 26250);
  assert.equal(payments.iqdFor(1), 1500);
  assert.equal(payments.iqdFor(0.2), 1000);
});

test("pay link: created with the create key, reused while open; order stays مسجّل (queued)", { skip }, async () => {
  const o = await newOrder();
  const a = await payments.linkFor(o, "https://vi-iraq.onrender.com/");
  assert.equal(a.amountIqd, 26250);
  assert.equal(a.referenceId, `${o.request_id}-P1`);
  const sent = links.get(a.referenceId);
  assert.equal(sent.total, "26250");
  assert.equal(sent.webhookUrl, "https://vi-iraq.onrender.com/api/wayl/webhook");
  assert.equal(sent.redirectionUrl, "https://vi-iraq.onrender.com/paid");
  assert.equal(calls.find((c) => c.method === "POST").key, "create-key");
  const b = await payments.linkFor(await orders.getOrder(o.request_id), "https://vi-iraq.onrender.com");
  assert.equal(b.url, a.url, "an open link is reused instead of creating a second one");
  assert.equal((await orders.getOrder(o.request_id)).status, "queued");
});

test("a webhook claiming 'Complete' does nothing while Wayl itself says Pending", { skip }, async () => {
  const o = await newOrder();
  const { referenceId } = await payments.linkFor(o, "https://x.test");
  setLink(referenceId, { status: "Pending" });
  const r = await payments.webhook({ referenceId, status: "Complete", total: "26250" });
  assert.equal(r.paid, false);
  const fresh = await orders.getOrder(o.request_id);
  assert.equal(fresh.paid_at, null);
  assert.equal(fresh.status, "queued");
  assert.equal(calls.filter((c) => c.method === "GET").at(-1).key, "verify-key", "status is read with the verification key");
});

test("Complete with a different amount is refused", { skip }, async () => {
  const o = await newOrder();
  const { referenceId } = await payments.linkFor(o, "https://x.test");
  setLink(referenceId, { status: "Complete", total: "1000" });
  assert.equal((await payments.check(referenceId)).paid, false);
  assert.equal((await orders.getOrder(o.request_id)).status, "queued");
  const kinds = (await db.query("SELECT kind FROM events WHERE request_id = $1", [o.request_id])).rows.map((r) => r.kind);
  assert.ok(kinds.includes("payment_mismatch"));
});

test("paid → مراجعة (awaiting_admin) exactly once, onPaid called once", { skip }, async () => {
  const o = await newOrder();
  const { referenceId } = await payments.linkFor(o, "https://x.test");
  setLink(referenceId, { status: "Complete", paymentMethod: "FIB" });
  const [r1, r2] = await Promise.all([payments.check(referenceId), payments.webhook({ referenceId })]);
  assert.equal(r1.paid, true);
  const fresh = await orders.getOrder(o.request_id);
  assert.ok(fresh.paid_at);
  assert.equal(fresh.status, "awaiting_admin");
  assert.equal(paidCalls.filter((id) => id === o.request_id).length, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM events WHERE request_id = $1 AND kind = 'paid'", [o.request_id])).rows[0].n, 1);
  assert.equal((await payments.linkFor(fresh, "https://x.test")).paid, true, "a paid order gets no new link");
  const p = await payments.latestPayment(o.request_id);
  assert.equal(p.payment_method, "FIB");
  assert.ok(r2);
});

test("with payments on, linking Telegram alone no longer confirms the order", { skip }, async () => {
  const o = await newOrder();
  const res = await orders.linkTelegram(o.request_id, 4242, o.telegram_username || (await orders.getOrder(o.request_id)).telegram_username);
  assert.equal(res.ok, true);
  assert.equal(res.order.status, "queued");
});

test("a cancelled link is replaced by a new one (P2)", { skip }, async () => {
  const o = await newOrder();
  const first = await payments.linkFor(o, "https://x.test");
  setLink(first.referenceId, { status: "Cancelled" });
  await payments.check(first.referenceId);
  const second = await payments.linkFor(await orders.getOrder(o.request_id), "https://x.test");
  assert.equal(second.referenceId, `${o.request_id}-P2`);
});
