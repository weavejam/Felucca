// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page's layout, in tuttidaw's frame and opened on its own alike: the page is a sheet of a natural size,
// scaled to fit the frame whatever its size (contained and centred, a CSS transform: the hit targets go with it), never
// scrolled. By the frame's shape:
//   wide       (1.3:1 or wider, at least 900 x 540 CSS px): the FM-1 drawn upright at the full height, the Parts panel
//              beside it (the render controls, the parts, the computer keys, the credits)
//   landscape  (any other frame wider than tall): the FM-1's own drawing, the bar under it (status, render, credits)
//   portrait   (taller than wide: a phone's sheet): the upright drawing, the bar under it
// The Parts panel shows T1..T4 as the live Felucca plays them (felucca_plugin.c tutti_view, read only): the engine and
// the sound, the MIDI channel tuttidaw's notes reach the part on, MUTE / ARP / HOLD, a level meter, and the pattern (LEN
// steps: notes, ties, accents, the step playing).
export const PREFERRED = { width: 1280, height: 800 };   // the `resize` hint: the wide layout's own shape (the host lays out)
const PAD = 16, GAP = 16, WIDE_H = 860;                  // the sheet's margins, the gap beside the device, the wide sheet's height
const ASPECT = { tall: 600 / 1070, wide: 1000 / 624 };   // the drawings' width / height (web/emu/index.html LAYOUTS)
const PANEL = [560, 1100];                               // the Parts panel's width, natural px

export function modeFor(w, h) {
  if (w / h >= 1.3 && w >= 900 && h >= 540) return "wide";
  return w >= h ? "landscape" : "portrait";
}
export const drawingFor = (mode) => (mode === "landscape" ? "wide" : "tall");
const frameMode = () => modeFor(document.documentElement.clientWidth || innerWidth, document.documentElement.clientHeight || innerHeight);

// the view's layout (felucca_plugin.c tt_view): per part 64 bytes, then sel and playing (u32)
export const PARTS_VIEW = { bytes: 4 * 64 + 8, part: 64, eng: 0, sound: 16, flags: 32, ch: 33, len: 34, step: 35, notes: 36,
                            ties: 44, acc: 52, level: 60, sel: 256, playing: 260 };
