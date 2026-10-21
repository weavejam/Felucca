// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page (/plugin/): the browser emulator's page (web/emu/index.html, built into this one by build.sh) with
// tuttidaw's protocol (tutti-plugin/0, protocol.js). Loaded before the emulator's script: it sets window.feluccaHost.
//   - in tuttidaw's iframe: the handshake; `init` gives the state the live FM-1 starts with (no saves in this browser);
//     the host's tempo and transport drive its preview; edits make new state revisions (state-changed); "Render to
//     tuttidaw" sends `commit`; renders run in a Worker (render-worker.js); mode 'render': headless, nothing else runs.
//   - opened by itself (or not connected within a few seconds): the emulator as on its own page, a note that it is a
//     tuttidaw plugin.
import { PluginSession } from "./protocol.js";
import { FM1Engine } from "./engine.js";
import { RenderError, checkTimeMap, tempoAt } from "./renderer.js";
import { STORE_AREAS } from "../emu/worklet.js";
import { BUILD } from "./build-info.js";

const embedded = window.parent !== window;
const AUTOSAVE = [0xE5000, 0xE7000];                   // project.c OBJ_AUTOSAVE's two sectors: the music, not the rest
const WASM_URL = new URL("felucca.wasm", import.meta.url).href;
const log = (...a) => console.debug(...a);

// ------------------------------------------------------------------ the emulator's hooks
let api = null, node = null, ac = null, standalone = !embedded, liveOn = false;
const host = window.feluccaHost = {
  worklet: "worklet-tutti.js",
  processor: "felucca-tutti",
  wasm: "felucca.wasm",
  midi: !embedded,                                     // (in tuttidaw's frame: no Web MIDI, the manifest asks none)
  attach: (a) => { api = a; ui(); },
};

// ------------------------------------------------------------------ the page's own parts
const $ = (id) => document.getElementById(id);
function ui() {
  const bar = document.createElement("section");
  bar.className = "tutti";
  bar.innerHTML = `
    <style>
      .tutti { margin: 12px auto 0; max-width: 1040px; padding: 0 16px; display: flex; flex-wrap: wrap; gap: 10px 16px;
               align-items: center; justify-content: center; color: var(--fg); }
      .tutti button { font: inherit; padding: 6px 14px; background: #1d1d1f; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
      .tutti button:disabled { opacity: .45; cursor: default; }
      .tutti progress { width: 120px; }
      .tutti .note { font-size: 12px; color: var(--dim); text-align: center; flex-basis: 100%; }
      .tutti [hidden] { display: none !important; }
    </style>
    <span id="tt-connected" hidden>
      <button id="tt-commit" type="button" title="Render this FM-1's song into tuttidaw at tuttidaw's tempo">Render to tuttidaw</button>
      <label><input type="checkbox" id="tt-stems"> T1–T4 stems too</label>
    </span>
    <span id="tt-render" hidden>Rendering <progress id="tt-progress" max="1" value="0"></progress></span>
    <p class="note" id="tt-note"></p>`;
  document.querySelector("main").insertBefore(bar, document.querySelector(".keys"));
  const foot = document.querySelector("footer");
  const credit = document.createElement("p");
  credit.innerHTML = `FM-1 plugin for <a href="https://tuttidaw.com">tuttidaw</a> by weavejam, built from Felucca
    (GPL-3.0) · <a href="../credits.html" target="_blank" rel="noopener">credits, licences, source</a><br>
    <small>Not affiliated with or endorsed by M-VAVE.</small>`;
  foot.insertBefore(credit, foot.firstChild);
  for (const a of foot.querySelectorAll("nav a")) if (!/^https?:/.test(a.getAttribute("href"))) a.remove();   // (the
  $("tt-commit").addEventListener("click", () => {                                                          // emulator site's)
    session.commit({ outputs: $("tt-stems").checked ? ["mix", "t1", "t2", "t3", "t4"] : ["mix"] });
  });
  if (standalone) becomeStandalone();
  else {
    note("Waiting for tuttidaw…");
    $("go").disabled = true;
  }
}
const note = (t) => { if ($("tt-note")) $("tt-note").textContent = t; };

function becomeStandalone() {
  standalone = true;
  delete host.sectors;                                 // (this browser's saves, as the emulator's own page)
  delete host.keep;
  host.midi = true;
  if ($("go")) $("go").disabled = false;
  note("This is the FM-1 plugin for tuttidaw. Opened on its own it is the Felucca emulator: your saves stay in this browser.");
}

// ------------------------------------------------------------------ the live FM-1 (edit mode)
let pts = [{ beat: 0, bpm: 120, ramp: "step" }], bpm = 0, sigBase = null, flashBase = null, snapWait = new Map(), snapId = 0;
const flashKey = (sectors) => {                        // the flash outside the autosave (presets, projects, settings)
  let h = 2166136261;
  for (const off of Object.keys(sectors).map(Number).sort((a, b) => a - b)) {
    if (off >= AUTOSAVE[0] && off < AUTOSAVE[1]) continue;
    h = Math.imul(h ^ off, 16777619);
    for (const b of sectors[off]) h = Math.imul(h ^ b, 16777619);
  }
  return h >>> 0;
};
const send = (m) => { if (node) node.port.postMessage(m); };
function setTempo(beat) {
  const b = tempoAt(pts, beat);
  if (b !== bpm) { bpm = b; send({ type: "tutti-tempo", bpm }); }
}

