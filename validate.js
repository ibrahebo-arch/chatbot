/**
 * Contact validation shared by the order API (the browser mirrors it in public/app.js).
 * Both values are mandatory for an order; the database enforces the same formats with CHECKs.
 */

/** "@Ahmed_VI", "t.me/ahmed_vi" → "ahmed_vi"; "" when invalid (5–32 letters, digits or _). */
function normalizeTelegram(v) {
  const s = String(v ?? "").trim().replace(/^(https?:\/\/)?(www\.)?t\.me\//i, "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s.toLowerCase() : "";
}

/**
 * Iraqi mobile → E.164 "+9647XXXXXXXXX"; "" when invalid.
 * Accepts 07XXXXXXXXX, 7XXXXXXXXX, 009647XXXXXXXXX, +9647XXXXXXXXX (spaces/dashes ignored).
 */
function normalizePhone(v) {
  const s = String(v ?? "").trim().replace(/[\s\-().]/g, "");
  const m = s.match(/^(?:0|\+964|00964)?(7\d{9})$/);
  return m ? `+964${m[1]}` : "";
}

const requesterIdFor = (telegram, phone) => `${telegram}-${phone.replace("+", "")}`;

module.exports = { normalizeTelegram, normalizePhone, requesterIdFor };
