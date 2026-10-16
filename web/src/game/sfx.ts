/**
 * Sound, synthesised.
 *
 * There is not one audio file in this repo and nothing here downloads any, so
 * every sound is built out of oscillators and filtered noise at the moment it
 * plays. That is a real constraint and it turned out to be the right one: a
 * footstep whose pitch moves a little each time never gets tiring, a dial tick
 * can rise with the value it is reporting, and the train's roll can follow the
 * actual speed of the actual run rather than being a loop that happens to be
 * playing. None of that is possible with a folder of .wav files.
 *
 * Two rules browsers impose and this has to live with:
 *
 * 1. An AudioContext will not start until the player has interacted with the
 *    page. So it is built lazily on the first cue after a gesture, and every
 *    cue before that is silently dropped rather than throwing.
 * 2. Stacked sounds clip. Everything goes through one compressor and a master
 *    gain well under 1, and the noisy cues are throttled.
 *
 * Muting is remembered per browser. An unasked-for noise is worse than silence.
 */

const STORE_KEY = 'chapter-quest.muted';

interface ToneOpts {
  /** Starting frequency, Hz. */
  from: number;
  /** Swept to, if given. */
  to?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Seconds from now, for a cue made of several notes. */
  delay?: number;
}

interface NoiseOpts {
  dur: number;
  freq: number;
  to?: number;
  q?: number;
  gain?: number;
  type?: BiquadFilterType;
  delay?: number;
}

