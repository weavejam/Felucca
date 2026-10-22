// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The Felucca plugin (web/plugin) in Node: the renderer against the wasm, and the protocol against a fake host over a
// MessageChannel (protocol-v0 11, the plugin's side).
//   node web/plugin/plugin_test.mjs build/plugin-wasm/felucca.wasm [build/emu/felucca.wasm]
// With the emulator's wasm too: the plugin's build (FELUCCA_TUTTI) plays the emulator's heavy song bit for bit as it
// (the per-part sums leave the mix as it was). FAST=1 skips the slow checks (64 bars, 48 kHz quality).
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync, execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { storeSectors } from "../emu/worklet.js";
import { render, planRender, midiEvents, device, frameAt, RenderError, NATIVE_RATE, MIN_BPM, MAX_BPM } from "./renderer.js";
import { packState, unpackState, stateEquals, STATE_VERSION } from "./state.js";
import { PluginSession, embedderAllowed, CHANNELS, PROTOCOL, INITIAL_CREDITS } from "./protocol.js";
import { FeluccaEngine, PreviewTempo } from "./engine.js";
import { Resampler } from "./resample.js";

const wasmPath = process.argv[2] || "build/plugin-wasm/felucca.wasm", emuPath = process.argv[3];
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

{ // 'start-tempo' (protocol 7): frame() is a constant map at the tempo at fromBeat, even with no change in the range
  const ctx = { timeMap: tm(100, [{ beat: 3.3, bpm: 137.7, ramp: "step" }]), key: null };
  const p = planRender(req({ context: ctx, fromBeat: 5, toBeat: 9.1, approximation: "start-tempo" }));
  const own = (b) => Math.round(b * 60 / 137.7 * 44100);
  check(`'start-tempo' lengths from the constant map at the start tempo: ${p.frames} = own(9.1) - own(5)`, p.frames === own(9.1) - own(5));
}
{ // the tempo range: the firmware's (40 .. 240 BPM), outside it 'unsupported', never a silently different tempo
  const code = (bpm, more) => { try { planRender(req({ context: ctxOf(bpm, more) })); return "ok"; } catch (e) { return e.code; } };
  const ex = await device(mod, {}, 120);
  check(`tempo: ${MIN_BPM} and ${MAX_BPM} BPM render; 39.99, 240.01, 300 and 10 BPM: unsupported; the wasm's range the same`,
        code(40) === "ok" && code(240) === "ok" && code(39.99) === "unsupported" && code(240.01) === "unsupported" &&
        code(300) === "unsupported" && code(10) === "unsupported" && code(120, [{ beat: 16, bpm: 400, ramp: "step" }]) === "ok" &&
        ex.tutti_bpm_min() === MIN_BPM && ex.tutti_bpm_max() === MAX_BPM && ex.tutti_tempo(300) === 0 && ex.tutti_tempo(39) === 0 &&
        ex.tutti_tempo(123.45) === 1);
}
{ // progress (protocol 6, no seek): over the pre-roll from beat 0 and the range, monotonic, to 1
  const seen = [];
  let chunks = 0;
  await render(mod, heavy, req({ fromBeat: 24, toBeat: 32 }), {
    chunk: async () => { chunks++; }, progress: (f) => seen.push([f, chunks]), cancelled: () => false });
  const before = Math.max(...seen.filter(([, c]) => c === 0).map(([f]) => f));
  check(`progress over pre-roll + range: ${seen.length} steps, ${before.toFixed(3)} (pre-roll 0.75) before the first chunk, then to 1`,
        seen.every(([f], i) => f >= 0 && f <= 1 && (!i || f >= seen[i - 1][0])) && before > 0.6 && before <= 0.75 &&
        seen.at(-1)[0] === 1 && seen.filter(([, c]) => c === 0).length > 3);
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
{ // use B: Felucca's own sequencer does not run when the request has input (protocol 7b), its song in the state or not
  const none = { notes: [], cc: [], pitchBend: [], preRollBeats: 0 };
  const a = (await renderAll(heavy, req({ input: null, outputs: ALL, toBeat: 8 }))).out;
  const b = (await renderAll(heavy, req({ input: none, outputs: ALL, toBeat: 8, tailMs: 500 }))).out;
  const one = { ...none, notes: [{ beat: 2, lengthBeats: 1, pitch: 64, velocity: 100, channel: 1 }] };
  const c = (await renderAll(heavy, req({ input: one, outputs: ALL, toBeat: 8 }))).out;
  const pk = (o) => Object.fromEntries(ALL.map((k) => [k, Math.max(peak(o[k][0]), peak(o[k][1]))]));
  const pa = pk(a), pb = pk(b), pc = pk(c), at = Math.round(2 * 0.5 * 44100) - 17;
  check(`use B: the state's song (use A peak ${pa.mix.toFixed(3)}) does not play: no notes -> every output silent`,
        pa.mix > 0.05 && ALL.every((k) => pb[k] === 0));
  check(`use B: one note on channel 1 -> T2 only (${pc.t2.toFixed(3)}), nothing before it`,
        pc.t2 > 0.01 && pc.t1 === 0 && pc.t3 === 0 && pc.t4 === 0 && peak(c.mix[0].subarray(0, at)) === 0);
}
{ // zero-length notes (protocol 7b): the off after the on, never before; a note that rounds to no frames too
  const n = (beat, lengthBeats, pitch = 60) => ({ beat, lengthBeats, pitch, velocity: 100, channel: 0 });
  const ev = midiEvents({ notes: [n(0, 1), n(1, 0), n(2, 1e-9), n(3, -0)], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8);
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  const kinds = ev.map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`);
  const want = [`on@0`, `off@${at(1)}`, `on@${at(1)}`, `off@${at(1) + 32}`, `on@${at(2)}`, `off@${at(2) + 32}`, `on@${at(3)}`, `off@${at(3) + 32}`];
  check(`zero-length notes: each off a block after its on (${kinds.slice(1, 4).join(" ")})`, kinds.join() === want.join());
  // moved a block on, an off stops at the next on of its pitch on its channel (before it), not other pitches or channels
  const near = 10 / 22050, other = { ...n(near, 0, 61) }, ch1 = { ...n(near, 0), channel: 1 };
  const ev2 = midiEvents({ notes: [n(0, 0), n(near, 2), other, ch1], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8);
  const k2 = ev2.map((e) => `${e.status >> 4 === 9 ? "on" : "off"}${e.status & 15}:${e.d1}@${e.frame}`);
  const want2 = ["on0:60@0", "off0:60@10", "on0:60@10", "on0:61@10", "on1:60@10", "off0:61@42", "off1:60@42", `off0:60@${at(near + 2)}`];
  check(`zero-length notes: the moved off not past the next on of its pitch and channel (${k2.slice(0, 3).join(" ")})`, k2.join() === want2.join());
  const two = (await renderAll({}, req({ input: { notes: [n(1, 0), n(1 + near, 2)], cc: [], pitchBend: [], preRollBeats: 0 }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const alone = (await renderAll({}, req({ input: { notes: [n(1 + near, 2)], cc: [], pitchBend: [], preRollBeats: 0 }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const mid = (x) => rms(x.subarray(at(2), at(2.75)));
  check(`zero-length note then the same pitch 10 frames on: that note held (rms ${mid(two).toFixed(4)}, alone ${mid(alone).toFixed(4)})`,
        mid(alone) > 1e-3 && mid(two) > mid(alone) / 2);
  const o = (await renderAll({}, req({ input: { notes: [n(1, 0)], cc: [], pitchBend: [], preRollBeats: 0 }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const held = (await renderAll({}, req({ input: { notes: [n(1, 8)], cc: [], pitchBend: [], preRollBeats: 0 }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const end = (x) => peak(x.subarray(x.length - 44100));
  check(`zero-length notes: the note sounds (peak ${peak(o).toFixed(3)}) and is let go (the last second ${end(o).toFixed(4)}, held ${end(held).toFixed(4)})`,
        peak(o) > 1e-3 && end(o) < end(held) / 4);
}
{ // the host's tempo is a runtime value: not the song's G_BPM, not in the autosave's signature (the state)
  const { exports: ex } = await WebAssembly.instantiate(mod, {});
  ex._initialize(); ex.web_nor_erase(); ex.tutti_boot(0);
  for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
  const g = () => new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 1)[0];
  const sig0 = ex.tutti_sig(), bpm0 = g();
  ex.tutti_tempo(97.3);
  for (let k = 0; k < 500 * 44.1; k += 128) ex.web_render(128);
  ex.tutti_tempo(181.25);
  for (let k = 0; k < 500 * 44.1; k += 128) ex.web_render(128);
  check(`host tempo: G_BPM stays the song's (${bpm0} -> ${g()}), the state's signature unchanged`, g() === bpm0 && ex.tutti_sig() === sig0);
}
{ // the preview's seek: bounded work per call (the worklet's quantum), the time meanwhile added; where it gets to the
  // same as one long seek
  const live = async () => {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize(); ex.web_nor_erase(); ex.tutti_boot(0);
    for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
    ex.web_test_heavy();
    ex.tutti_tempo(123.45);
    return ex;
  };
  const a = await live(), b = await live(), B = 1024, Q = 128 / 32, F = 44100 * 150;   // 2.5 minutes in (worklet SEEK_BLOCKS)
  b.tutti_seek(1, F);
  let left = b.tutti_seek_run(B, 0), calls = 1, bounded = left === Math.floor(F / 32) - B;
  const t0 = performance.now();
  while (left) {
    const was = left;
    left = b.tutti_seek_run(B, Q);
    bounded &&= left === Math.max(0, was + Q - B);
    calls++;
  }
  const ms = (performance.now() - t0) / (calls - 1);
  a.tutti_seek(1, F + (calls - 1) * 128);
  a.tutti_seek_run(0xFFFFFFFF, 0);
  const pos = (ex) => [0, 1, 2, 3].map((t) => `${ex.tutti_seq_idx(t)}:${ex.tutti_seq_pos(t)}`).join(" ");
  check(`seek: 2.5 min in, ${B} blocks a call (${calls} calls, ${ms.toFixed(3)} ms each, a quantum is 2.9 ms)`, bounded && ms < 1);
  check(`seek: in steps (the quanta meanwhile added) = in one go (${pos(b)})`, pos(a) === pos(b) && a.tutti_seek_run(B, 0) === 0);
  b.tutti_seek(1, 0);
  const z = b.tutti_seek_run(B, 0);
  b.tutti_seek(0, 0);
  check("seek: to 0 done at once; stopped: nothing to run", z === 0 && b.tutti_seek_run(B, Q) === 0);
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
  constructor() {
    this.ex = null; this.loads = 0; this.transports = []; this.tempos = [];
    this.tempo = new PreviewTempo((bpm) => { this.tempos.push(bpm); this.ex.tutti_tempo(bpm); });   // (as the page's)
  }
  async load(sectors, context) {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize(); ex.web_nor_erase();
    const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size());
    for (const [k, v] of Object.entries(sectors)) nor.set(v, +k);
    ex.tutti_boot(0);
    for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);   // (on for a second, as on the page: past the splash)
    this.ex = ex;
    this.sig = ex.tutti_sig();
    this.loads++;
    this.tempo.reset();
    this.context(context);
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
  context(ctx) { this.tempo.context(ctx); }
  transport(t) { this.transports.push(t); }
  close() { this.closed = true; }
}
const HOST = "https://tuttidaw.com";
function harness({ live = null, chunkFrames } = {}) {
  const hello = [];
  const engine = new FeluccaEngine({
    render: (sectors, r, sink) => render(mod, sectors, r, sink, chunkFrames ? { chunkFrames } : {}),
    live, onChanged: (rev) => session.stateChanged(rev),
  });
  if (live) live.engine = engine;
  const session = new PluginSession({ engine, post: (m) => hello.push(m), plugin: { id: "com.weavejam.felucca", version: "t", build: "t" } });
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
  const prod = (o) => embedderAllowed(o, CHANNELS.production), prev = (o) => embedderAllowed(o, CHANNELS.preview);
  const never = ["https://pr-12.tuttidaw.com", "http://tuttidaw.com", "https://tuttidaw.com.evil.io", "https://eviltuttidaw.com",
                 "https://a.b.tuttidaw.com", "https://www.tuttidaw.com:8443", "https://TUTTIDAW.com", "https://localhost:3000",
                 "http://127.0.0.1:5173", "http://localhost.evil.io", "http://localhost:5173/", "null", "", undefined];
  check("embedders, production: exactly https://tuttidaw.com and https://www.tuttidaw.com (the default)",
        ["https://tuttidaw.com", "https://www.tuttidaw.com"].every(prod) && !["http://localhost:5173", "http://localhost", ...never].some(prod) &&
        embedderAllowed("https://www.tuttidaw.com") && !embedderAllowed("http://localhost:5173"));
  check("embedders, preview: those and http://localhost:<any port>; not others",
        ["https://tuttidaw.com", "https://www.tuttidaw.com", "http://localhost:5173", "http://localhost"].every(prev) && !never.some(prev));
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
        i1.type === "init:ok" && i1.plugin.id === "com.weavejam.felucca" && i1.stateRevision === 1 && i1.sessionId === first);
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
  check(`render:ok is {type, id, renderId, frames: ${want}, outputs, build} after the last chunk`,
        Object.keys(a.ok).sort().join() === "build,frames,id,outputs,renderId,sessionId,type" && a.ok.frames === want &&
        a.ok.outputs.join() === ALL.join() && a.ok.build === "t" && a.ok.renderId === "w1" &&
        h.got.indexOf(a.ok) === -1);
  check("render via the session twice: the same bytes", a.chunks.length === b.chunks.length &&
        a.chunks.every((c, i) => c.output === b.chunks[i].output && same(c.channels[0], b.chunks[i].channels[0]) && same(c.channels[1], b.chunks[i].channels[1])));
  const pw = h.got.filter((m) => m.type === "render-progress" && m.renderId === "w2");
  check(`progress: render-progress messages, fraction 0..1, the last 1 (${pw.length} for w2)`, h.got.some((m) => m.type === "render-progress" && m.fraction >= 0 && m.fraction <= 1) &&
        pw.length > 0 && pw.at(-1).fraction === 1 && pw.every((m, i) => !i || m.fraction >= pw[i - 1].fraction));
  h.close();
}

// ---- sessions apart: what a request of an ended session sends goes nowhere, not into the next session
{
  const ctl = { initDelay: 0, renders: [] };
  const engine = {
    init: async () => { await sleep(ctl.initDelay); return { stateRevision: 1 }; },
    context() {}, transport() {}, close() {},
    getState: async () => { await sleep(ctl.initDelay); return { state: new ArrayBuffer(4), stateVersion: 1, stateRevision: 1 }; },
    render: (r, sink) => new Promise((res, rej) => ctl.renders.push({ r, sink, res, rej })),
  };
  const session = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  const conn = (sid) => {
    const ch = new MessageChannel(), got = [];
    ch.port1.onmessage = (e) => got.push(e.data);
    const ok = session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: sid, generation: 1, host: {} },
                                         origin: HOST, isParent: true, ports: [ch.port2] });
    return { ok, got, send: (m) => ch.port1.postMessage({ sessionId: sid, ...m }), close: () => ch.port1.close() };
  };
  // a late init of session A: B stays uninited (its requests: bad-request), nothing of A's in B
  ctl.initDelay = 200;
  const a = conn("A");
  a.send({ type: "init", id: "ia", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(30);
  a.send({ type: "close" });
  await sleep(30);
  ctl.initDelay = 0;
  const b = conn("B");
  await sleep(300);
  b.send({ type: "get-state", id: "gb" });
  await sleep(50);
  const gb = b.got.find((m) => m.id === "gb");
  check("a late init of an ended session: the new session not inited (bad-request), no init:ok anywhere",
        b.ok === 1 && session.inited === false && session.state === "initializing" && gb && gb.code === "bad-request" &&
        !a.got.concat(b.got).some((m) => m.type === "init:ok"));
  b.send({ type: "init", id: "ib", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  // a render of session B left running when B ends; C's render meanwhile; B's results go nowhere
  b.send({ type: "render", id: "rb", ...req({ renderId: "rb" }) });
  await sleep(50);
  ctl.initDelay = 150;
  b.send({ type: "get-state", id: "gs" });
  await sleep(20);
  b.send({ type: "close" });
  await sleep(30);
  ctl.initDelay = 0;
  const c = conn("C");
  c.send({ type: "init", id: "ic", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  c.send({ type: "render", id: "rc", ...req({ renderId: "rc" }) });
  await sleep(50);
  const old = ctl.renders[0];
  let cancelled = false;
  try { await old.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]); } catch (e) { cancelled = e.code === "cancelled"; }
  old.sink.progress(0.5);
  old.res({ frames: 4, outputs: ["mix"] });
  await sleep(200);
  const cur = ctl.renders[1];
  await cur.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]);
  cur.res({ frames: 4, outputs: ["mix"] });
  await sleep(50);
  const ofB = c.got.filter((m) => m.renderId === "rb" || m.id === "rb" || m.id === "gs");
  const okC = c.got.find((m) => m.id === "rc");
  check("a render of an ended session: its sink cancelled, nothing of it (or its get-state) in the next session",
        cancelled && ofB.length === 0 && c.got.every((m) => m.sessionId === "C") && !b.got.some((m) => m.id === "gs" || m.id === "rb"));
  check("the next session's render runs alongside (not busy), its render:ok has its build",
        ctl.renders.length === 2 && okC && okC.type === "render:ok" && okC.build === "b1" && okC.frames === 4 && session.render === null);
  a.close(); b.close(); c.close();
  session.close();
  // after the page went standalone (4 s without a connect): connects refused
  const s2 = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  s2.stopAccepting();
  const ch = new MessageChannel();
  check("a connect after going standalone: refused", s2.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL,
        sessionId: "late", generation: 1, host: {} }, origin: HOST, isParent: true, ports: [ch.port2] }) === 0 && s2.port === null);
  ch.port1.close();
}

// ---- the site (site.mjs): per channel, the embedders in build-info.js and _headers alike, the manifest, the CSP
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const site = (channel, env = {}) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `felucca-site-${channel}-`));
    const r = spawnSync(process.execPath, [path.join(ROOT, "web/plugin/site.mjs"), path.resolve(wasmPath), out, "1.0"],
                        { cwd: ROOT, env: { ...process.env, PLUGIN_ALLOW_DIRTY: "", ...env, PLUGIN_CHANNEL: channel }, encoding: "utf8" });
    return { out, ...r };
  };
  const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim() !== "";
  const checkSite = async (channel, s) => {
    const rd = (f) => fs.readFileSync(path.join(s.out, f), "utf8");
    const headers = rd("_headers"), m = JSON.parse(rd("tutti-plugin.json"));
    const info = await import(pathToFileURL(path.join(s.out, "plugin/build-info.js")).href);
    const anc = [...headers.matchAll(/frame-ancestors ([^;\n]*)/g)].map((x) => x[1]);
    const page = rd("plugin/index.html"), inline = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];
    const hash = (await import("crypto")).createHash("sha256").update(inline, "utf8").digest("base64");
    const csp = /\/plugin\/\*\n  Content-Security-Policy: ([^\n]*)/.exec(headers)[1];
    check(`site ${channel}: build-info EMBEDDERS and every frame-ancestors = ${CHANNELS[channel].join(" ")}`,
          JSON.stringify(info.EMBEDDERS) === JSON.stringify(CHANNELS[channel]) && anc.length === 2 &&
          anc.every((a) => a === CHANNELS[channel].join(" ")) && info.BUILD.channel === channel);
    check(`site ${channel}: manifest seek false, midiChannels 0..3 = T1..T4, source the pinned commit`,
          m.capabilities.seek === false && JSON.stringify(m.capabilities.midiChannels) === JSON.stringify([0, 1, 2, 3].map((c) => ({ channel: c, name: `T${c + 1}` }))) &&
          /^https:\/\/github\.com\/weavejam\/Felucca\/tree\/[0-9a-f]{40}$/.test(m.source) && m.source === info.BUILD.source);
    check(`site ${channel}: the plugin page's CSP (default-src 'none', the inline module's hash, wasm, worker, no frames, no forms)`,
          csp.startsWith(`default-src 'none'; script-src 'self' 'sha256-${hash}' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; `) &&
          ["style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:", "frame-src 'none'", "form-action 'none'"].every((d) => csp.includes(d)));
    fs.rmSync(s.out, { recursive: true, force: true });
  };
  const pv = site("preview", { PLUGIN_ALLOW_DIRTY: "1" });
  check(`site preview: built (${dirty ? "a dirty tree, allowed for a preview: marked" : "a clean tree"})`, pv.status === 0 &&
        (!dirty || fs.readFileSync(path.join(pv.out, "tutti-plugin.json"), "utf8").includes(".dirty")));
  await checkSite("preview", pv);
  const pr = site("production");
  if (dirty) {
    const forced = site("production", { PLUGIN_ALLOW_DIRTY: "1" });
    check("site production on a dirty tree: refused (also with PLUGIN_ALLOW_DIRTY=1)", pr.status === 1 && /changes not in/.test(pr.stderr) && forced.status === 1);
    console.log("plugin:   (the production site's checks need a clean tree: commit, then run again)");
    for (const x of [pr, forced]) fs.rmSync(x.out, { recursive: true, force: true });
  } else {
    check("site production: built", pr.status === 0);
    await checkSite("production", pr);
  }
  const bad = site("staging", { PLUGIN_ALLOW_DIRTY: "1" });
  check("site: an unknown PLUGIN_CHANNEL refused", bad.status === 1 && /PLUGIN_CHANNEL/.test(bad.stderr));
  fs.rmSync(bad.out, { recursive: true, force: true });
}

// ---- edit mode: the live device, edits -> revisions, state-changed debounced, get-state, the round trip
{
  const live = new NodeLive(), h = harness({ live });
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  const i = await h.reply("i");
  check("edit mode: init:ok, the live device loaded", i.type === "init:ok" && live.loads === 1);
  h.send({ type: "context", context: ctxOf(97.5) });
  h.send({ type: "context", context: { timeMap: { tempoPoints: [] } } });
  h.send({ type: "get-state", id: "g0" });
  await h.reply("g0");
  check(`context after init: to the live preview, its tempo ${live.tempos.join(" -> ")}; a malformed one changes nothing`,
        live.tempos.join() === "120,97.5" && live.tempo.bpm === 97.5 &&
        !h.got.some((m) => m.type === "error"));
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

// ---- the engine across sessions: a snapshot asked for in a session that ended comes late
{
  const snaps = [], renders = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new FeluccaEngine({ render: (sectors) => { renders.push(sectors); return { frames: 1, outputs: ["mix"] }; }, live });
  const A = { 0xE5000: new Uint8Array(4096).fill(1) }, B = { 0xE5000: new Uint8Array(4096).fill(2) };
  const C = { 0xE5000: new Uint8Array(4096).fill(3) };
  // a render of the ended session (its sink cancelled meanwhile): never rendered, never into the worker
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  let ended = false;
  const r1 = engine.render(req({ stateRevision: 2 }), { cancelled: () => ended }).then(() => "rendered", (e) => e.code);
  await sleep(0);
  ended = true;
  snaps.shift()(A);
  check(`a render whose session ended while its state was made: ${await r1}, nothing rendered`, (await r1) === "cancelled" && renders.length === 0);
  // a get-state of the ended session: the new session's revision 1 stays its own
  engine.changed();
  const g = engine.getState().then(() => "ok", (e) => e.code);
  await sleep(0);
  const stB = packState(B);
  await engine.init({ context: ctxOf(120), state: stB, stateVersion: STATE_VERSION, mode: "edit" });
  snaps.shift()(C);
  const gs = await g, now = await engine.getState();
  check(`a late snapshot of an ended session: dropped (${gs}), the new session's revision 1 its init state`,
        gs === "session-ended" && now.stateRevision === 1 && stateEquals(now.state, stB) && engine.states.size === 1 && snaps.length === 0);
  // a snapshot kept as the revision it was asked for, a change meanwhile: the next revision
  engine.changed();
  const g2 = engine.getState();
  await sleep(0);
  engine.changed();
  snaps.shift()(C);
  const s2 = await g2;
  check(`a change while a snapshot is made: kept as revision ${s2.stateRevision}, now ${engine.revision}`,
        s2.stateRevision === 2 && engine.revision === 3 && engine.dirty && stateEquals(engine.states.get(2).buf, packState(C)));
}

