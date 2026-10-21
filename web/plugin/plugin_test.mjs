// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The FM-1 plugin (web/plugin) in Node: the renderer against the wasm, and the protocol against a fake host over a
// MessageChannel (protocol-v0 11, the plugin's side).
//   node web/plugin/plugin_test.mjs build/plugin-site/plugin/felucca.wasm [build/emu/felucca.wasm]
// With the emulator's wasm too: the plugin's build (FELUCCA_TUTTI) plays the emulator's heavy song bit for bit as it
// (the per-part sums leave the mix as it was). FAST=1 skips the slow checks (64 bars, 48 kHz quality).
import fs from "fs";
import { storeSectors } from "../emu/worklet.js";
import { render, planRender, device, frameAt, RenderError, NATIVE_RATE } from "./renderer.js";
import { packState, unpackState, stateEquals, STATE_VERSION } from "./state.js";
import { PluginSession, embedderAllowed, PROTOCOL, INITIAL_CREDITS } from "./protocol.js";
import { FM1Engine } from "./engine.js";
import { Resampler } from "./resample.js";

const wasmPath = process.argv[2] || "build/plugin-site/plugin/felucca.wasm", emuPath = process.argv[3];
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const FAST = process.env.FAST === "1";
let fails = 0;
const check = (what, ok) => { console.log(`plugin: ${what.padEnd(84)} ${ok ? "ok" : "FAIL"}`); if (!ok) fails++; };
const tm = (bpm, more = []) => ({ tempoPoints: [{ beat: 0, bpm, ramp: "step" }, ...more], signatures: [{ beat: 0, numerator: 4, denominator: 4 }] });
const ctxOf = (bpm, more) => ({ timeMap: tm(bpm, more), key: null });
const req = (o) => ({ renderId: "r", stateRevision: 1, context: ctxOf(120), input: null, fromBeat: 0, toBeat: 8, tailMs: 0,
                      outputs: ["mix"], sampleRate: 44100, ...o });
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
const db = (x) => (20 * Math.log10(x)).toFixed(1);

// a live (not headless) instance, its music made by fn, its state as the page would give it
async function makeState(fn) {
  const { exports: ex } = await WebAssembly.instantiate(mod, {});
  ex._initialize();
  ex.web_nor_erase();
  ex.tutti_boot(0);
  fn(ex);
  if (!ex.tutti_snapshot()) throw new Error("snapshot failed");
  return storeSectors(new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size()));
}
// a whole render into one array per output channel
async function renderAll(sectors, r, opts) {
  const out = {}, offs = {};
  const res = await render(mod, sectors, r, {
    chunk: async (o, off, ch) => {
      if ((offs[o] ?? 0) !== off) throw new Error(`chunk of ${o} at ${off}, expected ${offs[o] ?? 0}`);
      offs[o] = off + ch[0].length;
      (out[o] ||= []).push(ch);
    },
    progress: () => {}, cancelled: () => false,
  }, opts);
  const cat = (parts, c) => { const n = parts.reduce((s, p) => s + p[c].length, 0), a = new Float32Array(n); let k = 0; for (const p of parts) { a.set(p[c], k); k += p[c].length; } return a; };
  return { res, out: Object.fromEntries(Object.entries(out).map(([o, p]) => [o, [cat(p, 0), cat(p, 1)]])) };
}
const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

const heavy = await makeState((ex) => ex.web_test_heavy());
const heavy3 = await makeState((ex) => { ex.web_test_heavy(); ex.tutti_test_clear(3); });   // T4 empty
const ALL = ["mix", "t1", "t2", "t3", "t4"];

