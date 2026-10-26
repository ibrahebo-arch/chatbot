/* VI Iraq – studio front end */
(() => {
  const $ = (id) => document.getElementById(id);
  const ROLES = { char1: "شخصية 1", char2: "شخصية 2", char3: "شخصية 3", ref: "مرجع" };

  const state = {
    messages: [],        // { role, content, files: [{ name, stored, url, image, video, role }] }
    quality: 1080,
    seconds: 15,
    language: "العربية",
    characters: "1",
    rates: { 1080: 80 / 60, 720: 44 / 60, 480: 22 / 60 },
    attachLimit: 200 * 1048576,
    sending: false,
    pending: [],         // files chosen but not yet sent in a message
    attachments: [],     // every file sent, goes with the order
    requestId: null,
    requesterId: null,
    accessToken: null,
    idemKey: null,       // reused on retry so a double click / timeout never creates a second order
    started: false,
  };
  const price = (q = state.quality, s = state.seconds) => Math.ceil((state.rates[q] || state.rates[1080]) * s);

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3400);
  };

  // ---------- validation (mirrors validate.js on the server) ----------
  const parseTelegram = (v) => {
    const s = String(v || "").trim().replace(/^(https?:\/\/)?(www\.)?t\.me\//i, "").replace(/^@/, "");
    return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s.toLowerCase() : "";
  };
  const parsePhone = (v) => {
    const m = String(v || "").trim().replace(/[\s\-().]/g, "").match(/^(?:0|\+964|00964)?(7\d{9})$/);
    return m ? `+964${m[1]}` : "";
  };
  const contact = () => ({ telegram: parseTelegram($("telegram").value), phone: parsePhone($("phone").value) });
  ["telegram", "phone"].forEach((id) => $(id).addEventListener("input", () => $(id).parentElement.classList.remove("bad")));

  // ---------- tabs ----------
  const showTab = (name) => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${name}`));
    $("mbar").classList.toggle("hide", name !== "studio");
    window.scrollTo({ top: 0 });
  };
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- showcase (loops before the first message) ----------
  async function showcase() {
    let loops = [];
    try { loops = (await (await fetch("/api/loops")).json()).loops || []; } catch {}
    const mosaic = $("mosaic");
    if (!loops.length) { mosaic.remove(); return; }
    // one cell per category (by file-name prefix); each cell rotates only inside its own category,
    // so models / movies / cars / cities / nature / games are all on screen at the same time
    const shuffle = (a) => a.sort(() => Math.random() - .5);
    const groupOf = (name) => {
      const p = name.split("-")[0];
      if (p === "model") return "model";
      if (p === "movie") return "movie";
      if (p === "car") return "car";
      if (p === "city" || p === "building") return "city";
      if (["nature", "desert", "beach", "space"].includes(p)) return "nature";
      if (p === "gaming" || p === "game") return "game";
      return "extra"; // ours-*, trend-*, cute-* – sprinkled into any cell now and then
    };
    const pools = {};
    loops.forEach((l) => (pools[groupOf(l.name)] ||= []).push(l));
    Object.values(pools).forEach(shuffle);
    const order = ["model", "movie", "car", "city", "nature", "game"].filter((g) => pools[g]?.length);
    const extra = pools.extra || [];
    // fewer categories than cells → cycle the categories again
    for (let i = 0; order.length && order.length < 6; i++) order.push(order[i % order.length]);
    const idx = {};
    const pick = (g) => { const pool = pools[g]; idx[g] = (idx[g] || 0) + 1; return pool[idx[g] % pool.length]; };
    const cells = [];
    for (let i = 0; i < Math.min(6, order.length); i++) {
      const cell = document.createElement("div"); cell.className = "cell"; cell.dataset.group = order[i];
      const img = document.createElement("img"); img.alt = "";
      const v = document.createElement("video"); v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "metadata";
      cell.append(img, v); mosaic.appendChild(cell); cells.push({ cell, img, v, group: order[i] });
    }
    const load = (c, loop) => {
      c.cell.classList.remove("ready");
      if (loop.poster) c.img.src = loop.poster;
      c.v.src = loop.src;
      c.v.onloadeddata = () => { c.cell.classList.add("ready"); c.v.play().catch(() => {}); };
    };
    cells.forEach((c, i) => setTimeout(() => load(c, pick(c.group)), i * 350));
    let tick = 0;
    const rotate = setInterval(() => {
      if (state.started) return clearInterval(rotate);
      const c = cells[tick++ % cells.length];
      const useExtra = extra.length && tick % 5 === 0;
      load(c, useExtra ? extra[(tick / 5) % extra.length | 0] : pick(c.group));
    }, 6500);
  }
  function startChat() {
    if (state.started) return;
    state.started = true;
    const s = $("showcase");
    s.classList.add("off");
    setTimeout(() => { s.classList.add("gone"); s.querySelectorAll("video").forEach((v) => { v.pause(); v.removeAttribute("src"); v.load(); }); }, 520);
  }
  $("starters").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("input").value = b.textContent; $("input").focus(); autoGrow();
  });

  // ---------- chat ----------
  const list = $("messages");
  function addMsg(role, content, files = [], cls = "") {
    const el = document.createElement("div");
    el.className = `msg ${role} ${cls}`.trim();
    if (role === "sys" && cls.includes("ids")) el.innerHTML = content; else el.textContent = content;
    if (files.length) {
      const box = document.createElement("div"); box.className = "files";
      files.forEach((f) => {
        if (f.image || f.video) {
          const fig = document.createElement("figure");
          const m = document.createElement(f.image ? "img" : "video");
          m.src = f.url; if (f.video) { m.controls = true; m.preload = "metadata"; m.playsInline = true; } else m.alt = f.name;
          const cap = document.createElement("figcaption"); cap.textContent = ROLES[f.role] || ROLES.ref;
          fig.append(m, cap); box.appendChild(fig);
        } else {
          const a = document.createElement("a"); a.className = "doc"; a.href = f.url; a.target = "_blank"; a.textContent = `📄 ${f.name}`; box.appendChild(a);
        }
      });
      el.appendChild(box);
    }
    if (role === "user" && state.requestId) {
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = `#${state.requestId}`; el.appendChild(tag);
    }
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }
  function typing() {
    const el = document.createElement("div");
    el.className = "msg bot typing"; el.innerHTML = "<span></span><span></span><span></span>";
    list.appendChild(el); list.scrollTop = list.scrollHeight;
    return el;
  }
  const orderPayload = () => ({
    quality: state.quality, seconds: state.seconds, language: state.language, characters: state.characters,
    ...contact(),
    requestId: state.requestId, requesterId: state.requesterId, accessToken: state.accessToken,
    description: state.messages.filter((m) => m.role === "user").map((m) => m.content).filter(Boolean).join("\n"),
    attachments: state.attachments,
    voice: voiceSpec(true),
  });

  // ---------- terms (public/policy.json) ----------
  // The card follows the customer's language: Arabic letters in their last message → Arabic, otherwise English.
  const isArabic = (s) => /[؀-ۿ]/.test(String(s || ""));
  const customerLang = () => {
    const last = [...state.messages].reverse().find((m) => m.role === "user" && String(m.content || "").trim());
    return !last || isArabic(last.content) ? "ar" : "en";
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const sectionEl = (s, Tag = "section") => {
    const box = el(Tag); box.dataset.n = s.n;
    box.append(el("h4", "", `${s.n}. ${s.title}`));
    const ul = el("ul"); s.items.forEach((i) => ul.append(el("li", "", i))); box.append(ul);
    return box;
  };
  // Nothing is blocked. A request that may conflict with the terms shows the rule(s) it conflicts with,
  // in the customer's language, the note that continuing means accepting the terms, and a
  // "read the rest" button that opens the remaining sections inside the same card.
  const ACCEPT = {
    ar: { head: "⚠️ طلبك قد يخالف شروط VI Iraq", accept: "بمتابعتك المحادثة وإرسال الطلب فأنت توافق على شروط وأحكام VI Iraq وتتحمل مسؤولية استخدام المخرجات.", more: "اقرأ باقي الشروط ▾", less: "إخفاء باقي الشروط ▴" },
    en: { head: "⚠️ Your request may conflict with VI Iraq's terms", accept: "By continuing the chat and sending your order, you accept VI Iraq's terms and conditions and take responsibility for how the outputs are used.", more: "Read the rest of the terms ▾", less: "Hide the rest of the terms ▴" },
  };
  function policyCard(sections, lang = customerLang(), target = null) {
    const doc = state.policy?.[lang];
    if (!doc) return;
    const t = ACCEPT[lang];
    const card = el("div", "msg sys policy");
    card.dir = lang === "ar" ? "rtl" : "ltr"; card.lang = lang;
    card.append(el("span", "ph", t.head));
    doc.sections.filter((s) => sections.includes(s.n)).forEach((s) => { const sec = sectionEl(s, "div"); sec.classList.add("hit"); card.append(sec); });
    card.append(el("p", "pa", t.accept));
    const rest = el("div", "rest"); rest.hidden = true;
    doc.sections.filter((s) => !sections.includes(s.n)).forEach((s) => rest.append(sectionEl(s, "div")));
    const more = el("button", "pl", t.more); more.type = "button";
    more.onclick = () => { rest.hidden = !rest.hidden; more.textContent = rest.hidden ? t.more : t.less; };
    card.append(more, rest);
    if (target) { target.prepend(card); return; }
    list.appendChild(card); list.scrollTop = list.scrollHeight;
  }
  function renderTerms(lang) {
    const doc = state.policy?.[lang]; if (!doc) return;
    $("termsTitle").textContent = doc.title; $("termsPlatform").textContent = doc.platform;
    const body = $("termsBody"); body.innerHTML = ""; body.dir = lang === "ar" ? "rtl" : "ltr"; body.lang = lang;
    doc.sections.forEach((s) => body.append(sectionEl(s)));
    document.querySelectorAll("#termsLang button").forEach((b) => b.classList.toggle("on", b.dataset.l === lang));
  }
  function openTerms(lang = "ar", n = null) {
    renderTerms(lang); showTab("contact");
    if (n) { const s = document.querySelector(`#termsBody section[data-n="${n}"]`); if (s) { s.scrollIntoView({ behavior: "smooth", block: "center" }); s.classList.add("flash"); setTimeout(() => s.classList.remove("flash"), 1700); } }
  }
  $("termsLang").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) renderTerms(b.dataset.l); });
  $("footTerms").addEventListener("click", (e) => { e.preventDefault(); openTerms(customerLang()); });

  // ---------- WhatsApp (floating button on every tab + contact tab) ----------
  const waLink = () => {
    const text = state.requestId ? `مرحباً VI Iraq، بخصوص طلبي ${state.requestId}` : "مرحباً VI Iraq 👋";
    return `https://wa.me/${state.whatsapp}?text=${encodeURIComponent(text)}`;
  };
  function setupWhatsApp() {
    if (!state.whatsapp) return;
    const n = state.whatsapp;
    $("waNumber").textContent = `+${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`;
    for (const id of ["waFloat", "waContact"]) {
      const a = $(id); a.href = waLink(); a.hidden = false;
      a.addEventListener("click", () => { a.href = waLink(); }); // picks up the order number once there is one
    }
  }

  // ---------- attachments ----------
  const tray = $("tray");
  function renderTray() {
    tray.hidden = !state.pending.length;
    tray.innerHTML = "";
    state.pending.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "att" + (f.done ? "" : " uploading");
      const thumb = f.image && f.preview ? `<img src="${f.preview}" alt="">`
        : f.video && f.preview ? `<video src="${f.preview}" muted playsinline preload="metadata"></video>`
        : `<span class="ic">📄</span>`;
      const role = (f.image || f.video)
        ? `<select data-i="${i}" title="دور هذا الملف">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${f.role === k ? "selected" : ""}>${v}</option>`).join("")}</select>`
        : "";
      el.innerHTML = `${thumb}<span class="body"><span class="nm" title="${f.name}">${f.name}${f.done ? "" : ` · ${f.progress || 0}%`}</span>${role}</span><button type="button" class="x" data-i="${i}" aria-label="إزالة">✕</button>${f.done ? "" : `<i class="prog" style="width:${f.progress || 0}%"></i>`}`;
      tray.appendChild(el);
    });
  }
  tray.addEventListener("click", (e) => { const b = e.target.closest(".x"); if (!b) return; state.pending.splice(Number(b.dataset.i), 1); renderTray(); });
  tray.addEventListener("change", (e) => { const s = e.target.closest("select"); if (s) state.pending[Number(s.dataset.i)].role = s.value; });
  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    [...$("fileInput").files].forEach((file) => {
      if (file.type.startsWith("audio/") || /.(mp3|m4a|wav|ogg|aac|opus)$/i.test(file.name)) { uploadVoice(file, file.name); return; }
      const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
      const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name);
      if (!isImage && !isVideo) { toast(`الملف ${file.name} غير مدعوم – ارفع صورة أو فيديو أو تسجيلاً صوتياً`); return; }
      if (file.size > state.attachLimit) { toast(`الملف ${file.name} أكبر من الحد المسموح (${Math.round(state.attachLimit / 1048576)} MB)`); return; }
      const item = { name: file.name, size: file.size, image: isImage, video: isVideo, role: isImage ? "char1" : "ref", preview: null, done: false, progress: 0, url: null, stored: null };
      // first picture defaults to character 1, next ones to 2, 3, then reference
      if (isImage) { const used = [...state.pending, ...state.attachments].filter((a) => a.image).length; item.role = ["char1", "char2", "char3"][used] || "ref"; }
      if (isImage || isVideo) item.preview = URL.createObjectURL(file);
      state.pending.push(item); renderTray();
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/attach/${encodeURIComponent(file.name)}?role=${item.role}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = Math.round((e.loaded / e.total) * 100); renderTray(); } };
      xhr.onload = () => {
        let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 200) Object.assign(item, { done: true, url: d.url, stored: d.stored, image: d.image, video: d.video });
        else { state.pending.splice(state.pending.indexOf(item), 1); toast(d.error || "فشل رفع الملف"); }
        renderTray();
      };
      xhr.onerror = () => { state.pending.splice(state.pending.indexOf(item), 1); toast("فشل رفع الملف"); renderTray(); };
      xhr.send(file);
    });
    $("fileInput").value = "";
  });

  // the customer can also set options by typing them
  function applyFromText(text) {
    const changed = [];
    const q = text.match(/\b(480|720|1080)\s*(p|px|بكسل)?\b/i);
    if (q) { setQuality(Number(q[1])); changed.push(`الجودة ${q[1]}p`); }
    const mins = text.match(/(\d+)\s*(دقيقة|دقائق|min|minute)/i);
    const secs = text.match(/(\d+)\s*(ثانية|ثواني|ث\b|s\b|sec|second)/i);
    if (mins) { setSeconds(Number(mins[1]) * 60); changed.push(`المدة ${mins[1]} دقيقة`); }
    else if (secs) { setSeconds(Number(secs[1])); changed.push(`المدة ${secs[1]} ثانية`); }
    else if (/\bدقيقة\b/.test(text) && !/\d/.test(text)) { setSeconds(60); changed.push("المدة دقيقة"); }
    const langs = [["english", "English"], ["انجليزي", "English"], ["إنجليزي", "English"], ["عراقي", "عراقي (لهجة)"], ["كردي", "كوردي"], ["كوردي", "كوردي"], ["تركي", "Türkçe"], ["فارسي", "فارسی"], ["بدون كلام", "بدون كلام"]];
    for (const [k, v] of langs) if (text.toLowerCase().includes(k)) { setLanguage(v); changed.push(`اللغة ${v}`); break; }
    const words = { "شخصية واحدة": 1, "شخص واحد": 1, "شخصيتين": 2, "شخصين": 2, "ثلاث": 3, "اربع": 4, "أربع": 4, "خمس": 5 };
    let chN = null;
    const ch = text.match(/(\d)\s*(شخصيات|شخصية|اشخاص|أشخاص|characters?|people)/i);
    if (ch) chN = Number(ch[1]); else for (const [k, v] of Object.entries(words)) if (text.includes(k) && /شخص/.test(text)) { chN = v; break; }
    if (chN) { setCharacters(chN >= 5 ? "5+" : chN); changed.push(`${chN} شخصيات`); }
    changed.push(...voiceFromText(text));
    if (changed.length) addMsg("sys", "تم ضبط: " + changed.join(" · "));
  }

  const input = $("input");
  const autoGrow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); } });

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const files = state.pending.filter((f) => f.done);
    if ((!text && !files.length) || state.sending) return;
    if (state.pending.some((f) => !f.done)) { toast("انتظر اكتمال رفع الملفات…"); return; }
    startChat();
    input.value = ""; autoGrow();
    state.pending = []; renderTray();
    const sent = files.map((f) => ({ name: f.name, stored: f.stored, url: f.url, image: f.image, video: f.video, role: f.role }));
    state.attachments.push(...sent);
    updateTrialRefs();
    state.messages.push({ role: "user", content: text, files: sent });
    addMsg("user", text, sent);
    if (text) applyFromText(text);
    const t = typing();
    state.sending = true;
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: state.messages, order: orderPayload() }) });
      const data = await r.json();
      t.remove();
      addMsg("bot", data.reply || "…");
      if (data.reply) state.messages.push({ role: "assistant", content: data.reply });
      if (data.policy?.sections?.length) policyCard(data.policy.sections, isArabic(text) || !text ? "ar" : "en");
    } catch {
      t.remove(); addMsg("bot", "تعذّر الاتصال بالخادم، حاول مرة ثانية.");
    } finally { state.sending = false; }
  });

  // ---------- controls ----------
  const slider = $("seconds");
  function setQuality(q) { state.quality = q; document.querySelectorAll("#quality button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === q)); render(); }
  function setSeconds(s) { state.seconds = Math.min(Number(slider.max), Math.max(Number(slider.min), Math.round(s / 5) * 5)); slider.value = state.seconds; render(); }
  function setLanguage(v) { state.language = v; $("language").value = v; render(); }
  function setCharacters(v) { state.characters = String(v); $("characters").value = String(v); render(); }
  $("quality").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setQuality(Number(b.dataset.v)); });
  slider.addEventListener("input", () => { state.seconds = Number(slider.value); render(); });
  $("quick").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeconds(Number(b.dataset.s)); });
  $("language").addEventListener("change", (e) => setLanguage(e.target.value));
  $("characters").addEventListener("change", (e) => setCharacters(e.target.value));
  $("mGo").addEventListener("click", () => { if (document.body.classList.contains("free-mode")) $("trialGo").click(); else $("panel").scrollIntoView({ behavior: "smooth", block: "start" }); });

  let afterRender = () => {};
  function render() {
    afterRender();
    const p = price();
    $("secVal").textContent = state.seconds;
    $("priceVal").textContent = p; $("ctaPrice").textContent = p; $("mPrice").textContent = p;
    $("priceMeta").textContent = `${state.quality}p · ${state.seconds} ثانية · ${state.language}`;
    const amt = document.querySelector(".amount"); amt.classList.add("bump"); setTimeout(() => amt.classList.remove("bump"), 150);
    slider.style.setProperty("--fill", `${((state.seconds - slider.min) / (slider.max - slider.min)) * 100}%`);
    document.querySelectorAll("#quick button").forEach((b) => b.classList.toggle("on", Number(b.dataset.s) === state.seconds));
    $("summary").innerHTML = [`${state.quality}p`, `${state.seconds} ث`, state.language, `${state.characters} شخصية`, `$${p}`].map((s) => `<span>${s}</span>`).join("");
    $("priceTable").innerHTML = [[15, "15 ثانية"], [30, "30 ثانية"], [60, "دقيقة"], [120, "دقيقتان"]]
      .map(([s, label]) => `<tr><td>${label}</td>${[480, 720, 1080].map((q) => `<td class="${q === state.quality ? "hi" : ""}">$${price(q, s)}</td>`).join("")}</tr>`).join("");
  }

  // ---------- send order ----------
  $("sendOrder").addEventListener("click", async () => {
    const note = $("orderNote");
    const fail = (field, msg) => {
      note.className = "note err"; note.textContent = msg;
      if (field === "chat") { input.focus(); return; }
      const el = $(field); el.parentElement.classList.add("bad"); el.focus(); el.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    if (!state.messages.some((m) => m.role === "user")) return fail("chat", "اكتب أولاً وصف الفيديو في الدردشة.");
    const c = contact();
    if (!c.telegram) return fail("telegram", "اكتب معرّف تيليغرام صحيح (مثال: ahmed_vi).");
    if (!c.phone) return fail("phone", "اكتب رقم هاتف عراقي صحيح (مثال: 7723682257).");
    const btn = $("sendOrder");
    btn.disabled = true; note.className = "note"; note.textContent = "جارٍ تجهيز الطلب وإرساله…";
    state.idemKey ||= (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const r = await fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": state.idemKey }, body: JSON.stringify({ messages: state.messages, order: orderPayload() }) });
      const data = await r.json();
      if (r.status === 400) { state.idemKey = null; return fail(data.field || "chat", data.message); }
      if (r.status === 429) { state.idemKey = null; note.className = "note err"; note.textContent = data.message; return; }
      note.className = `note ${data.ok ? "ok" : "err"}`; note.textContent = data.message;
      toast(data.ok ? "تم استلام طلبك" : "حدثت مشكلة");
      if (data.requestId) {
        state.idemKey = null;
        state.requestId = data.requestId; state.requesterId = data.requesterId; state.accessToken = data.accessToken;
        const bot = data.botLink ? `<br><a class="botlink" href="${data.botLink}" target="_blank" rel="noopener">افتح بوت التسليم واضغط Start ليصلك الفيديو على تيليغرام</a>` : "";
        addMsg("sys", `تم إرسال الطلب ✔<br>رقم الطلب <code>${data.requestId}</code> معرّفك <code>${data.requesterId}</code>${bot}<br><small>أي رسالة ترسلها الآن تُضاف إلى هذا الطلب.</small>`, [], "ids ok");
        if (data.botLink) note.innerHTML = `${note.textContent}<br><a href="${data.botLink}" target="_blank" rel="noopener">👉 افتح بوت التسليم واضغط Start</a>`;
        state.messages.push({ role: "assistant", content: `تم إرسال الطلب. رقم الطلب ${data.requestId}، معرّف الزبون ${data.requesterId}.` });
        btn.innerHTML = `إرسال طلب جديد <span class="cta-price">$<span id="ctaPrice">${price()}</span></span>`;
        
        if (data.policy?.sections?.length) policyCard(data.policy.sections);
        trackOrder(data);
        if (state.payments && data.payment && !data.payment.paid) { rememberOrder(); askPay(data); } else askBot(data);
      }
    } catch {
      note.className = "note err"; note.textContent = "تعذّر الاتصال بالخادم، اضغط مرة ثانية (لن يتكرر الطلب).";
    } finally { btn.disabled = false; }
  });

  // ---------- order status (polls the server; plays the video when ready) ----------
  const STEPS = [["queued", "مسجّل"], ["awaiting_admin", "مراجعة"], ["generating", "قيد الإنجاز"], ["completed", "جاهز"]];
  // after sending: the order is only confirmed once the customer presses Start in the bot
  function askBot(d) {
    const dlg = $("botDialog");
    if (state.demo || !d.botLink || d.linked || !dlg?.showModal) return; // test stage: no blocking dialog, the video comes anyway
    $("botDlgId").textContent = d.requestId;
    $("botDlgLink").href = d.botLink;
    $("botDlgLink").onclick = () => setTimeout(() => dlg.close(), 300);
    $("botDlgLater").onclick = () => dlg.close();
    if (!dlg.open) dlg.showModal();
  }
  // ---------- payment (Wayl) ----------
  const iqd = (n) => Number(n || 0).toLocaleString("en-US");
  const ownerHeaders = () => ({ "x-requester-id": state.requesterId, "x-order-token": state.accessToken });
  // remembered for the return from the payment page (/paid), which reloads the site
  const rememberOrder = () => { try { localStorage.setItem("vi-pay", JSON.stringify({ requestId: state.requestId, requesterId: state.requesterId, accessToken: state.accessToken, at: Date.now() })); } catch {} };
  async function pay(btn) {
    if (!state.requestId) return;
    // open the tab inside the click so the browser does not block it; the address comes after the request
    const win = window.open("", "_blank");
    if (win) win.document.write('<p dir="rtl" style="font:16px system-ui;padding:24px">جارٍ فتح صفحة الدفع…</p>');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/orders/${encodeURIComponent(state.requestId)}/pay`, { method: "POST", headers: ownerHeaders() });
      const d = await r.json();
      if (d.paid) { win?.close(); toast("تم الدفع مسبقاً ✔"); return; }
      if (!r.ok || !d.url) { win?.close(); toast(d.message || "تعذّر فتح صفحة الدفع"); return; }
      rememberOrder();
      if (win) { win.location.href = d.url; toast("أكمل الدفع في الصفحة الجديدة – تتحدث الحالة هنا تلقائياً"); }
      else location.href = d.url;
    } catch {
      win?.close(); toast("تعذّر الاتصال بالخادم، حاول مرة ثانية.");
    } finally { if (btn) btn.disabled = false; }
  }
  list.addEventListener("click", (e) => { const b = e.target.closest(".paybtn"); if (b) pay(b); });
  function askPay(d) {
    const dlg = $("payDialog");
    if (!dlg?.showModal) return;
    $("payDlgId").textContent = d.requestId;
    $("payDlgAmount").textContent = iqd(d.payment.amountIqd);
    $("payDlgUsd").textContent = `≈ $${price()}${d.payment.env === "test" ? " · وضع الاختبار" : ""}`;
    $("payDlgBtn").onclick = () => { pay($("payDlgBtn")); dlg.close(); };
    $("payDlgLater").onclick = () => dlg.close();
    if (!dlg.open) dlg.showModal();
  }

  const stepIndex = (s) => ({ queued: 0, awaiting_admin: 1, prompt_ready: 2, generating: 2, completed: 3, delivered: 3 })[s] ?? 0;
  let tracker = null;
  function trackOrder(first) {
    if (tracker) clearTimeout(tracker.timer);
    const card = addMsg("sys", "", [], "ids status");
    tracker = { card, video: null, timer: null };
    // steps light up one per second even when the server jumps ahead, so every state is seen
    tracker.shown = -1; tracker.latest = null; tracker.anim = null;
    const MSG = ["طلبك مسجّل ✔", state.payments ? "تم استلام الدفع ✔ طلبك قيد المراجعة…" : "طلبك قيد المراجعة…", "جارٍ إنجاز الفيديو…", "الفيديو جاهز 🎉"];
    const paint = () => {
      const d = tracker.latest; if (!d) return;
      const bad = d.status === "failed" || d.status === "cancelled";
      const at = tracker.shown;
      const steps = STEPS.map(([, label], i) => `<span class="${bad ? "" : i < at ? "done" : i === at ? "now" : ""}">${label}</span>`).join("");
      const msg = bad || at === stepIndex(d.status) ? d.message || "" : MSG[at] || "";
      const p = d.payment;
      const unpaid = p && !p.paid && d.status === "queued";
      const payBox = unpaid
        ? `<div class="pay"><span class="amt">${iqd(p.amountIqd)} د.ع</span><button type="button" class="paybtn">ادفع</button></div>`
        : p && p.paid ? `<span class="paid">✔ مدفوع${p.method ? ` (${p.method})` : ""}</span>` : "";
      const botText = state.demo || p ? "👉 اختياري: افتح البوت واضغط Start ليصلك الفيديو على تيليغرام أيضاً" : "👉 أكّد طلبك: افتح البوت واضغط Start";
      const bot = !d.linked && d.botLink ? `<br><a class="botlink" href="${d.botLink}" target="_blank" rel="noopener">${botText}</a>` : "";
      // rebuild only on a real change: replacing the card every second swallowed clicks on «ادفع»
      const html = `<b>طلب ${d.requestId}</b><div class="steps">${steps}</div><span class="stmsg">${msg}</span>${payBox}${bot}`;
      if (html !== tracker.html) {
        tracker.html = html;
        card.querySelector(".st")?.remove();
        const st = document.createElement("div"); st.className = "st";
        st.innerHTML = html;
        card.prepend(st);
      }
      if (d.videoUrl && at >= 3 && !tracker.video) {
        const v = document.createElement("video"); // plays like a GIF; controls for sound/fullscreen
        v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.controls = true; v.src = d.videoUrl; v.className = "result";
        card.appendChild(v); tracker.video = v;
        v.play().catch(() => {});
        list.scrollTop = list.scrollHeight;
      }
    };
    const step = () => {
      const d = tracker.latest;
      if (d && tracker.shown < stepIndex(d.status)) { tracker.shown++; paint(); }
      else if (d && tracker.shown === stepIndex(d.status)) paint();
      if (tracker.video || d?.status === "failed" || d?.status === "cancelled") return;
      tracker.anim = setTimeout(step, 1000);
    };
    const poll = async () => {
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(state.requestId)}/status`, { headers: { "x-requester-id": state.requesterId, "x-order-token": state.accessToken }, cache: "no-store" });
        if (r.status === 404) { try { localStorage.removeItem("vi-order"); } catch {} clearTimeout(tracker.anim); card.remove(); return; }
        const d = await r.json();
        if (d.ok) { tracker.latest = d; if (tracker.shown < 0) { tracker.shown = 0; paint(); } }
        if (["delivered", "failed", "cancelled"].includes(d.status) && tracker.video) return;
      } catch {}
      // quicker while a payment or the test-stage steps are under way
      const waitingPay = tracker.latest?.payment && !tracker.latest.payment.paid;
      tracker.timer = setTimeout(poll, (state.demo && !tracker.video) || waitingPay ? 2000 : 5000);
    };
    if (first && first.status) { tracker.latest = first; tracker.shown = 0; paint(); }
    step();
    poll();
  }

  // ---------- free trial: a mode of the studio (no price, no contact details) ----------
  // The customer writes the idea in the chat; the server has ChatGPT turn the chat into the prompt.
  // Results appear in the chat with a download button (pictures and videos).
  const trial = { on: false, mode: "order", style: "realistic", kind: "image", info: null, jobs: [], timers: {} };
  // results survive a reload (iPhone Safari often reloads a tab after switching apps): kept for 24 h
  const TRIAL_KEY = "vi-trial-jobs";
  const saveTrialJobs = () => { try { localStorage.setItem(TRIAL_KEY, JSON.stringify(trial.jobs.filter((j) => Date.now() - new Date(j.createdAt).getTime() < 86400e3).slice(-8))); } catch {} };
  ["trialStyle", "trialKind"].forEach((id) => $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    trial[id === "trialStyle" ? "style" : "kind"] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    if (id === "trialKind") placeVoice(); // the voice choice only matters for videos
  }));
  // one voice block for both panels: in the free trial under the video choice, in the paid order under «اللغة»
  function placeVoice() {
    const f = $("voiceField"); if (!f) return;
    if (trial.mode === "free") {
      const refs = $("trialRefs"); if (f.nextElementSibling !== refs) refs.before(f);
      f.hidden = trial.kind !== "video";
    } else {
      const lang = $("language").closest(".field"); if (lang.nextElementSibling !== f) lang.after(f);
      f.hidden = false;
    }
  }
  placeVoice();
  // pictures sent in the chat are used by the free trial too: characters keep their faces and clothes
  function updateTrialRefs() {
    const n = state.attachments.filter((a) => a.image).length;
    const p = $("trialRefs");
    p.hidden = !n;
    if (n) p.textContent = `📎 ${n} ${n === 1 ? "صورة" : "صور"} من الدردشة ستُستخدم: الشخصيات تظهر بنفس ملامحها وملابسها، وصور المرجع للأسلوب أو المكان.`;
  }
  function setMode(m) {
    trial.mode = m;
    if (m === "free") updateTrialRefs();
    $("panel").classList.toggle("free", m === "free");
    document.body.classList.toggle("free-mode", m === "free");
    $("modeSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    $("mGo").textContent = m === "free" ? "🎁 أنشئ مجاناً" : "تفاصيل الطلب وإرساله";
    placeVoice(); renderVoice();
    if (m === "free") loadTrial();
  }
  $("modeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.m); });
  function renderTrialLeft(s) {
    if (!s || !s.enabled) return;
    trial.info = s;
    $("trialSecs").textContent = s.videoSeconds;
    const videoBtn = $("trialKind").querySelector('[data-v="video"]');
    videoBtn.disabled = !s.videoAvailable;
    videoBtn.title = s.videoAvailable ? "" : "الفيديو المجاني غير متاح حالياً";
    if (!s.videoAvailable && trial.kind === "video") $("trialKind").querySelector('[data-v="image"]').click();
    $("trialLeft").innerHTML = s.paused
      ? "التجربة المجانية متوقفة لليوم – جرّب غداً 🙏"
      : `متبقي لك مجاناً: <b>${s.left.image}</b> ${s.left.image === 1 ? "صورة" : "صور"} · <b>${s.videoAvailable ? s.left.video : 0}</b> فيديو`;
    $("trialGo").disabled = Boolean(s.paused);
    document.querySelectorAll(".tjob .animate").forEach((b) => (b.hidden = !(s.left.video > 0 && s.videoAvailable)));
  }
  async function loadTrial() {
    try { renderTrialLeft(await (await fetch("/api/trial", { cache: "no-store" })).json()); } catch {}
  }
  // on a phone the free box sits below the chat: bring the card into view so the visitor sees it appear
  function bringIntoView(card) {
    if (!card || window.innerWidth > 820) return;
    const r = card.getBoundingClientRect();
    if (r.top < 60 || r.bottom > window.innerHeight - 20) card.scrollIntoView({ behavior: "auto", block: "center" });
  }
  // iPhone / iPad (iPadOS reports itself as a Mac with touch)
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const sharedFiles = new Map(); // job id → Promise<File|null>, fetched once per result
  function sharedFile(j, name) {
    if (!sharedFiles.has(j.id)) {
      sharedFiles.set(j.id, fetch(j.download).then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? new File([b], name, { type: j.kind === "video" ? "video/mp4" : "image/jpeg" }) : null)).catch(() => null));
    }
    return sharedFiles.get(j.id);
  }
  function trialCard(j) {
    let card = document.querySelector(`.tjob[data-id="${j.id}"]`);
    if (!card) {
      card = el("div", `msg sys tjob ${j.kind}`); card.dataset.id = j.id;
      list.appendChild(card);
    }
    const busy = j.status === "queued" || j.status === "running";
    const box = el("div", "media");
    if (busy) {
      const w = el("div", "wait"); const secs = Math.max(0, Math.round((Date.now() - new Date(j.createdAt || Date.now()).getTime()) / 1000));
      w.append(el("span", "spin"), el("span", "", j.kind === "video" ? "جارٍ تسجيل الصوت وإنشاء الفيديو… عادةً 1–3 دقائق" : "جارٍ إنشاء الصورة…"), el("span", "secs", `⏱️ ${secs} ث – تظهر هنا تلقائياً عند الانتهاء`)); box.append(w);
    } else if (j.status === "done" && j.url) {
      const m = el(j.kind === "video" ? "video" : "img");
      if (j.kind === "video") {
        Object.assign(m, { muted: true, loop: true, autoplay: true, playsInline: true, controls: true, preload: "auto" });
        let retried = false;
        m.onerror = () => { // the phone dropped the file: try once more, then point to the download button
          if (!retried) { retried = true; m.src = j.url + (j.url.includes("?") ? "&" : "?") + "r=" + Date.now(); m.load(); return; }
          const note = el("div", "wait"); note.append(el("span", "err", "تعذّر تشغيل الفيديو هنا – استخدم زر التنزيل بالأسفل ⬇️")); box.replaceChildren(note);
        };
      }
      else { m.alt = j.prompt; m.onload = () => card.classList.toggle("square", Math.abs(m.naturalWidth - m.naturalHeight) < 10); }
      m.src = j.url; box.append(m);
    } else {
      const w = el("div", "wait"); w.append(el("span", "err", "تعذّر الإنشاء – لم يُحتسب من رصيدك المجاني، جرّب مرة ثانية.")); box.append(w);
    }
    const info = el("div", "info");
    info.append(el("span", "p", j.prompt));
    if (j.speech?.text) info.append(el("span", "say", `🗣️ ${j.speech.text}`));
    if (j.kind === "video" && (j.voice?.label || j.voiceChoice)) info.append(el("span", "voice", `🎙️ ${j.voice?.label || j.voiceChoice}${j.voice?.fitted ? " · " + j.voice.fitted : ""}`));
    info.append(el("span", "tag2", `🎁 مجاناً${j.ticket ? ` · 🎟️ ${j.ticket}` : ""} · ${j.style === "cartoon" ? "🎨 كرتون" : "📷 واقعي"} · ${j.kind === "video" ? "🎬 فيديو" : "🖼️ صورة"}`));
    const acts = el("div", "acts");
    if (j.status === "done" && j.url) {
      const name = `vi-iraq-${j.ticket || j.id}.${j.kind === "video" ? "mp4" : "jpg"}`;
      let primary = null;
      if (IOS && j.download && navigator.canShare) {
        // iPhone: the share sheet's «حفظ الفيديو/Save Video» puts it in Photos; a download link does nothing in
        // Chrome on iPhone. The file is fetched now, so the tap opens the sheet at once (iOS needs a fresh tap).
        let file = null; sharedFile(j, name).then((f) => (file = f));
        const save = el("button", "dl", j.kind === "video" ? "⬇️ حفظ الفيديو" : "⬇️ حفظ الصورة"); save.type = "button";
        save.onclick = async () => {
          if (file && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== "AbortError") location.href = j.download; }
            return;
          }
          location.href = j.download; // not loaded yet or no file sharing: the browser saves the file itself
        };
        acts.append(save); primary = save;
        info.append(el("span", "save-hint", j.kind === "video" ? "اضغط «حفظ الفيديو» ثم اختر «حفظ الفيديو» من القائمة ليُحفظ في الصور." : "اضغط «حفظ الصورة» ثم اختر «حفظ الصورة» من القائمة لتُحفظ في الصور."));
      } else {
        const dl = el("a", "dl", j.kind === "video" ? "⬇️ تنزيل الفيديو" : "⬇️ تنزيل الصورة");
        dl.href = j.download || j.url; dl.setAttribute("download", name); acts.append(dl); primary = dl;
      }
      const fab = el("button", "fab-save", j.kind === "video" ? "⬇️ حفظ الفيديو" : "⬇️ حفظ"); fab.type = "button";
      fab.onclick = (e) => { e.stopPropagation(); primary.click(); };
      box.append(fab);
      if (j.kind === "image") {
        const an = el("button", "animate", "🎬 حرّكها فيديو"); an.type = "button";
        an.hidden = !(trial.info?.left?.video > 0 && trial.info?.videoAvailable);
        an.onclick = () => startTrial({ kind: "video", style: j.style, prompt: "حرّك هذه الصورة بحركة طبيعية: " + j.prompt, sourceJob: j.id, sourceToken: j.token });
        acts.append(an);
      }
      const order = el("button", "", "اطلب نسخة كاملة"); order.type = "button";
      order.onclick = () => { setMode("order"); $("panel").scrollIntoView({ behavior: "smooth", block: "start" }); };
      acts.append(order);
    }
    info.append(acts);
    card.replaceChildren(box, info);
    list.scrollTop = list.scrollHeight;
    const phase = busy ? "busy" : j.status;
    if (card.dataset.phase !== phase) { card.dataset.phase = phase; bringIntoView(card); } // new card, and again when it is finished
  }
  const pending = (j) => j.status === "queued" || j.status === "running";
  async function checkTrial(j) {
    const ctl = new AbortController();
    j.lastCheck = Date.now();
    const stop = setTimeout(() => ctl.abort(), 12000); // a request frozen by the phone is dropped and retried
    try {
      const r = await fetch(`/api/trial/jobs/${encodeURIComponent(j.id)}`, { headers: { "x-trial-token": j.token }, cache: "no-store", signal: ctl.signal });
      if (r.status === 404) { j.status = "gone"; return; }
      const d = await r.json();
      if (d.ok) {
        Object.assign(j, d.job); saveTrialJobs(); trialCard(j);
        if (!pending(j)) loadTrial(); // a failed job gives the slot back
      }
    } catch {} finally { clearTimeout(stop); }
  }
  function pollTrial(j, delay = null) {
    clearTimeout(trial.timers[j.id]);
    if (!pending(j)) return;
    trial.timers[j.id] = setTimeout(async () => {
      await checkTrial(j);
      pollTrial(j);
    }, delay ?? (j.kind === "video" ? 5000 : 2500));
  }
  // back in Safari after switching apps / unlocking: check every unfinished result right away
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trial.jobs.filter(pending).forEach((j) => pollTrial(j, 0));
  });
  // safety net: every unfinished result is checked again if its timer ever stopped, and the counter keeps ticking
  setInterval(() => {
    trial.jobs.filter(pending).forEach((j) => {
      if (!trial.timers[j.id] || Date.now() - (j.lastCheck || 0) > 15000) pollTrial(j, 0);
      const card = document.querySelector('.tjob[data-id="' + j.id + '"] .secs');
      if (card) card.textContent = "⏱️ " + Math.round((Date.now() - new Date(j.createdAt || Date.now()).getTime()) / 1000) + " ث – تظهر هنا تلقائياً عند الانتهاء";
    });
  }, 1000);
  window.addEventListener("pageshow", () => trial.jobs.filter(pending).forEach((j) => pollTrial(j, 0)));

  async function startTrial({ kind, style, prompt = null, sourceJob = null, sourceToken = null }) {
    const note = $("trialNote"), btn = $("trialGo");
    if (!sourceJob && state.pending.length) { // a picture waiting in the tray is not part of the chat yet
      note.className = "note err"; note.textContent = "أرسل الصورة أولاً بزر الإرسال في الدردشة (يمكنك كتابة فكرتك معها)، ثم اضغط «أنشئ مجاناً».";
      input.focus(); return;
    }
    if (!sourceJob && !state.messages.some((m) => m.role === "user" && String(m.content || "").trim())) {
      note.className = "note err"; note.textContent = "اكتب فكرتك في الدردشة أولاً، ثم اضغط «أنشئ مجاناً».";
      input.focus(); return;
    }
    startChat();
    note.className = "note"; note.textContent = "جارٍ تحضير فكرتك من محادثتك…";
    btn.disabled = true;
    const temp = el("div", "msg sys tjob temp " + kind);
    const tw = el("div", "wait"); tw.append(el("span", "spin"), el("span", "", "جارٍ تحضير فكرتك من محادثتك… ثم يبدأ الإنشاء"));
    const tbox = el("div", "media"); tbox.append(tw); temp.append(tbox); list.appendChild(temp); list.scrollTop = list.scrollHeight; bringIntoView(temp);
    try {
      const r = await fetch("/api/trial/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, style, prompt, sourceJob, sourceToken, voice: $("trialVoice").value, voiceSpec: kind === "video" ? voiceSpec() : null, messages: state.messages }) });
      const d = await r.json();
      temp.remove();
      if (!d.ok) { note.className = "note err"; note.textContent = d.message || "حدثت مشكلة، حاول مرة ثانية."; return; }
      note.textContent = "";
      if (d.policy?.sections?.length) policyCard(d.policy.sections);
      const j = { ...d.job, token: d.token, voiceChoice: kind === "video" ? voiceChoiceText() : "" };
      trial.jobs.push(j); saveTrialJobs();
      trialCard(j); renderTrialLeft(d); pollTrial(j);
      
    } catch {
      temp.remove();
      note.className = "note err"; note.textContent = "تعذّر الاتصال بالخادم، حاول مرة ثانية.";
    } finally { btn.disabled = Boolean(trial.info?.paused); }
  }
  $("trialGo").addEventListener("click", () => startTrial({ kind: trial.kind, style: trial.style }));

  // ---------- voice: who speaks in the video, with which voice (ready-made, the customer's own, or their words in a character's voice) ----------
  const voice = { catalog: { voices: [], types: [] }, videoSeconds: 10, type: "auto", preset: "auto", mode: "tts", clip: null, rec: null };
  const TYPE_OF_AGE = (n) => (n < 14 ? "child" : n <= 25 ? "young" : n <= 55 ? "adult" : "old");
  const typeLabel = (key) => voice.catalog.types.find((t) => t.key === key)?.label || "";
  const presetLabel = (id) => voice.catalog.voices.find((v) => v.id === id)?.label || "";
  async function loadVoices() {
    try {
      const d = await (await fetch("/api/voices")).json();
      if (!d.ok) return;
      voice.catalog = d; voice.videoSeconds = d.videoSeconds || 10;
      $("voiceType").append(...d.types.map((t) => { const o = el("option", "", t.label); o.value = t.key; return o; }));
      $("micBtn").hidden = !d.recording;
      fillPresets();
    } catch {}
  }
  function fillPresets() {
    const sel = $("voicePreset"); sel.innerHTML = "";
    const auto = el("option", "", voice.type === "auto" ? "الصوت المناسب للشخصية" : `الصوت المقترح – ${typeLabel(voice.type)}`); auto.value = "auto"; sel.append(auto);
    const [g, a] = voice.type.split(".");
    voice.catalog.voices.filter((v) => voice.type === "auto" || (v.gender === g && v.age === a))
      .forEach((v) => { const o = el("option", "", v.label); o.value = v.id; sel.append(o); });
    if ([...sel.options].some((o) => o.value === voice.preset)) sel.value = voice.preset; else voice.preset = "auto";
    renderVoice();
  }
  function setVoiceType(key) {
    voice.type = voice.catalog.types.some((t) => t.key === key) ? key : "auto";
    $("voiceType").value = voice.type; voice.preset = "auto"; fillPresets();
  }
  function setVoiceMode(m) {
    if ((m === "own" || m === "convert") && !voice.clip?.ok) m = "tts";
    voice.mode = m;
    $("voiceMode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === m));
    document.querySelectorAll(".vcheck .acts [data-use]").forEach((b) => b.classList.toggle("on", b.dataset.use === m));
    renderVoice();
  }
  // the character type the request uses: chosen type, else the chosen voice's own type
  const chosenType = () => {
    if (voice.type !== "auto") return voice.type;
    const p = voice.catalog.voices.find((v) => v.id === voice.preset);
    return p ? `${p.gender}.${p.age}` : "auto";
  };
  // the paid order: its length and «اللغة» field; the free video: 10 s and «لغة الكلام»
  const curSeconds = () => (trial.mode === "free" ? voice.videoSeconds : state.seconds);
  const isMute = () => (trial.mode === "free" ? $("trialVoice").value === "none" : state.language === "بدون كلام");
  function voiceSpec(forOrder = false) {
    const t = chosenType(); const [gender, age] = t === "auto" ? [null, null] : t.split(".");
    const spec = { mode: isMute() ? "none" : voice.mode, preset: voice.preset, gender, age, clip: voice.clip?.ok ? voice.clip.id : null };
    if (forOrder) spec.transcript = voice.clip?.transcript || "";
    return spec;
  }
  function voiceChoiceText() {
    if (isMute()) return "بدون صوت";
    const who = voice.preset !== "auto" ? presetLabel(voice.preset) : voice.type !== "auto" ? typeLabel(voice.type) : "صوت مناسب للشخصية";
    if (voice.mode === "own") return "صوتك كما سجّلته";
    if (voice.mode === "convert") return `كلامك بصوت: ${who}`;
    return who;
  }
  function renderVoice() {
    const s = $("voiceSummary"); if (!s) return;
    const own = voice.clip?.ok;
    $("voiceMode").querySelectorAll('[data-v="own"],[data-v="convert"]').forEach((b) => { b.disabled = !own; b.title = own ? "" : "سجّل صوتك أولاً بزر المايك 🎙️"; });
    $("voicePlay").disabled = voice.preset === "auto" && voice.type === "auto";
    if (isMute()) { s.textContent = "الفيديو بدون كلام – أصوات المكان فقط."; return; }
    const secs = curSeconds();
    let t = `سيتكلم في الفيديو: ${voiceChoiceText()}`;
    if (voice.mode === "tts") t += voice.type === "auto" ? " – نختار الشخصية والصوت من فكرتك." : " – والشخصية في الفيديو بنفس العمر والجنس.";
    if (own && voice.mode !== "tts") {
      const d = voice.clip.duration;
      t += ` · «${voice.clip.transcript.slice(0, 60)}${voice.clip.transcript.length > 60 ? "…" : ""}» · ${d.toFixed(1)} ث من ${secs} ث ${d > secs ? (voice.mode === "own" ? "– سيُقصّ الزائد" : "– سيُسرّع قليلاً") : "✔"}`;
    }
    s.textContent = t;
  }
  afterRender = renderVoice; // order length / language changed
  $("voiceType").addEventListener("change", (e) => setVoiceType(e.target.value));
  $("voicePreset").addEventListener("change", (e) => { voice.preset = e.target.value; renderVoice(); });
  $("trialVoice").addEventListener("change", renderVoice);
  $("voiceMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.disabled) setVoiceMode(b.dataset.v); });
  let previewAudio = null;
  $("voicePlay").addEventListener("click", () => {
    const id = voice.preset !== "auto" ? voice.preset : voice.catalog.types.find((t) => t.key === voice.type)?.preset;
    if (!id) return;
    previewAudio?.pause();
    previewAudio = new Audio(`/api/voices/${encodeURIComponent(id)}/preview`);
    const btn = $("voicePlay"), label = btn.querySelector("span");
    const show = (state, text) => { btn.dataset.state = state; label.textContent = text; };
    show("load", "…"); previewAudio.oncanplay = () => show("play", "يعمل");
    previewAudio.onended = previewAudio.onerror = () => show("", "اسمع");
    previewAudio.play().catch(() => show("", "اسمع"));
  });

  // the customer tells the chat which voice they want
  function voiceFromText(text) {
    const t = String(text || ""), changed = [];
    const about = /صوت|يتكلم|تتكلم|يحچي|تحچي|يحكي|تحكي|يكول|تكول|يقول|تقول|المتكلم|الشخصية/.test(t);
    const spoken = [[/بالفصحى|فصحى|فصيحة|عربية فصحى/, "ar", "فصحى"], [/باللهجة العراقية|لهجة عراقية|بالعراقي|عراقي (لهجة)|باللهجة البغدادية/, "ar-IQ", "عراقي"],
      [/بالانجليزي|بالإنجليزي|بالانكليزي|باللغة الانجليزية|باللغة الإنجليزية|in english|english voice/i, "en", "English"], [/بالكردي|بالكوردي|باللغة الكردية|باللهجة الكردية/, "ku", "كوردي"], [/بالتركي|باللغة التركية/, "tr", "Türkçe"], [/بالفارسي|باللغة الفارسية/, "fa", "فارسی"]];
    const sp = spoken.find(([re]) => re.test(t));
    if (sp && $("trialVoice").value !== sp[1]) { $("trialVoice").value = sp[1]; renderVoice(); changed.push(`لغة الكلام: ${sp[2]}`); }
    if (/بدون صوت|بلا صوت|بدون كلام/.test(t)) { if (trial.mode === "free") $("trialVoice").value = "none"; else setLanguage("بدون كلام"); renderVoice(); changed.push("بدون صوت"); return changed; }
    if (voice.clip?.ok && /(حول|حوّل|غير|غيّر|بدل|بدّل)\s*صوتي|كلامي بصوت/.test(t)) { setVoiceMode("convert"); changed.push("كلامك بصوت الشخصية"); }
    else if (voice.clip?.ok && /بصوتي|صوتي آني|نفس صوتي|صوتي كما/.test(t)) { setVoiceMode("own"); changed.push("صوتك كما هو"); }
    if (!about) return changed;
    const rules = [
      [/حجية|عجوز|جدة|بيبي/, "female.old"], [/حجي|شايب|جدو|كبير بالعمر|كبير بالسن/, "male.old"],
      [/بنت\s*(صغيرة|زغيرة|صغيره)|طفلة|بنية صغيرة/, "female.child"], [/ولد\s*(صغير|زغير)|طفل\b|جاهل/, "male.child"],
      [/شابة|بنت/, "female.young"], [/شاب\b|ولد/, "male.young"],
      [/امرأة|امراة|مرة|سيدة|ست\b|أم\b|ام\b|ماما/, "female.adult"], [/رجل|زلمة|رجال|أب\b|بابا/, "male.adult"],
    ];
    let key = rules.find(([re]) => re.test(t))?.[1] || null;
    const age = t.match(/عمر(?:ه|ها|و)?\s*(\d{1,2})/);
    if (age) {
      const gender = key ? key.split(".")[0] : chosenType() !== "auto" ? chosenType().split(".")[0] : /ها\s*\d|بنت|هي/.test(t) ? "female" : "male";
      key = `${gender}.${TYPE_OF_AGE(Number(age[1]))}`;
    }
    if (key && key !== voice.type) { setVoiceType(key); changed.push(`الصوت: ${typeLabel(key)}`); }
    return changed;
  }

  // ---------- recording in the chat ----------
  const micBtn = $("micBtn");
  function stopRec() { if (voice.rec?.mr?.state === "recording") voice.rec.mr.stop(); }
  micBtn.addEventListener("click", async () => {
    if (voice.rec) return stopRec();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("المتصفح لا يدعم التسجيل – ارفع ملفاً صوتياً بزر المشبك."); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast("اسمح للموقع باستخدام المايك ثم حاول مرة ثانية."); return; }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    const started = Date.now();
    voice.rec = { mr, timer: setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $("micTime").textContent = `${s}ث`;
      if (s >= 30) stopRec(); // a video holds at most ~10 s of speech; 30 s is the hard stop
    }, 250) };
    micBtn.classList.add("rec"); micBtn.title = "اضغط لإيقاف التسجيل";
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      clearInterval(voice.rec.timer); voice.rec = null;
      stream.getTracks().forEach((t) => t.stop());
      micBtn.classList.remove("rec"); micBtn.title = "سجّل صوتك – يُفحص ثم يُستخدم في الفيديو"; $("micTime").textContent = "";
      const blob = new Blob(chunks, { type: (mr.mimeType || type || "audio/webm").split(";")[0] });
      if (Date.now() - started < 800 || blob.size < 1500) { toast("التسجيل قصير جداً – اضغط وتكلّم ثم اضغط للإيقاف."); return; }
      uploadVoice(blob, "تسجيلك");
    };
    mr.start(250);
    toast("🎙️ يسجّل الآن… تكلّم ثم اضغط المايك للإيقاف");
  });

  // ---------- the check card: what we heard, and whether the recording can be used ----------
  const ICON = { ok: "✅", warn: "⚠️", bad: "❌" };
  const AGE_AR = { child: "طفل", young: "شاب", adult: "بالغ", old: "كبير بالعمر" };
  const GENDER_AR = { female: "أنثى", male: "ذكر" };
  function matchNote(clip) {
    const sp = clip.speaker || {}; const t = chosenType();
    if (!sp.gender || !sp.age || t === "auto") return "";
    const [g, a] = t.split(".");
    if (sp.gender === g && sp.age === a) return `✅ التسجيل يناسب الشخصية المختارة (${typeLabel(t)}).`;
    return `ℹ️ المتكلم في التسجيل: ${typeLabel(`${sp.gender}.${sp.age}`)}، والشخصية المختارة «${typeLabel(t)}»: مع «صوتي كما هو» نجعل الشخص في الفيديو يطابق صوتك، ومع «كلامي بصوت الشخصية» يقول ${typeLabel(t)} نفس كلامك.`;
  }
  function voiceCard(card, clip) {
    card.replaceChildren();
    card.append(el("h4", "", clip.ok ? "🎙️ فحص صوتك: صالح للاستخدام" : "🎙️ فحص صوتك: يحتاج تسجيلاً جديداً"));
    const a = el("audio"); a.controls = true; a.preload = "metadata"; a.src = clip.url; card.append(a);
    const ul = el("ul"); clip.items.forEach((i) => ul.append(el("li", i.level, `${ICON[i.level] || "•"} ${i.text}`))); card.append(ul);
    // who is speaking – the customer says it (used to match the person in the video to the recording)
    if (clip.ok) {
      const sp = clip.speaker || {};
      const who = el("label", "who", "🧑 صوت مَن في هذا التسجيل؟ ");
      const sel = el("select");
      const none = el("option", "", "اختر…"); none.value = ""; sel.append(none);
      voice.catalog.types.forEach((t) => { const o = el("option", "", t.label); o.value = t.key; sel.append(o); });
      sel.value = sp.gender && sp.age ? `${sp.gender}.${sp.age}` : "";
      sel.onchange = async () => {
        if (!sel.value) return;
        const [gender, age] = sel.value.split(".");
        try {
          const d = await (await fetch(`/api/voice/clips/${encodeURIComponent(clip.id)}/speaker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gender, age }) })).json();
          if (d.ok) { setClip(d.clip); voiceCard(card, d.clip); } else toast(d.message || "تعذّر الحفظ");
        } catch { toast("تعذّر الاتصال بالخادم"); }
      };
      who.append(sel); card.append(who);
    }
    const m = matchNote(clip); if (m && clip.ok) card.append(el("span", "match", m));
    const acts = el("div", "acts");
    if (clip.ok) {
      [["own", "🎙️ استخدم صوتي كما هو"], ["convert", "🔁 كلامي بصوت الشخصية"]].forEach(([v, label]) => {
        const b = el("button", voice.mode === v ? "on" : "", label); b.type = "button"; b.dataset.use = v;
        b.onclick = () => { useVideoForVoice(); setVoiceMode(v); };
        acts.append(b);
      });
    }
    const again = el("button", "", "🔍 افحص مرة ثانية"); again.type = "button";
    again.onclick = async () => {
      again.disabled = true; again.textContent = "⏳ يفحص…";
      try { const d = await (await fetch(`/api/voice/clips/${encodeURIComponent(clip.id)}/check?seconds=${curSeconds()}`, { method: "POST" })).json(); if (d.ok) { setClip(d.clip); voiceCard(card, d.clip); return; } toast(d.message || "تعذّر الفحص"); }
      catch { toast("تعذّر الاتصال بالخادم"); }
      again.disabled = false; again.textContent = "🔍 افحص مرة ثانية";
    };
    const rec = el("button", "", "🎙️ سجّل من جديد"); rec.type = "button"; rec.onclick = () => micBtn.click();
    acts.append(again, rec); card.append(acts);
    list.scrollTop = list.scrollHeight;
  }
  function setClip(clip) {
    voice.clip = clip;
    if (clip.ok && voice.mode === "tts") setVoiceMode("own"); else setVoiceMode(voice.mode);
  }
  // a recording only makes sense in a video: the paid order keeps it (with speech), the free trial switches to video
  function useVideoForVoice() {
    if (trial.mode !== "free") { if (state.language === "بدون كلام") setLanguage("عراقي (لهجة)"); return; }
    if (!trial.on) return;
    const vb = $("trialKind").querySelector('[data-v="video"]');
    if (vb && !vb.disabled && trial.kind !== "video") vb.click();
    if ($("trialVoice").value === "none") $("trialVoice").value = "ar-IQ";
  }
  async function uploadVoice(blob, name) {
    startChat();
    const local = URL.createObjectURL(blob);
    const um = addMsg("user", `🎙️ ${name}`); const pa = el("audio"); pa.controls = true; pa.src = local; um.append(pa);
    const card = addMsg("sys", "", [], "vcheck"); card.append(el("h4", "", "🔍 نفحص صوتك… (المدة، مستوى الصوت، الوضوح، الضجيج، الكلام واللهجة)"));
    try {
      const r = await fetch(`/api/voice/clip?seconds=${curSeconds()}`, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { card.replaceChildren(el("h4", "", `❌ ${d.message || "تعذّر فحص التسجيل"}`)); return; }
      setClip(d.clip); voiceCard(card, d.clip);
      if (d.clip.ok) {
        useVideoForVoice();
        // the assistant and the plan know what was said
        state.messages.push({ role: "user", content: `🎙️ (تسجيل صوتي لي): «${d.clip.transcript}»` });
      }
    } catch { card.replaceChildren(el("h4", "", "❌ تعذّر الاتصال بالخادم، حاول مرة ثانية.")); }
  }
  function initTrial() {
    trial.on = true;
    $("modeSeg").hidden = false;
    loadTrial();
  }
  // free results from before a reload come back into the chat (after the welcome message) and keep updating
  function restoreTrial() {
    try { trial.jobs = JSON.parse(localStorage.getItem(TRIAL_KEY) || "[]").filter((j) => j && j.id && j.token); } catch { trial.jobs = []; }
    // a refresh renews the chat: finished results are not brought back (the limits per visitor stay on the server);
    // only a result still being made returns, so a reload during the wait still delivers it
    trial.jobs = trial.jobs.filter(pending);
    saveTrialJobs();
    if (!trial.jobs.length) return;
    // the welcome page with the showcase loops stays as before; the chat opens only when something is still being made
    // (or when the visitor sends something – the finished results are already waiting in the list)
    if (trial.jobs.some(pending)) { startChat(); setMode("free"); }
    trial.jobs.forEach((j) => { trialCard(j); pollTrial(j, 0); });
  }

  // ---------- works ----------
  const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
  async function loadVideos() {
    let videos = [];
    try { videos = (await (await fetch("/api/videos")).json()).videos || []; } catch {}
    const grid = $("grid"); grid.innerHTML = "";
    if (!videos.length) { grid.innerHTML = `<div class="tile empty">لا توجد أعمال معروضة حالياً.</div>`; return; }
    videos.forEach((v, i) => {
      const tile = document.createElement("div"); tile.className = "tile";
      tile.innerHTML = `<div class="frame"><video muted loop playsinline preload="metadata" controls></video></div>
        <div class="meta"><b title="${v.file}">${v.name}</b><a href="${v.url}" target="_blank" rel="noopener">${fmtSize(v.size)} · فتح</a></div>`;
      const vid = tile.querySelector("video"), frame = tile.querySelector(".frame");
      if (v.name.startsWith("قبل وبعد") || v.name.startsWith("مقارنة")) frame.classList.add("compare");
      setTimeout(() => {
        vid.src = v.url;
        // vertical (9:16) videos: show the whole frame instead of a 16:9 crop
        vid.addEventListener("loadedmetadata", () => { if (!frame.classList.contains("compare") && vid.videoHeight > vid.videoWidth) frame.classList.add("tall"); }, { once: true });
        vid.addEventListener("loadeddata", () => { frame.classList.add("ready"); vid.play().catch(() => {}); }, { once: true });
        setTimeout(() => frame.classList.add("ready"), 9000);
      }, 200 + i * 250);
      grid.appendChild(tile);
    });
  }

  // ---------- boot ----------
  (async () => {
    $("year").textContent = new Date().getFullYear();
    try {
      const cfg = await (await fetch("/api/config")).json();
      if (cfg.rates) state.rates = cfg.rates;
      state.demo = Boolean(cfg.demo);
      state.payments = cfg.payments || null;
      state.whatsapp = cfg.whatsapp || null;
      if (cfg.trial) initTrial();
      loadVoices();
      const lim = String(cfg.attachLimit || "").match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i);
      if (lim) state.attachLimit = Number(lim[1]) * ({ kb: 1024, mb: 1048576, gb: 1073741824 }[(lim[2] || "mb").toLowerCase()]);
    } catch {}
    try { state.policy = await (await fetch("/policy.json")).json(); renderTerms("ar"); } catch {}
    setupWhatsApp();
    render();
    showcase();
    loadVideos();
    const hello = "هلا بيك 👋 احجيلي عن الفيديو اللي تريده: شنو الفكرة، ولمن موجّه؟ وإذا عندك صور للشخصيات أو مقطع مرجعي ارفعه من زر المشبك.";
    addMsg("bot", hello);
    state.messages.push({ role: "assistant", content: hello });
    if (trial.on) restoreTrial();
    // a refresh always opens the welcome page with the showcase loops (no previous order restored)
    try { localStorage.removeItem("vi-order"); } catch {}
    // …except the return from the payment page: Wayl sends the customer to /paid/?referenceId=<order>-P1&orderid=…
    if (location.pathname.startsWith("/paid")) {
      const ref = new URLSearchParams(location.search).get("referenceId") || "";
      let back = null;
      try { back = JSON.parse(localStorage.getItem("vi-pay") || "null"); } catch {}
      history.replaceState(null, "", "/");
      if (back?.requestId && Date.now() - back.at < 3 * 86400e3 && (!ref || ref.startsWith(back.requestId))) {
        Object.assign(state, { requestId: back.requestId, requesterId: back.requesterId, accessToken: back.accessToken });
        startChat();
        addMsg("sys", `رجعت من صفحة الدفع – نتحقق من دفع الطلب ${back.requestId}…`);
        trackOrder(null);
      } else if (ref) {
        addMsg("sys", `رجعت من صفحة الدفع (${ref}). إذا أكملت الدفع سيصلك التأكيد على تيليغرام وبالبريد.`);
      }
    }
  })();
})();