// ================================================================== review fixes
// ---- a revision is one state: its snapshot made once, whoever asks for it while it is made
{
  const snaps = [], rendered = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new FeluccaEngine({ render: (sectors) => { rendered.push(sectors); return { frames: 1, outputs: ["mix"] }; }, live });
  const A = { 0xE5000: new Uint8Array(4096).fill(4) }, B = { 0xE5000: new Uint8Array(4096).fill(5) };
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  const g1 = engine.getState();
  await sleep(0);
  const g2 = engine.getState();                       // (a second get-state while the first is made)
  const r = engine.render(req({ stateRevision: 2 }), { cancelled: () => false });
  await sleep(0);
  const asked = snaps.length;
  snaps.shift()(A);                                    // the device as it was asked
  while (snaps.length) snaps.shift()(B);               // (an edit meanwhile, its change not in yet: another state)
  const [s1, s2] = await Promise.all([g1, g2]);
  await r;
  check(`one snapshot per revision: ${asked} for get-state, get-state, render of revision 2; one state, the same bytes`,
        asked === 1 && s1.stateRevision === 2 && s2.stateRevision === 2 && stateEquals(s1.state, s2.state) &&
        stateEquals(s1.state, packState(A)) && rendered.length === 1 && rendered[0] === engine.states.get(2).sectors);
  // a render of the revision whose snapshot is on its way, a change since: that snapshot, not an unknown revision
  engine.changed();
  const g3 = engine.getState();
  await sleep(0);
  engine.changed();
  const r3 = engine.render(req({ stateRevision: 3 }), { cancelled: () => false }).then(() => "rendered", (e) => e.code);
  await sleep(0);
  const asked3 = snaps.length;
  while (snaps.length) snaps.shift()(B);
  const s3 = await g3;
  check(`a render of a revision still being made (now ${engine.revision}): ${await r3}, its one snapshot`,
        asked3 === 1 && (await r3) === "rendered" && s3.stateRevision === 3 && rendered.at(-1) === engine.states.get(3).sectors);
}

