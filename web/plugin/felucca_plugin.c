/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 weavejam
 * Parts derived from Felucca (tutti_settings_flush and tutti_snapshot after project.c settings_poll and autosave_poll,
 * tutti_restore after autosave_boot, tutti_render after audio.c audio_block, tutti_stem_render after fx.c master_out):
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Felucca for tuttidaw (protocol tutti-plugin/0, web/plugin/README.md): the browser emulator (web/emu/felucca_web.c,
 * the whole firmware against a simulated FM-1) built with FELUCCA_TUTTI, plus what a host needs:
 *   - the host's tempo, fractional (core.h tutti_beat_q32: the step clocks keep to its grid over any length);
 *   - a headless render: the device without its main loop (no screen, no keys, no flash writes), the transport
 *     started on the first block, MIDI events at frames (use B), blocks of CTL frames into float mix + each part's
 *     dry mix and sends (fx.c tutti_mx) for its stem;
 *   - a part's stem from those (tutti_stem_render, in an instance of its own: its own buses, see README);
 *   - the state: the music written as the autosave (project.c) and the flash's storage sectors read by the page;
 *   - for the live page: where the music has changed (tutti_sig), the transport placed at a frame (tutti_seek).
 *   web/plugin/build.sh  ->  build/plugin-site/plugin/felucca.wasm */
#define FELUCCA_TUTTI 1
#include "../emu/felucca_web.c"

#if !FELUCCA_CPU2
#error "FELUCCA_TUTTI needs FELUCCA_CPU2 (fx.c mixsum_t)"
#endif

/* ------------------------------------------------------------ the tempo --- */
/* the host's tempo: the firmware's own range (params.c G_BPM, 40 .. 240), fractional. A runtime value only: the song's
 * G_BPM (in the state and the autosave's signature) stays Felucca's own, and while hosted its BPM knob and TAP change
 * that, not the tempo; the screen shows the host's (core.h HEAD_BPM) */
#define TUTTI_BPM_MIN 40.0
#define TUTTI_BPM_MAX 240.0
EXPORT double tutti_bpm_min(void) { return TUTTI_BPM_MIN; }
EXPORT double tutti_bpm_max(void) { return TUTTI_BPM_MAX; }
/* 1 = set; 0 = out of the range (nothing changed). 0 bpm: none, G_BPM again */
EXPORT uint32_t tutti_tempo(double bpm)
{
    double s;
    if (bpm == 0.0) {
        tutti_beat_q32 = 0;
        tutti_bpm_shown = 0;
        return 1;
    }
    if (!(bpm >= TUTTI_BPM_MIN && bpm <= TUTTI_BPM_MAX))
        return 0;
    s = (double)FS * 60.0 / bpm;
    tutti_beat_q32 = (uint64_t)(s * 4294967296.0 + 0.5);
    tutti_bpm_shown = (int16_t)(bpm + 0.5);
    return 1;
}

/* ------------------------------------------------------------ the state --- */
/* the settings a MENU change left pending, written now (project.c settings_poll, without its wait for the transport) */
static void tutti_settings_flush(void)
{
    persist_t p;
#if FELUCCA_SLICE
    slc_store_poll();
#endif
    if (!persist_pending || !flash_ok)
        return;
    p = persist_saved;
    settings_export(&p);
    if (memcmp(&p, &persist_saved, sizeof p) && st_save(OBJ_SETTINGS, &p, sizeof p) != 0)
        return;
    persist_saved = p;
    persist_pending = 0;
}
/* the music as it is now into the autosave (project.c autosave_poll's write, at once), the settings too: then the
 * flash's storage sectors are the whole state. 1 = written */
EXPORT uint32_t tutti_snapshot(void)
{
    if (!flash_ok)
        return 0;
    tutti_settings_flush();
    project_capture(&proj_scratch);
    proj_wire_gen++;
    if (!proj_pack(&proj_wire, &proj_scratch) || st_save(OBJ_AUTOSAVE, &proj_wire, sizeof proj_wire) != 0)
        return 0;
    as.saved = as.seen = autosave_sig();
    as.last = fm1_ms;
    as.wrote = 1;
    return 1;
}
/* what the music is (project.c autosave_sig: a hash of what a project holds) */
EXPORT uint32_t tutti_sig(void) { return autosave_sig(); }