// ---- the mix is the emulator's: the heavy song through web_render, the plugin's build against the emulator's
if (emuPath) {
  const song = async (bytes) => {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    ex._initialize(); ex.web_nor_erase(); ex.web_boot();
    for (let k = 0; k < 500 * 44.1; k += 128) ex.web_render(128);
    ex.web_test_heavy();
    ex.web_buttons(1 << 10); for (let k = 0; k < 60 * 44.1; k += 128) ex.web_render(128);
    ex.web_buttons(0);
    const N = 128 * 689, out = new Float32Array(2 * N);
    for (let k = 0; k < N; k += 128) {
      ex.web_render(128);
      out.set(new Float32Array(ex.memory.buffer, ex.web_out_l(), 128), k);
      out.set(new Float32Array(ex.memory.buffer, ex.web_out_r(), 128), N + k);
    }
    return out;
  };
  const a = await song(fs.readFileSync(emuPath)), b = await song(fs.readFileSync(wasmPath));
  check(`the plugin's build plays the emulator's heavy song bit for bit (peak ${peak(a).toFixed(3)})`, peak(a) > 0.05 && same(a, b));
}

// ---- determinism
for (const sr of [44100, 48000]) {
  const r = req({ outputs: ALL, sampleRate: sr, toBeat: 6, tailMs: 300 });
  const x = await renderAll(heavy, r), y = await renderAll(heavy, r);
  check(`${sr} Hz: two renders (mix + 4 stems), byte for byte the same`, ALL.every((o) => same(x.out[o][0], y.out[o][0]) && same(x.out[o][1], y.out[o][1])));
}

// ---- geometry (protocol 5): exact frame counts, all outputs one length, frame 0 = fromBeat
for (const [bpm, from, to, tail, sr] of [[120, 0, 8, 0, 44100], [123.45, 4, 13.5, 250, 44100], [123.45, 1, 9, 100, 48000], [97, 0, 4, 10000, 48000]]) {
  const r = req({ context: ctxOf(bpm), fromBeat: from, toBeat: to, tailMs: tail, sampleRate: sr, outputs: ALL });
  const want = Math.round((to * 60 / bpm) * sr) - Math.round((from * 60 / bpm) * sr) + Math.ceil(tail * sr / 1000);
  const { out } = await renderAll(heavy, r);
  check(`${bpm} BPM [${from}, ${to}) + ${tail} ms at ${sr}: ${want} frames in each of 5 outputs`, ALL.every((o) => out[o][0].length === want && out[o][1].length === want));
}
{ // a later start is the same audio as the frames of a render from 0 (every render plays from the song's start)
  const a = (await renderAll(heavy, req({ context: ctxOf(123.45), fromBeat: 0, toBeat: 12 }))).out.mix[0];
  const b = (await renderAll(heavy, req({ context: ctxOf(123.45), fromBeat: 5.5, toBeat: 12 }))).out.mix[0];
  const off = Math.round((5.5 * 60 / 123.45) * 44100);
  check(`[5.5, 12) at 123.45 BPM is [0, 12)'s frames from ${off} on, bit for bit`, same(a.subarray(off, off + b.length), b));
}
{ // a tempo map with a change before the range: frame(beat) integrates it, the range at its own tempo
  const ctx = { timeMap: tm(100, [{ beat: 8, bpm: 140, ramp: "step" }]), key: null };
  const p = planRender(req({ context: ctx, fromBeat: 8, toBeat: 16 }));
  const f = (b) => frameAt(ctx.timeMap.tempoPoints, b, 44100);
  check(`a change at beat 8 (100 -> 140): [8, 16) is ${p.frames} = frame(16) - frame(8) frames at 140`,
        p.bpm === 140 && p.frames === f(16) - f(8) && f(8) === Math.round(8 * 60 / 100 * 44100));
  let code = null;
  try { planRender(req({ context: ctx, fromBeat: 4, toBeat: 12 })); } catch (e) { code = e.code; }
  const ap = planRender(req({ context: ctx, fromBeat: 4, toBeat: 12, approximation: "start-tempo" }));
  check("a change inside the range: 'unsupported'; with approximation 'start-tempo' at the tempo at fromBeat",
        code === "unsupported" && ap.bpm === 100 && ap.frames === Math.round(12 * 0.6 * 44100) - Math.round(4 * 0.6 * 44100));
  const ramp = { timeMap: tm(120, []), key: null };
  ramp.timeMap.tempoPoints = [{ beat: 0, bpm: 120, ramp: "linear" }, { beat: 4, bpm: 60, ramp: "step" }];
  const sec = frameAt(ramp.timeMap.tempoPoints, 4, 44100) / 44100, ideal = 60 * 4 / (60 - 120) * Math.log(60 / 120);
  check(`a linear ramp 120 -> 60 over 4 beats: ${sec.toFixed(4)} s (the integral: ${ideal.toFixed(4)} s)`, Math.abs(sec - ideal) < 1 / 44100);
}