// ---- use B: the sustain pedal down over toBeat (its pedal-up past it) lets go at toBeat: nothing held into the tail
{
  const n = (beat, lengthBeats) => ({ beat, lengthBeats, pitch: 60, velocity: 100, channel: 0 });
  const ped = (beat, value) => ({ beat, channel: 0, cc: 64, value });
  const inp = (cc) => ({ notes: [n(1, 10)], cc, pitchBend: [], preRollBeats: 0 });
  const end = Math.round(4 * 0.5 * 44100);
  const k = midiEvents(inp([ped(0.5, 127), ped(6, 0)]), 120, 4).map((e) => `${e.status.toString(16)}:${e.d1}:${e.d2}@${e.frame}`);
  check(`sustain: the pedal up at toBeat, before the note's off there (${k.slice(-2).join(" ")})`,
        k.slice(-2).join() === [`b0:64:0@${end}`, `80:60:0@${end}`].join());
  const one = async (cc) => (await renderAll({}, req({ input: inp(cc), toBeat: 4, tailMs: 3000, outputs: ["t1"] }))).out.t1[0];
  const free = await one([]), held = await one([ped(0.5, 127), ped(6, 0)]);
  const tail = (x) => rms(x.subarray(end + 44100));
  check(`sustain: the tail past toBeat as without the pedal (rms ${tail(held).toExponential(2)}, no pedal ${tail(free).toExponential(2)})`,
        rms(free.subarray(end - 22050, end)) > 1e-3 && tail(held) <= tail(free) * 1.05 + 1e-6);
}

