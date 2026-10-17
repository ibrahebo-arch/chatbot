/**
 * VI Iraq – the voice of a video.
 *
 *   1. Ready-made character voices (CATALOG): girl / boy / young woman / young man / woman / man / old woman /
 *      old man, several timbres each, from OpenAI TTS and from fal.ai (MiniMax Speech, ElevenLabs v3).
 *      The customer picks one, or "auto" lets the plan choose by the character in the idea.
 *   2. The customer's own recording (record in the chat or upload): checked first – length, loudness, clipping,
 *      silence, words heard, language/dialect, speaker gender and age – then used
 *        "own"     exactly as recorded (their voice inside the video), or
 *        "convert" the same words read by the chosen character voice.
 *   3. Every soundtrack is fitted to the video: up to 25 % faster when a little too long, otherwise cut with a
 *      short fade; very short audio is padded to the 2 s the video model needs.
 *
 * Provider names never reach the customer: the catalog shows only Arabic labels.
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const wm = require("./watermark"); // ffmpeg runner (ffmpeg-static)
const media = require("./media");

const clean = (v) => String(v || "").trim();
const OPENAI_KEY = clean(process.env.OPENAI_API_KEY);
const OPENAI_BASE = (clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com").replace(/\/+$/, "");
const FAL_KEY = clean(process.env.FAL_KEY);
const FAL_RUN = (clean(process.env.FAL_RUN_URL) || "https://fal.run").replace(/\/+$/, "");
const MINIMAX_MODEL = clean(process.env.VOICE_MINIMAX_MODEL) || "fal-ai/minimax/speech-2.8-hd";
const ELEVEN_MODEL = clean(process.env.VOICE_ELEVEN_MODEL) || "fal-ai/elevenlabs/tts/eleven-v3";
const TRANSCRIBE_MODEL = clean(process.env.TRANSCRIBE_MODEL) || "whisper-1";
const AUDIO_MODELS = [clean(process.env.AUDIO_ANALYZE_MODEL) || "gpt-audio", "gpt-audio-mini"];
const MIN_SECONDS = 2; // the video model needs at least 2 s of audio
const MAX_CLIP_SECONDS = 60;

// ---------- catalog ----------
const PERSONA = {
  "female.child": "You are a cheerful Iraqi girl, about 9 years old, with a light, young, playful voice.",
  "male.child": "You are an energetic Iraqi boy, about 9 years old, with a young, bright voice.",
  "female.young": "You are a friendly Iraqi young woman, about 20, warm and lively.",
  "male.young": "You are a friendly Iraqi young man, about 20, confident and lively.",
  "female.adult": "You are an Iraqi woman, about 35, clear, warm and confident.",
  "male.adult": "You are an Iraqi man, about 40, calm, deep and confident.",
  "female.old": "You are an Iraqi grandmother, about 65, slow, kind and a little husky.",
  "male.old": "You are an Iraqi grandfather, about 68, slow, wise and slightly raspy.",
};
// id → { label (Arabic, shown), gender, age, provider, voice }
const CATALOG = [
  { id: "girl-cheerful", label: "بنت صغيرة – مرحة", gender: "female", age: "child", provider: "openai", voice: "coral" },
  { id: "girl-soft", label: "بنت صغيرة – ناعمة", gender: "female", age: "child", provider: "openai", voice: "shimmer" },
  { id: "girl-lovely", label: "بنت صغيرة – لطيفة", gender: "female", age: "child", provider: "minimax", voice: "Lovely_Girl" },
  { id: "girl-sweet", label: "بنت صغيرة – حلوة", gender: "female", age: "child", provider: "minimax", voice: "Sweet_Girl_2" },
  { id: "boy-energetic", label: "ولد صغير – نشيط", gender: "male", age: "child", provider: "openai", voice: "ash" },
  { id: "boy-playful", label: "ولد صغير – مرح", gender: "male", age: "child", provider: "openai", voice: "verse" },
  { id: "boy-polite", label: "ولد – مؤدب", gender: "male", age: "child", provider: "minimax", voice: "Decent_Boy" },
  { id: "young-woman-warm", label: "شابة – دافئة", gender: "female", age: "young", provider: "elevenlabs", voice: "Lily" },
  { id: "young-woman-lively", label: "شابة – حيوية", gender: "female", age: "young", provider: "elevenlabs", voice: "Jessica" },
  { id: "young-woman-calm", label: "شابة – هادئة", gender: "female", age: "young", provider: "openai", voice: "sage" },
  { id: "young-man-modern", label: "شاب – عصري", gender: "male", age: "young", provider: "elevenlabs", voice: "Liam" },
  { id: "young-man-friendly", label: "شاب – ودود", gender: "male", age: "young", provider: "elevenlabs", voice: "Will" },
  { id: "young-man-confident", label: "شاب – واثق", gender: "male", age: "young", provider: "openai", voice: "echo" },
  { id: "young-man-strong", label: "شاب – قوي", gender: "male", age: "young", provider: "minimax", voice: "Young_Knight" },
  { id: "woman-clear", label: "امرأة – واضحة", gender: "female", age: "adult", provider: "openai", voice: "nova" },
  { id: "woman-steady", label: "امرأة – رزينة", gender: "female", age: "adult", provider: "minimax", voice: "Arabic_CalmWoman" },
  { id: "man-deep", label: "رجل – عميق", gender: "male", age: "adult", provider: "openai", voice: "onyx" },
  { id: "man-friendly", label: "رجل – ودود", gender: "male", age: "adult", provider: "minimax", voice: "Arabic_FriendlyGuy" },
  { id: "old-woman", label: "حجية كبيرة بالعمر", gender: "female", age: "old", provider: "openai", voice: "sage" },
  { id: "old-man", label: "حجي كبير بالعمر", gender: "male", age: "old", provider: "openai", voice: "ash" },
];
const BY_ID = Object.fromEntries(CATALOG.map((v) => [v.id, v]));
// the first choice for each character type (the voices the team liked in the listening test come first)
const DEFAULTS = {
  "female.child": "girl-cheerful", "male.child": "boy-energetic",
  "female.young": "young-woman-warm", "male.young": "young-man-modern",
  "female.adult": "woman-clear", "male.adult": "man-deep",
  "female.old": "old-woman", "male.old": "old-man",
};
const TYPE_LABEL = {
  "female.child": "بنت صغيرة", "male.child": "ولد صغير", "female.young": "شابة", "male.young": "شاب",
  "female.adult": "امرأة", "male.adult": "رجل", "female.old": "امرأة كبيرة بالعمر", "male.old": "رجل كبير بالعمر",
};
const GENDERS = ["female", "male"];
const AGES = ["child", "young", "adult", "old"];
const providerReady = (p) => (p === "openai" ? Boolean(OPENAI_KEY) : Boolean(FAL_KEY));

/** Public catalog for the page (no provider names). */
const publicCatalog = () => ({
  voices: CATALOG.filter((v) => providerReady(v.provider)).map(({ id, label, gender, age }) => ({ id, label, gender, age })),
  types: Object.entries(TYPE_LABEL).map(([key, label]) => ({ key, label, gender: key.split(".")[0], age: key.split(".")[1], preset: DEFAULTS[key] })),
});