/* the autosave as the music even with MENU > RESTORE LAST OFF (autosave_boot skips it then): a host's state is the
 * music it saved */
static void tutti_restore(void)
{
    int n;
    if (!flash_ok || !(ui_prefs & PREF_RESTORE_OFF))
        return;                                       /* (autosave_boot did it) */
    proj_wire_gen++;
    n = st_load(OBJ_AUTOSAVE, &proj_wire, sizeof proj_wire);
    if (n > 0 && proj_import(&proj_scratch, &proj_wire, n)) {
        proj_bound(&proj_scratch);
        project_restore_runtime(&proj_scratch);
    }
    as.saved = as.seen = autosave_sig();
}

/* ----------------------------------------------------- the headless device --- */
#define TT_MAXB 128u                       /* blocks a call renders at most (4096 frames) */
static float tt_l[TT_MAXB * CTL], tt_r[TT_MAXB * CTL];
static int32_t tt_out[2u * CTL];
static int32_t tt_cap[NPART][TT_MAXB][6][CTL];     /* each part's l r c d v (fx.c mixsum_t) per block of a call, and
                                                     * the limiter's gain (fx.c tutti_lim) */
static uint32_t tt_capture, tt_blk, tt_frames, tt_ms0;
static uint32_t tt_headless;

/* power on as web_boot, for the host: headless (render) the main loop never runs: the splash's wait over, the keys
 * free, MASTER at its top (the render's level; the live page keeps its knob); the state's music in any case */
EXPORT void tutti_boot(uint32_t headless)
{
    tt_headless = headless;
    web_boot();
    tutti_restore();
    if (headless) {
        kb_boot_hold = 0;
        song.master_q12 = MASTER_FULL;
        tutti_clock_int = 1;                          /* the host's clock: the internal one at its tempo */
        song.rec = 0;                                 /* (no live recording, no count-in) */
        tt_ms0 = fm1_ms;
    }
}

/* 1: the internal clock at the host's tempo for any playback hosted (a render; the live page in tuttidaw's frame, from
 * worklet-tutti.js tutti-hosted), whatever CLK says: no clock pulses come from a host. A runtime override (core.h
 * CLOCK_MODE): song.g[G_CLOCK], what the state saves and the page shows, stays the user's choice */
EXPORT void tutti_clock_internal(uint32_t on) { tutti_clock_int = on ? 1u : 0u; }

/* the parts' sums of this block (fx.c mix_block) into the call's capture */
static int32_t tt_lvl[NPART];                      /* each part's peak since the page's view read it */
static void tutti_parts(uint32_t n)
{
    uint32_t p, i;
    for (p = 0; p < NPART; p++)
        for (i = 0; i < n; i++) {
            int32_t l = tutti_mx[p].l[i], r = tutti_mx[p].r[i];
            l = l < 0 ? -l : l;
            r = r < 0 ? -r : r;
            if (l > tt_lvl[p])
                tt_lvl[p] = l;
            if (r > tt_lvl[p])
                tt_lvl[p] = r;
        }
    if (!tt_capture || tt_blk >= TT_MAXB)
        return;
    for (p = 0; p < NPART; p++) {
        const mixsum_t *sm = &tutti_mx[p];
        int32_t (*c)[CTL] = tt_cap[p][tt_blk];
        for (i = 0; i < n; i++) {
            c[0][i] = sm->l[i];
            c[1][i] = sm->r[i];
            c[2][i] = sm->c[i];
            c[3][i] = sm->d[i];
            c[4][i] = sm->v[i];
        }
    }
}

/* MIDI events at frames from the transport's start (use B), in time order: each goes in with the block whose start is
 * nearest (the firmware takes MIDI per block of CTL frames: within CTL / 2), as USB-MIDI's packets arrive */
#define TT_NEV 65536u
static struct { uint32_t frame, pkt; } tt_ev[TT_NEV];
static uint32_t tt_nev, tt_evr;
EXPORT uint32_t tutti_event(uint32_t frame, uint32_t status, uint32_t d1, uint32_t d2)
{
    if (tt_nev >= TT_NEV || status < 0x80u || status >= 0xF0u)
        return 0;
    tt_ev[tt_nev].frame = frame;
    tt_ev[tt_nev].pkt = (status >> 4) | status << 8 | (d1 & 127u) << 16 | (d2 & 127u) << 24;
    tt_nev++;
    return 1;
}
static void tt_events(uint32_t f0)
{
    while (tt_evr < tt_nev && tt_ev[tt_evr].frame < f0 + CTL / 2u) {
        if (mi_w - mi_r >= MQ - 1u)
            return;                                   /* the queue full: the rest with the next block */
        midi_enqueue(tt_ev[tt_evr].pkt, 1);
        tt_evr++;
    }
}

