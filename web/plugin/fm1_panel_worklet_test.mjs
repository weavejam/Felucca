// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// web/emu/worklet.js's presses against a fake device: the page's queued (each held HOLD_MS), a hardware FM-1's
// (`direct`, fm1-panel.js) at once, the two OR-ed. node web/plugin/fm1_panel_worklet_test.mjs
import assert from "node:assert/strict";

globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
globalThis.registerProcessor = () => {};
globalThis.currentTime = 0;
const { HOLD_MS } = await import("../emu/worklet.js");
const w = new globalThis.FeluccaProcessor();

let now = 0;
const applied = [];
w.ex = {
  web_now_ms: () => now,
  web_buttons: (m) => applied.push(["buttons", m]),
  web_keys: (m) => applied.push(["keys", m]),
};

// the page's presses: queued, each held HOLD_MS of device time
w.onMessage({ type: "keys", mask: 1 });
w.onMessage({ type: "keys", mask: 0 });
assert.deepEqual(applied, []);
w.input();
assert.deepEqual(applied, [["keys", 1]]);

// the hardware's: at once, OR-ed with what the page holds (not behind the page's queue)
w.onMessage({ type: "keys", mask: 1 << 5, direct: true });
assert.deepEqual(applied.at(-1), ["keys", 1 | (1 << 5)]);
w.onMessage({ type: "keys", mask: (1 << 5) | (1 << 7), direct: true });
assert.deepEqual(applied.at(-1), ["keys", 1 | (1 << 5) | (1 << 7)]);

// the page's queued lift arrives HOLD_MS later and keeps the hardware's keys down
now = HOLD_MS - 1;
w.input();
assert.equal(applied.length, 3);
now = HOLD_MS;
w.input();
assert.deepEqual(applied.at(-1), ["keys", (1 << 5) | (1 << 7)]);

// the hardware lets go: only what the page holds (nothing) is left; buttons alike
w.onMessage({ type: "keys", mask: 0, direct: true });
assert.deepEqual(applied.at(-1), ["keys", 0]);
w.onMessage({ type: "buttons", mask: 1 << 1, direct: true });
assert.deepEqual(applied.at(-1), ["buttons", 1 << 1]);
console.log("fm1_panel_worklet_test: ok");