/** A sound that lasts as long as the thing making it. */
export interface Rumble {
  /** 0..1 — how hard it is working. */
  level(value: number): void;
  stop(): void;
}

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = read();
  private last: Record<string, number> = {};

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.52, this.ctx.currentTime, 0.02);
    }
    try {
      localStorage.setItem(STORE_KEY, muted ? '1' : '0');
    } catch {
      // Private window, or storage is blocked. Muting still works this session.
    }
  }

  toggle(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * The audio graph, built on first use. Returns null until the browser is
   * willing to make a sound, which is any time before the first click or key.
   */
  private ready(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.52;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx.state === 'running' ? this.ctx : null;
  }

  /** One second of white noise, made once and replayed through filters. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuf) {
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  /** True at most once per `ms` for this key, so held keys do not machine-gun. */
  private spaced(key: string, ms: number): boolean {
    const now = Date.now();
    if (now - (this.last[key] ?? 0) < ms) return false;
    this.last[key] = now;
    return true;
  }

  private tone(o: ToneOpts): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type ?? 'square';
    osc.frequency.setValueAtTime(o.from, t);
    if (o.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + o.dur);
    }
    const peak = o.gain ?? 0.26;
    const attack = Math.min(o.attack ?? 0.006, o.dur / 2);
    // Exponential ramps cannot touch zero, hence the near-silent floor.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
  }

  private noise(o: NoiseOpts): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'bandpass';
    filter.frequency.setValueAtTime(o.freq, t);
    if (o.to !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.dur);
    }
    filter.Q.value = o.q ?? 1;
    const gain = ctx.createGain();
    const peak = o.gain ?? 0.16;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.008, o.dur / 2));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + o.dur + 0.03);
  }

  // --- cues ---------------------------------------------------------------

  /** A boot heel on stone. Pitched slightly differently every time. */
  step(): void {
    if (!this.spaced('step', 110)) return;
    const jitter = 0.86 + Math.random() * 0.3;
    this.noise({ dur: 0.075, freq: 210 * jitter, q: 1.3, gain: 0.3, type: 'lowpass' });
    this.tone({ from: 78 * jitter, to: 52, dur: 0.06, type: 'sine', gain: 0.3 });
  }

  /** Walked into something solid. */
  bump(): void {
    if (!this.spaced('bump', 220)) return;
    this.tone({ from: 110, to: 62, dur: 0.12, type: 'sine', gain: 0.38 });
    this.noise({ dur: 0.1, freq: 420, q: 0.7, gain: 0.16, type: 'lowpass' });
  }

  /** Something came into reach. */
  near(): void {
    this.tone({ from: 760, to: 1180, dur: 0.07, type: 'triangle', gain: 0.18 });
  }

  /** E, and it did something. */
  act(): void {
    this.tone({ from: 480, to: 700, dur: 0.07, type: 'square', gain: 0.3 });
    this.tone({ from: 700, to: 980, dur: 0.09, type: 'square', gain: 0.26, delay: 0.06 });
  }

  /** E, and there was nothing there. */
  deny(): void {
    if (!this.spaced('deny', 180)) return;
    this.tone({ from: 150, to: 110, dur: 0.14, type: 'square', gain: 0.26 });
  }

  /** One step of a dial. `at` is 0..1 across the range, and the pitch follows it. */
  tick(at: number): void {
    const clamped = Math.min(1, Math.max(0, at));
    this.tone({ from: 900 + clamped * 700, dur: 0.028, type: 'square', gain: 0.18 });
  }

  /** A setting locked in. */
  commit(): void {
    for (const [i, hz] of [523, 659, 784].entries()) {
      this.tone({ from: hz, dur: 0.1, type: 'triangle', gain: 0.24, delay: i * 0.045 });
    }
  }

  /** Something thrown, with everything behind it. */
  launch(): void {
    this.tone({ from: 190, to: 880, dur: 0.3, type: 'sawtooth', gain: 0.32 });
    this.noise({ dur: 0.34, freq: 500, to: 2600, q: 0.9, gain: 0.24 });
  }

  /** Brakes biting. Called repeatedly while they are held. */
  brake(): void {
    if (!this.spaced('brake', 150)) return;
    this.noise({ dur: 0.22, freq: 2300, to: 3200, q: 0.7, gain: 0.2, type: 'highpass' });
  }

  /** It arrived. */
  land(won: boolean): void {
    this.tone({ from: 130, to: 58, dur: 0.18, type: 'sine', gain: 0.4 });
    this.noise({ dur: 0.16, freq: 520, q: 0.9, gain: 0.2, type: 'lowpass' });
    if (won) this.win();
    else this.lose();
  }

  win(): void {
    for (const [i, hz] of [523, 659, 784, 1047].entries()) {
      this.tone({ from: hz, dur: 0.17, type: 'square', gain: 0.24, delay: i * 0.075 });
    }
  }

  lose(): void {
    this.tone({ from: 392, to: 294, dur: 0.22, type: 'sawtooth', gain: 0.28 });
    this.tone({ from: 294, to: 196, dur: 0.3, type: 'sawtooth', gain: 0.24, delay: 0.16 });
  }

  /** A panel came up. */
  open(): void {
    this.tone({ from: 320, to: 620, dur: 0.08, type: 'triangle', gain: 0.2 });
  }

  /** A panel went away. */
  close(): void {
    this.tone({ from: 620, to: 320, dur: 0.08, type: 'triangle', gain: 0.18 });
  }

  /** A new act, a new room. */
  chapter(): void {
    for (const [i, hz] of [392, 523, 659].entries()) {
      this.tone({ from: hz, dur: 0.26, type: 'triangle', gain: 0.22, delay: i * 0.11 });
    }
  }

  /**
   * Something heavy under way: wheels, a rope, a fall. Held open until it
   * stops, with the level following how fast it is actually going — which is
   * why this is synthesised rather than a loop being faded up and down.
   */
  rumble(): Rumble {
    const ctx = this.ready();
    if (!ctx || !this.master) {
      return { level: () => undefined, stop: () => undefined };
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;
    filter.Q.value = 2.4;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();

    let stopped = false;
    return {
      level: (value) => {
        if (stopped || !this.ctx) return;
        const v = Math.min(1, Math.max(0, value));
        const now = this.ctx.currentTime;
        gain.gain.setTargetAtTime(0.0001 + v * 0.42, now, 0.06);
        // Faster means brighter, the way anything rolling does.
        filter.frequency.setTargetAtTime(170 + v * 430, now, 0.08);
      },
      stop: () => {
        if (stopped || !this.ctx) return;
        stopped = true;
        const now = this.ctx.currentTime;
        gain.gain.setTargetAtTime(0.0001, now, 0.05);
        src.stop(now + 0.4);
      },
    };
  }
}

function read(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

export const sfx = new Sfx();
