import { parseMidi, type MidiNote, type MidiSong } from "./midi";

/**
 * Tetris soundtrack. "midi" plays the Game Boy arrangement through a small
 * Web Audio chiptune synth (square lead + harmony, wave-channel bass, noise
 * drums) whose tempo follows the game level; "mp3" loops the recording at its
 * own tempo. One shared instance; the choice is remembered per phone.
 */
export type SoundMode = "midi" | "mp3" | "off";
export type SoundStatus = {
  mode: SoundMode;
  playing: boolean;
  rate: number;
  /** Line-clear effects played so far, e.g. "lines:2 tetris:1". */
  sfx: string;
};

const MODE_KEY = "pretzel_tetris_sound";
const MIDI_URL = "/audio/tetris-theme-a.mid";
const MP3_URL = "/audio/tetris-theme.mp3";
/** Line-clear effects: 2-3 lines and a Tetris (4 lines). */
const SFX_URLS = { lines: "/audio/line-clear.mp3", tetris: "/audio/tetris-clear.mp3" } as const;
type SfxName = keyof typeof SFX_URLS;
const SFX_GAIN = 0.9;
const LOOKAHEAD_S = 0.12;
const SCHEDULE_MS = 25;
const MASTER_GAIN = 0.5;
const MP3_VOLUME = 0.6;
/** MIDI channel -> voice. Channel 9 is the noise (drum) channel. */
const LEAD = 1;
const HARMONY = 2;
const BASS = 0;
const DRUMS = 9;

/** +4% tempo per level, level 1..15 (1.00x..1.56x), matching the game's speed-ups. */
export function rateForLevel(level: number): number {
  return 1 + 0.04 * (Math.min(15, Math.max(1, level)) - 1);
}

function readMode(): SoundMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "midi" || m === "mp3" || m === "off") return m;
  } catch {
    /* storage unavailable */
  }
  return "midi";
}

class Soundtrack {
  mode: SoundMode = readMode();
  private wanted = false;
  private level = 1;
  private rate = 1;
  private listeners = new Set<() => void>();
  private snap: SoundStatus = { mode: this.mode, playing: false, rate: 1, sfx: "lines:0 tetris:0" };

  // ── Web Audio (MIDI) ──
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bassWave: PeriodicWave | null = null;
  private sfx: Partial<Record<SfxName, AudioBuffer>> = {};
  private sfxLoading = false;
  private sfxPlayed: Record<SfxName, number> = { lines: 0, tetris: 0 };
  private song: MidiSong | null = null;
  private songLoading: Promise<void> | null = null;
  private timer: number | undefined;
  /** Song position = anchorTick + (audioTime - anchorTime) / secondsPerTick */
  private anchorTime = 0;
  private anchorTick = 0;
  /** Absolute tick where the current pass through the song began. */
  private loopStart = 0;
  private nextIdx = 0;

  // ── MP3 ──
  private audio: HTMLAudioElement | null = null;

  /** For useSyncExternalStore: stable function identity. */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Cached status: a new object only when something changed (useSyncExternalStore needs that). */
  status = (): SoundStatus => this.snap;

  private emit() {
    const next = this.compute();
    const prev = this.snap;
    if (next.mode === prev.mode && next.playing === prev.playing && next.rate === prev.rate && next.sfx === prev.sfx) return;
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  private compute(): SoundStatus {
    const playing =
      this.mode === "midi"
        ? this.timer !== undefined
        : this.mode === "mp3"
          ? !!this.audio && !this.audio.paused
          : false;
    const sfx = `lines:${this.sfxPlayed.lines} tetris:${this.sfxPlayed.tetris}`;
    return { mode: this.mode, playing, rate: this.mode === "midi" ? this.rate : 1, sfx };
  }

  setMode(mode: SoundMode) {
    if (mode === this.mode) return;
    const wanted = this.wanted;
    const level = this.level; // stop() resets it
    this.stop();
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* not persisted */
    }
    this.unlock();
    if (wanted) this.play(level);
    this.emit();
  }

