# FM-1 for tuttidaw (`web/plugin/`)

A [tuttidaw](https://tuttidaw.com) plugin (protocol `tutti-plugin/0`, an "L0 offline plugin") built from Felucca:
the browser emulator (`web/emu/`, the whole firmware in WebAssembly) as the plugin's own UI, plus a headless
renderer that renders the FM-1's song (or MIDI from tuttidaw) offline into a mix and four part stems, at tuttidaw's
tempo. GPL-3.0-only like the rest of Felucca. Not affiliated with or endorsed by M-VAVE.

## Build, run, test

```
tools/build.py --gen-only           # build/gen (fonts, icons, tables, samples); no JieLi toolchain or SDK needed
web/plugin/build.sh                 # -> build/plugin-site/ (needs emcc and node)
node web/plugin/plugin_test.mjs build/plugin-site/plugin/felucca.wasm [build/emu/felucca.wasm]
node web/plugin/dev/serve.mjs       # the site on http://127.0.0.1:8791/, a stand-in host on http://localhost:8792/
```

`tools/build.py --gen-only` needs Pillow with Raqm (FriBiDi), as `./build.sh` does. `tests/run_tests.sh` builds and
tests the plugin too when `emcc` is there. `.github/workflows/plugin-site.yml` builds the site and keeps it as an
artifact; the site is static (Cloudflare Pages: `_headers` sets the manifest's CORS and `no-cache`, `frame-ancestors`
for tuttidaw, the wasm's type).

| File | What |
| --- | --- |
| `felucca_plugin.c` | the emulator (`web/emu/felucca_web.c`) built with `FELUCCA_TUTTI`, and the host's exports: tempo, headless render, MIDI at frames, stems, state snapshot, preview seek |
| `renderer.js` | a render: the time map's geometry, the request checked, a fresh instance per render, mix and stems, 48 kHz |
| `resample.js` | 44.1 kHz to 48 kHz |
| `state.js` | the state blob (the flash's storage sectors) |
| `protocol.js` | the session: handshake, messages, state machine, credited chunks |
| `engine.js` | state revisions, renders of a revision, the live device |
| `tutti.js`, `worklet-tutti.js`, `render-worker.js` | the page: the emulator's page and worklet with the protocol, renders in a Worker |
| `site.mjs`, `build.sh` | the static site, the manifest |
| `dev/` | a stand-in host and a server for development |
| `plugin_test.mjs` | the tests (Node) |

## What the firmware does differently (`FELUCCA_TUTTI`)

Only builds that define `FELUCCA_TUTTI=1` (this plugin's) change; the hardware build, the host tests
(`tests/regress.c`'s golden renders) and the browser emulator preprocess to the same code as without it.

- **Fractional tempo.** The firmware's tempo is an integer `G_BPM` and a beat is `44100 * 60 / BPM` samples, truncated:
  at 123 BPM its step clock is 50 samples behind the ideal grid after 64 bars, and 123.45 BPM cannot be set at all. Hosted,
  the host's tempo is a beat in samples in Q32 (`tutti_beat_q32`), and every step clock (the sequencer's tracks, a SONG
  section's start, the SLICER) counts exact step lengths: each step is `floor(end) - floor(start)` of its exact span
  (swing included), so the steps add up to the exact time and a bar starts within one sample of
  `bar * 4 * 60 / bpm * 44100` however long the render (`plugin_test.mjs`: 64 bars at 123.45 BPM, worst 0.96 samples).
  What is timed by a whole number of samples (the delay's time, LFO and ENV SYNC, the ARP's rate) takes the beat rounded.
- **Per-part sums.** Each part is mixed into sums of its own first (its dry L/R and its CHORUS, DELAY and REVERB sends, the
  `mixsum_t` the second core uses) and then added to the mix. The sums are integers, so the mix is bit for bit the same
  (`plugin_test.mjs` checks it against the emulator's build). The master limiter's gain per sample is kept as well.

## Stems and the mix

- `mix` is the FM-1's master output exactly as the instrument makes it (the buses, the master's DC blocker and LOW CUT,
  the limiter, the soft clip), with MASTER at its top (the knob is a monitor volume; the live page keeps its own). The
  metronome's click is never in a render (it is the speaker's only on the FM-1 too).
- `t1`..`t4` are each part's dry signal (after its DIST, INSERT, SLICER, level and pan) plus **its own share of the
  buses**: an instance of the firmware of its own runs the chorus, delay and reverb on that part's sends only, then
  the master's level, DC blocker and LOW CUT, then **the mix's limiter gain** at that sample (so a stem is as loud as
  the part is in the limited mix).
- The buses and the master are not linear (the reverb's and the delay's saturation, the soft clip, BASS+), so the stems
  do not add up to the mix exactly (`stemsSumToMix: false`). With the test song, which drives the limiter hard, the
  difference is about -26 dB of the mix. Not in the stems: the soft clip, BASS+ and the FX hold layer (a live
  performance gesture). A part with nothing playing gives a silent stem.

## Timing

- **Blocks.** The firmware takes its events (sequencer steps, MIDI) once per block of 32 frames (`CTL`). A step sounds
  at the first block boundary at or after its exact time (0 to 31 frames late, as on the FM-1); a MIDI note of use B
  goes in with the nearest block (within 16 frames of its time). There is no other latency: a render's frame 0 is the
  sound at `fromBeat` (`tutti_latency()` is 0).
- **Every render plays from the song's start.** A render of `[fromBeat, toBeat)` renders from beat 0 (transport started
  at frame 0) and drops the frames before `fromBeat`, so notes held over `fromBeat`, delay and reverb tails, LFOs and
  automation are as when the song plays through, and a render of a later range is bit for bit the same audio as that
  part of a render from 0.
- **Tempo maps.** `tempoMap: "constant"`: frame positions follow the host's map (protocol section 5: `frame(beat)` integrates it,
  linear ramps included); the FM-1 plays the range at the tempo in effect at `fromBeat`. A tempo change inside the
  range is refused (`unsupported`) unless the request says `approximation: "start-tempo"`; then the range is
  rendered at the start tempo throughout and is as long as that tempo makes it (the host warps it).
- **Use A / use B.** `input: null`: the FM-1's own sequencer plays (use A), from beat 0, and stops at `toBeat` (the
  nearest block): its notes are released there and the tail only rings out. With `input` (use B) the sequencer stays
  stopped and the notes, CC and pitch bend go in as USB-MIDI would deliver them: a channel plays the part the FM-1's
  MIDI IN setting gives it (by default channels 1..4 play T1..T4). Notes are released at `min(end, toBeat)`.

## Sample rates

The firmware runs at 44.1 kHz only (its tables, filters and delays). `48000` is made from it by `resample.js`: a
polyphase windowed sinc at the exact ratio 160/147, 192 taps (Kaiser, beta 9.5, cut-off 0.95 of 22.05 kHz), centred
on each output frame (no delay), in double precision. A 1 kHz sine comes out within -120 dB of the ideal.

## State

The state is the emulator's flash storage, the same sectors the emulator's page keeps (`web/emu/worklet.js`
`STORE_AREAS`: projects, user presets and their FM6 patches, user sample slots, settings, FM6's voice bank, and the
autosave holding the music). Before the state is read, the music is written as the autosave
(`tutti_snapshot`). A new instance loads the autosave at power-on even with MENU > RESTORE LAST OFF. Format
(`stateVersion` 1): `"FM1T"`, u32 version, u32 count, then count x (u32 offset, 4096 bytes), little-endian. A song is
about 4 KiB, everything at most about 320 KiB. The hardware's backup files (`web/fm1backup.js`) are not read as a state
(they restore through the device's editor protocol); save a project on the FM-1 and rebuild it here, or use the
emulator.

Revisions: 1 is the state `init` gave (or the factory state). An edit on the live FM-1 (its music, a saved preset or
project, a setting) starts the next revision, `state-changed` follows once it has been still for 600 ms (at most every
2 s while it keeps changing). Renders take the state of the revision they ask for (the last 8 are kept).

## The page

- In tuttidaw's frame: the handshake (accepted from `https://tuttidaw.com`, `https://*.tuttidaw.com` and
  `http://localhost:<port>`, from the parent window only), then `init`. Edit mode: the live FM-1 starts with the state (on its
  own if the browser lets the frame play sound, else with Switch on). It saves nothing in this browser, and tuttidaw's
  transport drives its preview (listen-only: it starts at `atEpochMs` less the output latency, a drift of over 20 ms
  re-seeks). Render to tuttidaw sends `commit` (the mix, or with the T1..T4 stems). Renders run in a Worker, so the
  FM-1 and its screen stay live. `mode: "render"` is headless: no device, no audio, only renders.
- Opened by itself (or not connected within 4 s): the browser emulator, its saves in this browser, with a note.
- `/credits.html`: who made what, the licences, the source of the build.

## Not done (yet)

- `tempoMap: "full"` (tempo changes inside a render): the firmware's step clocks would need the tempo per block.
- Sub-block timing (steps and MIDI to the sample): the firmware's control rate is a block of 32 frames.
- The hardware backup format as a state (above).
- Web MIDI in tuttidaw's frame (the manifest asks no `midi` permission; opened by itself it has the emulator's MIDI in).
