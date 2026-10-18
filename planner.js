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
const library = require("./library");

const clean = (v) => String(v || "").trim();
const GUIDE = fs.readFileSync(path.join(__dirname, "prompts", "media-prompt-guide.md"), "utf8");
const RULES = "READ THIS FIRST. The guide below is binding, not advice. Before you write, read every section (1-10) and apply each one that fits the request: the JSON format (section 1), the prompt order (2), real-person rules (3), motion beats (4), living humanoid presence – breathing, blinking, facial reactions (4b), Iraqi places (5), named places and the LOCATION REFERENCE (5b), speech length and dialect (6), voices and characters – the speaker matches the chosen voice, fixed words stay exact (6b), exact on-screen text (7), cartoon mode (8), customer pictures (8b), the quality checklist (9) and the reply language (10). The REALITY LIBRARY block in the request (core + entries matched to this customer's words: people, physics, sounds, places, items, actions) is binding too: turn every point that fits into concrete visible and audible detail. If the customer's wish and a rule conflict, keep the customer's idea and satisfy the rule another way. Never output anything except the JSON object.\n\n";
const RULES_END = "\n\n---\nFINAL CHECK before you answer: go through section 9 line by line; the prompt is English, follows the section 2 order, has concrete motion beats for video, keeps the customer's exact words for on-screen text, and the speech is short natural dialect that fits the clip length. Fix anything that fails, then output the JSON only.";
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const PROMPT_MODEL = clean(process.env.PROMPT_MODEL) || "gpt-6-sol";
const FALLBACK_MODEL = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";
const ANTHROPIC_KEY = clean(process.env.ANTHROPIC_API_KEY);
const CLAUDE_MODEL = clean(process.env.CLAUDE_MODEL) || "claude-opus-5-5";

const LANG_NAMES = { "ar-IQ": "Iraqi Arabic dialect", ar: "Modern Standard Arabic", en: "English", ku: "Kurdish", tr: "Turkish", fa: "Persian", none: "no voice" };
const normLang = (l) => (LANG_NAMES[l] ? l : "ar-IQ");

const ROLE_NAMES = { char1: "Character 1 (a person who must appear)", char2: "Character 2 (a person who must appear)", char3: "Character 3 (a person who must appear)", ref: "a reference for style, place or product (not a person to copy)" };

/** What to tell the model about the pictures the customer sent in the chat (they are attached as images). */
function picturesNote(kind, refs) {
  if (!refs?.length) return "";
  const list = refs.map((r, i) => `Picture ${i + 1} = ${ROLE_NAMES[r.role] || ROLE_NAMES.ref}`).join("; ");
  return kind === "video"
    ? ` CUSTOMER PICTURES (attached, in this order): ${list}. Picture 1 is used as the FIRST FRAME of the video (image-to-video): describe exactly what you see in it (face, hair, clothes, place) so nothing changes, and write only the motion, the camera and the sound. Do not ask for a different person or place.`
    : ` CUSTOMER PICTURES (attached, in this order): ${list}. The result is an edit that puts the people from the character pictures into the new scene: say who from which picture appears, with the face, hair and clothes exactly as in their picture. Reference pictures only give style, place or product.`;
}

const AGE_WORDS = { child: "a child about 8–12 years old", young: "a young person about 18–25", adult: "an adult about 30–50", old: "an elderly person over 60" };
const GENDER_WORDS = { female: "female", male: "male" };

