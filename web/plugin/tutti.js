// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page (/plugin/): the browser emulator's page (web/emu/index.html, built into this one by build.sh) with
// tuttidaw's protocol (tutti-plugin/0, protocol.js). Loaded before the emulator's script: it sets window.feluccaHost.
//   - in tuttidaw's iframe: the handshake; `init` gives the state the live Felucca starts with (no saves in this browser);
//     the host's tempo and transport drive its preview; edits make new state revisions (state-changed); "Render to
//     tuttidaw" sends `commit`; renders run in a Worker (render-worker.js); mode 'render': headless, nothing else runs.
//   - opened by itself (or not connected within a few seconds): the emulator as on its own page, a note that it is a
//     tuttidaw plugin.
// Either way the page fits the frame it is in, any size, never scrolled (layout.js): wide, the FM-1 upright beside the
// Parts panel; otherwise the FM-1 alone, scaled to fit.
import { PluginSession, embedderAllowed } from "./protocol.js";
import { FeluccaEngine, PreviewTempo, recText } from "./engine.js";
import { RenderError } from "./renderer.js";
import { BUILD, EMBEDDERS } from "./build-info.js";
import { setupLayout, modeFor, drawingFor, PREFERRED } from "./layout.js";

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
  drawing: () => drawingFor(modeFor(document.documentElement.clientWidth || innerWidth,
                                    document.documentElement.clientHeight || innerHeight)),
  attach: (a) => { api = a; ui(); },
  started: (n) => watch(n),                            // (opened on its own; live.load's for tuttidaw's)
};
let layout = null;
// the device's messages for the page: the Parts panel's view (worklet-tutti.js tutti-view), REC's arming (tutti-rec),
// the rest as they went
function watch(n, also = () => false) {
  const frames = n.port.onmessage;
  recShow(0);                                          // (a new device: its own arming to come)
  n.port.onmessage = (e) => {
    if (e.data.type === "tutti-view") { if (layout) layout.view(e.data.view); }
    else if (e.data.type === "tutti-rec") recShow(e.data.rec);
    else if (!also(e.data)) frames(e);
  };
}

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
      .tutti .rec { color: #e5484d; font-weight: 600; }
      .tutti .rec::before { content: "● "; }
      .tutti .note { font-size: 12px; color: var(--dim); text-align: center; flex-basis: 100%; }
      .tutti [hidden] { display: none !important; }
    </style>
    <span class="rec" id="tt-rec" role="status" hidden></span>
    <span id="tt-connected" hidden>
      <button id="tt-commit" type="button" title="Render this Felucca song into tuttidaw at tuttidaw's tempo">Render to tuttidaw</button>
      <label><input type="checkbox" id="tt-stems"> T1–T4 stems too</label>
    </span>
    <span id="tt-render" hidden>Rendering <progress id="tt-progress" max="1" value="0"></progress></span>
    <p class="note" id="tt-note"></p>`;
  document.querySelector("main").insertBefore(bar, document.querySelector(".keys"));
  const foot = document.querySelector("footer");
  const credit = document.createElement("p");
  credit.innerHTML = `Felucca plugin for <a href="https://tuttidaw.com">tuttidaw</a> by weavejam, built from Felucca
    (GPL-3.0) · <a href="../credits.html" target="_blank" rel="noopener">credits, licences, source</a><br>
    <small>Source of this build: <span id="tt-source"></span></small><br>
    <small>Not affiliated with or endorsed by M-VAVE.</small>`;
  credit.querySelector("#tt-source").textContent = BUILD.source;   // (as text too: tuttidaw's frame opens no popups)
  foot.insertBefore(credit, foot.firstChild);
  // (the emulator site's links)
  for (const a of foot.querySelectorAll("nav a")) if (!/^https?:/.test(a.getAttribute("href"))) a.remove();
  const mini = document.createElement("p");            // (the credits in one line: the bar's, the layouts without the panel)
  mini.className = "tt-mini";
  mini.innerHTML = `Felucca plugin for tuttidaw · GPL-3.0 · <a href="../credits.html" target="_blank" rel="noopener">credits,
    licences, source</a> · not affiliated with M-VAVE`;
  layout = setupLayout({ device: $("device"), bar, keys: document.querySelector(".keys"), footer: foot, mini, draw: api.draw });
  $("tt-commit").addEventListener("click", () => {
    session.commit({ outputs: $("tt-stems").checked ? ["mix", "t1", "t2", "t3", "t4"] : ["mix"] });
  });
  if (standalone) becomeStandalone();
  else {
    note("Waiting for tuttidaw…");
    $("go").disabled = true;
  }
}
const note = (t) => { if ($("tt-note")) $("tt-note").textContent = t; };
function recShow(rec) {
  const el = $("tt-rec"), t = recText(rec);
  if (!el) return;
  el.textContent = t;
  el.hidden = !t;
}

function becomeStandalone() {
  standalone = true;
  session.stopAccepting();                             // (a late connect would find the emulator on this browser's saves)
  delete host.sectors;                                 // (this browser's saves, as the emulator's own page)
  delete host.keep;
  host.midi = true;
  if ($("go")) $("go").disabled = false;
  note("This is the Felucca plugin for tuttidaw. Opened on its own it is the Felucca emulator: your saves stay in this browser.");
}

// ------------------------------------------------------------------ the live Felucca (edit mode)
let sigBase = null, flashBase = null, snapWait = new Map(), snapId = 0, loads = 0;
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
const tempo = new PreviewTempo((bpm) => send({ type: "tutti-tempo", bpm }));

const live = {
  sectors: {},
  async load(sectors, context) {
    loads++;
    this.sectors = sectors;
    flashBase = flashKey(sectors);
    sigBase = null;
    this.context(context);
    host.sectors = () => this.sectors;
    host.keep = (s) => {                               // a save on the live Felucca: a change (the autosave's own: not)
      const k = flashKey(s);
      if (flashBase !== null && k !== flashBase) engine.changed();
      flashBase = k;
      return true;
    };
    host.started = (n, c) => {
      node = n;
      ac = c;
      liveOn = true;
      send({ type: "tutti-hosted" });                 // (the internal clock while hosted, whatever CLK is set to)
      tempo.reset();
      tempo.at(0);
      watch(n, (m) => {
        if (m.type === "tutti-sig") {
          if (sigBase !== null && m.sig !== sigBase) engine.changed();
          sigBase = m.sig;
        } else if (m.type === "tutti-snapshot") {
          const w = snapWait.get(m.id);
          snapWait.delete(m.id);
          if (w) w(m);
        } else return false;
        return true;
      });
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
    const id = ++snapId, load = loads;
    const m = await new Promise((res, rej) => {
      snapWait.set(id, res);
      send({ type: "tutti-snapshot", id });
      setTimeout(() => { if (snapWait.delete(id)) rej(new RenderError("internal", "the live Felucca did not answer")); }, 5000);
    });
    if (!m.ok) throw new RenderError("internal", "the live Felucca could not save its state");
    if (load !== loads) return m.sectors;              // (a state loaded since, another session's: it stays)
    sigBase = m.sig;
    flashBase = flashKey(m.sectors);
    return (this.sectors = m.sectors);
  },
  context(ctx) { tempo.context(ctx); },
  transport(t) {
    if (!node || !ac) return;
    tempo.at(t.beat);
    if (!t.playing) { send({ type: "tutti-play", gen: t.generation, playing: false }); return; }
    // the context frame heard at atEpochMs: by the output's timestamp (it has the output latency) where there is one
    let atCtx;
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) atCtx = ts.contextTime + (t.atEpochMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    else atCtx = ac.currentTime + (t.atEpochMs - (performance.timeOrigin + performance.now())) / 1000 - (ac.outputLatency || ac.baseLatency || 0);
    send({ type: "tutti-play", gen: t.generation, playing: true, atFrame: Math.round(atCtx * ac.sampleRate),
           pos: Math.round((t.beat * 60 / tempo.bpm) * 44100) });
  },
  close() { send({ type: "tutti-play", gen: -1, playing: false }); },
};

// ------------------------------------------------------------------ renders in a Worker
// one render at a time in it: one still running when another starts (its session ended meanwhile: it is let go, not
// waited for) goes with its worker, and the new one gets a fresh worker. The session's end (close, the port's
// messageerror) or a message between it and the page that cannot be read (messageerror, either way): the worker's work
// ended with it (stopWorker)
let worker = null, workerBusy = null;
function stopWorker(err = new RenderError("cancelled", "the session ended")) {
  if (worker && workerBusy) {
    worker.terminate();
    workerBusy(err);
    worker = null;
  }
}
function renderInWorker(sectors, req, sink) {
  // (an ended session's render, its state made late: it never touches the worker, the next session's render may be in it)
  if (sink.cancelled()) return Promise.reject(new RenderError("cancelled", "cancelled"));
  stopWorker();
  worker = worker || new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  const w = worker;
  $("tt-render").hidden = false;
  $("tt-progress").value = 0;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (sink.cancelled()) w.postMessage({ type: "cancel" }); }, 50);
    const end = () => { clearInterval(poll); w.onmessage = w.onmessageerror = null; workerBusy = null; $("tt-render").hidden = true; };
    const unreadable = () => {                         // (the session ends: its teardown stops this worker, see close)
      log("tutti: a render worker message could not be read");
      session.close();
      stopWorker(new RenderError("internal", "a render worker message could not be read"));
    };
    w.onmessageerror = unreadable;
    workerBusy = (err) => { end(); reject(err); };
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
      else if (m.type === "messageerror") unreadable();
    };
    w.onerror = (e) => { end(); worker = null; w.terminate(); reject(new RenderError("internal", e.message || "the render worker failed")); };
    w.postMessage({ type: "render", wasmUrl: WASM_URL, sectors, req });
  });
}

// ------------------------------------------------------------------ the session
const engine = new FeluccaEngine({
  render: renderInWorker,
  live,
  onChanged: (rev) => session.stateChanged(rev),
});
const session = new PluginSession({
  engine,
  post: (m) => window.parent.postMessage(m, "*"),
  allow: (origin) => embedderAllowed(origin, EMBEDDERS),   // (the build's channel: site.mjs PLUGIN_CHANNEL)
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

engine.close = () => {                                 // (the session's end: the live device stopped, a render's worker too)
  stopWorker();
  live.close();
};

let alone = 0;
if (embedded) {
  // the host lays the frame out, this page fits whatever it gets (layout.js): `resize` is only the size it prefers,
  // the wide layout's own shape, once connected (never from the frame's size: no loop with the host's layout)
  window.addEventListener("message", (e) => {
    if (session.onWindowMessage({ data: e.data, origin: e.origin, isParent: e.source === window.parent, ports: e.ports })) {
      note("Connected to tuttidaw.");
      session.resize(PREFERRED.width, PREFERRED.height);
    }
  });
  session.hello();
  alone = setTimeout(() => { if (!session.port) becomeStandalone(); }, 4000);   // (not tuttidaw's frame)
}
window.addEventListener("pagehide", () => session.close());
