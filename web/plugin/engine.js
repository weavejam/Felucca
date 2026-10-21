// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The FM-1 behind a session (protocol.js engine): the state and its revisions, renders of a revision's state, the
// live device of the page (edit mode) when there is one.
//   render(sectors, request, sink) -> result      renderer.js render, here or in a Worker (render-worker.js)
//   live (edit mode, the page; null headless): {
//     load(sectors, context) -> Promise          (re)start the live device with this state
//     snapshot() -> Promise<sectors>             its state now (felucca_plugin.c tutti_snapshot)
//     context(context), transport(transport)     the host's tempo, its transport (preview, listen-only)
//     close()
//   } and it calls engine.changed() when its music or flash changed (the page's check, tutti.js)
// A revision is a state the host may ask a render of: 1 the one init gave (or the factory state), +1 when the live
// device changed since the last revision; its bytes are made when the host asks for them (get-state) or renders it.
import { packState, unpackState, STATE_VERSION, StateError } from "./state.js";
import { RenderError } from "./renderer.js";

const KEEP = 8;                                        // revisions whose states are kept for renders

export class FM1Engine {
  constructor({ render, live = null, onChanged = () => {}, name = () => null }) {
    this.renderFn = render;
    this.live = live;
    this.onChanged = onChanged;                        // (revision): the session's state-changed
    this.name = name;
    this.revision = 0;
    this.states = new Map();                           // revision -> { buf, sectors }
    this.dirty = false;                                // the live device changed since `revision` was made
  }

  async init({ context, state, stateVersion, mode }) {
    const sectors = state ? unpackState(state, stateVersion) : {};
    this.mode = mode;
    this.context = context;
    this.revision = 1;
    this.states.clear();
    this.keep(1, { buf: state ? state.slice(0) : packState(sectors), sectors });   // (the input is never changed)
    if (mode === "edit" && this.live) await this.live.load(sectors, context);
    return { stateRevision: this.revision };
  }

  keep(rev, s) {
    this.states.set(rev, s);
    for (const k of [...this.states.keys()]) if (k <= rev - KEEP) this.states.delete(k);
  }

  // the live device changed (its music, a saved preset, a setting): a new revision from now
  changed() {
    if (!this.revision) return;
    if (!this.dirty) {
      this.dirty = true;
      this.revision++;
    }
    this.onChanged(this.revision);
  }

  // the state of the current revision, made now if it is not yet
  async current() {
    const have = this.states.get(this.revision);
    if (have && !this.dirty) return have;
    if (!this.live || this.mode !== "edit") return have;
    this.dirty = false;                                // (a change from here on: the next revision)
    const sectors = await this.live.snapshot();
    const s = { buf: packState(sectors), sectors };
    this.keep(this.revision, s);
    return s;
  }

  async getState() {
    const s = await this.current();
    const name = this.name();
    return { state: s.buf.slice(0), stateVersion: STATE_VERSION, stateRevision: this.revision,
             ...(name ? { summary: { name } } : {}) };
  }

  context(ctx) {
    this.context = ctx;
    if (this.live) this.live.context(ctx);
  }
  transport(t) { if (this.live) this.live.transport(t); }

  async render(req, sink) {
    let s = this.states.get(req.stateRevision);
    if (req.stateRevision === this.revision) s = await this.current();
    if (!s) throw new RenderError("state-incompatible", `state revision ${req.stateRevision} is not known (now ${this.revision})`);
    return this.renderFn(s.sectors, req, sink);
  }

  close() { if (this.live) this.live.close(); }
}

export { StateError };