/** What the planner must know about the voice the customer chose (guide §6b). */
function voiceNote(v) {
  if (!v || v.mode === "none") return "";
  const who = v.gender && v.age ? `${GENDER_WORDS[v.gender]}, ${AGE_WORDS[v.age]}` : "";
  let s = who ? ` SPEAKING CHARACTER (chosen by the customer): ${who}. The person on screen who speaks MUST match this gender and age; set speech.gender="${v.gender}" and speech.age="${v.age}".` : " Choose the speaking character from the idea and set speech.gender and speech.age to match the person on screen.";
  if (v.fixedText) {
    s += ` The spoken words are FIXED (the customer's own recording${v.mode === "own" ? ", used as the soundtrack exactly as recorded" : ", read again in the character's voice"}): "${String(v.fixedText).slice(0, 400)}". Set speech.text to exactly these words – do not change, translate or shorten them.`;
    if (v.audioSeconds) s += ` The recording lasts about ${Number(v.audioSeconds).toFixed(1)} s: the character speaks during that time, then reacts naturally without speaking.`;
  }
  return s;
}

function task({ kind, style, seconds, voiceLang, hasReferenceImage, refs = [], voice: v = null }) {
  const voice = voiceLang === "none" ? "The customer wants NO voice: speech must be null; describe ambient sound only."
    : `Spoken language for speech.text: ${LANG_NAMES[voiceLang]} (${voiceLang}).${voiceNote(v)}`;
  return kind === "video"
    ? `TASK: a ${seconds}-second ${style} VIDEO.${hasReferenceImage ? " The first frame is the customer's own picture (image-to-video): keep that exact scene, character and clothes, and describe only the motion, camera and sound." : ""}${picturesNote(kind, refs)} ${voice} Fit the action and the speech into ${seconds} seconds.`
    : `TASK: one ${style} PICTURE (no video, no speech: speech must be null).${picturesNote(kind, refs)}`;
}

