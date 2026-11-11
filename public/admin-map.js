// VI Iraq – the learning map (page /admin/trained/map): a 3D picture of what the studio studied and learned, the days
// and the tables. Data: /admin/trained/map.json (same login), refreshed every minute. Needs three.js (r128, global THREE).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  const COLORS = { reality: 0x58a6ff, human: 0xf78166, sound: 0xbc8cff, place: 0x3fb950, item: 0xd8b25a, action: 0xff7b72, nature: 0x56d364, animal: 0xe3b341, style: 0x79c0ff };
  const AREA = 0x2dd4bf, FOOT = 0x39c5cf, WRIT = 0xd8b25a;
  const hex = (c) => "#" + c.toString(16).padStart(6, "0");
  let D = null, tab = "entries", sortBy = null, sortAsc = false, pick = "";

  // ---------- tiles, legend, live ----------
  function hud() {
    const t = D.totals;
    const tiles = [[num(t.entries), "entries in the library"], [num(t.learned), "learned from real footage"], [num(t.clips), "real clips studied"], [num(t.minutes) + " min", "of footage watched"],
      [t.avgScore + " / 10", "average clip value"], [num(t.approved) + " / " + num(t.rejected + t.duplicates), "drafts kept / refused"], [num(t.used), "entries already used"], [num(t.clipsToday) + " · " + num(t.addedToday), "today: clips · added"]];
    $("stats").innerHTML = tiles.map(([b, s]) => `<div class="tile"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
    $("legend").innerHTML = `<div><i style="background:${hex(COLORS.reality)}"></i>inner ring – knowledge domains (height = entries)</div><div><i style="background:${hex(AREA)}"></i>outer ring – areas of real life (height = clips studied)</div><div><i style="background:${hex(FOOT)}"></i>spheres – footage sources · <i style="background:${hex(WRIT)}"></i>diamonds – written sources</div><small>The solid part of a pillar is what is done: entries learned from footage (inner), searches already covered (outer).</small>`;
    const mins = t.lastStudy ? Math.round((Date.now() + 3 * 3600e3 - Date.parse(t.lastStudy.replace(" ", "T") + ":00Z")) / 60000) : 1e9;
    $("live").className = "hud" + (mins < 240 ? " on" : "");
    $("live").innerHTML = `<span class="dot"></span>${mins < 240 ? "learning – last study " + (mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago") : "no study in the last 4 hours"}<br><span>snapshot ${esc(D.at)} Iraq time · ${num(t.waiting)} drafts waiting</span><br><a href="/admin/trained">daily reports</a> · <a href="/admin/trained/${esc(D.today)}">today</a>`;
    $("sum").textContent = `${num(D.entries.length)} entries learned · ${num(D.clips.length)} clips looked at (${num(t.clips)} studied, ${num(t.failed)} failed) · ${D.areas.length} areas of real life · ${D.sources.length} sources. Click a column to sort.`;
  }

  // ---------- day bars ----------
  function days() {
    const max = Math.max(1, ...D.days.map((d) => Math.max(d.clips, d.added)));
    $("days").innerHTML = D.days.map((d) => `<a class="d" href="/admin/trained/${esc(d.d)}" title="${esc(d.d)} – ${d.clips} clips studied, ${d.added} entries added" style="text-decoration:none"><span class="two"><i style="height:${Math.round(100 * d.clips / max)}%;background:${hex(AREA)}"></i><i style="height:${Math.round(100 * d.added / max)}%;background:${hex(WRIT)}"></i></span>${esc(d.d.slice(8))}</a>`).join("");
    $("days").scrollLeft = 1e6;
  }

  // ---------- tables ----------
  const TABLES = {
    entries: { head: ["Added", "Domain", "Names", "What it teaches", "Used", "Learned from"], rows: () => D.entries.map((e) => [e.at, e.domain, e.names.join(" · "), e.body, e.uses, (e.src ? e.src + ": " : "") + e.clip]), num: [4], wide: [3] },
    clips: { head: ["When", "Source", "Clip", "Search", "Value", "Added", "Refused", "Result"], rows: () => D.clips.map((c) => [c.at, c.src, c.title, c.q, c.score == null ? "" : c.score, c.added, c.rejected, c.status]), num: [4, 5, 6], wide: [2], link: (i) => D.clips[i].url },
    areas: { head: ["Area of real life", "Clips studied", "Searches covered", "Most studied searches"], rows: () => D.areas.map((a) => [a.name, a.clips, a.covered + " / " + a.searches, a.top.map((x) => x.q + " (" + x.n + ")").join(" · ")]), num: [1], wide: [3] },
    sources: { head: ["Source", "Kind", "Clips studied", "Failed", "Minutes", "Value", "Entries in the library"], rows: () => D.sources.map((s) => [s.name, s.kind, s.studied || "", s.failed || "", s.minutes || "", s.avg || "", s.entries]), num: [2, 3, 4, 5, 6] },
  };
  function table() {
    const T = TABLES[tab], q = $("q").value.trim().toLowerCase();
    let rows = T.rows().map((r, i) => ({ r, i }));
    if (q) rows = rows.filter((x) => x.r.join(" ").toLowerCase().indexOf(q) >= 0);
    if (sortBy != null) rows.sort((a, b) => { const x = a.r[sortBy], y = b.r[sortBy]; const nx = parseFloat(x), ny = parseFloat(y); const c = T.num.includes(sortBy) ? (isNaN(nx) ? -1 : nx) - (isNaN(ny) ? -1 : ny) : String(x).localeCompare(String(y)); return sortAsc ? c : -c; });
    const shown = rows.slice(0, 500);
    document.querySelector("#learn thead").innerHTML = "<tr>" + T.head.map((h, i) => `<th data-i="${i}">${esc(h)}${sortBy === i ? (sortAsc ? " ▲" : " ▼") : ""}</th>`).join("") + "</tr>";
    document.querySelector("#learn tbody").innerHTML = shown.map(({ r, i }) => "<tr>" + r.map((v, k) => {
      const url = T.link && k === 2 ? T.link(i) : "";
      const cell = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>` : `<span class="ar">${esc(v)}</span>`;
      return `<td class="${T.num.includes(k) ? "n" : (T.wide || []).includes(k) ? "f" : ""}">${k === 1 && (tab === "entries" || tab === "clips") ? `<span class="pill">${esc(v)}</span>` : cell}</td>`;
    }).join("") + "</tr>").join("");
    $("count").textContent = `${num(rows.length)} rows${rows.length > shown.length ? " – showing the first " + shown.length + ", filter to narrow" : ""}`;
  }
  function setTab(t, filter) {
    tab = t; sortBy = null; sortAsc = false;
    for (const k of Object.keys(TABLES)) $("t-" + k).className = k === t ? "on" : "";
    if (filter != null) $("q").value = filter;
    table();
  }
  for (const k of Object.keys(TABLES)) $("t-" + k).onclick = () => setTab(k, "");
  $("q").addEventListener("input", table);
  document.querySelector("#learn thead").addEventListener("click", (e) => { const th = e.target.closest("th"); if (!th) return; const i = Number(th.dataset.i); if (sortBy === i) sortAsc = !sortAsc; else { sortBy = i; sortAsc = false; } table(); });

  // ---------- the 3D map ----------
  function scene3d() {
    const canvas = $("c"), wrap = $("wrap"), tip = $("tip");
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { $("err").style.display = "flex"; return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x0d1117, 0.0065);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 600);
    scene.add(new THREE.AmbientLight(0x8fa3c0, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(30, 60, 20); scene.add(sun);
    const glow = new THREE.PointLight(0xd8b25a, 1.6, 90); glow.position.set(0, 9, 0); scene.add(glow);
    const hits = [], labels = [];

    // floor rings
    for (const [r, c] of [[16, 0x243041], [31, 0x1c3a3a], [46, 0x1f2937]]) {
      const g = new THREE.RingGeometry(r - 0.06, r + 0.06, 128); const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      m.rotation.x = -Math.PI / 2; scene.add(m);
    }
    const grid = new THREE.GridHelper(120, 40, 0x18202c, 0x131a25); grid.position.y = -0.02; scene.add(grid);

    function label(text, color, size) {
      const c = document.createElement("canvas"), x = c.getContext("2d"); const fs = 44;
      x.font = `600 ${fs}px system-ui,Segoe UI,Tahoma,sans-serif`; const w = Math.ceil(x.measureText(text).width) + 24;
      c.width = w; c.height = fs + 22; x.font = `600 ${fs}px system-ui,Segoe UI,Tahoma,sans-serif`; x.fillStyle = "rgba(13,17,23,.55)"; x.fillRect(0, 0, w, c.height);
      x.fillStyle = color; x.textBaseline = "middle"; x.fillText(text, 12, c.height / 2);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
      s.scale.set(size * w / c.height, size, 1); labels.push(s); return s;
    }
    function pillar(x, z, w, h, share, color, info) {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const ghost = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.2, roughness: 0.6 })); ghost.position.y = h / 2;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(ghost.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })); edges.position.y = h / 2;
      const sh = Math.max(0.12, h * Math.min(1, share));
      const solid = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, sh, w * 0.86), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.28, roughness: 0.45 })); solid.position.y = sh / 2;
      g.add(ghost, edges, solid); ghost.userData.info = info; solid.userData.info = info; hits.push(ghost, solid);
      const l = label(info.title, hex(color), 1.5); l.position.set(0, h + 1.5, 0); g.add(l);
      scene.add(g); return g;
    }

    // core: the library
    const core = new THREE.Group(); core.position.y = 9; scene.add(core);
    const coreIn = new THREE.Mesh(new THREE.IcosahedronGeometry(3.3, 1), new THREE.MeshStandardMaterial({ color: 0xd8b25a, emissive: 0xd8b25a, emissiveIntensity: 0.55, roughness: 0.35, flatShading: true }));
    const coreOut = new THREE.Mesh(new THREE.IcosahedronGeometry(4.7, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.16 }));
    const halos = [0, 1].map((i) => { const m = new THREE.Mesh(new THREE.TorusGeometry(6 + i * 1.1, 0.045, 8, 96), new THREE.MeshBasicMaterial({ color: i ? 0x58a6ff : 0xd8b25a, transparent: true, opacity: 0.6 })); core.add(m); return m; });
    core.add(coreIn, coreOut);
    const T = D.totals;
    coreIn.userData.info = { title: "VI-Iraq library", lines: [[num(T.entries), "entries live"], [num(T.learned), "learned from real footage"], [num(T.written), "written (files, lessons, fixes)"], [num(T.core), "core rules, always on"], [num(T.vectors), "with a meaning vector"], [num(T.used) + " entries · " + num(T.uses) + " times", "used in plans"], [num(T.switchedOff), "switched off"]], share: T.learned / Math.max(1, T.entries), shareText: "learned from footage", color: 0xd8b25a };
    hits.push(coreIn);
    const cl = label("VI-Iraq library · " + num(T.entries), "#d8b25a", 2.1); cl.position.set(0, 16.5, 0); cl.userData.always = true; scene.add(cl);

    // inner ring: domains
    const maxE = Math.max(1, ...D.domains.map((d) => d.entries));
    D.domains.forEach((d, i) => {
      const a = (i / D.domains.length) * Math.PI * 2, c = COLORS[d.name] || 0x8b98a5;
      pillar(Math.cos(a) * 16, Math.sin(a) * 16, 2.5, 2 + 12 * Math.sqrt(d.entries / maxE), d.learned / Math.max(1, d.entries), c,
        { title: d.name, lines: [[num(d.entries), "entries"], [num(d.learned), "learned from real footage"], [num(d.used) + " entries · " + num(d.uses) + " times", "used in plans"]], share: d.learned / Math.max(1, d.entries), shareText: "learned from footage", color: c, tab: "entries", filter: d.name });
    });
    // outer ring: areas of real life
    const maxC = Math.max(1, ...D.areas.map((x) => x.clips));
    D.areas.forEach((x, i) => {
      const a = (i / D.areas.length) * Math.PI * 2 + 0.07;
      pillar(Math.cos(a) * 31, Math.sin(a) * 31, 1.9, 1.5 + 11 * Math.sqrt(x.clips / maxC), x.covered / Math.max(1, x.searches), AREA,
        { title: x.name, lines: [[num(x.clips), "clips studied"], [x.covered + " of " + x.searches, "searches covered"], [x.top.filter((t) => t.n).map((t) => t.q + " (" + t.n + ")").join(", ") || "–", "most studied"]], share: x.covered / Math.max(1, x.searches), shareText: "of its searches covered", color: AREA, tab: "areas", filter: x.name });
    });
    // sources above, each with a stream into the core
    const streams = [];
    const maxS = Math.max(1, ...D.sources.map((s) => s.entries));
    D.sources.forEach((s, i) => {
      const a = (i / D.sources.length) * Math.PI * 2 + 0.4, foot = s.kind === "footage", c = foot ? FOOT : WRIT;
      const pos = new THREE.Vector3(Math.cos(a) * 44, 15 + (i % 3) * 3.2, Math.sin(a) * 44), size = 1.1 + 2.3 * Math.sqrt(s.entries / maxS);
      const m = new THREE.Mesh(foot ? new THREE.SphereGeometry(size, 24, 16) : new THREE.OctahedronGeometry(size * 1.15, 0), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.4, flatShading: !foot }));
      m.position.copy(pos); scene.add(m); hits.push(m);
      m.userData.info = { title: s.name, lines: foot ? [[num(s.studied), "clips studied"], [num(s.failed), "could not be read"], [num(s.minutes) + " min", "of footage"], [s.avg + " / 10", "average value"], [num(s.entries), "entries in the library"]] : [[num(s.entries), "entries in the library"], [num(s.used), "already used in plans"]], share: foot ? s.studied / Math.max(1, s.clips) : s.used / Math.max(1, s.entries), shareText: foot ? "of its clips read to the end" : "already used", color: c, tab: foot ? "clips" : "sources", filter: foot ? s.id.slice(7) : "" };
      m.userData.spin = 0.2 + (i % 4) * 0.07;
      const l = label(s.name, hex(c), 1.35); l.position.copy(pos).add(new THREE.Vector3(0, size + 1.6, 0)); scene.add(l);
      const mid = pos.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 9, 0));
      const curve = new THREE.QuadraticBezierCurve3(pos, mid, new THREE.Vector3(0, 9, 0));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.16 })); scene.add(line);
      const n = Math.max(6, Math.min(90, Math.round(8 + 18 * Math.log10(1 + s.entries))));
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: c, size: 0.42, transparent: true, opacity: 0.9, depthWrite: false })); scene.add(pts);
      streams.push({ curve, pts, line, t: Array.from({ length: n }, () => Math.random()), speed: 0.05 + 0.05 * Math.random() });
    });

    // camera: orbit around the core
    const HOME = { th: 0.6, ph: 1.08, r: 96 }; const cam = { ...HOME }, goal = { ...HOME };
    let rot = true, names = true, flow = true, drag = false, hover = null, px = 0, py = 0, moved = 0;
    const place = () => { const y = Math.cos(cam.ph) * cam.r, f = Math.sin(cam.ph) * cam.r; camera.position.set(Math.cos(cam.th) * f, y + 6, Math.sin(cam.th) * f); camera.lookAt(0, 6, 0); };
    canvas.addEventListener("pointerdown", (e) => { drag = true; moved = 0; px = e.clientX; py = e.clientY; canvas.classList.add("drag"); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointerup", (e) => { drag = false; canvas.classList.remove("drag"); if (moved < 5 && hover && hover.tab) { setTab(hover.tab, hover.filter); $("learn").scrollIntoView({ behavior: "smooth" }); } });
    canvas.addEventListener("pointermove", (e) => {
      if (drag) { const dx = e.clientX - px, dy = e.clientY - py; moved += Math.abs(dx) + Math.abs(dy); px = e.clientX; py = e.clientY; goal.th += dx * 0.006; goal.ph = Math.max(0.12, Math.min(1.5, goal.ph - dy * 0.005)); tip.style.display = "none"; return; }
      const r = canvas.getBoundingClientRect(); ray.setFromCamera({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
      const h = ray.intersectObjects(hits, false)[0]; hover = h ? h.object.userData.info : null;
      if (!hover) { tip.style.display = "none"; return; }
      tip.innerHTML = `<b style="color:${hex(hover.color)}">${esc(hover.title)}</b><div class="bar"><i style="width:${Math.round(100 * Math.min(1, hover.share || 0))}%;background:${hex(hover.color)}"></i></div><span class="k">${Math.round(100 * (hover.share || 0))}% ${esc(hover.shareText)}</span>` + hover.lines.map(([b, k]) => `<div>${esc(b)} <span class="k">${esc(k)}</span></div>`).join("") + (hover.tab ? `<div class="k" style="margin-top:4px">click to see it in the tables</div>` : "");
      tip.style.display = "block"; const tw = tip.offsetWidth, th = tip.offsetHeight, x = e.clientX - r.left, y = e.clientY - r.top;
      tip.style.left = Math.max(8, Math.min(x + 16, r.width - tw - 8)) + "px"; tip.style.top = Math.max(8, Math.min(y + 16, r.height - th - 8)) + "px";
    });
    canvas.addEventListener("pointerleave", () => { hover = null; tip.style.display = "none"; });
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); goal.r = Math.max(34, Math.min(170, goal.r * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
    const ray = new THREE.Raycaster();
    const on = (b, v) => { b.className = v ? "on" : ""; };
    $("b-rot").onclick = () => { rot = !rot; on($("b-rot"), rot); };
    $("b-lab").onclick = () => { names = !names; on($("b-lab"), names); labels.forEach((l) => { l.visible = names || l.userData.always; }); };
    $("b-flow").onclick = () => { flow = !flow; on($("b-flow"), flow); streams.forEach((s) => { s.pts.visible = flow; s.line.visible = flow; }); };
    $("b-top").onclick = () => { goal.ph = 0.14; goal.r = 112; };
    $("b-home").onclick = () => { Object.assign(goal, HOME); };

    let W = 0, H = 0;
    const fit = () => { const w = wrap.clientWidth, h = wrap.clientHeight; if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    setInterval(fit, 300); fit();
    const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = performance.now(), time = 0;
    (function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05); last = now;
      if (W < 40 || document.hidden) return;
      time += dt;
      if (rot && !drag && !hover && !calm) goal.th += dt * 0.06;
      cam.th += (goal.th - cam.th) * 0.09; cam.ph += (goal.ph - cam.ph) * 0.09; cam.r += (goal.r - cam.r) * 0.09; place();
      if (!calm) {
        coreIn.rotation.y += dt * 0.3; coreOut.rotation.y -= dt * 0.18; coreOut.rotation.x += dt * 0.1;
        halos[0].rotation.x = Math.PI / 2 + Math.sin(time * 0.5) * 0.5; halos[0].rotation.y += dt * 0.4;
        halos[1].rotation.x = Math.PI / 2 + Math.cos(time * 0.4) * 0.6; halos[1].rotation.z += dt * 0.3;
        const s = 1 + Math.sin(time * 1.6) * 0.04; coreIn.scale.set(s, s, s);
        for (const m of hits) if (m.userData.spin) m.rotation.y += dt * m.userData.spin;
        if (flow) for (const st of streams) {
          const p = st.pts.geometry.attributes.position;
          for (let i = 0; i < st.t.length; i++) { st.t[i] += dt * st.speed; if (st.t[i] > 1) st.t[i] -= 1; const v = st.curve.getPoint(st.t[i]); p.setXYZ(i, v.x, v.y, v.z); }
          p.needsUpdate = true;
        }
      }
      renderer.render(scene, camera);
    })(last);
  }

  // ---------- start ----------
  async function load(first) {
    try {
      const r = await fetch("/admin/trained/map.json", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      D = await r.json(); hud(); days(); table();
      if (first) { if (window.THREE) scene3d(); else $("err").style.display = "flex"; }
    } catch (e) { if (first) { $("err").textContent = "Could not load the learning data (" + e.message + "). Reload the page."; $("err").style.display = "flex"; } }
  }
  load(true); setInterval(() => { if (!document.hidden) load(false); }, 60000);
})();