// ---- fractional tempo: the step clock against the ideal grid
async function bars(bpm, nbars, hosted) {
  const ex = await device(mod, {}, 120);
  ex.tutti_tempo(hosted ? bpm : 0);
  if (!hosted) new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 1)[0] = bpm;      // G_BPM, the firmware's own (integer)
  ex.tutti_start(0xFFFFFFFF);                           // (never stopped)
  const got = [];
  let f0 = 0, last = -1;
  while (got.length < nbars) {
    ex.tutti_render(1, 0);
    const idx = ex.tutti_seq_idx(0), pos = ex.tutti_seq_pos(0);
    if (idx === 0 && last !== 0) got.push(f0 - pos);   // step 0 started pos samples before this block
    last = idx;
    f0 += 32;
  }
  return got;                                          // got[k]: the start of bar k (bar 0 at frame 0)
}
if (!FAST) {
  const bpm = 123.45, n = 65, got = await bars(bpm, n, true);
  const err = got.map((f, k) => f - (k * 4 * 60 / bpm) * 44100), worst = Math.max(...err.map(Math.abs));
  check(`123.45 BPM: 64 bars' starts each within 1 sample of the ideal (worst ${worst.toFixed(3)}, bar 64 at ${got[64]})`, worst < 1);
  const old = await bars(123, n, false), drift = old[64] - 64 * 4 * 60 / 123 * 44100;
  console.log(`plugin:   (the firmware's integer step clock at 123 BPM: bar 64 ${drift.toFixed(1)} samples from its ideal)`);
}

// ---- stems
{
  const { out } = await renderAll(heavy3, req({ outputs: ALL, toBeat: 8, tailMs: 500 }));
  const p = Object.fromEntries(ALL.map((o) => [o, Math.max(peak(out[o][0]), peak(out[o][1]))]));
  check(`stems: T1..T3 sound (${["t1", "t2", "t3"].map((o) => p[o].toFixed(3)).join(" ")}), T4 (empty) silent (${p.t4})`,
        p.t1 > 1e-3 && p.t2 > 0.01 && p.t3 > 0.01 && p.t4 === 0);
  const sumErr = [0, 1].map((c) => {
    const e = new Float32Array(out.mix[c].length);
    for (let i = 0; i < e.length; i++) e[i] = out.mix[c][i] - out.t1[c][i] - out.t2[c][i] - out.t3[c][i] - out.t4[c][i];
    return rms(e) / rms(out.mix[c]);
  });
  console.log(`plugin:   (mix - (t1 + t2 + t3 + t4): ${db(sumErr[0])} / ${db(sumErr[1])} dB of the mix, L / R: the soft clip and the buses)`);
  check("stems add up to the mix within -20 dB (best effort: README)", sumErr.every((x) => x < 0.1));
}