const live = {
  sectors: {},
  async load(sectors, context) {
    this.sectors = sectors;
    flashBase = flashKey(sectors);
    sigBase = null;
    this.context(context);
    host.sectors = () => this.sectors;
    host.keep = (s) => {                               // a save on the live FM-1: a change (the autosave's own: not)
      const k = flashKey(s);
      if (flashBase !== null && k !== flashBase) engine.changed();
      flashBase = k;
      return true;
    };
    host.started = (n, c) => {
      node = n;
      ac = c;
      liveOn = true;
      bpm = 0;
      setTempo(0);
      const frames = n.port.onmessage;
      n.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === "tutti-sig") {
          if (sigBase !== null && m.sig !== sigBase) engine.changed();
          sigBase = m.sig;
        } else if (m.type === "tutti-snapshot") {
          const w = snapWait.get(m.id);
          snapWait.delete(m.id);
          if (w) w(m);
        } else frames(e);
      };
      note("");
    };
    if (node) {                                        // on already: the new state into it
      send({ type: "load", sectors });
      return;
    }
    $("go").disabled = false;
    note("");
    // start at once where the browser lets this frame play sound (the host's allow="autoplay" and a gesture there);
    // else the Switch on button
    let can = false;
    try {
      const probe = new AudioContext();
      can = probe.state === "running";
      probe.close();
    } catch {}
    if (can && api) api.switchOn();
  },
  async snapshot() {
    if (!node || !liveOn) return this.sectors;         // (not switched on: nothing changed)
    const id = ++snapId;
    const m = await new Promise((res, rej) => {
      snapWait.set(id, res);
      send({ type: "tutti-snapshot", id });
      setTimeout(() => { if (snapWait.delete(id)) rej(new RenderError("internal", "the live FM-1 did not answer")); }, 5000);
    });
    if (!m.ok) throw new RenderError("internal", "the live FM-1 could not save its state");
    sigBase = m.sig;
    flashBase = flashKey(m.sectors);
    return (this.sectors = m.sectors);
  },
  context(ctx) {
    try { pts = checkTimeMap(ctx && ctx.timeMap); } catch { return; }
    setTempo(0);
  },
  transport(t) {
    if (!node || !ac) return;
    setTempo(t.beat);
    if (!t.playing) { send({ type: "tutti-play", gen: t.generation, playing: false }); return; }
    // the context frame heard at atEpochMs: by the output's timestamp (it has the output latency) where there is one
    let atCtx;
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) atCtx = ts.contextTime + (t.atEpochMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    else atCtx = ac.currentTime + (t.atEpochMs - (performance.timeOrigin + performance.now())) / 1000 - (ac.outputLatency || ac.baseLatency || 0);
    send({ type: "tutti-play", gen: t.generation, playing: true, atFrame: Math.round(atCtx * ac.sampleRate),
           pos: Math.round((t.beat * 60 / bpm) * 44100) });
  },
  close() { send({ type: "tutti-play", gen: -1, playing: false }); },
};

// ------------------------------------------------------------------ renders in a Worker
let worker = null;
function renderInWorker(sectors, req, sink) {
  worker = worker || new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  const w = worker;
  $("tt-render").hidden = false;
  $("tt-progress").value = 0;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (sink.cancelled()) w.postMessage({ type: "cancel" }); }, 50);
    const end = () => { clearInterval(poll); w.onmessage = null; $("tt-render").hidden = true; };
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === "chunk") {
        try {
          await sink.chunk(m.output, m.frameOffset, m.channels);
          w.postMessage({ type: "ack" });
        } catch {
          w.postMessage({ type: "cancel" });
        }
      } else if (m.type === "progress") {
        $("tt-progress").value = m.fraction;
        sink.progress(m.fraction);
      } else if (m.type === "done") { end(); resolve(m.result); }
      else if (m.type === "error") { end(); reject(new RenderError(m.code, m.message)); }
    };
    w.onerror = (e) => { end(); worker = null; w.terminate(); reject(new RenderError("internal", e.message || "the render worker failed")); };
    w.postMessage({ type: "render", wasmUrl: WASM_URL, sectors, req });
  });
}

// ------------------------------------------------------------------ the session
const engine = new FM1Engine({
  render: renderInWorker,
  live,
  onChanged: (rev) => session.stateChanged(rev),
});
const session = new PluginSession({
  engine,
  post: (m) => window.parent.postMessage(m, "*"),
  plugin: { id: BUILD.id, version: BUILD.version, build: BUILD.build },
  log,
});
const initOrig = engine.init.bind(engine);
engine.init = async (args) => {
  clearTimeout(alone);
  if (args.mode === "render") {                        // headless: no device, no sound, only renders
    note("Rendering for tuttidaw (headless).");
    if ($("go")) $("go").disabled = true;
  } else {
    $("tt-connected").hidden = false;
  }
  return initOrig(args);
};

let alone = 0;
if (embedded) {
  // the host lays the frame out: the size this page wants, once connected and whenever it changes
  const size = () => session.resize(Math.min(1600, document.documentElement.scrollWidth), Math.min(1200, document.documentElement.scrollHeight));
  window.addEventListener("message", (e) => {
    if (session.onWindowMessage({ data: e.data, origin: e.origin, isParent: e.source === window.parent, ports: e.ports })) {
      note("Connected to tuttidaw.");
      size();
    }
  });
  session.hello();
  alone = setTimeout(() => { if (!session.port) becomeStandalone(); }, 4000);   // (not tuttidaw's frame)
  new ResizeObserver(size).observe(document.body);
}
window.addEventListener("pagehide", () => session.close());
