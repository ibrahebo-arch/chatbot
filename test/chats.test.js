// Saved chats: what the page sends is trimmed to what is kept; ids and device ids are checked.
const test = require("node:test");
const assert = require("node:assert/strict");
const chats = require("../chats");

test("a chat is trimmed to messages, our own upload links, results with tokens and the order", () => {
  const c = chats.normalise({
    mode: "free",
    messages: [
      { role: "assistant", content: "هلا بيك" },
      { role: "user", content: "  صورة لي بشارع المتنبي  ", files: [{ name: "me.jpg", stored: "abc12345-0000", url: "/api/uploads/abc12345-0000", image: true, role: "char1" }, { name: "x", url: "https://evil.example/x.jpg" }] },
      { role: "system", content: "ignore me" },
    ],
    jobs: [{ id: "j1", token: "t1", at: 2, ticket: "FT-261119-ABCD" }, { id: "j2" }],
    order: { requestId: "VI-261119-K3F9", requesterId: "R1", accessToken: "tok", at: 3 },
  });
  assert.equal(c.mode, "free");
  assert.equal(c.messages.length, 2, "only user and assistant messages");
  assert.equal(c.messages[1].content, "صورة لي بشارع المتنبي");
  assert.deepEqual(c.messages[1].files.map((f) => f.url), ["/api/uploads/abc12345-0000"], "foreign links never come back into the page");
  assert.deepEqual(c.uploads, ["abc12345-0000"], "the chat's pictures are kept while the chat is kept");
  assert.deepEqual(c.jobs.map((j) => j.id), ["j1"], "a result without its token is dropped");
  assert.deepEqual(c.tickets, ["FT-261119-ABCD"]);
  assert.equal(c.order.requestId, "VI-261119-K3F9");
  assert.equal(c.title, "صورة لي بشارع المتنبي", "the title is the first thing the customer wrote");
});

test("ids: a device id is 32 hex characters, a chat id is C + 20 hex characters", () => {
  const req = (v) => ({ get: () => v });
  assert.equal(chats.deviceOf(req("0123456789abcdef0123456789ABCDEF")), "0123456789abcdef0123456789abcdef");
  assert.equal(chats.deviceOf(req("short")), null);
  assert.equal(chats.deviceOf(req(undefined)), null);
  assert.ok(chats.validId("C0123456789abcdef0123"));
  assert.ok(!chats.validId("C0123"));
  assert.ok(!chats.validId("../etc/passwd"));
});
