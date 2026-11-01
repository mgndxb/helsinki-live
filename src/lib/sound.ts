/**
 * Ambient sound and interface sounds, synthesised in the browser with the Web Audio API.
 * No audio files.
 *
 * Everything is one instrument: a soft felt-and-glass tone. The ambient pad is that tone held
 * and layered; interface sounds are short taps of it; the slow background notes are distant
 * strikes of it. Every sound takes its notes from the chord the pad is playing at that moment,
 * and everything shares one room (reverb + echo), so effects always sit inside the music.
 *
 *   pad (triangle + sine per chord tone, crossfading chords) ─ warm lowpass ─┐
 *   sub drone + room air ──────────────────────────────────────────────────┼─ ambient ─┐
 *   background notes + interface sounds ─ felt voice ─ soft lowpass ─ fx ───┘           ├─ master ─ out
 *                                 (both buses feed one reverb and one echo) ────────────┘
 *
 * The same engine as magnus.is-a.dev, so the portfolio and its Lab projects share one sound.
 * They live on the same origin, so turning it off anywhere turns it off everywhere. Browsers only
 * allow audio after a gesture, so it starts with the visitor's first click or key press.
 */

const STORAGE_KEY = "mk-sound";
const TUNING_KEY = "mk-sound-tuning";

// Lush, unresolved voicings in D: Dmaj9, Bm9, Gmaj9, A13sus. Five tones each, low and open.
const CHORDS = [
  [146.83, 220.0, 277.18, 329.63, 369.99],
  [123.47, 185.0, 220.0, 277.18, 293.66],
  [98.0, 146.83, 185.0, 220.0, 246.94],
  [110.0, 164.81, 196.0, 246.94, 293.66],
];

const CHORD_SECONDS = 14;
const CROSSFADE_SECONDS = 6;

/** The few dials that shape the whole mix, 0 to 1. Adjustable live with ?tune on the site. */
export interface Tuning {
  master: number;
  ambient: number;
  effects: number;
  brightness: number;
  space: number;
}

// Tuned by ear with the ?tune panel.
export const DEFAULT_TUNING: Tuning = {
  master: 0.75,
  ambient: 0.5,
  effects: 0.6,
  brightness: 0.45,
  space: 0.8,
};

type Listener = (enabled: boolean) => void;

interface Pad {
  group: GainNode;
  oscillators: OscillatorNode[];
}

interface FeltOptions {
  gain: number;
  decay?: number;
  attack?: number;
  pan?: number;
  delay?: number;
  /** Lowpass cutoff at the strike; it closes as the note fades, like felt on a string. */
  bright?: number;
  /** How much goes to the echo. */
  echo?: number;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private ambient!: GainNode;
  private fx!: GainNode;
  private fxTone!: BiquadFilterNode;
  private padFilter!: BiquadFilterNode;
  private reverbOut!: GainNode;
  private echoIn!: GainNode;
  private echoOut!: GainNode;
  private drift!: GainNode;
  private noise!: AudioBuffer;
  private pad: Pad | null = null;
  private chord = 0;
  private chordTimer = 0;
  private notesTimer = 0;
  private last = new Map<string, number>();
  private listeners = new Set<Listener>();

  enabled = false;
  tuning: Tuning = { ...DEFAULT_TUNING };

  /** On unless the visitor has turned it off before. */
  get wanted(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Must be called from a user gesture (click, tap or key press). */
  async enable({ bloom = false }: { bloom?: boolean } = {}) {
    if (this.enabled) return;
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    await ctx.resume();
    this.enabled = true;
    this.remember("on");
    // A slow swell in, never a jump.
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.tuning.master, now + 3.5);
    if (!this.pad) this.playChord(this.chord, 5);
    this.startLoops();
    if (bloom) this.bloom();
    this.emit();
  }

