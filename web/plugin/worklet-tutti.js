// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page's live Felucca: the emulator's worklet (web/emu/worklet.js, its Felucca processor) on the plugin's build
// (felucca_plugin.c) with what the host needs from it:
//   load            as the emulator's, booted by tutti_boot (the state's music, RESTORE LAST or not); again for a
//                   new state (the module kept)
//   tutti-tempo     {bpm}: the host's tempo (fractional)
//   tutti-play      {gen, playing, atFrame, pos}: the host's transport, listen-only: play from `pos` (frames of
//                   44.1 kHz from beat 0) at this context's frame `atFrame`; the same generation again: only a drift
//                   of over 20 ms moves it (re-seek); not playing: stop. A seek runs the sequencer up to `pos` at most
//                   SEEK_BLOCKS blocks per render quantum (felucca_plugin.c tutti_seek_run), silent until it is there
//   tutti-snapshot  {id}: the music written as the autosave, the storage sectors back {type: tutti-snapshot, id, sectors}
//   tutti-hosted    the page is tuttidaw's (not the emulator on its own): the internal clock at the host's tempo from
//                   now on, this device and those loaded after it, whatever CLK says (felucca_plugin.c
//                   tutti_clock_internal: a runtime override, the saved setting stays the user's)
// and out: {type: tutti-sig, sig} when the music (project.c autosave_sig) changed; {type: tutti-view, view} with every
// frame published, the parts as the page's Parts panel shows them (felucca_plugin.c tutti_view, VIEW_BYTES).
import { storeSectors, restoreSectors } from "../emu/worklet.js";

const Base = globalThis.FeluccaProcessor;
const DRIFT = 0.02;                                    // s
const SEEK_BLOCKS = 1024;                               // a seek's blocks per render quantum (plugin_test.mjs times them)
const VIEW_BYTES = 4 * 64 + 8;                         // felucca_plugin.c tt_view (layout.js PARTS_VIEW reads it)

class FeluccaTutti extends Base {
  constructor() {
    super();
    this.module = null;
    this.bpm = 0;
    this.play = null;                                  // a start to come: {gen, atFrame, pos}
    this.at = null;                                    // playing: {gen, frame, pos} (pos at that frame)
    this.seeking = null;                               // a seek on its way: {gen, frame, pos} (pos at that frame)
    this.sentSig = null;
    this.hosted = false;
  }

  async onMessage(m) {
    if (m.type === "load") return this.load(m);
    if (m.type === "tutti-tempo") {
      this.bpm = m.bpm;
      if (this.ex) this.ex.tutti_tempo(m.bpm);         // (out of Felucca's range: refused, the tempo stays)
      return;
    }
    if (m.type === "tutti-hosted") {
      this.hosted = true;
      if (this.ex) this.ex.tutti_clock_internal(1);
      return;
    }
    const ex = this.ex;
    if (!ex) return;
    if (m.type === "tutti-play") return this.schedule(m);
    if (m.type === "tutti-snapshot") {
      const ok = ex.tutti_snapshot();
      const sectors = storeSectors(new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size()));
      this.sentWrites = ex.web_flash_writes_count();   // (they go with this reply, not with a frame)
      this.sentSig = ex.tutti_sig() >>> 0;
      this.port.postMessage({ type: "tutti-snapshot", id: m.id, ok: !!ok, sectors, sig: this.sentSig });
      return;
    }
    return super.onMessage(m);
  }

  async load(m) {
    try {
      if (m.wasm) this.module = await WebAssembly.compile(m.wasm);
      const { exports: ex } = await WebAssembly.instantiate(this.module, {});
      ex._initialize();
      ex.web_nor_erase();
      restoreSectors(new Uint8Array(ex.memory.buffer, ex.web_nor(), ex.web_nor_size()), m.sectors);
      ex.web_master(m.master ?? 700);
      ex.tutti_boot(0);
      if (this.hosted) ex.tutti_clock_internal(1);
      if (this.bpm) ex.tutti_tempo(this.bpm);
      this.ex = ex;
      this.sentWrites = ex.web_flash_writes_count();
      this.sentDraws = -1;
      this.sentLeds = "";
      this.queue = [];
      this.play = this.at = this.seeking = null;
      this.sentSig = null;
      this.port.postMessage({ type: "ready", rate: ex.web_sample_rate() });
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  }

  schedule(m) {
    if (!m.playing) {
      this.play = null;
      if (this.at || this.seeking) this.ex.tutti_seek(0, 0);
      this.at = this.seeking = null;
      return;
    }
    const run = this.at || this.seeking;
    if (run && run.gen === m.gen) {                    // still the same run: only a drift moves it
      const ours = run.pos + (m.atFrame - run.frame);
      if (Math.abs(ours - m.pos) <= DRIFT * sampleRate) return;
    }
    this.play = { gen: m.gen, atFrame: m.atFrame, pos: m.pos };
  }

  process(inputs, outputs) {
    const p = this.play, ex = this.ex;
    let left = 0;                                      // a seek's blocks still to run
    if (ex && p && currentFrame + 128 > p.atFrame) {    // (the quantum it starts in)
      this.play = this.at = null;
      const pos = Math.max(0, Math.round(p.pos + (currentFrame - p.atFrame)));
      ex.tutti_seek(1, pos);
      this.seeking = { gen: p.gen, frame: currentFrame, pos };
      left = ex.tutti_seek_run(SEEK_BLOCKS, 0);
    } else if (ex && this.seeking)                     // on with it, the last (silent) quantum's time added
      left = ex.tutti_seek_run(SEEK_BLOCKS, outputs[0][0].length / ex.tutti_block_frames());
    if (this.seeking) {
      if (left) return true;                           // not there yet: silence (the outputs are zeros), the UI waits
      const s = this.seeking;
      this.seeking = null;
      this.at = { gen: s.gen, frame: currentFrame, pos: s.pos + (currentFrame - s.frame) };
    }
    return super.process(inputs, outputs);
  }

  publish() {
    super.publish();
    const view = new Uint8Array(this.ex.memory.buffer, this.ex.tutti_view(), VIEW_BYTES).slice();
    this.port.postMessage({ type: "tutti-view", view }, [view.buffer]);
    const sig = this.ex.tutti_sig() >>> 0;
    if (sig !== this.sentSig) {
      this.sentSig = sig;
      this.port.postMessage({ type: "tutti-sig", sig });
    }
  }
}
registerProcessor("felucca-tutti", FeluccaTutti);
