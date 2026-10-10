/* VI Iraq – control-center front end */
(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    messages: [],
    quality: 1080,
    seconds: 15,
    language: "العربية",
    characters: "1",
    rates: { 1080: 80 / 60, 720: 44 / 60, 480: 22 / 60 },
    sending: false,
    pending: [],      // attachments chosen but not yet sent in a message
    attachments: [],  // every attachment sent, goes with the order
  };
  const price = (q = state.quality, s = state.seconds) =>
    Math.ceil((state.rates[q] || state.rates[1080]) * s);

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 3200);
  };

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${b.dataset.tab}`));
    })
  );

  // ---------- chat ----------
  const list = $("messages");
  function addMsg(role, content, files = []) {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.textContent = content;
    if (files.length) {
      const box = document.createElement("div");
      box.className = "files";
      files.forEach((f) => {
        if (f.image) {
          const a = document.createElement("a"); a.href = f.url; a.target = "_blank";
          const img = document.createElement("img"); img.src = f.url; img.alt = f.name; a.appendChild(img); box.appendChild(a);
        } else if (f.video) {
          const wrap = document.createElement("div"); wrap.className = "vid";
          const v = document.createElement("video"); v.src = f.url; v.controls = true; v.preload = "metadata"; v.playsInline = true;
          const cap = document.createElement("a"); cap.href = f.url; cap.target = "_blank"; cap.textContent = `🎬 ${f.name}`;
          wrap.appendChild(v); wrap.appendChild(cap); box.appendChild(wrap);
        } else {
          const a = document.createElement("a"); a.href = f.url; a.target = "_blank"; a.textContent = `📄 ${f.name}`; box.appendChild(a);
        }
      });
      el.appendChild(box);
    }
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }
  function typing() {
    const el = document.createElement("div");
    el.className = "msg bot typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }
  const orderPayload = () => ({
    quality: state.quality,
    seconds: state.seconds,
    language: state.language,
    characters: state.characters,
    contact: $("contact").value.trim(),
    description: state.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
    attachments: state.attachments,
  });

  // ---------- attachments (any number of images / files) ----------
  const tray = $("tray");
  function renderTray() {
    tray.hidden = !state.pending.length;
    tray.innerHTML = "";
    state.pending.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "att" + (f.done ? "" : " uploading");
      const thumb = f.image && f.preview ? `<img src="${f.preview}" alt="">`
        : f.video && f.preview ? `<video src="${f.preview}" muted playsinline preload="metadata"></video>`
        : `<span class="ic">${f.video ? "🎬" : "📄"}</span>`;
      el.innerHTML = thumb +
        `<span class="nm" title="${f.name}">${f.name}${f.done ? "" : ` · ${f.progress || 0}%`}</span>` +
        `<button type="button" class="x" data-i="${i}">✕</button>` +
        (f.done ? "" : `<i class="prog" style="width:${f.progress || 0}%"></i>`);
      tray.appendChild(el);
    });
  }
  tray.addEventListener("click", (e) => {
    const b = e.target.closest(".x"); if (!b) return;
    state.pending.splice(Number(b.dataset.i), 1); renderTray();
  });
  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    [...$("fileInput").files].forEach((file) => {
      const isVideo = file.type.startsWith("video/") || /.(mp4|webm|mov|m4v)$/i.test(file.name);
      if (state.attachLimit && file.size > state.attachLimit) { toast(`الملف ${file.name} أكبر من الحد المسموح (${Math.round(state.attachLimit / 1048576)} MB)`); return; }
      const item = { name: file.name, size: file.size, image: file.type.startsWith("image/"), video: isVideo, preview: null, done: false, progress: 0, url: null, stored: null };
      if (item.image || item.video) item.preview = URL.createObjectURL(file);
      state.pending.push(item); renderTray();
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/attach/${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = Math.round((e.loaded / e.total) * 100); renderTray(); } };
      xhr.onload = () => {
        let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 200) { Object.assign(item, { done: true, url: d.url, stored: d.stored, image: d.image, video: d.video }); }
        else { state.pending.splice(state.pending.indexOf(item), 1); toast(d.error || "فشل رفع الملف"); }
        renderTray();
      };
      xhr.onerror = () => { state.pending.splice(state.pending.indexOf(item), 1); toast("فشل رفع الملف"); renderTray(); };
      xhr.send(file);
    });
    $("fileInput").value = "";
  });

  // The customer can set everything from inside the chat by typing it.
  function applyFromText(text) {
    const changed = [];
    const q = text.match(/\b(480|720|1080)\s*(p|px|بكسل)?\b/i);
    if (q) { setQuality(Number(q[1])); changed.push(`الدقة ${q[1]}p`); }
    const mins = text.match(/(\d+)\s*(دقيقة|دقائق|min|minute)/i);
    const secs = text.match(/(\d+)\s*(ثانية|ثواني|ث|s|sec|second)/i);
    if (mins) { setSeconds(Number(mins[1]) * 60); changed.push(`المدة ${mins[1]} دقيقة`); }
    else if (secs) { setSeconds(Number(secs[1])); changed.push(`المدة ${secs[1]} ثانية`); }
    else if (/\bدقيقة\b/.test(text) && !/\d/.test(text)) { setSeconds(60); changed.push("المدة دقيقة"); }
    const langs = [["english", "English"], ["انجليزي", "English"], ["إنجليزي", "English"], ["عراقي", "عراقي (لهجة)"], ["كردي", "كوردي"], ["كوردي", "كوردي"], ["تركي", "Türkçe"], ["فارسي", "فارسی"], ["بدون كلام", "بدون كلام"], ["عربي", "العربية"]];
    for (const [k, v] of langs) if (text.toLowerCase().includes(k)) { setLanguage(v); changed.push(`اللغة ${v}`); break; }
    const words = { "شخصية واحدة": 1, "شخص واحد": 1, "شخصيتين": 2, "شخصين": 2, "ثلاث": 3, "اربع": 4, "أربع": 4, "خمس": 5 };
    let chN = null;
    const ch = text.match(/(\d)\s*(شخصيات|شخصية|اشخاص|أشخاص|characters?|people)/i);
    if (ch) chN = Number(ch[1]);
    else for (const [k, v] of Object.entries(words)) if (text.includes(k) && /شخص/.test(text)) { chN = v; break; }
    if (chN) { setCharacters(chN >= 5 ? "5+" : chN); changed.push(`${chN} شخصيات`); }
    if (changed.length) addMsg("sys", "⚙️ تم ضبط: " + changed.join(" · "));
  }

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("input").value.trim();
    const files = state.pending.filter((f) => f.done);
    if ((!text && !files.length) || state.sending) return;
    if (state.pending.some((f) => !f.done)) { toast("انتظر اكتمال رفع الملفات…"); return; }
    $("input").value = "";
    state.pending = []; renderTray();
    state.attachments.push(...files.map((f) => ({ name: f.name, stored: f.stored, url: f.url, image: f.image, video: f.video })));
    const content = text + (files.length ? `${text ? "\n" : ""}[مرفقات: ${files.map((f) => f.name).join("، ")}]` : "");
    state.messages.push({ role: "user", content });
    addMsg("user", text, files);
    if (text) applyFromText(text);
    const t = typing();
    state.sending = true;
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: state.messages, order: orderPayload() }),
      });
      const data = await r.json();
      t.remove();
      addMsg("bot", data.reply || "…");
      if (data.reply) state.messages.push({ role: "assistant", content: data.reply });
    } catch {
      t.remove();
      addMsg("bot", "تعذّر الاتصال بالخادم، حاول مرة ثانية.");
    } finally {
      state.sending = false;
    }
  });

  // ---------- controls ----------
  const slider = $("seconds");
  function setQuality(q) {
    state.quality = q;
    document.querySelectorAll("#quality button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === q));
    render();
  }
  function setSeconds(s) {
    state.seconds = Math.min(Number(slider.max), Math.max(Number(slider.min), Math.round(s / 5) * 5));
    slider.value = state.seconds;
    render();
  }
  function setLanguage(v) { state.language = v; $("language").value = v; render(); }
  function setCharacters(v) { state.characters = String(v); $("characters").value = String(v); render(); }

  $("quality").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setQuality(Number(b.dataset.v)); });
  slider.addEventListener("input", () => { state.seconds = Number(slider.value); render(); });
  $("quick").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeconds(Number(b.dataset.s)); });
  $("language").addEventListener("change", (e) => setLanguage(e.target.value));
  $("characters").addEventListener("change", (e) => setCharacters(e.target.value));

  function render() {
    const p = price();
    $("secVal").textContent = state.seconds;
    $("priceVal").textContent = p;
    $("ctaPrice").textContent = p;
    $("priceMeta").textContent = `${state.quality}p · ${state.seconds} ثانية · ${state.language}`;
    const amt = document.querySelector(".amount");
    amt.classList.add("bump");
    setTimeout(() => amt.classList.remove("bump"), 150);
    slider.style.setProperty("--fill", `${((state.seconds - slider.min) / (slider.max - slider.min)) * 100}%`);
    document.querySelectorAll("#quick button").forEach((b) => b.classList.toggle("on", Number(b.dataset.s) === state.seconds));
    $("summary").innerHTML = [`🎞️ ${state.quality}p`, `⏱️ ${state.seconds}ث`, `🌍 ${state.language}`, `👥 ${state.characters}`, `💵 $${p}`]
      .map((s) => `<span>${s}</span>`).join("");
    $("priceTable").innerHTML = [[15, "15 ثانية"], [30, "30 ثانية"], [60, "دقيقة"], [120, "دقيقتان"]]
      .map(([s, label]) => `<tr><td>${label}</td>${[480, 720, 1080].map((q) => `<td class="${q === state.quality ? "hi" : ""}">$${price(q, s)}</td>`).join("")}</tr>`)
      .join("");
  }

  // ---------- send order ----------
  $("sendOrder").addEventListener("click", async () => {
    const note = $("orderNote");
    if (!state.messages.some((m) => m.role === "user")) {
      note.className = "note err";
      note.textContent = "اكتب أولاً وصف الفيديو في الدردشة 👆";
      $("input").focus();
      return;
    }
    const btn = $("sendOrder");
    btn.disabled = true;
    note.className = "note";
    note.textContent = "جارٍ الإرسال…";
    try {
      const r = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: state.messages, order: orderPayload() }),
      });
      const data = await r.json();
      note.className = `note ${data.ok ? "ok" : "err"}`;
      note.textContent = data.message;
      toast(data.ok ? "✅ تم استلام طلبك" : "⚠️ حدثت مشكلة");
      if (data.ok) addMsg("sys", `✅ تم إرسال الطلب: ${state.quality}p / ${state.seconds} ثانية / $${price()}`);
    } catch {
      note.className = "note err";
      note.textContent = "تعذّر الاتصال بالخادم.";
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- video widgets ----------
  const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
  async function loadVideos() {
    let videos = [];
    try { videos = (await (await fetch("/api/videos")).json()).videos || []; } catch {}
    $("vidCount").textContent = videos.length;
    $("vidPill").classList.toggle("off", !videos.length);
    const grid = $("grid");
    grid.innerHTML = "";
    if (!videos.length) {
      grid.insertAdjacentHTML("beforeend", `
        <div class="tile offline"><h3>🔴 لا توجد فيديوهات</h3>
          <div class="frame"><div><h4>OFFLINE</h4><p>public/videos</p><p style="opacity:.75">أضف ملفات .mp4 أو .webm</p></div></div>
        </div>`);
    }
    videos.forEach((v, i) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.innerHTML = `
        <h3><span>🟢</span><span class="name" title="${v.file}">${v.name}</span></h3>
        <div class="frame"><video muted loop playsinline preload="metadata" controls></video></div>
        <div class="meta">
          <span>${fmtSize(v.size)}</span>
          <span><a href="${v.url}" target="_blank" rel="noopener">فتح في تبويب جديد</a></span>
        </div>`;
      const vid = tile.querySelector("video");
      const frame = tile.querySelector(".frame");
      // Attach tiles one at a time so the page paints before the videos start.
      setTimeout(() => {
        vid.src = v.url;
        vid.addEventListener("loadeddata", () => { frame.classList.add("ready"); vid.play().catch(() => {}); }, { once: true });
        setTimeout(() => frame.classList.add("ready"), 9000);
      }, 220 + i * 260);
      grid.appendChild(tile);
    });
  }

  // ---------- boot ----------
  (async () => {
    try {
      const cfg = await (await fetch("/api/config")).json();
      if (cfg.rates) state.rates = cfg.rates;
      const lim = String(cfg.attachLimit || "").match(/^(d+(?:.d+)?)s*(kb|mb|gb)?$/i);
      if (lim) state.attachLimit = Number(lim[1]) * ({ kb: 1024, mb: 1048576, gb: 1073741824 }[(lim[2] || "mb").toLowerCase()]);
      $("mailPill").title = cfg.mail ? "البريد يعمل" : (cfg.mailError || "البريد غير مفعّل");
      $("aiPill").classList.toggle("off", !cfg.ai);
      $("mailPill").classList.toggle("off", !cfg.mail);
      $("aiState").innerHTML = cfg.ai ? '<i class="dot"></i> جاهز للدردشة' : '<i class="dot" style="background:#f85149;box-shadow:0 0 7px #f85149"></i> وضع يدوي (بدون مفتاح OpenAI)';
    } catch {}
    render();
    loadVideos();
    const hello = "هلا بيك في VI Iraq 👋\nاكتب طلبك هنا وأرفق الصور أو الفيديوهات أو الملفات التي تريدها.";
    addMsg("bot", hello);
    state.messages.push({ role: "assistant", content: hello });
  })();
})();
