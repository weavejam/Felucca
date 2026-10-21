// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page's live FM-1: the emulator's worklet (web/emu/worklet.js, its Felucca processor) on the plugin's build
// (felucca_plugin.c) with what the host needs from it:
//   load            as the emulator's, booted by tutti_boot (the state's music, RESTORE LAST or not); again for a
//                   new state (the module kept)
//   tutti-tempo     {bpm}: the host's tempo (fractional)
//   tutti-play      {gen, playing, atFrame, pos}: the host's transport, listen-only: play from `pos` (frames of
//                   44.1 kHz from beat 0) at this context's frame `atFrame`; the same generation again: only a drift
//                   of over 20 ms moves it (re-seek); not playing: stop
//   tutti-snapshot  {id}: the music written as the autosave, the storage sectors back {type: tutti-snapshot, id, sectors}
// and out: {type: tutti-sig, sig} when the music (project.c autosave_sig) changed.
import { storeSectors, restoreSectors } from "../emu/worklet.js";

const Base = globalThis.FeluccaProcessor;
const DRIFT = 0.02;                                    // s

class FeluccaTutti extends Base {
  constructor() {
    super();
    this.module = null;
    this.bpm = 0;
    this.play = null;                                  // a start to come: {gen, atFrame, pos}
    this.at = null;                                    // playing: {gen, frame, pos} (pos at that frame)
    this.sentSig = null;
  }

  async onMessage(m) {
    if (m.type === "load") return this.load(m);
    if (m.type === "tutti-tempo") {
      this.bpm = m.bpm;
      if (this.ex) this.ex.tutti_tempo(m.bpm);
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
      if (this.bpm) ex.tutti_tempo(this.bpm);
      this.ex = ex;
      this.sentWrites = ex.web_flash_writes_count();
      this.sentDraws = -1;
      this.sentLeds = "";
      this.queue = [];
      this.play = this.at = null;
      this.sentSig = null;
      this.port.postMessage({ type: "ready", rate: ex.web_sample_rate() });
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  }

  schedule(m) {
    if (!m.playing) {
      this.play = null;
      if (this.at) this.ex.tutti_seek(0, 0);
      this.at = null;
      return;
    }
    if (this.at && this.at.gen === m.gen) {            // still the same run: only a drift moves it
      const ours = this.at.pos + (m.atFrame - this.at.frame);
      if (Math.abs(ours - m.pos) <= DRIFT * sampleRate) return;
    }
    this.play = { gen: m.gen, atFrame: m.atFrame, pos: m.pos };
  }

  process(inputs, outputs) {
    const p = this.play;
    if (this.ex && p && currentFrame + 128 > p.atFrame) {   // (the quantum it starts in)
      this.play = null;
      const pos = Math.max(0, Math.round(p.pos + (currentFrame - p.atFrame)));
      this.ex.tutti_seek(1, pos);
      this.at = { gen: p.gen, frame: currentFrame, pos };
    }
    return super.process(inputs, outputs);
  }

  publish() {
    super.publish();
    const sig = this.ex.tutti_sig() >>> 0;
    if (sig !== this.sentSig) {
      this.sentSig = sig;
      this.port.postMessage({ type: "tutti-sig", sig });
    }
  }
}
registerProcessor("felucca-tutti", FeluccaTutti);