/* the transport from the next block (frame 0 of the render: step 0 of every track there); stopped with the block nearest
 * to frame `stop` (toBeat: the notes let go there, the tail only rings out; ~0u: never) */
static uint32_t tt_stop = ~0u;
EXPORT void tutti_start(uint32_t stop)
{
    transport_req = 1;
    tt_stop = stop;
}

/* use B: the host's MIDI plays (tutti_event), and its notes last as long as the host says whatever the parts' latches
 * (ARP 2 HOLD: core.h tutti_host_notes, a runtime override; the saved setting stays). With the block nearest to frame
 * `end` (toBeat), after that block's MIDI, every note still held and the arp's chord are let go (seq.c
 * tutti_release_host): from there only the releases and the FX tails ring, no new note starts */
static uint32_t tt_end = ~0u;
EXPORT void tutti_input_end(uint32_t end)
{
    tutti_host_notes = 1;
    tt_end = end;
}

/* nblocks (<= TT_MAXB) blocks of CTL frames into tutti_out_l / _r; capture: the parts' sums too (tutti_cap). The
 * device's clock (fm1_ms, TIMER4) follows the frames; the audio ISR's block (audio.c audio_block) without the
 * metronome's click (the DAC's only) and the scope */
EXPORT void tutti_render(uint32_t nblocks, uint32_t capture)
{
    uint32_t b, k;
    if (nblocks > TT_MAXB)
        nblocks = TT_MAXB;
    tt_capture = capture;
    for (b = 0; b < nblocks; b++) {
        uint32_t f0 = tt_frames;
        while ((uint64_t)(fm1_ms - tt_ms0 + 1u) * FS <= (uint64_t)f0 * 1000u) {
            fm1_ms++;
            web_ticks += 1000u * FM1_TICKS_PER_US;
        }
        tt_events(f0);
        if (tt_stop != ~0u && f0 + CTL / 2u > tt_stop) {
            transport_req = 2;                        /* (seq.c events_block: seq_stop, before the steps) */
            tt_stop = ~0u;
        }
        if (tt_end != ~0u && f0 + CTL / 2u > tt_end) {
            tutti_let_go = 1;                         /* (events_block, after the block's MIDI) */
            tt_end = ~0u;
        }
        tt_blk = b;
        mix_block(tt_out, CTL);
        if (capture && b < TT_MAXB) {
            uint32_t p;
            for (p = 0; p < NPART; p++)
                memcpy(tt_cap[p][b][5], tutti_lim, sizeof tutti_lim);
        }
        for (k = 0; k < CTL; k++) {                    /* (audio.c: Q15 -> 24 bit; web_ms: 24 bit -> float) */
            tt_l[b * CTL + k] = (float)(tt_out[2u * k] * (1 << OUT_SHIFT)) / 8388608.0f;
            tt_r[b * CTL + k] = (float)(tt_out[2u * k + 1u] * (1 << OUT_SHIFT)) / 8388608.0f;
        }
        tt_frames += CTL;
    }
    tt_capture = 0;
}
EXPORT float *tutti_out_l(void) { return tt_l; }
EXPORT float *tutti_out_r(void) { return tt_r; }
EXPORT int32_t *tutti_cap(uint32_t p) { return &tt_cap[p % NPART][0][0][0]; }
EXPORT uint32_t tutti_block_frames(void) { return CTL; }
EXPORT uint32_t tutti_max_blocks(void) { return TT_MAXB; }
EXPORT int16_t *tutti_song_g(void) { return song.g; }
EXPORT uint32_t tutti_master_q12(void) { return song.master_q12; }
/* frames from an event to its sound: none (a step, a MIDI note sounds in the block it is taken in; the firmware takes
 * them per block, so within CTL frames of their time, see tt_events and README) */
EXPORT uint32_t tutti_latency(void) { return 0; }
/* the step clocks, for the tests: track t's step and samples into it at the last block's start (seq.c seq_tick) */
EXPORT uint32_t tutti_seq_idx(uint32_t t) { return trk[t % NTRK].seq_idx; }
EXPORT uint32_t tutti_seq_pos(uint32_t t) { return trk[t % NTRK].seq_pos; }