// ---- use B: a part with ARP and HOLD saved: the host's notes last as long as the host says (a runtime override), so
// after a note's end (and every note at toBeat) only the releases and the FX tails ring, no new arp note starts
{
  const AM_UP = 1;                                     // (seq.c)
  const arpState = (hold, dry) => makeState((ex) => {
    for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
    ex.tutti_test_arp(0, AM_UP, hold, dry);
    for (let k = 0; k < 100 * 44.1; k += 128) ex.web_render(128);
  });
  const latched = await arpState(1, 0), unlatched = await arpState(0, 0), dry = await arpState(1, 1);
  const chord = (beat, len) => [60, 64, 67].map((pitch) => ({ beat, lengthBeats: len, pitch, velocity: 100, channel: 0 }));
  const one = async (state, notes) => (await renderAll(state, req({ input: { notes, cc: [], pitchBend: [], preRollBeats: 0 },
                                                                     toBeat: 4, tailMs: 4000, outputs: ["t1"] }))).out.t1;
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  // a note starts where a 10 ms window is louder than the one before by over 6 dB (a release only falls)
  const onsets = ([l, r], from) => {
    const w = 441, e = [], out = [];
    for (let i = from; i + w <= l.length; i += w) e.push(Math.max(rms(l.subarray(i, i + w)), rms(r.subarray(i, i + w))));
    for (let i = 1; i < e.length; i++) if (e[i] > 1e-4 && e[i] > 2 * e[i - 1]) out.push(from + i * w);
    return out;
  };
  const settle = 44100 / 2;                            // (the release)
  for (const [what, notes, end] of [["a chord ending before toBeat", chord(0.5, 1), 1.5], ["a chord held past toBeat", chord(0.5, 10), 4]]) {
    const h = await one(latched, notes), u = await one(unlatched, notes), d = await one(dry, notes);
    const pre = onsets(d, 0).filter((f) => f < at(Math.min(end, 1.5))).length, post = onsets(d, at(end) + settle);
    check(`ARP HOLD saved, use B, ${what}: the arp plays while it is held (${pre} notes by beat 1.5)`, pre >= 3);
    check(`ARP HOLD, ${what}: as the same part without HOLD, sample for sample (the FX tails too)`, same(h[0], u[0]) && same(h[1], u[1]));
    check(`ARP HOLD, ${what} (dry): no note starts ${end === 4 ? "after toBeat" : "after its end"} + 0.5 s (${post.length}), the tail dies (${db(rms(d[0].subarray(at(end) + 3 * 44100)) + 1e-12)} dB)`,
          post.length === 0 && rms(d[0].subarray(at(end) + 3 * 44100)) < 1e-4);
  }
  // the override is the render's only: the state still says HOLD, and the device itself (MIDI in, live) still latches
  const { exports: ex } = await WebAssembly.instantiate(mod, {});
  ex._initialize(); ex.web_nor_erase();
  const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size());
  for (const [o, v] of Object.entries(dry)) nor.set(v, +o);
  ex.tutti_boot(0);
  for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
  const hold = ex.tutti_test_arp(0, 0, 0, 0);
  ex.web_midi(0x90, 60, 100);
  for (let k = 0; k < 300 * 44.1; k += 128) ex.web_render(128);
  ex.web_midi(0x80, 60, 0);
  const L = new Float32Array(3 * 44100);
  for (let k = 0; k + 128 <= L.length; k += 128) { ex.web_render(128); L.set(new Float32Array(ex.memory.buffer, ex.web_out_l(), 128), k); }
  const still = onsets([L, L], 44100).length;
  check(`ARP HOLD stays saved (${hold}); off a render it latches as on the FM-1 (${still} notes 1 .. 3 s after the key)`, hold === 1 && still > 0);
}

