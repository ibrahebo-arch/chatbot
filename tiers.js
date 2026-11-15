/**
 * VI Iraq – the three paid video models (owner, 2026-11-15). The customer picks a MODEL and, separately, a QUALITY
 * (480p / 720p / 1080p) – nine prices. Each model is a different AI video model:
 *   WI_IRAQ   ★★★    Wan 3.0
 *   KING_IRAQ ★★★★   Kling 3
 *   VIP_IRAQ  ★★★★★  Kling 3 + a quality check of every part (a weak part is made again once)
 * Price per second (server.js): the quality's rate + $0.20 (PRICE_MODEL_STEP) per star step above WI_IRAQ.
 */
const MODELS = {
  wi: { name: "WI_IRAQ", stars: 3, step: 0, engine: "wan", check: false, about: "Wan 3.0" },
  king: { name: "KING_IRAQ", stars: 4, step: 1, engine: "kling", check: false, about: "Kling 3" },
  vip: { name: "VIP_IRAQ", stars: 5, step: 2, engine: "kling", check: true, about: "Kling 3 + quality check" },
};
const KEYS = Object.keys(MODELS);
const QUALITIES = [480, 720, 1080];
/** A model key from a request ("wi" | "king" | "vip"); anything else → WI_IRAQ. Pure – tested. */
const modelOf = (m) => (KEYS.includes(String(m || "").toLowerCase()) ? String(m).toLowerCase() : "wi");
const starsOf = (n) => "★".repeat(n);
/** "VIP_IRAQ ★★★★★". */
const modelLabel = (m) => (MODELS[m] ? `${MODELS[m].name} ${starsOf(MODELS[m].stars)}` : "");
/** For the customer: "VIP_IRAQ ★★★★★ · 1080p" (orders from before the models: "1080p"). */
const orderLabel = (m, q) => (MODELS[m] ? `${modelLabel(m)} · ${q}p` : `${q}p`);
/** For the team: "VIP_IRAQ ★★★★★ · 1080p (Kling 3 + quality check)". */
const teamLabel = (m, q) => (MODELS[m] ? `${orderLabel(m, q)} (${MODELS[m].about})` : `${q}p`);

module.exports = { MODELS, KEYS, QUALITIES, modelOf, modelLabel, orderLabel, teamLabel };
