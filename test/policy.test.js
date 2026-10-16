// Terms (public/policy.json), the WhatsApp contact, and the order gate wiring – no database, no OpenAI.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.DATABASE_URL = "";
process.env.FAL_KEY = "";
const { app } = require("../server");
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "policy.json"), "utf8"));

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("terms have the same 6 sections in Arabic and English, each with items", () => {
  for (const lang of ["ar", "en"]) {
    assert.deepEqual(policy[lang].sections.map((s) => s.n), [1, 2, 3, 4, 5, 6], lang);
    for (const s of policy[lang].sections) assert.ok(s.title && s.items.length, `${lang} section ${s.n}`);
  }
  policy.ar.sections.forEach((s, i) => assert.equal(s.items.length, policy.en.sections[i].items.length, `section ${s.n}: same number of points`));
});

test("terms file is served and the WhatsApp number reaches the page", async () => {
  const p = await fetch(`${base}/policy.json`);
  assert.equal(p.status, 200);
  assert.equal((await p.json()).en.sections.length, 6);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.match(cfg.whatsapp, /^964\d{10}$/);
});

test("without FAL_KEY the free trial is off: tab hidden by config, start route 404", async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.trial, false);
  assert.equal((await (await fetch(`${base}/api/trial`)).json()).enabled, false);
  assert.equal((await fetch(`${base}/api/trial/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
});

test("the page has the contact tab, the terms area and the floating WhatsApp button", async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const id of ['data-tab="contact"', 'id="view-contact"', 'id="termsBody"', 'id="waFloat"', 'id="waContact"']) assert.ok(html.includes(id), id);
});