/** The preset for a request: an explicit ready preset, else the default for gender+age, else a sensible fallback. */
function pick({ preset, gender, age } = {}) {
  if (preset && BY_ID[preset] && providerReady(BY_ID[preset].provider)) return BY_ID[preset];
  const g = GENDERS.includes(gender) ? gender : "male";
  const a = AGES.includes(age) ? age : "adult";
  const want = BY_ID[DEFAULTS[`${g}.${a}`]];
  if (want && providerReady(want.provider)) return want;
  return CATALOG.find((v) => v.gender === g && v.age === a && providerReady(v.provider)) || CATALOG.find((v) => providerReady(v.provider)) || null;
}
/** Same character type on OpenAI (used when fal fails). */
const openaiTwin = (v) => CATALOG.find((x) => x.provider === "openai" && x.gender === v.gender && x.age === v.age) || CATALOG.find((x) => x.provider === "openai" && x.gender === v.gender);

/** Old plans say voice: male | female | child – map that (plus optional gender/age) to a character type. */
function typeFromSpeech(speech = {}) {
  let gender = GENDERS.includes(speech.gender) ? speech.gender : speech.voice === "female" ? "female" : speech.voice === "male" ? "male" : null;
  let age = AGES.includes(speech.age) ? speech.age : speech.voice === "child" ? "child" : null;
  if (!gender) gender = speech.voice === "child" ? "female" : "male";
  if (!age) age = "adult";
  return { gender, age };
}