// ---- use A: the sequencer stops at toBeat, the tail only rings out
{
  const drums = await makeState((ex) => { ex.web_test_heavy(); for (const t of [0, 1, 2]) ex.tutti_test_clear(t); });
  const a = (await renderAll(drums, req({ toBeat: 4, tailMs: 2000 }))).out.mix[0];
  const b = (await renderAll(drums, req({ toBeat: 12, tailMs: 0 }))).out.mix[0];
  const s = Math.round(4 * 0.5 * 44100) + 22050, e = s + 44100;       // 0.5 .. 1.5 s after toBeat
  const ta = peak(a.subarray(s, e)), tb = peak(b.subarray(s, e));
  check(`use A: after toBeat no new steps, the tail rings out (${ta.toFixed(4)} vs playing on ${tb.toFixed(3)})`,
        same(a.subarray(0, 88200 - 32), b.subarray(0, 88200 - 32)) && tb > 0.05 && ta < tb / 10);
}

// ---- use B: MIDI notes into T1, the sequencer stopped; their timing
{
  const input = { notes: [{ beat: 1, lengthBeats: 1, pitch: 60, velocity: 100, channel: 0 }, { beat: 2.5, lengthBeats: 10, pitch: 67, velocity: 90, channel: 0 }],
                  cc: [{ beat: 0, channel: 0, cc: 1, value: 0 }], pitchBend: [{ beat: 0, channel: 0, value: 0 }], preRollBeats: 0 };
  const { out } = await renderAll({}, req({ input, toBeat: 4, tailMs: 200, outputs: ["mix", "t1", "t2"] }));
  const l = out.mix[0], at = l.findIndex((x) => Math.abs(x) > 1e-4), want = Math.round(1 * 0.5 * 44100);
  check(`use B: a note at beat 1 (frame ${want}) sounds at frame ${at}: the nearest block, within 16 frames`, Math.abs(at - want) <= 17);
  check("use B: before it silence, T1's stem has it, T2's nothing", peak(l.subarray(0, want - 17)) === 0 && peak(out.t1[0]) > 0.01 && peak(out.t2[0]) === 0);
  const held = (await renderAll({}, req({ input, toBeat: 3, tailMs: 0 }))).out.mix[0];
  const late = (await renderAll({}, req({ input, fromBeat: 2.75, toBeat: 3, tailMs: 0 }))).out.mix[0];
  check("use B: a note held over fromBeat sounds from its first frame (rendered from the song's start)",
        same(held.subarray(held.length - late.length), late) && peak(late.subarray(0, 64)) > 1e-3);
}

// ---- 48 kHz: the resampler against a sine
if (!FAST) {
  const f = 1000, n = 44100, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = r[i] = 0.5 * Math.sin(2 * Math.PI * f * i / 44100);
  const rs = new Resampler(0), ol = new Float64Array(48000), or = new Float64Array(48000);
  rs.push(l, r);
  const k = rs.take(ol, or, 0, 48000);
  let e = 0, c = 0;
  for (let i = 2000; i < k - 2000; i++) { const d = ol[i] - 0.5 * Math.sin(2 * Math.PI * f * i / 48000); e += d * d; c++; }
  const err = Math.sqrt(e / c) / (0.5 / Math.SQRT2);
  check(`48 kHz: a 1 kHz sine resampled, error ${db(err)} dB (under -90), on time (no delay)`, err < 10 ** (-90 / 20));
}

// ---- the state: packed, unpacked, a render of it the same in a fresh instance
{
  const buf = packState(heavy), back = unpackState(buf);
  check(`state: ${buf.byteLength} B, unpacked to the same sectors, the input unchanged`,
        Object.keys(back).length === Object.keys(heavy).length && Object.keys(heavy).every((k) => same(heavy[k], back[k])) && stateEquals(buf, packState(back)));
  let bad = 0;
  for (const b of [new ArrayBuffer(3), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer, buf.slice(0, buf.byteLength - 1)])
    try { unpackState(b); } catch (e) { if (e.code === "state-incompatible") bad++; }
  try { unpackState(buf, 2); } catch (e) { if (e.code === "state-incompatible") bad++; }
  check("state: short, foreign, truncated and other-version states refused (state-incompatible)", bad === 4);
}