const F_MUTE = 1, F_DRUM = 2, F_ARP = 4, F_HOLD = 8;
export function readView(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), V = PARTS_VIEW;
  const str = (o) => { let s = ""; for (let i = o; i < o + 16 && u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
  const bits = (o, len) => Array.from({ length: len }, (_, s) => (u8[o + (s >> 3)] >> (s & 7)) & 1);
  const parts = [];
  for (let p = 0; p < 4; p++) {
    const o = p * V.part, len = u8[o + V.len], f = u8[o + V.flags];
    parts.push({ eng: str(o + V.eng), sound: str(o + V.sound), mute: !!(f & F_MUTE), drum: !!(f & F_DRUM), arp: !!(f & F_ARP),
                 hold: !!(f & F_HOLD), ch: u8[o + V.ch], len, step: u8[o + V.step],
                 notes: bits(o + V.notes, len), ties: bits(o + V.ties, len), acc: bits(o + V.acc, len),
                 level: dv.getFloat32(o + V.level, true) });
  }
  return { parts, sel: dv.getUint32(V.sel, true), playing: !!dv.getUint32(V.playing, true) };
}
const chName = (c) => (c < 16 ? `MIDI ch ${c + 1}` : c === 16 ? "MIDI omni" : c === 18 ? "MIDI all ch (SEL)" : "no MIDI");

const CSS = `
html, body { height: 100%; overflow: hidden; }
body > main { display: none; }
.tt-stage { position: fixed; inset: 0; overflow: hidden; }
.tt-sheet { position: absolute; left: 0; top: 0; transform-origin: 0 0; box-sizing: border-box; padding: ${PAD}px;
            display: flex; gap: ${GAP}px; }
.tt-sheet.compact { flex-direction: column; align-items: stretch; gap: 10px; }
.tt-dev { flex: none; }
.tt-side { display: flex; flex-direction: column; min-width: 0; }
.tt-sheet.compact .tt-side { gap: 4px; }
.tt-sheet.wide .tt-side { flex: none; box-sizing: border-box; padding: 18px 22px 12px; background: var(--body); color: var(--label);
                          border-radius: 28px; gap: 12px; overflow: hidden; }
.tt-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.tt-head h1 { margin: 0; font-size: 22px; letter-spacing: .02em; color: #fff; }
.tt-head small { color: #a1a1a6; }
.tt-sheet.compact .tt-head, .tt-sheet.compact .tt-parts, .tt-sheet.compact .keys, .tt-sheet.compact footer { display: none; }
.tt-sheet.wide .tt-mini { display: none; }
.tt-mini { margin: 0; text-align: center; font-size: 12px; color: var(--dim); }
.tt-sheet .tutti { margin: 0; max-width: none; padding: 0; }
.tt-sheet .tutti .note:empty { display: none; }
.tt-sheet.wide .tutti { justify-content: flex-start; color: var(--label); }
.tt-sheet.wide .tutti .note { color: #a1a1a6; text-align: left; }
.tt-sheet.wide .tutti button { background: #f2f2f4; color: #111; }
.tt-parts { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.tt-parts > h2 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .12em; color: #8e8e93; display: flex; gap: 10px; }
.tt-parts > h2 span { letter-spacing: 0; font-weight: 400; }
.tt-part { flex: 1 1 0; min-height: min-content; display: grid; grid-template-columns: 44px minmax(0, 1fr) 150px; gap: 6px 14px;
           align-content: center; padding: 10px 14px; background: var(--tray); border-radius: 16px; border: 2px solid transparent; }
.tt-part.sel { border-color: var(--edge); }
.tt-part .id { grid-row: 1 / 4; align-self: center; font: 600 20px/1 'DotGothic16', ui-monospace, monospace; color: #fff; }
.tt-part.sel .id { color: var(--lit); }
.tt-part .names { display: flex; gap: 10px; align-items: baseline; min-width: 0; white-space: nowrap; }
.tt-part .sound { font: 16px/1.3 'DotGothic16', ui-monospace, monospace; color: #fff; overflow: hidden; text-overflow: ellipsis; }
.tt-part .eng { font-size: 11px; letter-spacing: .1em; color: #8e8e93; }
.tt-part .chips { display: flex; gap: 6px; justify-content: flex-end; align-items: center; font-size: 11px; white-space: nowrap; }
.tt-part .chips span { padding: 0 6px; border-radius: 6px; background: var(--part); color: #c7c7cc; }
.tt-part .chips span[hidden] { display: none; }
.tt-part .chips .mute { background: #5a2a26; color: #ffb4ab; }
.tt-part .chips .hold { background: #1f3a5c; color: #a8d1ff; }
.tt-part .meter { grid-column: 2 / 4; height: 6px; border-radius: 4px; background: var(--part); overflow: hidden; align-self: center; }
.tt-part .meter i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #5fe08a 0 70%, #ffd60a 70% 90%, #ff453a 90%); }
.tt-part .steps { grid-column: 2 / 4; display: grid; grid-template-columns: repeat(16, 1fr); gap: 4px 3px; }
.tt-part .steps b[hidden] { display: none; }
.tt-part .steps b { height: 12px; border-radius: 3px; background: var(--part); }
.tt-part .steps b:nth-child(4n + 1) { margin-left: 3px; }
.tt-part .steps b.n { background: #d8cfb6; }
.tt-part .steps b.t { background: #6f6a5c; }
.tt-part .steps b.a { background: var(--lit); box-shadow: inset 0 0 0 2px #ff9f0a; }
.tt-part .steps b.p { outline: 2px solid var(--green); outline-offset: 1px; }
.tt-part.mute .steps, .tt-part.mute .names { opacity: .45; }
.tt-sheet.wide .keys { margin: 0; color: #a1a1a6; font-size: 12px; line-height: 1.9; }
.tt-sheet.wide .keys span { margin: 0 6px; }
.tt-sheet.wide kbd { color: #e5e5ea; border-color: #48484a; }
.tt-sheet.wide footer { margin: 0; color: #8e8e93; font-size: 11px; line-height: 1.5; }
.tt-sheet.wide footer p { margin: 0 0 2px; }
.tt-sheet.wide footer a { color: #c7c7cc; }
`;

// nodes: { device, bar, keys, footer, mini }; draw(name): the emulator's drawing
export function setupLayout({ device, bar, keys, footer, mini, draw }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const stage = document.createElement("div"), sheet = document.createElement("div");
  const dev = document.createElement("div"), side = document.createElement("div");
  stage.className = "tt-stage";
  sheet.className = "tt-sheet";
  dev.className = "tt-dev";
  side.className = "tt-side";
  const head = document.createElement("div");
  head.className = "tt-head";
  head.innerHTML = `<h1>Felucca</h1><small>for tuttidaw · the FM-1's firmware, live</small>`;
  const parts = partsPanel();
  dev.appendChild(device);
  side.append(head, bar, parts.el, keys, footer, mini);
  sheet.append(dev, side);
  stage.appendChild(sheet);
  document.body.insertBefore(stage, document.body.firstChild);

  let mode = null;
  function fit() {
    const W = document.documentElement.clientWidth || innerWidth, H = document.documentElement.clientHeight || innerHeight;
    if (!W || !H) return;
    const m = modeFor(W, H);
    if (m !== mode) {
      mode = m;
      sheet.classList.toggle("wide", m === "wide");
      sheet.classList.toggle("compact", m !== "wide");
      draw(drawingFor(m));
    }
    let wn, hn;
    if (m === "wide") {
      hn = WIDE_H;
      for (let pass = 0; pass < 3; pass++) {             // the device at the full height, the panel the rest of the width
        const devH = hn - 2 * PAD, devW = devH * ASPECT.tall;
        const fixed = devW + 2 * PAD + GAP;
        wn = Math.min(Math.max(W * hn / H, fixed + PANEL[0]), fixed + PANEL[1]);
        Object.assign(sheet.style, { width: `${wn}px`, height: `${hn}px` });
        dev.style.width = `${devW}px`;
        Object.assign(side.style, { width: `${wn - fixed}px`, height: `${devH}px` });
        const over = side.scrollHeight - side.clientHeight;
        if (over <= 0) break;
        hn += over + 4;                                  // (a panel that does not fit: a taller sheet, scaled down)
      }
    } else {
      const d = drawingFor(m);
      wn = (d === "wide" ? 1000 : 600) + 2 * PAD;
      Object.assign(sheet.style, { width: `${wn}px`, height: "auto" });
      dev.style.width = `${wn - 2 * PAD}px`;
      Object.assign(side.style, { width: "auto", height: "auto" });
      hn = sheet.offsetHeight;
    }
    const s = Math.min(W / wn, H / hn);
    sheet.style.transform = `translate(${Math.round((W - wn * s) / 2)}px, ${Math.round((H - hn * s) / 2)}px) scale(${s})`;
  }
  let queued = false;
  const refit = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fit(); }); } };
  addEventListener("resize", refit);
  new ResizeObserver(refit).observe(document.documentElement);
  new ResizeObserver(refit).observe(bar);
  document.fonts?.ready.then(refit, () => {});
  fit();
  return { fit: refit, view: (u8) => parts.update(readView(u8)), mode: () => mode };
}