  /**
   * Call from a tap (Join, Play again, pad keys, Sound overlay). Mobile
   * browsers only allow audio that was first started inside a user gesture.
   */
  unlock() {
    if (this.mode === "off") return;
    // Web Audio carries the chiptune and, in both modes, the line-clear effects.
    if (!this.ctx) this.createContext();
    if (this.ctx && this.ctx.state === "suspended" && document.visibilityState === "visible") {
      this.ctx.resume().catch(() => {});
    }
    this.loadSfx();
    if (this.mode === "midi") {
      void this.loadSong();
    } else if (this.mode === "mp3") {
      const el = this.mp3();
      if (el.dataset.primed) return;
      el.dataset.primed = "1";
      // Start muted and stop at once: from now on Safari lets play() run outside a tap.
      el.muted = true;
      el.play()
        .then(() => {
          if (!this.wanted) el.pause();
          el.muted = false;
          this.emit();
        })
        .catch(() => {
          el.muted = false;
          delete el.dataset.primed;
        });
    }
  }

  /** Line-clear effect: 2-3 lines -> "lines", 4 -> "tetris"; singles are silent. Off mutes it. */
  playClear(lines: number) {
    if (this.mode === "off" || lines < 2) return;
    const name: SfxName = lines >= 4 ? "tetris" : "lines";
    const ctx = this.ctx;
    const buf = this.sfx[name];
    if (!ctx || !buf) return;
    if (ctx.state === "suspended" && document.visibilityState === "visible") ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = SFX_GAIN;
    src.connect(g).connect(ctx.destination);
    src.start();
    this.sfxPlayed[name]++;
    this.emit();
  }

  /** Start (or keep) the music for the current mode; idempotent, cheap to call every frame. */
  play(level: number) {
    this.setLevel(level);
    if (this.wanted) return;
    this.wanted = true;
    if (this.mode === "midi") this.startMidi();
    else if (this.mode === "mp3") {
      const el = this.mp3();
      el.currentTime = 0;
      el.play()
        .then(() => this.emit())
        .catch(() => {});
    }
    this.emit();
  }

  setLevel(level: number) {
    if (level === this.level) return;
    this.level = level;
    const rate = rateForLevel(level);
    if (rate === this.rate) return;
    if (this.ctx && this.song && this.timer !== undefined) {
      // Re-anchor at the end of what is already scheduled, so queued notes keep their timing.
      const t = this.ctx.currentTime + LOOKAHEAD_S;
      this.anchorTick = this.tickAt(t);
      this.anchorTime = t;
    }
    this.rate = rate;
    this.emit();
  }

  stop() {
    if (!this.wanted) return;
    this.wanted = false;
    this.level = 1;
    this.rate = 1;
    window.clearInterval(this.timer);
    this.timer = undefined;
    // Notes already handed to the audio clock can't be recalled; dropping the bus silences them.
    this.master?.disconnect();
    this.master = null;
    this.audio?.pause();
    this.emit();
  }

  /** Tab hidden: freeze the audio clock / recording without forgetting what was playing. */
  suspend() {
    this.ctx?.suspend().catch(() => {});
    this.audio?.pause();
  }

  resume() {
    this.ctx?.resume().catch(() => {});
    if (this.wanted && this.mode === "mp3") this.audio?.play().catch(() => {});
  }

  // ── internals ──
  private mp3(): HTMLAudioElement {
    if (!this.audio) {
      const el = new Audio(MP3_URL);
      el.loop = true;
      el.preload = "auto";
      el.volume = MP3_VOLUME;
      el.addEventListener("pause", () => this.emit());
      el.addEventListener("playing", () => this.emit());
      this.audio = el;
    }
    return this.audio;
  }

