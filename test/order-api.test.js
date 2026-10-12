// POST /api/order rejects missing / invalid contact details before anything is created.
// Runs without a database: validation happens first and returns 400 naming the field.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = ""; // make sure nothing could be written even if a .env sets one
const { app } = require("../server");

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (order) =>
  fetch(`${base}/api/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "إعلان لمطعم" }], order: { quality: 1080, seconds: 15, ...order } }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("missing telegram username → 400 telegram", async () => {
  const r = await post({ phone: "07501234567" });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, "telegram");
});

test("missing phone → 400 phone", async () => {
  const r = await post({ telegram: "@ahmed_vi" });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, "phone");
});

test("invalid formats → 400 naming the field", async () => {
  assert.equal((await post({ telegram: "ab", phone: "07501234567" })).body.field, "telegram");
  assert.equal((await post({ telegram: "@ahmed_vi", phone: "12345" })).body.field, "phone");
});
