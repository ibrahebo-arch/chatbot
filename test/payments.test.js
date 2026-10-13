// Payment routes without a database or Wayl keys: everything payment-related stays off.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = "";
process.env.WAYL_API_KEY = "";
const { app } = require("../server");

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("without WAYL_API_KEY: /api/config has no payments, pay and webhook routes are 404", async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.payments, null);
  assert.equal((await fetch(`${base}/api/orders/VI-260101-AAAA/pay`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/api/wayl/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
});