  private createContext() {
    // iPhone: play through the silent switch, like a game would (Safari 16.4+).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        /* older Safari */
      }
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    // Game Boy wave channel: a buzzier tone than a pure triangle, so the bass carries on phone speakers.
    const imag = new Float32Array([0, 1, 0.5, 0.33, 0.22, 0.15, 0.1, 0.07, 0.05]);
    this.bassWave = ctx.createPeriodicWave(new Float32Array(imag.length), imag);
    this.noise = noise;
    this.ctx = ctx;
  }

  private loadSfx() {
    const ctx = this.ctx;
    if (!ctx || this.sfxLoading) return;
    this.sfxLoading = true;
    for (const name of Object.keys(SFX_URLS) as SfxName[]) {
      fetch(SFX_URLS[name])
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        // Callback form: older Safari has no promise-returning decodeAudioData.
        .then((data) => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(data, res, rej)))
        .then((buf) => {
          this.sfx[name] = buf;
        })
        .catch((e) => {
          console.warn(`tetris sfx: could not load ${name}:`, e);
          this.sfxLoading = false; // retry on the next tap
        });
    }
  }

  private loadSong(): Promise<void> {
    if (this.song) return Promise.resolve();
    if (!this.songLoading) {
      this.songLoading = fetch(MIDI_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          this.song = parseMidi(buf);
        })
        .catch((e) => {
          console.warn("tetris soundtrack: could not load MIDI:", e);
          this.songLoading = null;
        });
    }
    return this.songLoading;
  }

  private secondsPerTick(): number {
    const song = this.song!;
    return 60 / (song.bpm * song.ppq) / this.rate;
  }

  private tickAt(time: number): number {
    return this.anchorTick + (time - this.anchorTime) / this.secondsPerTick();
  }

  private startMidi() {
    if (!this.ctx) this.createContext();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended" && document.visibilityState === "visible") ctx.resume().catch(() => {});
    void this.loadSong().then(() => {
      if (!this.wanted || this.mode !== "midi" || !this.song || this.timer !== undefined) return;
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      this.master = master;
      this.anchorTime = ctx.currentTime + 0.05;
      this.anchorTick = 0;
      this.loopStart = 0;
      this.nextIdx = 0;
      this.schedule();
      this.timer = window.setInterval(() => this.schedule(), SCHEDULE_MS);
      this.emit();
    });
  }

  /** Hand every note that starts within the look-ahead window to the audio clock. */
  private schedule() {
    const ctx = this.ctx;
    const song = this.song;
    if (!ctx || !song || !this.master || ctx.state !== "running") return;
    const spt = this.secondsPerTick();
    const horizon = this.tickAt(ctx.currentTime + LOOKAHEAD_S);
    for (;;) {
      const n = song.notes[this.nextIdx];
      if (!n) {
        // End of the song: loop seamlessly.
        if (this.loopStart + song.lengthTicks >= horizon) break;
        this.loopStart += song.lengthTicks;
        this.nextIdx = 0;
        continue;
      }
      const abs = this.loopStart + n.tick;
      if (abs >= horizon) break;
      const when = this.anchorTime + (abs - this.anchorTick) * spt;
      // Skip anything that fell behind (e.g. after the tab was frozen) rather than burst it out.
      if (when >= ctx.currentTime - 0.02) this.voice(n, Math.max(when, ctx.currentTime), n.durTicks * spt);
      this.nextIdx++;
    }
  }

  private voice(n: MidiNote, when: number, dur: number) {
    const ctx = this.ctx!;
    const out = this.master!;
    const vel = n.velocity / 127;
    const g = ctx.createGain();
    g.connect(out);

    if (n.channel === DRUMS) {
      const hat = n.note === 69;
      const len = hat ? 0.04 : 0.09;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = hat ? "highpass" : "bandpass";
      f.frequency.value = hat ? 7000 : 2000;
      const peak = (hat ? 0.06 : 0.1) * vel;
      g.gain.setValueAtTime(peak, when);
      g.gain.exponentialRampToValueAtTime(0.0005, when + len);
      src.connect(f).connect(g);
      src.start(when, Math.random() * 0.5);
      src.stop(when + len + 0.02);
      return;
    }

    const osc = ctx.createOscillator();
    let peak: number;
    let note = n.note;
    if (n.channel === BASS) {
      if (this.bassWave) osc.setPeriodicWave(this.bassWave);
      else osc.type = "triangle";
      note += 12; // written at A0..A2: an octave up so phone speakers can play it
      peak = 0.16;
    } else {
      osc.type = "square";
      peak = n.channel === LEAD ? 0.1 : n.channel === HARMONY ? 0.07 : 0.06;
    }
    peak *= vel;
    osc.frequency.value = 440 * 2 ** ((note - 69) / 12);
    const end = when + Math.max(0.03, dur * 0.95);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.004);
    g.gain.setValueAtTime(peak, Math.max(when + 0.004, end - 0.015));
    g.gain.linearRampToValueAtTime(0, end);
    osc.connect(g);
    osc.start(when);
    osc.stop(end + 0.01);
  }
}

export const soundtrack = new Soundtrack();
