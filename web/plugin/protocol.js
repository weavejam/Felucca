// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// tutti-plugin/0, the plugin's side (docs: the host's protocol-v0.md; web/plugin/README.md): the handshake (hello ->
// connect with a MessagePort), the session's requests and replies, the state machine, renders streamed in credited
// chunks. No DOM here: the page (tutti.js) hands it window messages and an engine; the tests (plugin_test.mjs) a fake
// host over a MessageChannel.
//   engine: {
//     init({ sampleRate, context, state, stateVersion, mode }) -> { stateRevision }      (throws StateError)
//     context(context), transport(transport)                                              (no reply)
//     getState() -> { state: ArrayBuffer, stateVersion, stateRevision, summary? }
//     render(request, sink) -> result        sink: chunk(output, frameOffset, channels) -> Promise, progress(f),
//                                            cancelled(); throws RenderError(code) (renderer.js)
//     close()
//   }
// and calls back: session.stateChanged(revision), session.commit({ fromBeat?, toBeat?, outputs? }),
// session.resize(width, height).
export const PROTOCOL = "tutti-plugin/0";
export const CODES = ["bad-request", "unsupported", "busy", "state-incompatible", "cancelled", "too-large", "timeout",
                      "session-ended", "internal"];
export const INITIAL_CREDITS = 8;
export const STATE_DEBOUNCE_MS = 600, STATE_MAX_WAIT_MS = 2000, PROGRESS_MS = 100;

// The pages that may embed it: production tuttidaw, its subdomains (previews), a local dev server (any port)
export function embedderAllowed(origin) {
  if (typeof origin !== "string") return false;
  if (origin === "https://tuttidaw.com") return true;
  if (/^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.tuttidaw\.com$/.test(origin)) return true;
  return /^http:\/\/localhost(:\d{1,5})?$/.test(origin);
}