/** The user message for the planner: text, plus the customer's pictures as images when there are any. */
function userContent(text, refs = []) {
  if (!refs.length) return text;
  return [{ type: "text", text }, ...refs.map((r) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${r.buf.toString("base64")}`, detail: "auto" } }))];
}

/**
 * Real places the customer names (Arabic or English). Their typical look is added to the request so the picture or
 * video shows that place and not a generic street; places that are not in the list are handled by the guide (§5b).
 */
const LOCATIONS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "prompts", "locations.json"), "utf8")); } catch { return []; } })();
const normAr = (s) => String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
function locationsIn(text, max = 3) {
  const t = normAr(text);
  const hits = LOCATIONS.filter((l) => l.names.some((n) => {
    const k = normAr(n);
    return /^[a-z0-9 .'-]+$/.test(k) ? new RegExp("(^|[^a-z])" + k.split(".").join("[.]") + "([^a-z]|$)").test(t) : t.includes(k);
  }));
  hits.sort((a, b) => b.look.length - a.look.length); // the most specific places first (a district before its city)
  return hits.slice(0, max);
}
function locationNote(conversation) {
  const own = conversation.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const hits = locationsIn(own);
  if (!hits.length) return "";
  return "\n\nLOCATION REFERENCE – the customer named these real places. Show them as they really look (landmarks, architecture, street life) and keep these details in the prompt:\n" + hits.map((l) => "- " + l.look).join("\n");
}

/** The reality library block for this request (computed once per plan; the place list alone without plan opts). */
const knowledge = (conversation, opts) => (opts && typeof opts.libraryNote === "string" ? opts.libraryNote : locationNote(conversation));

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
    ...(["female", "male"].includes(p.speech.gender) ? { gender: p.speech.gender } : {}),
    ...(["child", "young", "adult", "old"].includes(p.speech.age) ? { age: p.speech.age } : {}),
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
  const user = userContent(`${task(opts)}\n\nCONVERSATION:\n${conversationText(conversation)}${knowledge(conversation, opts)}`, opts.refs);
  for (const model of [PROMPT_MODEL, FALLBACK_MODEL]) {
    try {
      const plan = parsePlan(await chatgpt(model, RULES + GUIDE + RULES_END, user));
      if (plan) return { plan, by: model };
    } catch (e) { console.error(`planner draft (${model}):`, e.message); }
  }
  return null;
}

/** Step 2 – Claude corrects the plan against the guide (only when a key is set). */
let anthropic = null;
/** Without a Claude key the same prompt model re-reads the guide and corrects its own draft. */
async function selfReview(plan, conversation, opts, model) {
  try {
    const user = userContent(`${task(opts)}

CONVERSATION:
${conversationText(conversation)}${knowledge(conversation, opts)}

DRAFT PLAN (written by you a moment ago):
${JSON.stringify(plan)}

You are now the REVIEWER. Check the draft against every numbered section of the guide, one by one, and against the customer's words. Fix what fails (dialect, speech length, motion beats, camera, Iraqi place detail, on-screen text spelling, contradictions, quality lines). Return the corrected plan as the same JSON object only.`, opts.refs);
    return parsePlan(await chatgpt(model, RULES + GUIDE + RULES_END, user));
  } catch (e) { console.error(`planner self-review (${model}):`, e.message); return null; }
}

async function review(plan, conversation, opts) {
  if (!ANTHROPIC_KEY) return null;
  try {
    if (!anthropic) { const Anthropic = require("@anthropic-ai/sdk"); anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY }); }
    const r = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: "medium" },
      system: [{ type: "text", text: GUIDE + "\n\nYou are the REVIEWER. You receive a draft plan written by another model. Check it against every section of the guide and against the customer's conversation, fix everything that is wrong or missing (dialect, motion beats, camera, Iraqi place detail, speech length, on-screen text spelling, contradictions, anatomy/quality lines) and return the corrected plan as the same JSON object only.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `${task(opts)}\n\nCONVERSATION:\n${conversationText(conversation)}${knowledge(conversation, opts)}\n\nDRAFT PLAN:\n${JSON.stringify(plan)}` }],
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
  const lib = library.note(conversation, o.kind === "video" ? "video" : "image");
  o.libraryNote = lib.text;
  const own = conversation.filter((m) => m.role === "user").map((m) => m.content).join("\n").slice(0, 900);
  if (!OPENAI_KEY) return { plan: applyVoice({ prompt: own, negative: "", speech: null, onScreenText: null, shots: [] }, o), by: "customer" };
  const d = await draft(conversation, o);
  if (!d) return { plan: applyVoice({ prompt: own, negative: "", speech: null, onScreenText: null, shots: [] }, o), by: "customer" };
  const claude = await review(d.plan, conversation, o);
  const second = claude ? null : (ANTHROPIC_KEY ? null : await selfReview(d.plan, conversation, o, d.by));
  const fixed = claude || second;
  const p = fixed || d.plan;
  applyVoice(p, o);
  if (o.kind === "video" && !/frozen|mannequin/i.test(p.negative || "")) p.negative = [p.negative, "frozen face, mannequin stillness, statue-like pose, no blinking, dead eyes, rigid stare"].filter(Boolean).join(", ");
  return { plan: p, by: claude ? `${d.by}+${CLAUDE_MODEL}` : second ? `${d.by}+review` : d.by, library: lib.ids };
}

/**
 * The customer's voice choice always wins over the model (pure – tested): no voice → speech null; their own
 * words → speech.text is exactly the recording; a chosen character → speech.gender / speech.age.
 */
function applyVoice(p, o) {
  const v = o.voice || null;
  if (o.kind !== "video" || o.voiceLang === "none" || v?.mode === "none") { p.speech = null; return p; }
  if (v?.fixedText) {
    p.speech = { lang: o.voiceLang || p.speech?.lang || "ar-IQ", tone: "", voice: "male", ...(p.speech || {}), text: String(v.fixedText).slice(0, 400) };
  }
  if (p.speech && v?.gender) p.speech.gender = v.gender;
  if (p.speech && v?.age) p.speech.age = v.age;
  return p;
}

module.exports = { locationsIn, locationNote, plan, parsePlan, applyVoice, voiceNote, userContent, task, normLang, LANG_NAMES, PROMPT_MODEL, CLAUDE_MODEL, reviewEnabled: Boolean(ANTHROPIC_KEY) };