  disable() {
    if (!this.enabled || !this.ctx) return;
    this.enabled = false;
    this.remember("off");
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.8);
    this.stopLoops();
    window.setTimeout(() => {
      if (!this.enabled) void ctx.suspend();
    }, 1200);
    this.emit();
  }

  toggle() {
    if (this.enabled) this.disable();
    else void this.enable();
  }

  /** The visitor chose silence before sound ever started. */
  decline() {
    this.remember("off");
  }

  /** Pause while the tab is hidden; pick up again when it comes back. */
  setVisible(visible: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (visible) {
      void this.ctx.resume();
      this.startLoops();
    } else {
      this.stopLoops();
      void this.ctx.suspend();
    }
  }

  /** Scroll speed opens the pad's filter a little, so the room breathes with movement. */
  setMotion(velocity: number) {
    if (!this.ready()) return;
    const lift = Math.min(Math.abs(velocity) * 30, 900);
    this.padFilter.frequency.setTargetAtTime(this.padCutoff() + lift, this.ctx!.currentTime, 0.6);
  }

  /** Live mix adjustments (the ?tune panel). */
  setTuning(partial: Partial<Tuning>) {
    this.tuning = { ...this.tuning, ...partial };
    try {
      localStorage.setItem(TUNING_KEY, JSON.stringify(this.tuning));
    } catch {
      // Not saved, but still applied for this visit.
    }
    this.applyTuning();
  }

  /** Picks up settings saved by the ?tune panel in this browser. */
  loadSavedTuning() {
    try {
      const saved = localStorage.getItem(TUNING_KEY);
      if (saved) this.tuning = { ...DEFAULT_TUNING, ...JSON.parse(saved) };
    } catch {
      // Fall back to the defaults.
    }
  }

  resetTuning() {
    try {
      localStorage.removeItem(TUNING_KEY);
    } catch {
      // Nothing stored.
    }
    this.tuning = { ...DEFAULT_TUNING };
    this.applyTuning();
  }

  // ---------- Interface sounds: all the same felt voice, all from the current chord ----------

  /** A glassy whisper for hovering something interactive. */
  tick() {
    if (!this.ready() || this.throttled("tick", 0.07)) return;
    this.felt(this.tone(1 + Math.floor(Math.random() * 4), 2), {
      gain: 0.0045,
      decay: 0.45,
      attack: 0.004,
      bright: 3200,
      pan: Math.random() * 0.6 - 0.3,
    });
  }

  /** A soft, low press. */
  press() {
    if (!this.ready() || this.throttled("press", 0.06)) return;
    this.felt(this.tone(0, 1), { gain: 0.02, decay: 0.7, bright: 1500, echo: 0.1 });
  }

  /** List rows play the chord upwards, so moving down a list plays an arpeggio. */
  note(index: number, pan = 0) {
    if (!this.ready() || this.throttled(`note${index}`, 0.12)) return;
    this.felt(this.tone(index, 1), { gain: 0.018, decay: 2.4, pan: pan || ((index % 5) / 4 - 0.5) * 0.8, echo: 0.3 });
  }

  /** A new scene or chapter coming into view. */
  chime(index: number) {
    if (!this.ready() || this.throttled("chime", 0.4)) return;
    this.felt(this.tone(index, 1), { gain: 0.026, decay: 3.6, echo: 0.45 });
    this.felt(this.tone(index + 2, 1), { gain: 0.012, decay: 3, delay: 0.14, echo: 0.45, pan: 0.3 });
  }

  /** Glassy notes for moving through the particle name, panned with the pointer. */
  sparkle(x: number) {
    if (!this.ready() || this.throttled("sparkle", 0.13)) return;
    this.felt(this.tone(Math.floor(Math.random() * 5), 2), {
      gain: 0.007 + Math.random() * 0.005,
      decay: 1.8,
      attack: 0.006,
      pan: x * 2 - 1,
      bright: 4000,
      echo: 0.55,
    });
  }

  /** A label decoding itself: three quick, quiet notes up the chord. */
  data() {
    if (!this.ready() || this.throttled("data", 0.5)) return;
    [0, 2, 4].forEach((step, i) =>
      this.felt(this.tone(step, 2), { gain: 0.0055, decay: 0.6, attack: 0.004, delay: i * 0.07, bright: 3600, echo: 0.25 }),
    );
  }

  /** Something resolving: air rising into the whole chord. */
  swell() {
    if (!this.ready() || this.throttled("swell", 1.5)) return;
    this.air(0.022, 400, 2400, 1.2);
    [0, 1, 2, 3, 4].forEach((step, i) =>
      this.felt(this.tone(step, 1), { gain: 0.014, decay: 3.8, delay: 0.3 + i * 0.09, pan: (i - 2) * 0.25, echo: 0.45 }),
    );
  }

  /** Opening or closing something small: two notes, up or down. */
  pop(open: boolean) {
    if (!this.ready() || this.throttled("pop", 0.1)) return;
    const [first, second] = open ? [2, 4] : [4, 2];
    this.felt(this.tone(first, 1), { gain: 0.016, decay: 0.6 });
    this.felt(this.tone(second, 1), { gain: 0.014, decay: 0.9, delay: 0.07, echo: 0.15 });
  }

  /** Switching tabs. */
  select() {
    if (!this.ready() || this.throttled("select", 0.08)) return;
    this.felt(this.tone(3, 1), { gain: 0.015, decay: 1.1, echo: 0.2 });
  }

  /** Done, it worked: copied, sent, saved. */
  success() {
    if (!this.ready()) return;
    this.felt(this.tone(2, 1), { gain: 0.02, decay: 1.6, echo: 0.35 });
    this.felt(this.tone(0, 2), { gain: 0.018, decay: 2.2, delay: 0.11, echo: 0.35 });
  }

  /** The booking was written: two notes rising. */
  confirm() {
    if (!this.ready()) return;
    this.felt(this.tone(1, 1), { gain: 0.024, decay: 2, echo: 0.35 });
    this.felt(this.tone(3, 1), { gain: 0.022, decay: 2.4, delay: 0.12, echo: 0.35 });
  }

  /** The database said no: a low, muted strike, still in key. */
  refuse() {
    if (!this.ready()) return;
    const root = CHORDS[this.chord]![0]!;
    this.felt(root / 2, { gain: 0.07, decay: 0.9, attack: 0.006, bright: 420 });
    this.felt(root, { gain: 0.026, decay: 0.7, delay: 0.05, bright: 600 });
  }

  /** Air moving, for panels opening and closing. */
  swoosh(opening: boolean) {
    if (!this.ready()) return;
    this.air(0.022, opening ? 300 : 1800, opening ? 1800 : 300, 0.7);
  }

  /** The way in: air, then the chord blooming across two octaves. */
  bloom() {
    if (!this.ready()) return;
    this.air(0.025, 250, 1800, 2);
    [0, 2, 4, 6, 8, 10].forEach((step, i) =>
      this.felt(this.tone(step, 0), {
        gain: i === 0 ? 0.03 : 0.018,
        decay: 5,
        attack: 0.02,
        delay: 0.4 + i * 0.13,
        pan: (i - 2.5) * 0.25,
        echo: 0.5,
      }),
    );
  }

  // ---------- Internals ----------

  private ready() {
    return this.enabled && this.ctx !== null && this.ctx.state === "running";
  }

  /** Keeps any one sound from firing too often, so interactions never turn into noise. */
  private throttled(key: string, seconds: number) {
    const now = this.ctx!.currentTime;
    if (now - (this.last.get(key) ?? -1) < seconds) return true;
    this.last.set(key, now);
    return false;
  }

  /** A tone from the chord playing right now: step 0–4 walks the chord, higher steps climb octaves. */
  private tone(step: number, octave: number) {
    const chord = CHORDS[this.chord]!;
    const index = ((step % chord.length) + chord.length) % chord.length;
    return chord[index]! * 2 ** (octave + Math.floor(step / chord.length));
  }

  private padCutoff() {
    return 380 + this.tuning.brightness * 1100;
  }

  private applyTuning() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const t = this.tuning;
    if (this.enabled) this.master.gain.setTargetAtTime(t.master, now, 0.2);
    this.ambient.gain.setTargetAtTime(t.ambient * 0.9, now, 0.2);
    this.fx.gain.setTargetAtTime(t.effects * 1.2, now, 0.2);
    this.padFilter.frequency.setTargetAtTime(this.padCutoff(), now, 0.3);
    this.fxTone.frequency.setTargetAtTime(2000 + t.brightness * 4000, now, 0.3);
    this.reverbOut.gain.setTargetAtTime(t.space * 1.1, now, 0.3);
    this.echoOut.gain.setTargetAtTime(t.space * 0.55, now, 0.3);
  }

  private remember(value: "on" | "off") {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage can be blocked; the toggle still works for this visit.
    }
  }

  private emit() {
    this.listeners.forEach((listener) => listener(this.enabled));
  }

  private build() {
    const AudioCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtor();
    this.ctx = ctx;

    this.loadSavedTuning();

    // Master: a gentle top-end roll-off and soft compression keep the whole mix smooth.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 20;
    compressor.ratio.value = 2.5;
    compressor.connect(ctx.destination);
    const masterTone = ctx.createBiquadFilter();
    masterTone.type = "lowpass";
    masterTone.frequency.value = 8500;
    masterTone.connect(compressor);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(masterTone);

    // One room for everything: a long, dark reverb.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(7, 3.4);
    const reverbTone = ctx.createBiquadFilter();
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 3200;
    this.reverbOut = ctx.createGain();
    reverb.connect(reverbTone).connect(this.reverbOut).connect(this.master);

    // And one echo, whose repeats darken each time round.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.62;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const feedbackTone = ctx.createBiquadFilter();
    feedbackTone.type = "lowpass";
    feedbackTone.frequency.value = 1700;
    this.echoIn = ctx.createGain();
    this.echoIn.connect(delay);
    delay.connect(feedbackTone).connect(feedback).connect(delay);
    this.echoOut = ctx.createGain();
    feedbackTone.connect(this.echoOut);
    this.echoOut.connect(this.master);
    this.echoOut.connect(reverb);

    // The ambient bus: pad, sub and air.
    this.ambient = ctx.createGain();
    this.ambient.connect(this.master);
    const ambientSend = ctx.createGain();
    ambientSend.gain.value = 0.8;
    this.ambient.connect(ambientSend).connect(reverb);

    // The effects bus: every felt note, softened so nothing pokes out of the pad.
    this.fxTone = ctx.createBiquadFilter();
    this.fxTone.type = "lowpass";
    this.fxTone.Q.value = 0.3;
    this.fx = ctx.createGain();
    this.fxTone.connect(this.fx);
    this.fx.connect(this.master);
    const fxSend = ctx.createGain();
    fxSend.gain.value = 0.75;
    this.fx.connect(fxSend).connect(reverb);

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.Q.value = 0.5;
    this.padFilter.connect(this.ambient);
    this.lfo(0.027, 140, this.padFilter.frequency);

    // A shared, very slow pitch drift, like tape: the pad never sits perfectly still.
    this.drift = ctx.createGain();
    this.drift.gain.value = 4;
    const driftOsc = ctx.createOscillator();
    driftOsc.frequency.value = 0.13;
    driftOsc.connect(this.drift);
    driftOsc.start();

    this.noise = this.noiseBuffer(4);

    // Room air: pink noise, band-limited to a soft hush that slowly swells.
    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const airLow = ctx.createBiquadFilter();
    airLow.type = "highpass";
    airLow.frequency.value = 160;
    const airHigh = ctx.createBiquadFilter();
    airHigh.type = "lowpass";
    airHigh.frequency.value = 1100;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.012;
    this.lfo(0.05, 0.006, airGain.gain);
    air.connect(airLow).connect(airHigh).connect(airGain).connect(this.ambient);
    air.start();

    this.applyTuning();
  }

  private lfo(rate: number, depth: number, target: AudioParam) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = depth;
    osc.connect(gain).connect(target);
    osc.start();
  }

  /**
   * Fade a new chord in over the old one. Crossfading (rather than sliding the pitch of the
   * same voices) is what keeps it sounding like an instrument and not a synth demo.
   */
  private playChord(index: number, fadeIn: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const chord = CHORDS[index]!;

    const group = ctx.createGain();
    group.gain.setValueAtTime(0, now);
    group.gain.linearRampToValueAtTime(1, now + fadeIn);
    group.connect(this.padFilter);

    const oscillators: OscillatorNode[] = [];
    chord.forEach((frequency, i) => {
      const panner = ctx.createStereoPanner();
      panner.pan.value = (i / (chord.length - 1)) * 1.3 - 0.65;
      const voice = ctx.createGain();
      voice.gain.value = 0.021;
      voice.connect(panner).connect(group);
      (
        [
          ["triangle", -5],
          ["sine", 6],
        ] as const
      ).forEach(([type, cents]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = frequency;
        osc.detune.value = cents;
        this.drift.connect(osc.detune);
        osc.connect(voice);
        osc.start(now);
        oscillators.push(osc);
      });
    });

    // The sub drone, an octave under the root, moves with the chord.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = chord[0]! / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.05;
    sub.connect(subGain).connect(group);
    sub.start(now);
    oscillators.push(sub);

    if (this.pad) {
      const old = this.pad;
      old.group.gain.cancelScheduledValues(now);
      old.group.gain.setValueAtTime(old.group.gain.value, now);
      old.group.gain.linearRampToValueAtTime(0, now + CROSSFADE_SECONDS);
      old.oscillators.forEach((osc) => osc.stop(now + CROSSFADE_SECONDS + 0.2));
    }
    this.pad = { group, oscillators };
  }

  /** Move through the chords, and place a few distant notes in between. */
  private startLoops() {
    this.stopLoops();
    this.chordTimer = window.setInterval(() => {
      if (!this.ready()) return;
      this.chord = (this.chord + 1) % CHORDS.length;
      this.playChord(this.chord, CROSSFADE_SECONDS);
    }, CHORD_SECONDS * 1000);

    const distantNote = () => {
      if (this.ready()) {
        const step = Math.floor(Math.random() * 5);
        const octave = Math.random() < 0.7 ? 2 : 1;
        this.felt(this.tone(step, octave), {
          gain: 0.008 + Math.random() * 0.006,
          decay: 5,
          attack: 0.035,
          pan: Math.random() * 1.4 - 0.7,
          bright: 2200,
          echo: 0.6,
        });
        // Sometimes a second note answers the first.
        if (Math.random() < 0.35) {
          this.felt(this.tone(step + 2, octave), {
            gain: 0.006,
            decay: 4.5,
            attack: 0.035,
            delay: 0.6 + Math.random() * 0.6,
            pan: Math.random() * 1.4 - 0.7,
            bright: 2000,
            echo: 0.6,
          });
        }
      }
      this.notesTimer = window.setTimeout(distantNote, 5000 + Math.random() * 6000);
    };
    this.notesTimer = window.setTimeout(distantNote, 3000);
  }

  private stopLoops() {
    window.clearInterval(this.chordTimer);
    window.clearTimeout(this.notesTimer);
  }

  /**
   * The one instrument: a triangle and sine an octave apart, struck softly, through a lowpass
   * that closes as the note fades. Sounds like a felt piano heard through glass.
   */
  private felt(frequency: number, { gain, decay = 2.5, attack = 0.012, pan = 0, delay = 0, bright = 2600, echo = 0 }: FeltOptions) {
    const ctx = this.ctx!;
    const start = ctx.currentTime + delay;
    const end = start + decay;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);

    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 0.4;
    tone.frequency.setValueAtTime(bright, start);
    tone.frequency.exponentialRampToValueAtTime(Math.max(260, bright * 0.3), start + decay * 0.7);

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    (
      [
        ["sine", 1, 1],
        ["triangle", 1, 0.45],
        ["sine", 2, 0.12],
      ] as const
    ).forEach(([type, ratio, level]) => {
      const osc = ctx.createOscillator();
      const partial = ctx.createGain();
      osc.type = type;
      osc.frequency.value = frequency * ratio;
      partial.gain.value = level;
      osc.connect(partial).connect(tone);
      osc.start(start);
      osc.stop(end + 0.1);
    });

    tone.connect(envelope).connect(panner).connect(this.fxTone);
    if (echo > 0) {
      const send = ctx.createGain();
      send.gain.value = echo;
      panner.connect(send).connect(this.echoIn);
    }
  }

  /** Air: noise swept through a soft bandpass. */
  private air(volume: number, from: number, to: number, duration: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(from, now);
    filter.frequency.exponentialRampToValueAtTime(to, now + duration);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(volume, now + duration * 0.45);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(envelope).connect(this.fxTone);
    source.start(now);
    source.stop(now + duration + 0.05);
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Pinkish noise (Paul Kellet's filter): softer than white noise, closer to real air.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
    }
    return buffer;
  }

  /** A stereo reverb tail: decaying noise, slightly different in each ear. */
  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }
}

export const sound = new SoundEngine();