const isStr = (x) => typeof x === "string" && x.length > 0 && x.length <= 200;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export class PluginSession {
  // post(message): to window.parent, target '*' (the hello only); log(...): a console
  constructor({ engine, post, plugin, allow = embedderAllowed, log = () => {}, now = () => Date.now() }) {
    this.engine = engine;
    this.postParent = post;
    this.plugin = plugin;                             // { id, version, build }
    this.allow = allow;
    this.log = log;
    this.now = now;
    this.port = null;
    this.id = null;
    this.state = "connecting";                         // -> initializing -> ready (-> rendering -> ready) -> closed
    this.render = null;                                // the render running: { id, renderId, credits, cancel, ... }
    this.stTimer = null;
  }

  hello() { this.postParent({ type: "tutti-plugin:hello", protocol: PROTOCOL }); }

  // a window message: { data, origin, isParent (event.source === window.parent), ports }. 1 = it was taken
  onWindowMessage({ data, origin, isParent, ports }) {
    if (!data || data.type !== "tutti-plugin:connect") return 0;
    if (!isParent || !this.allow(origin)) { this.log("tutti: connect refused from", origin); return 0; }
    if (this.port) { this.log("tutti: a second connect ignored"); return 0; }
    if (data.protocol !== PROTOCOL || !isStr(data.sessionId) || !isNum(data.generation) || !ports || !ports[0]) {
      this.log("tutti: a malformed connect ignored");
      return 0;
    }
    this.id = data.sessionId;
    this.render = null;
    this.generation = data.generation;
    this.host = data.host || null;
    this.origin = origin;
    this.port = ports[0];
    this.state = "initializing";                       // (until init:ok; requests before it: bad-request)
    this.inited = false;
    this.port.onmessage = (e) => this.onPort(e.data);
    if (this.port.start) this.port.start();
    return 1;
  }

  send(msg, transfer = []) {
    if (!this.port || this.state === "closed") return;   // (a session that ended: nothing more)
    this.port.postMessage({ ...msg, sessionId: this.id }, transfer);
  }
  error(code, message, extra = {}, fatal = false) {
    this.send({ type: "error", code, message: String(message).slice(0, 500), fatal, ...extra });
  }

  async onPort(m) {
    if (this.state === "closed") return;
    if (!m || typeof m !== "object" || typeof m.type !== "string") { this.log("tutti: dropped", m); return; }
    if (m.sessionId !== this.id) { this.log("tutti: dropped (session)", m.type); return; }
    const requests = ["init", "get-state", "render"];
    if (requests.includes(m.type) && !isStr(m.id)) { this.error("bad-request", `${m.type} without an id`); return; }
    if (m.type !== "init" && m.type !== "close" && !this.inited) {
      if (requests.includes(m.type)) this.error("bad-request", "before init", { id: m.id });
      else this.log("tutti: dropped before init", m.type);
      return;
    }
    try {
      switch (m.type) {
        case "init": return await this.onInit(m);
        case "context":
          if (!m.context || typeof m.context !== "object") return this.log("tutti: dropped context");
          return this.engine.context(m.context);
        case "transport":
          if (!isNum(m.generation) || typeof m.playing !== "boolean" || !isNum(m.beat) || !isNum(m.atEpochMs))
            return this.log("tutti: dropped transport");
          return this.engine.transport(m);
        case "get-state": return await this.onGetState(m);
        case "render": return await this.onRender(m);
        case "render-credit": {
          const r = this.render;
          if (r && r.renderId === m.renderId && Number.isInteger(m.chunks) && m.chunks > 0 && m.chunks <= 1e6) {
            r.credits += m.chunks;
            r.wake();
          } else this.log("tutti: dropped render-credit");
          return;
        }
        case "cancel": {
          const r = this.render;
          if (r && r.renderId === m.renderId) { r.cancel = true; r.wake(); }
          return;
        }
        case "close": return this.close();
        default: this.log("tutti: unknown message", m.type);
      }
    } catch (err) {
      this.log("tutti: internal", err);
      if (requests.includes(m.type)) this.error("internal", err && err.message || err, { id: m.id });
    }
  }

  async onInit(m) {
    if (this.inited || this.state !== "initializing" || this.initing) { this.error("bad-request", "init twice", { id: m.id }); return; }
    const { sampleRate, context, state, stateVersion, mode } = m;
    if (!isNum(sampleRate) || !context || typeof context !== "object" || (mode !== "edit" && mode !== "render") ||
        !(state === null || state instanceof ArrayBuffer) || !(stateVersion === null || isNum(stateVersion)) ||
        (state !== null && stateVersion === null)) {
      this.error("bad-request", "init: sampleRate, context, state, stateVersion, mode", { id: m.id });
      return;
    }
    if (state && state.byteLength > 8388608) { this.error("too-large", "state over 8 MiB", { id: m.id }); return; }
    this.initing = true;
    this.mode = mode;
    try {
      const r = await this.engine.init({ sampleRate, context, state, stateVersion, mode });
      if (this.state === "closed") return;
      this.inited = true;
      this.state = "ready";
      this.send({ type: "init:ok", id: m.id, plugin: this.plugin, stateRevision: r.stateRevision });
    } catch (err) {
      const code = err && CODES.includes(err.code) ? err.code : "internal";   // (StateError: state-incompatible)
      if (code === "internal") this.log("tutti: init failed", err);
      this.error(code, err && err.message || err, { id: m.id }, code === "internal");
    } finally {
      this.initing = false;
    }
  }

  async onGetState(m) {
    const s = await this.engine.getState();
    this.send({ type: "get-state:ok", id: m.id, state: s.state, stateVersion: s.stateVersion, stateRevision: s.stateRevision,
                ...(s.summary ? { summary: s.summary } : {}) }, [s.state]);
  }

  async onRender(m) {
    if (!isStr(m.renderId) || !isNum(m.stateRevision) || !m.context || !Array.isArray(m.outputs) ||
        !isNum(m.fromBeat) || !isNum(m.toBeat) || !isNum(m.tailMs) || !isNum(m.sampleRate) ||
        !(m.input === null || (m.input && typeof m.input === "object"))) {
      this.error("bad-request", "render: renderId, stateRevision, context, input, fromBeat, toBeat, tailMs, outputs, sampleRate",
                 { id: m.id, ...(isStr(m.renderId) ? { renderId: m.renderId } : {}) });
      return;
    }
    if (this.render) { this.error("busy", "a render is running", { id: m.id, renderId: m.renderId }); return; }
    let wake = () => {};
    const r = this.render = { id: m.id, renderId: m.renderId, credits: INITIAL_CREDITS, cancel: false,
                              wake: () => wake(), lastProgress: -Infinity };
    this.state = "rendering";
    const sink = {
      cancelled: () => r.cancel || this.state === "closed",
      progress: (f) => {
        const t = this.now();
        if (t - r.lastProgress < PROGRESS_MS) return;
        r.lastProgress = t;
        this.send({ type: "render-progress", renderId: r.renderId, fraction: Math.max(0, Math.min(1, f)) });
      },
      chunk: async (output, frameOffset, channels) => {
        while (r.credits <= 0 && !sink.cancelled()) await new Promise((res) => { wake = res; });
        if (sink.cancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
        r.credits--;
        this.send({ type: "render-chunk", renderId: r.renderId, output, frameOffset, channels },
                  channels.map((c) => c.buffer));
      },
    };
    try {
      const res = await this.engine.render(m, sink);
      if (r.cancel) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      this.send({ type: "render:ok", id: r.id, renderId: r.renderId, ...(res || {}) });
    } catch (err) {
      const code = err && CODES.includes(err.code) ? err.code : "internal";
      if (code === "internal") this.log("tutti: render failed", err);
      this.error(code, err && err.message || err, { id: r.id, renderId: r.renderId });
    } finally {
      this.render = null;
      if (this.state === "rendering") this.state = "ready";
    }
  }

  // ---- from the plugin
  // the state changed: state-changed once it has been still for STATE_DEBOUNCE_MS (at most every STATE_MAX_WAIT_MS
  // while it keeps changing), with the revision at that moment
  stateChanged(revision) {
    if (!this.inited || this.state === "closed") return;
    const t = this.now();
    this.stFirst = this.stFirst || t;
    this.stRevision = revision;
    clearTimeout(this.stTimer);
    const fire = () => {
      this.stTimer = null;
      this.stFirst = 0;
      this.send({ type: "state-changed", stateRevision: this.stRevision });
    };
    const wait = Math.min(STATE_DEBOUNCE_MS, Math.max(0, this.stFirst + STATE_MAX_WAIT_MS - t));
    this.stTimer = setTimeout(fire, wait);
  }
  commit(p = {}) {
    if (!this.inited) return false;
    const msg = { type: "commit" };
    if (isNum(p.fromBeat)) msg.fromBeat = p.fromBeat;
    if (isNum(p.toBeat)) msg.toBeat = p.toBeat;
    if (Array.isArray(p.outputs)) msg.outputs = p.outputs;
    this.send(msg);
    return true;
  }
  resize(width, height) {
    if (this.port) this.send({ type: "resize", width: Math.round(width), height: Math.round(height) });
  }
  close() {
    if (this.state === "closed") return;
    if (this.render) { this.render.cancel = true; this.render.wake(); }
    clearTimeout(this.stTimer);
    this.state = "closed";
    try { this.engine.close(); } catch {}
    if (this.port) { this.port.onmessage = null; try { this.port.close(); } catch {} }
    this.port = null;                                  // (a new connect may start another session)
  }
}