// ================================================================== the protocol (a fake host)
// a live device as the page has it (tutti.js live): the wasm not headless, its edits checked by tutti_sig
class NodeLive {
  constructor() { this.ex = null; this.loads = 0; this.transports = []; }
  async load(sectors) {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize(); ex.web_nor_erase();
    const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size());
    for (const [k, v] of Object.entries(sectors)) nor.set(v, +k);
    ex.tutti_boot(0);
    for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);   // (on for a second, as on the page: past the splash)
    this.ex = ex;
    this.sig = ex.tutti_sig();
    this.loads++;
  }
  edit(fn) {                                          // a user's edit, then the page's check
    fn(this.ex);
    for (let k = 0; k < 100 * 44.1; k += 128) this.ex.web_render(128);
    const s = this.ex.tutti_sig();
    if (s !== this.sig) { this.sig = s; this.engine.changed(); }
  }
  async snapshot() {
    this.ex.tutti_snapshot();
    this.sig = this.ex.tutti_sig();
    return storeSectors(new Uint8Array(this.ex.memory.buffer, this.ex.web_nor(), this.ex.web_nor_size()));
  }
  context() {}
  transport(t) { this.transports.push(t); }
  close() { this.closed = true; }
}
const HOST = "https://tuttidaw.com";
function harness({ live = null, chunkFrames } = {}) {
  const hello = [];
  const engine = new FM1Engine({
    render: (sectors, r, sink) => render(mod, sectors, r, sink, chunkFrames ? { chunkFrames } : {}),
    live, onChanged: (rev) => session.stateChanged(rev),
  });
  if (live) live.engine = engine;
  const session = new PluginSession({ engine, post: (m) => hello.push(m), plugin: { id: "com.weavejam.fm1", version: "t", build: "t" } });
  const h = { session, engine, hello, got: [], waiters: [] };
  h.connect = (o = {}) => {
    const ch = new MessageChannel();
    h.port = ch.port1;
    h.port.onmessage = (e) => {
      h.got.push(e.data);
      for (const w of [...h.waiters]) if (w.pred(e.data)) { h.waiters.splice(h.waiters.indexOf(w), 1); w.res(e.data); }
    };
    h.sid = o.sessionId || "s-" + Math.random().toString(36).slice(2);
    return session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: h.sid, generation: o.generation ?? 1,
                                             host: { name: "test", version: "0", timeOrigin: 0 } },
                                     origin: o.origin ?? HOST, isParent: o.isParent ?? true, ports: [ch.port2] });
  };
  h.send = (m, transfer) => h.port.postMessage({ sessionId: h.sid, ...m }, transfer || []);
  h.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const old = h.got.find(pred);
    if (old) { h.got.splice(h.got.indexOf(old), 1); return res(old); }
    const w = { pred, res: (m) => { clearTimeout(t); h.got.splice(h.got.indexOf(m), 1); res(m); } };
    const t = setTimeout(() => { h.waiters.splice(h.waiters.indexOf(w), 1); rej(new Error("timeout waiting")); }, ms);
    h.waiters.push(w);
  });
  h.reply = (id) => h.wait((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error"));
  h.terminals = (id) => h.got.filter((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error")).length;
  h.close = () => { try { h.port.close(); } catch {} };
  return h;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = (h, renderId) => {                    // the chunks of a render, granting a credit per chunk taken
  const chunks = [];
  const on = h.port.onmessage;
  h.port.onmessage = (e) => {
    if (e.data.type === "render-chunk" && e.data.renderId === renderId) {
      chunks.push(e.data);
      h.send({ type: "render-credit", renderId, chunks: 1 });
    } else on(e);
  };
  return chunks;
};

// ---- handshake
{
  const h = harness();
  h.session.hello();
  check("hello: {type, protocol} to the parent, nothing else", h.hello.length === 1 && h.hello[0].type === "tutti-plugin:hello" &&
        h.hello[0].protocol === PROTOCOL && Object.keys(h.hello[0]).length === 2);
  check("embedders: tuttidaw.com, its subdomains, localhost:*; not others",
        ["https://tuttidaw.com", "https://www.tuttidaw.com", "https://pr-12.tuttidaw.com", "http://localhost:5173", "http://localhost"].every(embedderAllowed) &&
        !["http://tuttidaw.com", "https://tuttidaw.com.evil.io", "https://eviltuttidaw.com", "https://a.b.tuttidaw.com", "https://localhost:3000",
          "http://127.0.0.1:5173", "null", undefined].some(embedderAllowed));
  check("connect from a wrong origin ignored", h.connect({ origin: "https://evil.example" }) === 0);
  check("connect from another window (not the parent) ignored", h.connect({ isParent: false }) === 0);
  check("connect from the parent at tuttidaw.com accepted", h.connect() === 1);
  const first = h.sid;
  const h2port = h.port;
  check("a second connect ignored while the session lives", h.connect({ sessionId: "other" }) === 0);
  h.port = h2port; h.sid = first;
  h.send({ type: "get-state", id: "g0" });
  const g0 = await h.reply("g0");
  check("get-state before init: error bad-request", g0.type === "error" && g0.code === "bad-request" && g0.fatal === false);
  h.port.postMessage({ type: "init", sessionId: "wrong", id: "x", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  check("a message of another session dropped (no reply)", !h.got.some((m) => m.id === "x"));
  h.send({ type: "init", id: "i1", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  const i1 = await h.reply("i1");
  check("init (null state, mode render, no gesture, no audio): init:ok {plugin, stateRevision}",
        i1.type === "init:ok" && i1.plugin.id === "com.weavejam.fm1" && i1.stateRevision === 1 && i1.sessionId === first);
  h.send({ type: "init", id: "i2", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  check("init twice: bad-request", (await h.reply("i2")).code === "bad-request");
  h.send({ type: "bogus" });
  h.send({ type: "render", id: "rb" });
  const rb = await h.reply("rb");
  h.port.postMessage("not an object");
  h.send({ type: "render" });
  const noid = await h.wait((m) => m.type === "error" && m.id === undefined);
  check("unknown types and invalid messages: dropped or bad-request, the session goes on", rb.code === "bad-request" && noid.code === "bad-request");
  h.send({ type: "render", id: "big", ...req({ renderId: "big", toBeat: 2000, context: ctxOf(60) }) });
  check("a render over 600 s: too-large", (await h.reply("big")).code === "too-large");
  h.send({ type: "render", id: "sr", ...req({ renderId: "sr", sampleRate: 96000 }) });
  check("a render at 96 kHz: unsupported", (await h.reply("sr")).code === "unsupported");
  h.send({ type: "render", id: "tc", ...req({ renderId: "tc", context: ctxOf(120, [{ beat: 4, bpm: 90, ramp: "step" }]) }) });
  check("a tempo change in the range (tempoMap constant): unsupported", (await h.reply("tc")).code === "unsupported");
  h.send({ type: "render", id: "rv", ...req({ renderId: "rv", stateRevision: 7 }) });
  check("a render of an unknown state revision: state-incompatible", (await h.reply("rv")).code === "state-incompatible");
  h.send({ type: "close" });
  await sleep(20);
  check("close: the session ends; a new connect (a reload) is a new session", h.session.state === "closed" && h.connect({ generation: 2 }) === 1);
  h.send({ type: "init", id: "i3", sampleRate: 44100, context: ctxOf(120), state: packState(heavy), stateVersion: STATE_VERSION, mode: "render" });
  check("init with a saved state in the new session: init:ok", (await h.reply("i3")).type === "init:ok");
  h.send({ type: "init", id: "i4", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i4");
  const h3 = harness();
  h3.connect();
  h3.send({ type: "init", id: "i5", sampleRate: 44100, context: ctxOf(120), state: new ArrayBuffer(16), stateVersion: 1, mode: "render" });
  const i5 = await h3.reply("i5");
  const h4 = harness();
  h4.connect();
  h4.send({ type: "init", id: "i6", sampleRate: 44100, context: ctxOf(120), state: packState(heavy), stateVersion: 9, mode: "render" });
  const i6 = await h4.reply("i6");
  check("init with a foreign state or an unread version: state-incompatible", i5.code === "state-incompatible" && i6.code === "state-incompatible");
  h.close(); h3.close(); h4.close();
}

// ---- renders through the session: chunks, lengths, credits, cancel, busy, determinism
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(123.45), state: packState(heavy), stateVersion: 1, mode: "render" });
  const rev = (await h.reply("i")).stateRevision;
  // credit backpressure: no credits granted -> exactly INITIAL_CREDITS chunks, then it waits
  h.send({ type: "render", id: "c1", ...req({ renderId: "c1", stateRevision: rev, context: ctxOf(123.45), toBeat: 40, outputs: ALL }) });
  await sleep(1500);
  const inFlight = h.got.filter((m) => m.type === "render-chunk" && m.renderId === "c1").length;
  check(`credits: ${inFlight} chunks out with the ${INITIAL_CREDITS} initial credits, then it waits`, inFlight === INITIAL_CREDITS && h.terminals("c1") === 0);
  h.send({ type: "render", id: "c2", ...req({ renderId: "c2", stateRevision: rev }) });
  const busy = await h.reply("c2");
  check("a second render while one runs: busy", busy.code === "busy" && busy.renderId === "c2");
  h.send({ type: "render-credit", renderId: "c1", chunks: 3 });
  await sleep(800);
  const after = h.got.filter((m) => m.type === "render-chunk" && m.renderId === "c1").length;
  check(`credits: 3 more granted, ${after - inFlight} more chunks`, after === inFlight + 3);
  h.send({ type: "cancel", renderId: "c1" });
  const term = await h.reply("c1");
  await sleep(300);
  check("cancel mid-render: exactly one terminal, error cancelled", term.code === "cancelled" && h.terminals("c1") === 0);
  // whole renders: mix + stems, 123.45 BPM, chunks of <= 1 s, the lengths of section 5, twice the same
  const run = async (id, extra = {}) => {
    const chunks = collect(h, id);
    h.send({ type: "render", id, ...req({ renderId: id, stateRevision: rev, context: ctxOf(123.45), fromBeat: 2, toBeat: 18, tailMs: 750, outputs: ALL, ...extra }) });
    const ok = await h.reply(id);
    return { ok, chunks };
  };
  const a = await run("w1"), b = await run("w2");
  const want = Math.round(18 * 60 / 123.45 * 44100) - Math.round(2 * 60 / 123.45 * 44100) + Math.ceil(0.75 * 44100);
  const len = (cs, o) => cs.filter((c) => c.output === o).reduce((s, c) => s + c.channels[0].length, 0);
  check(`render via the session: render:ok, each output ${want} frames, chunks <= 1 s, offsets in order`,
        a.ok.type === "render:ok" && ALL.every((o) => len(a.chunks, o) === want) && a.chunks.every((c) => c.channels[0].length <= 44100 && c.channels.length === 2) &&
        ALL.every((o) => a.chunks.filter((c) => c.output === o).every((c, i, cs) => c.frameOffset === (i ? cs[i - 1].frameOffset + cs[i - 1].channels[0].length : 0))));
  check("render via the session twice: the same bytes", a.chunks.length === b.chunks.length &&
        a.chunks.every((c, i) => c.output === b.chunks[i].output && same(c.channels[0], b.chunks[i].channels[0]) && same(c.channels[1], b.chunks[i].channels[1])));
  check("progress: render-progress messages, fraction 0..1", h.got.some((m) => m.type === "render-progress" && m.fraction >= 0 && m.fraction <= 1));
  h.close();
}

// ---- edit mode: the live device, edits -> revisions, state-changed debounced, get-state, the round trip
{
  const live = new NodeLive(), h = harness({ live });
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  const i = await h.reply("i");
  check("edit mode: init:ok, the live device loaded", i.type === "init:ok" && live.loads === 1);
  h.send({ type: "get-state", id: "g1" });
  const g1 = await h.reply("g1");
  live.edit((ex) => ex.web_test_heavy());
  live.edit((ex) => ex.web_enc(3, 2));
  live.edit((ex) => ex.web_enc(3, 2));
  await sleep(100);
  const early = h.got.filter((m) => m.type === "state-changed").length;
  const sc = await h.wait((m) => m.type === "state-changed", 5000);
  await sleep(700);
  check(`edits: one state-changed after ${">="} 500 ms (debounced), revision ${g1.stateRevision} -> ${sc.stateRevision}`,
        early === 0 && sc.stateRevision === g1.stateRevision + 1 && h.got.filter((m) => m.type === "state-changed").length === 0);
  h.send({ type: "get-state", id: "g2" });
  const g2 = await h.reply("g2");
  h.send({ type: "get-state", id: "g3" });
  const g3 = await h.reply("g3");
  check("get-state after edits: the new revision; again without edits: the same revision, the same bytes",
        g2.type === "get-state:ok" && g2.stateRevision === sc.stateRevision && g2.stateVersion === STATE_VERSION &&
        g3.stateRevision === g2.stateRevision && stateEquals(g2.state, g3.state) && !stateEquals(g1.state, g2.state));
  const chunks = collect(h, "e1");
  h.send({ type: "render", id: "e1", ...req({ renderId: "e1", stateRevision: g2.stateRevision, outputs: ["mix", "t2"], toBeat: 8 }) });
  await h.reply("e1");
  // the round trip: that state into a new session (render mode), the same render
  const h2 = harness();
  h2.connect();
  h2.send({ type: "init", id: "j", sampleRate: 44100, context: ctxOf(120), state: g2.state, stateVersion: g2.stateVersion, mode: "render" });
  const j = await h2.reply("j");
  const chunks2 = collect(h2, "e2");
  h2.send({ type: "render", id: "e2", ...req({ renderId: "e2", stateRevision: j.stateRevision, outputs: ["mix", "t2"], toBeat: 8 }) });
  await h2.reply("e2");
  check(`state round trip: get-state -> init in a new session -> the same render (${chunks.length} chunks, peak ${peak(chunks[0].channels[0]).toFixed(3)})`,
        chunks.length === chunks2.length && peak(chunks[0].channels[0]) > 0.05 &&
        chunks.every((c, k) => c.output === chunks2[k].output && same(c.channels[0], chunks2[k].channels[0]) && same(c.channels[1], chunks2[k].channels[1])));
  live.edit((ex) => ex.web_enc(3, 5));
  h.send({ type: "render", id: "e3", ...req({ renderId: "e3", stateRevision: g1.stateRevision }) });
  const e3 = await h.reply("e3");
  check("an older revision (kept) still renders", e3.type === "render:ok");
  h.send({ type: "transport", generation: 3, playing: true, beat: 4, atEpochMs: 1000, loop: null });
  h.send({ type: "transport", generation: 3, playing: "yes", beat: 4, atEpochMs: 1000, loop: null });
  await sleep(50);
  check("transport: to the live device (preview); a malformed one dropped", live.transports.length === 1 && live.transports[0].beat === 4);
  h.session.commit({ outputs: ["mix"] });
  const cm = await h.wait((m) => m.type === "commit");
  check("commit (the Render to tuttidaw button): {type: commit, outputs}", cm.outputs[0] === "mix" && cm.sessionId === h.sid);
  h.send({ type: "close" });
  await sleep(20);
  check("close: the live device closed", live.closed === true);
  h.close(); h2.close();
}

console.log(fails ? `plugin: ${fails} FAILED` : "plugin: all ok");
process.exit(fails ? 1 : 0);
