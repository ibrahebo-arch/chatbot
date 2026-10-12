const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTelegram, normalizePhone, requesterIdFor } = require("../validate");

test("telegram: missing or invalid is rejected", () => {
  for (const v of [undefined, null, "", "   ", "@", "abcd", "a".repeat(33), "ahmed vi", "ahmed-vi", "أحمد_123", "@@ahmed_vi"]) {
    assert.equal(normalizeTelegram(v), "", `should reject ${JSON.stringify(v)}`);
  }
});

test('telegram: "@name" is normalized (no @, lowercase)', () => {
  assert.equal(normalizeTelegram("@Ahmed_VI"), "ahmed_vi");
  assert.equal(normalizeTelegram("  ahmed_vi  "), "ahmed_vi");
  assert.equal(normalizeTelegram("https://t.me/Ahmed_VI"), "ahmed_vi");
  assert.equal(normalizeTelegram("abc12"), "abc12");
});

test("phone: missing or invalid is rejected", () => {
  for (const v of [undefined, "", "   ", "0750123456", "075012345678", "06501234567", "+9646501234567", "9647501234567", "+964750123456", "+1 202 555 0100", "07501234abc"]) {
    assert.equal(normalizePhone(v), "", `should reject ${JSON.stringify(v)}`);
  }
});

test("phone: all accepted Iraqi forms normalize to the same E.164 number", () => {
  const want = "+9647501234567";
  for (const v of ["07501234567", "7501234567", "009647501234567", "+9647501234567", "0750 123 4567", "+964 750-123-4567"]) {
    assert.equal(normalizePhone(v), want, `${v}`);
  }
  assert.equal(normalizePhone("07501234567"), normalizePhone("+9647501234567"));
});

test("requester id is derived from the normalized pair", () => {
  assert.equal(requesterIdFor(normalizeTelegram("@Ahmed_VI"), normalizePhone("07501234567")), "ahmed_vi-9647501234567");
});