/* ------------------------------------------------------------ a stem --- */
/* In an instance of its own (booted with the same state, the same tempo; song.g copied in from the render's before each
 * call): one part's sums (tt_cap's layout, copied into tutti_bus_in) through this instance's buses (fx.c fx_buses: its
 * own chorus, delay and reverb, fed by this part's sends only), added to the part's dry mix, at the master's level, the
 * DC blocker and LOW CUT as master_out has them, then the mix's limiter gain of that sample (the mix's, not its own: the
 * stems add up to the mix as it was limited); not the soft clip, BASS+ or the FX layer (see README) */
static int32_t tt_bus[TT_MAXB][6][CTL];
static float tt_sl[TT_MAXB * CTL], tt_sr[TT_MAXB * CTL];
EXPORT int32_t *tutti_bus_in(void) { return &tt_bus[0][0][0]; }
EXPORT float *tutti_stem_l(void) { return tt_sl; }
EXPORT float *tutti_stem_r(void) { return tt_sr; }
EXPORT void tutti_stem_render(uint32_t nblocks, int32_t mg)
{
    uint32_t b, i;
    if (nblocks > TT_MAXB)
        nblocks = TT_MAXB;
    for (b = 0; b < nblocks; b++) {
        int32_t (*s)[CTL] = tt_bus[b];
        fx_buses(s[2], s[3], s[4], wet, CTL);
        for (i = 0; i < CTL; i++) {
            int32_t side = hl.side ? rev_side[i] : 0;
            int32_t l = (((s[0][i] + wet[i] + side) >> 2) * mg) >> 10;
            int32_t r = (((s[1][i] + wet[i] - side) >> 2) * mg) >> 10;
            l = dc_block(l, &dc_l, &dce_l);
            r = dc_block(r, &dc_r, &dce_r);
            if (fx_lowcut) {
                uint32_t sh = fx_lowcut == 2u ? 5u : 6u;
                l = lowcut1(lowcut1(l, &lc_l1, &lce[0], sh), &lc_l2, &lce[1], sh);
                r = lowcut1(lowcut1(r, &lc_r1, &lce[2], sh), &lc_r2, &lce[3], sh);
            }
            if (s[5][i] < 32768) {
                l = ((l >> 4) * s[5][i]) >> 11;
                r = ((r >> 4) * s[5][i]) >> 11;
            }
            tt_sl[b * CTL + i] = (float)(l * (1 << OUT_SHIFT)) / 8388608.0f;
            tt_sr[b * CTL + i] = (float)(r * (1 << OUT_SHIFT)) / 8388608.0f;
        }
    }
}

/* ------------------------------------------------------- the live page --- */
/* the transport for the page's preview of the host's (listen-only): stopped, or playing from `frames` after the
 * start: the sequencer started and run on that far without sound (events_block: its steps, automation, SONG sections,
 * as playing them would), then what it started let go (faded over a block), so the music goes on from there.
 * tutti_seek only starts it; tutti_seek_run runs it a bounded number of blocks per call (the worklet: per render
 * quantum, silent until it is done), so a seek minutes into a song never stalls the audio thread */
static uint32_t tt_seek, tt_seeking;               /* blocks still to run; a seek is on */
EXPORT void tutti_seek(uint32_t play, uint32_t frames)
{
    seq_stop();
    transport_req = 0;
    tt_seek = tt_seeking = 0;
    if (!play)
        return;
    song.rec = 0;
    seq_start();
    tt_seek = frames / CTL;
    tt_seeking = 1;
}
/* at most `max` blocks of the seek, `more` blocks added to it first (the time that went by meanwhile) -> the blocks still
 * to run; 0: it is done (what it started let go now), or there is none */
EXPORT uint32_t tutti_seek_run(uint32_t max, uint32_t more)
{
    uint32_t i, k;
    if (!tt_seeking)
        return 0;
    tt_seek += more;
    for (; tt_seek && max; tt_seek--, max--)
        events_block(CTL);
    if (tt_seek)
        return tt_seek;
    tt_seeking = 0;
    for (i = 0; i < NTRK; i++)
        for (k = 0; k < NVOICE; k++)
            if (trk[i].v[k].active)
                voice_kill(&trk[i].v[k]);
    return 0;
}

