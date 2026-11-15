/**
 * VI Iraq – the three paid video models the customer picks (owner, 2026-11-15). Each is one output quality;
 * the price per second is in server.js (RATES). Shown to customers by name and stars, to the team with the resolution.
 */
const TIERS = {
  480: { name: "WI_IRAQ", stars: 3 },
  720: { name: "KING_IRAQ", stars: 4 },
  1080: { name: "VIP_IRAQ", stars: 5 },
};
const starsOf = (n) => "★".repeat(n);
/** "VIP_IRAQ ★★★★★" for a quality (480 / 720 / 1080); unknown → its resolution. Pure – tested. */
const tierLabel = (q) => (TIERS[q] ? `${TIERS[q].name} ${starsOf(TIERS[q].stars)}` : `${q}p`);
/** For the team: "VIP_IRAQ ★★★★★ (1080p)". */
const tierTeam = (q) => (TIERS[q] ? `${tierLabel(q)} (${q}p)` : `${q}p`);

module.exports = { TIERS, tierLabel, tierTeam };
