// Security regressions: headers, rate limits that a fake IP header cannot dodge, admin token lockout.
// Runs without a database (all requests are rejected before anything is stored).
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = "";
process.env.ADMIN_TOKEN = "correct-admin-token-123";
delete process.env.TRUST_PROXY;
const { app } = require("../server");

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const order = (headers) => fetch(`${base}/api/order`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }).then((r) => r.status);

test("security headers are sent and Express is not announced", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self' https:\/\/static\.cloudflareinsights\.com(;|$)/, "own scripts + Cloudflare analytics only");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("strict-transport-security"), /max-age=\d+/);
});

test("a fake first X-Forwarded-For value does not reset the order limit (behind nginx)", async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push(await order({ "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` }));
  assert.deepEqual(codes.slice(5), [429, 429], `got ${codes}`);
});

test("behind Cloudflare the limit follows CF-Connecting-IP, not X-Forwarded-For", async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push(await order({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": `198.51.100.${i}` }));
  assert.deepEqual(codes.slice(5), [429, 429], `got ${codes}`);
});

test("10 wrong admin tokens lock the admin API for that visitor, even with the right token", async () => {
  const ip = { "cf-connecting-ip": "203.0.113.77" };
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/requests`, { headers: { ...ip, "x-admin-token": `wrong-${i}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/requests`, { headers: { ...ip, "x-admin-token": "correct-admin-token-123" } })).status, 429);
});