/* ------------------------------------------------------- the page's view --- */
/* the plugin page's Parts panel (layout.js, a wide frame): what each part is and plays, read as the device runs (it
 * changes nothing; the parts' levels are the plugin's own, tutti_parts, so the MIXER page keeps its meters). Layout
 * (little-endian, layout.js PARTS_VIEW): per part 64 bytes: the engine's name and the sound's (16 each, 0-ended), flags
 * (1 MUTE, 2 a DRUM part, 4 ARP on, 8 ARP 2 HOLD), the MIDI channel it plays (0..15; 16 OMNI, 17 none, 18 every
 * channel: MIDI IN SEL and it is selected), LEN, the step playing (255: stopped), the steps with a note or hits, the TIE
 * steps, the accented ones (bit s: step s, 8 bytes each), the peak since the last read (float, full scale 1); then the
 * selected part and 1 while the sequencer plays (u32 each) */
static struct {
    struct {
        char eng[16], sound[16];
        uint8_t flags, ch, len, step;
        uint8_t notes[8], ties[8], acc[8];
        float level;
    } p[NPART];
    uint32_t sel, playing;
} tt_view;
EXPORT void *tutti_view(void)
{
    uint32_t i, s;
    int32_t b = midi_base();
    for (i = 0; i < NPART; i++) {
        const track_t *t = &trk[i];
        uint32_t len = (uint32_t)clamp(t->p[P_SLEN], 1, NSTEP), ch = b == -1 ? (i == song.sel ? 18u : 17u)
                                                                      : b == -2 ? mch_get(i) : (uint32_t)b + i;
        str_cpy(tt_view.p[i].eng, ENGINES[eng_idx(t->eng_req)]->name, 16);
        sound_name(t, tt_view.p[i].sound);
        tt_view.p[i].flags = (uint8_t)((t->p[P_MUTE] ? 1u : 0u) | (drum_track(t) ? 2u : 0u) | (t->p[P_AMODE] ? 4u : 0u) |
                                       (t->p[P_AHOLD] ? 8u : 0u));
        tt_view.p[i].ch = (uint8_t)(ch > 18u ? 17u : ch);
        tt_view.p[i].len = (uint8_t)len;
        tt_view.p[i].step = song.playing ? (uint8_t)(t->seq_idx % len) : 255u;
        memset(tt_view.p[i].notes, 0, 24);
        for (s = 0; s < len; s++) {
            const step_t *st = &t->step[s];
            uint8_t bit = (uint8_t)(1u << (s & 7u));
            if (st->time == ST_NOTE && (st->n || st->hit))
                tt_view.p[i].notes[s >> 3] |= bit;
            else if (st->time == ST_TIE)
                tt_view.p[i].ties[s >> 3] |= bit;
            if (st->time == ST_NOTE && ((st->flags & SF_ACCENT) || st->acc))
                tt_view.p[i].acc[s >> 3] |= bit;
        }
        tt_view.p[i].level = (float)tt_lvl[i] * (float)(1 << OUT_SHIFT) / 8388608.0f;
        tt_lvl[i] = 0;
    }
    tt_view.sel = song.sel;
    tt_view.playing = song.playing ? 1u : 0u;
    return &tt_view;
}

/* for the tests (web/plugin/plugin_test.mjs): track t's pattern emptied (the heavy song, web_test_heavy, without it) */
EXPORT void tutti_test_clear(uint32_t t)
{
    memset(trk[t % NTRK].step, 0, sizeof trk[0].step);
    ui.force = 1;
}
/* for the tests: part t's ARP 2 HOLD as it is (P_AHOLD, what the state saves); mode > 0 first: ARP on in that mode
 * (seq.c AM_UP = 1 ...), HOLD as `hold` says, and `dry`: no CHORUS, DELAY, REVERB sends (a tail with no echoes) */
EXPORT uint32_t tutti_test_arp(uint32_t t, int32_t mode, uint32_t hold, uint32_t dry)
{
    track_t *k = &trk[t % NTRK];
    if (mode > 0) {
        k->p[P_AMODE] = (int16_t)mode;
        k->p[P_AHOLD] = hold ? 1 : 0;
        if (dry)
            k->p[P_CHOR] = k->p[P_DLY] = k->p[P_REV] = 0;
        ui.force = 1;
    }
    return (uint32_t)k->p[P_AHOLD];
}
