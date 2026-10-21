// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin's state (tutti-plugin/0 `state`, opaque to the host): the flash's storage sectors, as the browser emulator
// keeps them (web/emu/worklet.js STORE_AREAS: projects, user presets and their FM6 patches, the user sample slots, the
// autosave that holds the music (written just before, felucca_plugin.c tutti_snapshot), FM6's voice bank, the
// settings), only those that hold something. Version 1, little-endian:
//   "FM1T"  u32 version (1)  u32 count  then count x { u32 offset, 4096 bytes }   (offsets ascending)
// At most 72 + 3 + 4 sectors (~ 320 KiB), far under the host's 8 MiB.
import { STORE_AREAS } from "../emu/worklet.js";

export const STATE_VERSION = 1;
export const STATE_READS = [1, 1];
const MAGIC = 0x5431_4d46;                             // "FM1T"
const SECTOR = 4096;

export class StateError extends Error {
  constructor(message) { super(message); this.name = "StateError"; this.code = "state-incompatible"; }
}

export function packState(sectors) {
  const offs = Object.keys(sectors).map(Number).sort((a, b) => a - b);
  const buf = new ArrayBuffer(12 + offs.length * (4 + SECTOR)), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, STATE_VERSION, true);
  dv.setUint32(8, offs.length, true);
  offs.forEach((off, i) => {
    const p = 12 + i * (4 + SECTOR);
    dv.setUint32(p, off, true);
    u8.set(sectors[off], p + 4);
  });
  return buf;
}

// -> {offset: Uint8Array(4096)} (copies: the input is never changed); StateError when it is not one
export function unpackState(buf, version = STATE_VERSION) {
  if (version < STATE_READS[0] || version > STATE_READS[1]) throw new StateError(`state version ${version} not read by this plugin`);
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) throw new StateError("not an FM-1 state");
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new StateError("not an FM-1 state");
  if (dv.getUint32(4, true) !== version) throw new StateError("state version differs from its header");
  const n = dv.getUint32(8, true);
  if (buf.byteLength !== 12 + n * (4 + SECTOR)) throw new StateError("state truncated or padded");
  const out = {};
  let last = -1;
  for (let i = 0; i < n; i++) {
    const p = 12 + i * (4 + SECTOR), off = dv.getUint32(p, true);
    if (off <= last || off % SECTOR || !STORE_AREAS.some(([a, e]) => off >= a && off + SECTOR <= e))
      throw new StateError(`state sector at ${off} not a storage sector`);
    out[off] = u8.slice(p + 4, p + 4 + SECTOR);
    last = off;
  }
  return out;
}

// the bytes a state is: for tests and the page (two states with the same music and settings are the same bytes)
export function stateEquals(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
