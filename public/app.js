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
    started: false,
  };
  const price = (q = state.quality, s = state.seconds) => Math.ceil((state.rates[q] || state.rates[1080]) * s);

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3400);
  };

  // ---------- validation (mirrors the server) ----------
  const parseTelegram = (v) => {
    const m = String(v || "").trim().replace(/^(https?:\/\/)?(www\.)?t\.me\//i, "").replace(/^@+/, "").match(/^[A-Za-z][A-Za-z0-9_]{4,31}$/);
    return m ? m[0] : "";
  };
  const parsePhone = (v) => {
    let d = String(v || "").replace(/\D/g, "");
    if (d.startsWith("00964")) d = d.slice(5); else if (d.startsWith("964")) d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
    return /^7\d{9}$/.test(d) ? `+964${d}` : "";
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
    // shuffle, then fill 6 cells and rotate one cell at a time
    loops.sort(() => Math.random() - .5);
    let next = 0;
    const cells = [];
    for (let i = 0; i < 6; i++) {
      const cell = document.createElement("div"); cell.className = "cell";
      const img = document.createElement("img"); img.alt = "";
      const v = document.createElement("video"); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "metadata";
      cell.append(img, v); mosaic.appendChild(cell); cells.push({ cell, img, v });
    }
    const load = (c, loop) => {
      c.cell.classList.remove("ready");
      if (loop.poster) c.img.src = loop.poster;
      c.v.src = loop.src;
      c.v.onloadeddata = () => { c.cell.classList.add("ready"); c.v.play().catch(() => {}); };
    };
    cells.forEach((c, i) => setTimeout(() => load(c, loops[next++ % loops.length]), i * 350));
    const rotate = setInterval(() => {
      if (state.started) return clearInterval(rotate);
      load(cells[Math.floor(Math.random() * cells.length)], loops[next++ % loops.length]);
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
    requestId: state.requestId, requesterId: state.requesterId,
    description: state.messages.filter((m) => m.role === "user").map((m) => m.content).filter(Boolean).join("\n"),
    attachments: state.attachments,
  });

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
      const isImage = file.type.startsWith("image/");
      if (file.size > state.attachLimit) { toast(`الملف ${file.name} أكبر من الحد المسموح (${Math.round(state.attachLimit / 1048576)} MB)`); return; }
      const item = { name: file.name, size: file.size, image: isImage, video: isVideo, role: isImage ? "char1" : "ref", preview: null, done: false, progress: 0, url: null, stored: null };
      // first picture defaults to character 1, next ones to 2, 3, then reference
      if (isImage) { const used = [...state.pending, ...state.attachments].filter((a) => a.image).length; item.role = ["char1", "char2", "char3"][used] || "ref"; }
      if (isImage || isVideo) item.preview = URL.createObjectURL(file);
      state.pending.push(item); renderTray();
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/attach/${encodeURIComponent(file.name)}`);
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
    try {
      const r = await fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: state.messages, order: orderPayload() }) });
      const data = await r.json();
      if (r.status === 400) return fail(data.field || "chat", data.message);
      note.className = `note ${data.ok ? "ok" : "err"}`; note.textContent = data.message;
      toast(data.ok ? "تم استلام طلبك" : "حدثت مشكلة");
      if (data.requestId) {
        state.requestId = data.requestId; state.requesterId = data.requesterId;
        addMsg("sys", `تم إرسال الطلب ✔<br>رقم الطلب <code>${data.requestId}</code> معرّفك <code>${data.requesterId}</code><br><small>أي رسالة ترسلها الآن تُضاف إلى هذا الطلب.</small>`, [], "ids ok");
        state.messages.push({ role: "assistant", content: `تم إرسال الطلب. رقم الطلب ${data.requestId}، معرّف الزبون ${data.requesterId}.` });
        btn.innerHTML = `إرسال طلب جديد <span class="cta-price">$<span id="ctaPrice">${price()}</span></span>`;
        if (window.innerWidth <= 820) list.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } catch {
      note.className = "note err"; note.textContent = "تعذّر الاتصال بالخادم.";
    } finally { btn.disabled = false; }
  });

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
      const lim = String(cfg.attachLimit || "").match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb)?$/i);
      if (lim) state.attachLimit = Number(lim[1]) * ({ kb: 1024, mb: 1048576, gb: 1073741824 }[(lim[2] || "mb").toLowerCase()]);
    } catch {}
    render();
    showcase();
    loadVideos();
    const hello = "هلا بيك 👋 احجيلي عن الفيديو اللي تريده: شنو الفكرة، ولمن موجّه؟ وإذا عندك صور للشخصيات أو مقطع مرجعي ارفعه من زر المشبك.";
    addMsg("bot", hello);
    state.messages.push({ role: "assistant", content: hello });
  })();
})();
