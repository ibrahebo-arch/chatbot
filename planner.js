/**
 * VI Iraq – turns the customer's chat into a complete production plan for the media model.
 *
 *   1. ChatGPT (PROMPT_MODEL, default gpt-6-sol) writes the plan as JSON, following
 *      prompts/media-prompt-guide.md: English prompt, negative, speech line (Iraqi by default),
 *      on-screen text, shot beats.
 *   2. Claude (claude-opus-5-5, when ANTHROPIC_API_KEY is set) reviews it against the same guide and
 *      returns the corrected plan – wrong dialect, missing motion, too-long speech, contradictions.
 *   3. If a step fails, the previous result is used; if everything fails, the customer's words are
 *      the prompt. The trial never waits on a broken model.
 *
 * plan = { prompt, negative, speech: { lang, text, voice, tone } | null, onScreenText: {...} | null, shots: [] }
 */
const fs = require("fs");
const path = require("path");

const clean = (v) => String(v || "").trim();
const GUIDE = fs.readFileSync(path.join(__dirname, "prompts", "media-prompt-guide.md"), "utf8");
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const PROMPT_MODEL = clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const FALLBACK_MODEL = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const ANTHROPIC_KEY = clean(process.env.ANTHROPIC_API_KEY);
const CLAUDE_MODEL = clean(process.env.CLAUDE_MODEL) || "claude-opus-5-5";

const LANG_NAMES = { "ar-IQ": "Iraqi Arabic dialect", ar: "Modern Standard Arabic", en: "English", ku: "Kurdish", tr: "Turkish", fa: "Persian", none: "no voice" };
const normLang = (l) => (LANG_NAMES[l] ? l : "ar-IQ");

function task({ kind, style, seconds, voiceLang, hasReferenceImage }) {
  const voice = voiceLang === "none" ? "The customer wants NO voice: speech must be null; describe ambient sound only."
    : `Spoken language for speech.text: ${LANG_NAMES[voiceLang]} (${voiceLang}).`;
  return kind === "video"
    ? `TASK: a ${seconds}-second ${style} VIDEO.${hasReferenceImage ? " The first frame is the customer's own picture (image-to-video): keep that exact scene, character and clothes, and describe only the motion, camera and sound." : ""} ${voice} Fit the action and the speech into ${seconds} seconds.`
    : `TASK: one ${style} PICTURE (no video, no speech: speech must be null).`;
}

function conversationText(conversation) {
  return conversation.map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${String(m.content || "").slice(0, 1500)}`).join("\n").slice(-7000);
}

function parsePlan(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  let p; try { p = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!p || typeof p.prompt !== "string" || p.prompt.trim().length < 10) return null;
  const speech = p.speech && typeof p.speech === "object" && clean(p.speech.text) ? {
    lang: normLang(clean(p.speech.lang)), text: clean(p.speech.text).slice(0, 400),
    voice: ["male", "female", "child"].includes(p.speech.voice) ? p.speech.voice : "male", tone: clean(p.speech.tone).slice(0, 120),
  } : null;
  const ost = p.onScreenText && typeof p.onScreenText === "object" && clean(p.onScreenText.text) ? {
    text: clean(p.onScreenText.text).slice(0, 80), lang: clean(p.onScreenText.lang).slice(0, 10), placement: clean(p.onScreenText.placement).slice(0, 120),
  } : null;
  return {
    prompt: p.prompt.trim().slice(0, 1500),
    negative: clean(p.negative).slice(0, 300) || "blurry, deformed hands, extra fingers, distorted face, duplicate person, watermark",
    speech, onScreenText: ost,
    shots: Array.isArray(p.shots) ? p.shots.map((x) => clean(x).slice(0, 200)).filter(Boolean).slice(0, 4) : [],
  };
}

async function chatgpt(model, system, user) {
  const reasoning = /^(gpt-[5-9]|o\d)/.test(model);
  const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" } };
  if (reasoning) body.max_completion_tokens = 2500; else { body.max_tokens = 900; body.temperature = 0.4; }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  return data.choices?.[0]?.message?.content || "";
}

/** Step 1 – ChatGPT writes the plan. */
async function draft(conversation, opts) {
  const user = `${task(opts)}\n\nCONVERSATION:\n${conversationText(conversation)}`;
  for (const model of [PROMPT_MODEL, FALLBACK_MODEL]) {
    try {
      const plan = parsePlan(await chatgpt(model, GUIDE, user));
      if (plan) return { plan, by: model };
    } catch (e) { console.error(`planner draft (${model}):`, e.message); }
  }
  return null;
}

/** Step 2 – Claude corrects the plan against the guide (only when a key is set). */
let anthropic = null;
async function review(plan, conversation, opts) {
  if (!ANTHROPIC_KEY) return null;
  try {
    if (!anthropic) { const Anthropic = require("@anthropic-ai/sdk"); anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY }); }
    const r = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: "medium" },
      system: [{ type: "text", text: GUIDE + "\n\nYou are the REVIEWER. You receive a draft plan written by another model. Check it against every section of the guide and against the customer's conversation, fix everything that is wrong or missing (dialect, motion beats, camera, Iraqi place detail, speech length, on-screen text spelling, contradictions, anatomy/quality lines) and return the corrected plan as the same JSON object only.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `${task(opts)}\n\nCONVERSATION:\n${conversationText(conversation)}\n\nDRAFT PLAN:\n${JSON.stringify(plan)}` }],
    });
    if (r.stop_reason === "refusal") return null;
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return parsePlan(text);
  } catch (e) {
    console.error("planner review (claude):", e.message);
    return null;
  }
}

/**
 * The complete plan for a trial job.
 * opts: { kind, style, seconds, voiceLang, hasReferenceImage }
 */
async function plan(conversation, opts) {
  const o = { ...opts, voiceLang: opts.voiceLang === "none" ? "none" : normLang(opts.voiceLang) };
  const own = conversation.filter((m) => m.role === "user").map((m) => m.content).join("\n").slice(0, 900);
  if (!OPENAI_KEY) return { plan: { prompt: own, negative: "", speech: null, onScreenText: null, shots: [] }, by: "customer" };
  const d = await draft(conversation, o);
  if (!d) return { plan: { prompt: own, negative: "", speech: null, onScreenText: null, shots: [] }, by: "customer" };
  const fixed = await review(d.plan, conversation, o);
  const p = fixed || d.plan;
  if (o.kind !== "video" || o.voiceLang === "none") p.speech = null;
  return { plan: p, by: fixed ? `${d.by}+${CLAUDE_MODEL}` : d.by };
}

module.exports = { plan, parsePlan, normLang, LANG_NAMES, PROMPT_MODEL, CLAUDE_MODEL, reviewEnabled: Boolean(ANTHROPIC_KEY) };