// ------------------------------------------------------------------ the Parts panel
function partsPanel() {
  const el = document.createElement("section");
  el.className = "tt-parts";
  el.innerHTML = `<h2>PARTS <span id="tt-parts-note">Switch on to see the parts</span></h2>`;
  const rows = [];
  for (let p = 0; p < 4; p++) {
    const r = document.createElement("div");
    r.className = "tt-part";
    r.innerHTML = `<div class="id">T${p + 1}</div>
      <div class="names"><span class="sound">—</span><span class="eng"></span></div>
      <div class="chips"><span class="ch"></span><span class="mute" hidden>MUTE</span><span class="arp" hidden>ARP</span><span class="hold" hidden>HOLD</span></div>
      <div class="meter" role="meter" aria-label="T${p + 1} level" aria-valuemin="-60" aria-valuemax="0"><i></i></div>
      <div class="steps" aria-hidden="true"></div>`;
    el.appendChild(r);
    const q = (s) => r.querySelector(s);
    rows.push({ r, sound: q(".sound"), eng: q(".eng"), ch: q(".ch"), mute: q(".mute"), arp: q(".arp"), hold: q(".hold"),
                steps: q(".steps"), meter: q(".meter"), bar: q(".meter i"), cells: [], key: "", shown: 0 });
  }
  const note = el.querySelector("#tt-parts-note");
  let on = false;
  function update(v) {
    if (!on) { on = true; note.textContent = "as the live Felucca plays them, each on its MIDI channel"; }
    v.parts.forEach((p, i) => {
      const x = rows[i];
      const key = [p.eng, p.sound, p.ch, p.mute, p.arp, p.hold, i === v.sel].join("|");
      if (key !== x.key) {
        x.key = key;
        x.sound.textContent = p.sound || p.eng || "—";
        x.eng.textContent = p.sound ? p.eng : "";
        x.ch.textContent = chName(p.ch);
        x.mute.hidden = !p.mute;
        x.arp.hidden = !p.arp;
        x.hold.hidden = !(p.arp && p.hold);
        x.r.classList.toggle("sel", i === v.sel);
        x.r.classList.toggle("mute", p.mute);
      }
      while (x.cells.length < p.len) x.cells.push(x.steps.appendChild(document.createElement("b")));
      const pat = p.notes.join("") + p.ties.join("") + p.acc.join("") + ":" + p.step;
      if (pat !== x.pat) {
        x.pat = pat;
        x.cells.forEach((c, s) => {
          c.hidden = s >= p.len;
          c.className = s >= p.len ? "" : p.acc[s] && p.notes[s] ? "a" : p.notes[s] ? "n" : p.ties[s] ? "t" : "";
          if (s === p.step) c.classList.add("p");
        });
      }
      // the level: dB over 60 dB, falling back at ~20 dB/s
      const dB = p.level > 0 ? 20 * Math.log10(p.level) : -100;
      x.shown = Math.max(Math.min(1, Math.max(0, (dB + 60) / 60)), x.shown - 0.012);
      x.bar.style.width = `${(x.shown * 100).toFixed(1)}%`;
      x.meter.setAttribute("aria-valuenow", Math.round(Math.max(-60, dB)));
    });
  }
  return { el, update };
}
