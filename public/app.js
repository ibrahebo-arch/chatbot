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
      const v = document.createElement("video"); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "metadata";
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
  function policyCard(sections, lang = customerLang()) {
    const doc = state.policy?.[lang];
    if (!doc) return;
    const card = el("div", "msg sys policy");
    card.dir = lang === "ar" ? "rtl" : "ltr"; card.lang = lang;
    card.append(el("span", "ph", lang === "ar" ? "⚠️ لا يمكننا تنفيذ هذا الطلب – يخالف شروط VI Iraq" : "⚠️ We can't make this request – it is not allowed under VI Iraq's terms"));
    doc.sections.filter((s) => sections.includes(s.n)).forEach((s) => card.append(sectionEl(s, "div")));
    const more = el("button", "pl", lang === "ar" ? "عرض كل الشروط وإخلاء المسؤولية" : "View all terms and the disclaimer");
    more.type = "button"; more.onclick = () => openTerms(lang, sections[0]);
    card.append(more);
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
      const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
      const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(file.name);
      if (!isImage && !isVideo) { toast(`الملف ${file.name} غير مدعوم – ارفع صورة أو فيديو فقط`); return; }
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
  $("mGo").addEventListener("click", () => $("panel").scrollIntoView({ behavior: "smooth", block: "start" }));

  function render() {
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
      if (r.status === 422 && data.policy) {
        state.idemKey = null;
        const lang = customerLang();
        note.className = "note err";
        note.textContent = lang === "ar" ? data.message : "We can't make this request because it breaks VI Iraq's terms. Change the idea and send it again.";
        policyCard(data.policy.sections, lang);
        if (window.innerWidth <= 820) list.scrollIntoView({ behavior: "smooth", block: "end" });
        return;
      }
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
        if (window.innerWidth <= 820) list.scrollIntoView({ behavior: "smooth", block: "end" });
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
      setTimeout(() => {
        vid.src = v.url;
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