// ---- hosted playback: the internal clock whatever CLK says (a runtime override), the saved CLK the user's
{
  const G_CLOCK = 2;                                   // (core.h)
  const boot = async (sectors) => {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize(); ex.web_nor_erase();
    const nor = new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size());
    for (const [o, v] of Object.entries(sectors)) nor.set(v, +o);
    ex.tutti_boot(0);
    return ex;
  };
  const clk = (ex) => new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 64)[G_CLOCK];
  const ext = await makeState((ex) => {                // a song saved with CLK USB
    for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
    ex.web_test_heavy();
    new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 64)[G_CLOCK] = 1;
    for (let k = 0; k < 100 * 44.1; k += 128) ex.web_render(128);
  });
  const ex = await boot(ext);
  const can = typeof ex.tutti_clock_internal === "function";
  if (can) ex.tutti_clock_internal(1);                 // (worklet-tutti.js: tutti-hosted)
  ex.tutti_tempo(120);
  for (let k = 0; k < 1000 * 44.1; k += 128) ex.web_render(128);
  ex.tutti_seek(1, 0);
  ex.tutti_seek_run(1024, 0);
  const steps = () => [0, 1, 2, 3].map((t) => ex.tutti_seq_idx(t)).join();
  for (let k = 0; k < 250 * 44.1; k += 128) ex.web_render(128);
  const steps0 = steps();
  for (let k = 0; k < 500 * 44.1; k += 128) ex.web_render(128);
  const steps1 = steps();                              // (a quarter at 120 BPM later: 4 steps on)
  ex.tutti_snapshot();
  const reloaded = clk(await boot(storeSectors(new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size()))));
  check(`hosted preview of a song saved with CLK USB: the internal clock plays it (steps ${steps0} -> ${steps1})`, can && steps0 !== steps1);
  check(`hosted preview: CLK stays the user's (${clk(ex)}), in the state it saves too (${reloaded})`, clk(ex) === 1 && reloaded === 1);
  const a = (await renderAll(ext, req({ toBeat: 8 }))).out.mix[0];
  check(`a render of a CLK USB song: the internal clock at the host's tempo (peak ${peak(a).toFixed(3)})`, peak(a) > 0.05);
}

