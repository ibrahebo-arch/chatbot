#!/usr/bin/env node
/**
 * VI Iraq – animatic: the approved storyboard pictures + the real voice/sound track as one rough vertical video, so a
 * reel can be judged (Higgsfield Virality Predictor, the reel review) BEFORE the real video is generated.
 *
 *   node tools/animatic.js --out animatic.mp4 --audio dialogue.mp3 --seconds 15 \
 *        --shot frame1.jpg:0 --shot frame2.jpg:2 --shot frame3.jpg:5 [--title "شنو اشترت بالماستر؟"]
 *
 * Each --shot is "<picture>:<second it starts>" (in order); a shot lasts until the next one starts. Every shot gets a
 * slow push-in so the animatic moves like a video, frames are cut to 9:16 (1080x1920), the title (if any) sits at the
 * top like the real reels. No AI, nothing leaves the machine; it takes about a minute.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const w = require("../watermark");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const shots = args.flatMap((a, i) => (a === "--shot" ? [args[i + 1]] : [])).map((s) => { const k = s.lastIndexOf(":"); return { file: s.slice(0, k), at: Number(s.slice(k + 1)) }; });
const out = opt("out"), audio = opt("audio"), total = Number(opt("seconds", 0)), title = opt("title", "");
if (!out || !shots.length || shots.some((s) => !fs.existsSync(s.file) || !Number.isFinite(s.at))) {
  console.error('usage: node tools/animatic.js --out a.mp4 [--audio track.mp3] --seconds 15 --shot pic.jpg:0 --shot pic2.jpg:3 … [--title "…"]');
  process.exit(1);
}
const run = async (a, ms = 300000) => { const r = await w.run(["-y", ...a], ms); if (r.code !== 0) throw new Error(r.stderr.split("\n").filter((l) => /error|invalid|no such/i.test(l)).slice(0, 3).join(" | ") || r.stderr.slice(-300)); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animatic-"));
  try {
    let len = total;
    if (!len && audio) { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec((await w.run(["-i", audio])).stderr); if (m) len = Number(m[2]) * 60 + Number(m[3]); }
    if (!len) len = shots[shots.length - 1].at + 3;
    const parts = [];
    for (const [i, s] of shots.entries()) {
      const d = Math.max(0.4, (i + 1 < shots.length ? shots[i + 1].at : len) - s.at), frames = Math.round(d * 30), p = path.join(dir, `s${i}.mp4`);
      // fill 9:16, then a gentle push-in (zoompan) – the frame moves like a phone video instead of a still slide
      await run(["-loop", "1", "-i", s.file, "-t", d.toFixed(2), "-vf",
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=2160:3840,zoompan=z='min(1+0.0009*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,setsar=1`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", p]);
      parts.push(p);
    }
    const list = path.join(dir, "list.txt"); fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
    const silent = path.join(dir, "v.mp4");
    await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
    let vf = "null";
    if (title) {
      const t = path.join(dir, "title.txt"); fs.writeFileSync(t, title);
      const font = ["C:/Windows/Fonts/tahoma.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf"].find((f) => fs.existsSync(f));
      if (font) vf = `drawtext=fontfile='${font.replace(/:/g, "\\:")}':textfile='${t.replace(/\\/g, "/").replace(/:/g, "\\:")}':fontsize=54:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=150`;
    }
    await run(["-i", silent, ...(audio ? ["-i", audio] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]), "-map", "0:v", "-map", "1:a", "-vf", vf, "-t", len.toFixed(2),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);
    console.log(JSON.stringify({ out, seconds: +len.toFixed(2), shots: shots.length, title: Boolean(title) }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error("animatic:", e.message); process.exit(1); });