// ---------- ffmpeg helpers ----------
async function withFiles(fn) {
  if (!wm.ready) throw new Error("ffmpeg is not available");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vi-voice-"));
  await wm.slot();
  try { return await fn(dir); } finally { wm.release(); fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
const durationOf = (stderr) => {
  const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/** Any audio (webm/ogg/m4a/wav/mp3, or a video's sound) → mono 44.1 kHz MP3, at most MAX_CLIP_SECONDS. */
async function toMp3(buf) {
  return withFiles(async (dir) => {
    const input = path.join(dir, "in.bin"), output = path.join(dir, "out.mp3");
    await fs.writeFile(input, buf);
    const r = await wm.run(["-y", "-v", "error", "-i", input, "-vn", "-t", String(MAX_CLIP_SECONDS), "-ac", "1", "-ar", "44100", "-b:a", "128k", output], 60000);
    if (r.code !== 0) throw new Error("not a readable audio file");
    const out = await fs.readFile(output);
    if (out.length < 800) throw new Error("the recording is empty");
    const info = await wm.run(["-i", output], 20000);
    return { mp3: out, duration: durationOf(info.stderr) };
  });
}

/** Loudness and silence of an MP3. */
async function measure(mp3) {
  return withFiles(async (dir) => {
    const input = path.join(dir, "a.mp3");
    await fs.writeFile(input, mp3);
    const r = await wm.run(["-i", input, "-af", "volumedetect,silencedetect=noise=-40dB:d=0.4", "-f", "null", "-"], 60000);
    const num = (re) => { const m = r.stderr.match(re); return m ? Number(m[1]) : null; };
    const duration = durationOf(r.stderr);
    let silent = 0;
    for (const m of r.stderr.matchAll(/silence_duration:\s*([\d.]+)/g)) silent += Number(m[1]);
    const openStart = [...r.stderr.matchAll(/silence_start:\s*([\d.]+)/g)].length > [...r.stderr.matchAll(/silence_end:/g)].length;
    if (openStart) { const last = [...r.stderr.matchAll(/silence_start:\s*([\d.]+)/g)].pop(); silent += Math.max(0, duration - Number(last[1])); }
    return { duration, meanDb: num(/mean_volume:\s*(-?[\d.]+) dB/), maxDb: num(/max_volume:\s*(-?[\d.]+) dB/), speechShare: duration ? Math.max(0, Math.min(1, 1 - silent / duration)) : 0 };
  });
}

/** How a soundtrack is fitted to `seconds`: speed factor (≤ 1.25) and whether it is cut. Pure – tested. */
function fitPlan(duration, seconds, allowSpeedUp = true) {
  if (!duration || duration <= seconds) return { tempo: 1, cut: false, pad: duration < MIN_SECONDS };
  const ratio = duration / seconds;
  if (allowSpeedUp && ratio <= 1.25) return { tempo: Math.round(ratio * 1000) / 1000, cut: false, pad: false };
  return { tempo: allowSpeedUp ? 1.15 : 1, cut: true, pad: false };
}

/** Fits an MP3 to the video length (see fitPlan); returns { mp3, duration, tempo, cut }. */
async function fit(mp3, seconds, allowSpeedUp = true) {
  const { duration } = await measure(mp3);
  const plan = fitPlan(duration, seconds, allowSpeedUp);
  if (plan.tempo === 1 && !plan.cut && !plan.pad) return { mp3, duration, tempo: 1, cut: false };
  return withFiles(async (dir) => {
    const input = path.join(dir, "a.mp3"), output = path.join(dir, "b.mp3");
    await fs.writeFile(input, mp3);
    const filters = [];
    if (plan.tempo !== 1) filters.push(`atempo=${plan.tempo}`);
    if (plan.pad) filters.push(`apad=whole_dur=${MIN_SECONDS + 0.2}`);
    if (plan.cut) filters.push(`afade=t=out:st=${Math.max(0, seconds - 0.3)}:d=0.3`);
    const args = ["-y", "-v", "error", "-i", input, ...(filters.length ? ["-af", filters.join(",")] : []), ...(plan.cut ? ["-t", String(seconds)] : []), "-ac", "1", "-ar", "44100", "-b:a", "128k", output];
    const r = await wm.run(args, 60000);
    if (r.code !== 0) throw new Error("could not fit the voice to the video");
    const out = await fs.readFile(output);
    return { mp3: out, duration: plan.cut ? seconds : plan.pad ? MIN_SECONDS + 0.2 : duration / plan.tempo, tempo: plan.tempo, cut: plan.cut };
  });
}

// ---------- speech ----------
const LANG_BOOST = { "ar-IQ": "Arabic", ar: "Arabic", en: "English", tr: "Turkish", fa: "Persian", ku: "auto" };

async function falRun(model, body) {
  const r = await fetch(`${FAL_RUN}/${model}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Key ${FAL_KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fal ${r.status} ${JSON.stringify(j.detail || j.message || "").slice(0, 160)}`);
  const url = j.audio?.url || j.audio_url || j.url;
  if (!url || !media.isProviderUrl(url)) throw new Error("fal: no audio returned");
  const a = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!a.ok) throw new Error(`audio download ${a.status}`);
  return Buffer.from(await a.arrayBuffer());
}

async function openaiSpeak(v, { text, lang, tone }) {
  const persona = PERSONA[`${v.gender}.${v.age}`] || "";
  const r = await fetch(`${OPENAI_BASE}/v1/audio/speech`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: media.TTS_MODEL, voice: v.voice, input: String(text).slice(0, 400), response_format: "mp3",
      instructions: `${persona} ${media.ACCENT[lang] || media.ACCENT["ar-IQ"]} ${tone ? "Tone: " + tone + "." : ""} Speak the text exactly as written, no additions.`,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`openai tts ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error("openai tts: empty audio");
  return buf;
}

/**
 * A line spoken by a catalog voice → MP3. fal voices fall back to the same character type on OpenAI,
 * so a video never loses its voice because one provider is down.
 */
async function speak(v, { text, lang = "ar-IQ", tone = "" }) {
  if (!v) throw new Error("no voice available");
  const words = clean(text);
  if (!words) throw new Error("nothing to say");
  try {
    if (v.provider === "minimax") return await falRun(MINIMAX_MODEL, { text: words, voice_setting: { voice_id: v.voice, speed: 1 }, language_boost: LANG_BOOST[lang] || "auto", output_format: "url" });
    if (v.provider === "elevenlabs") return await falRun(ELEVEN_MODEL, { text: words, voice: v.voice });
    return await openaiSpeak(v, { text: words, lang, tone });
  } catch (e) {
    const twin = v.provider === "openai" ? null : openaiTwin(v);
    if (!twin || !OPENAI_KEY) throw e;
    console.error(`voice ${v.id}: ${String(e.message).slice(0, 120)} – using ${twin.id}`);
    return openaiSpeak(twin, { text: words, lang, tone });
  }
}

// ---------- checking a recording ----------
async function transcribe(mp3) {
  if (!OPENAI_KEY) return { text: "", lang: "" };
  const fd = new FormData();
  fd.append("file", new Blob([mp3], { type: "audio/mpeg" }), "voice.mp3");
  fd.append("model", TRANSCRIBE_MODEL);
  fd.append("response_format", TRANSCRIBE_MODEL === "whisper-1" ? "verbose_json" : "json");
  fd.append("prompt", "Iraqi Arabic, Baghdadi dialect, everyday speech.");
  const r = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`transcription ${r.status}`);
  return { text: clean(j.text).slice(0, 600), lang: clean(j.language) };
}

/**
 * An audio model listens to the recording's QUALITY: clarity, noise, music, several speakers, dialect.
 * It is not asked who the speaker is (the models decline to judge gender or age from a voice); the customer
 * says who is speaking on the check card, and that is what the video matches.
 */
async function listen(mp3) {
  if (!OPENAI_KEY) return null;
  const ask = `You check recordings for a video studio. Listen to this recording and rate its audio quality. Answer with ONE JSON object only, no other text:
{"clarity":"good|ok|poor","background_noise":"none|low|high","music":true|false,"several_speakers":true|false,"dialect":"iraqi|other_arabic|standard_arabic|not_arabic|unknown"}`;
  for (const model of AUDIO_MODELS) {
    try {
      const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model, modalities: ["text"], messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } }] }] }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `status ${r.status}`);
      const s = String(j.choices?.[0]?.message?.content || "");
      const a = s.indexOf("{"), b = s.lastIndexOf("}");
      if (a < 0) throw new Error("no JSON");
      return JSON.parse(s.slice(a, b + 1));
    } catch (e) { console.error(`voice listen (${model}):`, String(e.message).slice(0, 140)); }
  }
  return null;
}

/**
 * The verdict shown to the customer (pure – tested): items { level: ok|warn|bad, text } in Arabic.
 * m = measure(), heard = { text, lang }, ai = listen() or null, seconds = video length.
 */
function judge(m, heard, ai, seconds) {
  const items = [];
  const d = Number(m.duration) || 0;
  const add = (level, text) => items.push({ level, text });
  if (d < 1.2) add("bad", "التسجيل قصير جداً – سجّل جملة كاملة (2–10 ثوانٍ).");
  else if (d > seconds) add("warn", `مدة صوتك ${d.toFixed(1)} ث والفيديو ${seconds} ث – سنسرّعه قليلاً أو نقصّ الزائد. الأفضل جملة أقصر.`);
  else add("ok", `المدة ${d.toFixed(1)} ث – مناسبة لفيديو ${seconds} ث.`);
  if (m.maxDb != null && m.maxDb < -24) add("bad", "الصوت منخفض جداً – قرّب الهاتف من فمك وسجّل مرة ثانية.");
  else if (m.maxDb != null && m.maxDb > -0.3) add("warn", "الصوت عالٍ لدرجة التشويش – ابعد الهاتف قليلاً.");
  else add("ok", "مستوى الصوت جيد.");
  if (d >= 1.2 && m.speechShare < 0.3) add("warn", "أغلب التسجيل صمت – تكلّم بشكل متواصل.");
  if (!clean(heard?.text)) add("bad", "لم نسمع كلاماً واضحاً في التسجيل.");
  else add("ok", `سمعنا: «${clean(heard.text).slice(0, 120)}»`);
  if (ai) {
    if (ai.clarity === "poor") add("warn", "الكلام غير واضح – سجّل بهدوء وببطء.");
    if (ai.background_noise === "high") add("warn", "يوجد ضجيج قوي – سجّل في مكان أهدأ.");
    if (ai.music) add("warn", "يوجد موسيقى في الخلفية – الأفضل تسجيل بدون موسيقى.");
    if (ai.several_speakers) add("warn", "سمعنا أكثر من شخص – سجّل صوتاً واحداً فقط.");
    if (ai.dialect === "iraqi") add("ok", "اللهجة عراقية ✔");
  }
  return { ok: !items.some((i) => i.level === "bad"), items };
}

/** Who speaks in the recording, as a character type ({ gender, age } or nulls) – from the customer's own answer. */
function speakerOf(ai) {
  if (!ai) return { gender: null, age: null, ageEstimate: null };
  return {
    gender: GENDERS.includes(ai.gender) ? ai.gender : null,
    age: AGES.includes(ai.age_group) ? ai.age_group : null,
    ageEstimate: Number.isFinite(Number(ai.age_estimate)) && ai.age_estimate !== null ? Math.round(Number(ai.age_estimate)) : null,
  };
}

/** Full check of a converted recording. */
async function check(mp3, seconds) {
  const m = await measure(mp3);
  const [heard, ai] = await Promise.all([transcribe(mp3).catch((e) => { console.error("voice transcribe:", e.message); return { text: "", lang: "" }; }), listen(mp3)]);
  const verdict = judge(m, heard, ai, seconds);
  return { duration: Math.round(m.duration * 100) / 100, metrics: m, heard, speaker: { gender: null, age: null, ageEstimate: null }, ai, ...verdict };
}

/** Customer-facing summary of a stored clip row. */
const clipView = (row) => row && ({
  id: row.id, url: `/api/voice/clips/${row.id}/audio`, duration: Number(row.duration_sec), transcript: row.transcript || "",
  ok: Boolean(row.analysis?.ok), items: row.analysis?.items || [], speaker: row.analysis?.speaker || {},
});

const typeLabel = (gender, age) => TYPE_LABEL[`${gender}.${age}`] || "";
const newClipId = () => "V" + crypto.randomBytes(12).toString("base64url");

module.exports = {
  CATALOG, DEFAULTS, TYPE_LABEL, GENDERS, AGES, MIN_SECONDS,
  publicCatalog, pick, typeFromSpeech, typeLabel, speak, toMp3, measure, fit, fitPlan, transcribe, listen, judge, speakerOf, check, clipView, newClipId,
  byId: (id) => BY_ID[id] || null,
};
