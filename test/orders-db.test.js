// Database tests (rate limit, idempotency, normalization, CHECK constraints).
// Needs TEST_DATABASE_URL; runs inside a throw-away schema that is dropped at the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Client } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && "set TEST_DATABASE_URL to run the database tests";
const schema = `vi_test_${crypto.randomBytes(4).toString("hex")}`;
const ssl = () => { try { return new URL(URL_).hostname.includes(".render.com") ? { rejectUnauthorized: false } : false; } catch { return false; } };

let orders, db, admin;
test.before(async () => {
  if (skip) return;
  admin = new Client({ connectionString: URL_, ssl: ssl() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  process.env.DATABASE_URL = URL_;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  db = require("../db");
  orders = require("../orders");
  await db.initDb();
});
test.after(async () => {
  if (skip) return;
  await db.pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const { normalizeTelegram: tgn, normalizePhone: ph } = require("../validate");
const opts = { quality: 1080, seconds: 15, price: 20 };

test("07501234567 and +9647501234567 are the same requester", { skip }, async () => {
  const a = await orders.createOrder({ telegram: tgn("@Same_User1"), phone: ph("07501234567"), options: opts });
  assert.equal(a.created, true);
  const r = (await db.query("SELECT phone, telegram_username FROM requesters WHERE id = $1", [a.order.requester_id])).rows[0];
  assert.deepEqual(r, { phone: "+9647501234567", telegram_username: "same_user1" });
  await assert.rejects(orders.createOrder({ telegram: tgn("same_user1"), phone: ph("+9647501234567"), options: opts }), { code: "rate_limited" });
  assert.equal((await db.query("SELECT count(*)::int n FROM requesters WHERE phone = '+9647501234567'")).rows[0].n, 1);
});

test("second order inside 20 minutes is rejected while the first is in progress (same requester, phone, username)", { skip }, async () => {
  const first = await orders.createOrder({ telegram: "rate_user1", phone: "+9647701112233", options: opts });
  assert.equal(first.created, true);
  const again = orders.createOrder({ telegram: "rate_user1", phone: "+9647701112233", options: opts });
  await assert.rejects(again, (e) => e.code === "rate_limited" && e.retryAfterSec > 1100 && e.retryAfterSec <= 1200);
  // a new requester_id with the same phone or the same username is still limited
  await assert.rejects(orders.createOrder({ telegram: "other_name1", phone: "+9647701112233", options: opts }), { code: "rate_limited" });
  await assert.rejects(orders.createOrder({ telegram: "rate_user1", phone: "+9647709998877", options: opts }), { code: "rate_limited" });
  // 20 minutes later it is allowed again
  await db.query("UPDATE orders SET created_at = now() - interval '21 minutes' WHERE request_id = $1", [first.order.request_id]);
  assert.equal((await orders.createOrder({ telegram: "rate_user1", phone: "+9647701112233", options: opts })).created, true);
});

test("after the video is received the customer can order again right away", { skip }, async () => {
  const first = await orders.createOrder({ telegram: "again_user1", phone: "+9647722223333", options: opts });
  await assert.rejects(orders.createOrder({ telegram: "again_user1", phone: "+9647722223333", options: opts }), { code: "rate_limited" });
  await db.query("UPDATE orders SET status = 'delivered' WHERE request_id = $1", [first.order.request_id]);
  assert.equal((await orders.createOrder({ telegram: "again_user1", phone: "+9647722223333", options: opts })).created, true);
});

test("idempotency key returns the same order instead of a second one", { skip }, async () => {
  const key = crypto.randomUUID();
  const a = await orders.createOrder({ telegram: "idem_user1", phone: "+9647801234567", idempotencyKey: key, options: opts });
  const [b, c] = await Promise.all([1, 2].map(() => orders.createOrder({ telegram: "idem_user1", phone: "+9647801234567", idempotencyKey: key, options: opts })));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(c.created, false);
  assert.equal(b.order.request_id, a.order.request_id);
  assert.equal((await db.query("SELECT count(*)::int n FROM orders WHERE requester_id = $1", [a.order.requester_id])).rows[0].n, 1);
});

test("database CHECKs reject bad contact values even without the app", { skip }, async () => {
  await assert.rejects(db.query("INSERT INTO requesters (id, telegram_username, phone) VALUES ('x', '@Bad', '+9647501234567')"));
  await assert.rejects(db.query("INSERT INTO requesters (id, telegram_username, phone) VALUES ('y', 'good_name', '07501234567')"));
  await assert.rejects(db.query("INSERT INTO requesters (id, telegram_username, phone) VALUES ('z', 'good_name', NULL)"));
});

test("order stays queued until Telegram is linked, then waits for the admin (AUTO_GENERATE=false)", { skip }, async () => {
  delete process.env.AUTO_GENERATE;
  const { order } = await orders.createOrder({ telegram: "link_user1", phone: "+9647511112222", options: opts });
  assert.equal(await orders.advance(order.request_id), null);
  assert.equal((await orders.getOrder(order.request_id)).status, "queued");
  const wrong = await orders.linkTelegram(order.request_id, 111, "someone_else");
  assert.equal(wrong.reason, "username_mismatch");
  const ok = await orders.linkTelegram(order.request_id, 111, "Link_User1");
  assert.equal(ok.ok, true);
  assert.equal(ok.order.status, "awaiting_admin");
  const kinds = (await db.query("SELECT kind FROM events WHERE request_id = $1 ORDER BY id", [order.request_id])).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["created", "telegram_linked", "status"]);
});

test("owner check needs requester id and access token", { skip }, async () => {
  const { order } = await orders.createOrder({ telegram: "owner_user1", phone: "+9647533334444", options: opts });
  assert.ok(await orders.getOwnedOrder(order.request_id, order.requester_id, order.access_token));
  assert.equal(await orders.getOwnedOrder(order.request_id, order.requester_id, "wrong-token"), null);
  assert.equal(await orders.getOwnedOrder(order.request_id, "someone-9647500000000", order.access_token), null);
});

test("updated_at is maintained by the trigger", { skip }, async () => {
  const { order } = await orders.createOrder({ telegram: "time_user1", phone: "+9647544445555", options: opts });
  await new Promise((r) => setTimeout(r, 1100));
  await orders.saveBrief(order.request_id, "# brief");
  const after = (await db.query("SELECT updated_at FROM orders WHERE request_id = $1", [order.request_id])).rows[0].updated_at;
  assert.ok(after.getTime() - new Date(order.updated_at).getTime() >= 1000, "updated_at should move forward on UPDATE");
});