// ---- use B: a negative length (protocol 7b: <= 0) is a zero-length note: its on, then its off a block after
{
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  let k;
  try {
    k = midiEvents({ notes: [{ beat: 1, lengthBeats: -0.75, pitch: 60, velocity: 100, channel: 0 }], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8)
      .map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`).join(" ");
  } catch (err) { k = `${err.code}`; }
  check(`a note of length -0.75: accepted, its on then its off (${k})`, k === `on@${at(1)} off@${at(1) + 32}`);
}

// ---- the range's limits: frames the device can count, the pre-roll from beat 0, the credits a render holds
{
  const code = (o) => { try { planRender(req(o)); return "ok"; } catch (err) { return err.code; } };
  const far = code({ fromBeat: 1e12, toBeat: 1e12 + 4 });
  const pre = code({ fromBeat: 1300, toBeat: 1304 });  // 650 s of pre-roll at 120 BPM
  const near = code({ fromBeat: 1218, toBeat: 1222 }); // 609 s
  check(`frames past 2^32 from beat 0: ${far}; a pre-roll over 610 s: ${pre}; 609 s: ${near}`,
        far === "bad-request" && pre === "too-large" && near === "ok");
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "pr", ...req({ renderId: "pr", fromBeat: 1300, toBeat: 1304 }) });
  const pr = await h.reply("pr");
  h.send({ type: "render", id: "cr", ...req({ renderId: "cr", toBeat: 800, outputs: ALL }) });
  await sleep(200);
  for (let i = 0; i < 3; i++) h.send({ type: "render-credit", renderId: "cr", chunks: 1e6 });
  await sleep(100);
  const credits = h.session.render ? h.session.render.credits : NaN;
  h.send({ type: "cancel", renderId: "cr" });
  const cr = await h.reply("cr");
  check(`a render with 650 s of pre-roll: ${pr.code}; credits granted 3 x 1e6: ${credits} held (at most 600 s x 8 outputs)`,
        pr.code === "too-large" && credits > 0 && credits <= 4800 && cr.code === "cancelled");
  h.close();
}

// ---- the port's messageerror ends the session: its render cancelled, the port let go, a new connect accepted
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "me", ...req({ renderId: "me", toBeat: 400 }) });
  await sleep(300);
  const port = h.session.port, r = h.session.render;
  const has = typeof port.onmessageerror === "function";
  if (has) port.onmessageerror(new Event("messageerror"));
  await sleep(100);
  check("port messageerror: the session closed, its render cancelled, the port's handlers off, a new connect accepted",
        has && h.session.state === "closed" && !!r && r.cancel === true && h.session.render === null && h.session.port === null &&
        !port.onmessage && !port.onmessageerror && h.connect({ generation: 2 }) === 1);
  h.close();
}

console.log(fails ? `plugin: ${fails} FAILED` : "plugin: all ok");
process.exit(fails ? 1 : 0);
