import { AUDIO_VARIANTS, clamp } from "./audio-dsp.js";
import { AmbientMusic } from "./audio-music.js";
import { soundDescription } from "./audio-samples.js";
import { spatialSound } from "./audio-spatial.js";
import { MAX_SOUND_BUFFERS, MAX_SOUND_BYTES, SoundBank } from "./sound-bank.js";

export const MAX_AUDIO_VOICES = 12;
export const AUDIO_MASTER_GAIN = 0.72;
export const MAX_VOICE_GAIN = 0.15;
export const AUDIO_LIMITS = Object.freeze({
  voices: MAX_AUDIO_VOICES,
  reservedVoices: 2,
  animalVoices: 2,
  animalGapSeconds: 1.1,
  cachedBuffers: MAX_SOUND_BUFFERS,
  cachedBytes: MAX_SOUND_BYTES,
});
const MUTE_FADE = 0.015;
const MUTE_STOP = 0.018;

function browserContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context() : null;
}

function disconnect(node) {
  try {
    node?.disconnect();
  } catch {
    // Context shutdown can race a browser's onended delivery.
  }
}

function close(context) {
  if (!context || context.state === "closed") return;
  try {
    void Promise.resolve(context.close()).catch(() => {});
  } catch {
    // Audio remains optional even if the device disappears during shutdown.
  }
}

/** One optional context and bank; each voice adds a source, gain and optional pan. */
export class AudioEngine {
  constructor({ createContext = browserContext, random } = {}) {
    this.createContext = createContext;
    this.random = random;
    this.context = null;
    this.master = null;
    this.bank = null;
    this.enabled = true;
    this.volume = 1;
    this.paused = false;
    this.hidden = false;
    this.lifecycleRevision = 0;
    this.music = new AmbientMusic();
    this.disposed = false;
    this.resuming = null;
    this.voices = new Set();
    this.lastPlayed = new Map();
    this.lastAnimal = -Infinity;
    this.serial = 0;
    this._emptyBuffers = new Map();
  }

  get buffers() {
    return this.bank?.buffers ?? this._emptyBuffers;
  }

  get cachedBytes() {
    return this.bank?.bytes ?? 0;
  }

  /** Call only from a user gesture. Never create/resume contexts from play(). */
  unlock() {
    if (this.disposed || !this.enabled || this.hidden) return Promise.resolve(false);
    if (this.context?.state === "closed") this._clearGraph();
    if (!this.context) {
      try {
        this.context = this.createContext();
        if (!this.context) return Promise.resolve(false);
        this.master = this.context.createGain();
        this.master.gain.setValueAtTime(AUDIO_MASTER_GAIN * this.volume, this.context.currentTime);
        this.master.connect(this.context.destination);
        this.bank = new SoundBank(this.context);
      } catch {
        this._clearGraph();
        return Promise.resolve(false);
      }
    }
    const context = this.context;
    if (context.state === "running") return Promise.resolve(true);
    if (this.resuming) return this.resuming;
    try {
      const pending = Promise.resolve(context.resume())
        .then(
          () =>
            this.context === context &&
            !this.disposed &&
            this.enabled &&
            !this.hidden &&
            context.state === "running",
          () => false
        )
        .finally(() => {
          if (this.resuming === pending) this.resuming = null;
        });
      this.resuming = pending;
      return pending;
    } catch {
      return Promise.resolve(false);
    }
  }

  setEnabled(enabled) {
    if (this.disposed || this.enabled === Boolean(enabled)) return;
    this.enabled = Boolean(enabled);
    this.lifecycleRevision++;
    this.music.reset();
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    let faded = false;
    try {
      const gain = this.master.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
      else {
        const value = gain.value;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(value, now);
      }
      if (this.enabled) gain.setValueAtTime(0, now);
      gain.linearRampToValueAtTime(this.enabled ? AUDIO_MASTER_GAIN * this.volume : 0, now + MUTE_FADE);
      faded = true;
    } catch {
      // A suspended/closing context may refuse automation; still stop voices.
    }
    for (const voice of this.voices) {
      if (this.enabled) {
        if (voice.muted) this._releaseVoice(voice, true);
      } else if (faded && this.context.state === "running") {
        voice.muted = true;
        voice.endTime = Math.min(voice.endTime, now + MUTE_STOP);
        try {
          voice.source.stop(voice.endTime);
        } catch {
          this._releaseVoice(voice, true);
        }
      } else {
        this._releaseVoice(voice, true);
      }
    }
  }

  setVolume(volume) {
    if (this.disposed || !Number.isFinite(volume)) return;
    const next = clamp(volume, 0, 1);
    if (next === this.volume) return;
    this.volume = next;
    this.lifecycleRevision++;
    if (this.master && this.context?.state !== "closed") {
      const now = this.context.currentTime;
      const gain = this.master.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
      else {
        const value = gain.value;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(value, now);
      }
      gain.linearRampToValueAtTime(this.enabled ? AUDIO_MASTER_GAIN * this.volume : 0, now + MUTE_FADE);
    }
    if (!this.volume) {
      this.music.reset();
      for (const voice of this.voices) this._releaseVoice(voice, true);
    }
  }

  setPaused(paused) {
    if (this.disposed || this.paused === Boolean(paused)) return;
    this.paused = Boolean(paused);
    this.lifecycleRevision++;
    this.music.reset();
    if (this.paused)
      for (const voice of this.voices)
        if (voice.group !== "ui") this._releaseVoice(voice, true);
  }

  setHidden(hidden) {
    if (this.disposed || this.hidden === Boolean(hidden)) return;
    this.hidden = Boolean(hidden);
    this.lifecycleRevision++;
    this.music.reset();
    if (this.hidden)
      for (const voice of this.voices) this._releaseVoice(voice, true);
  }

  update(dt) {
    if (this.disposed || !this.enabled || this.paused || this.hidden ||
      this.volume === 0 || this.context?.state !== "running") return;
    this.music.update(dt, (note) => this.play("music", note));
  }

  /** Admission only. Refused/suspended sounds are dropped, never queued. */
  play(kind = "mine", id = 3, options = {}, listener = null) {
    if (this.disposed || !this.enabled || this.hidden || this.volume === 0 ||
      (this.paused && kind !== "ui-click") || this.context?.state !== "running")
      return false;
    const definition = soundDescription(kind, id);
    if (!definition) return false;
    const spatial = spatialSound(options, listener, kind === "horse-step" ? 18 : 24);
    if (!spatial || spatial.gain <= 0.001) return false;
    const now = this.context.currentTime;
    for (const voice of this.voices)
      if (voice.endTime <= now) this._releaseVoice(voice, true);

    const last = this.lastPlayed.get(definition.cooldownKey) ?? -Infinity;
    if (now - last < definition.cooldown) return false;
    if (kind === "animal" && now - this.lastAnimal < AUDIO_LIMITS.animalGapSeconds)
      return false;
    // Reserve two voices for level/teleport cues. Drop overflow rather than cut
    // an audible tail; movement and pickup storms also have per-group ceilings.
    const budget = definition.priority
      ? MAX_AUDIO_VOICES
      : MAX_AUDIO_VOICES - AUDIO_LIMITS.reservedVoices;
    if (this.voices.size >= budget) return false;
    let count = 0;
    for (const voice of this.voices)
      if (voice.group === definition.group) count++;
    const groupLimit = kind === "animal" ? AUDIO_LIMITS.animalVoices : definition.limit;
    if (count >= groupLimit) return false;

    const voice = {
      source: null,
      gain: null,
      panner: null,
      group: definition.group,
      animal: kind === "animal",
      released: false,
    };
    try {
      let sample;
      if (kind === "music") {
        const buffer = this.bufferFor(definition, 0);
        if (buffer) sample = { buffer, variant: 0 };
      } else if (typeof this.random === "function") {
        const draw = this.random();
        const variant = Math.floor(
          clamp(Number.isFinite(draw) ? draw : 0, 0, 0.999999) * AUDIO_VARIANTS
        );
        const buffer = this.bufferFor(definition, variant);
        if (buffer) sample = { buffer, variant };
      } else {
        sample = this.bank.next(definition);
      }
      if (!sample) return false;
      const { buffer, variant } = sample;
      // A cold PCM render can advance the device clock. Schedule the complete
      // attack/release from actual playback admission, not pre-synthesis time.
      const start = this.context.currentTime;
      this.serial = (this.serial + 1) >>> 0;
      const jitter = ((Math.imul(this.serial, 1103515245) >>> 8) & 65535) / 65535;
      const rate = kind === "animal" || kind === "music"
        ? 1
        : clamp(definition.rate * (0.97 + jitter * 0.06), 0.75, 1.5);
      const level = Math.min(
        MAX_VOICE_GAIN,
        definition.gain * (0.93 + variant * 0.035)
      ) * spatial.gain;
      voice.source = this.context.createBufferSource();
      voice.gain = this.context.createGain();
      voice.source.buffer = buffer;
      voice.source.playbackRate.setValueAtTime(rate, start);
      const duration = buffer.duration / rate;
      // Baked envelopes plus a short output taper; no live filter/oscillator.
      voice.gain.gain.setValueAtTime(0, start);
      voice.gain.gain.linearRampToValueAtTime(level, start + 0.004);
      voice.gain.gain.setValueAtTime(level, start + duration - 0.02);
      voice.gain.gain.linearRampToValueAtTime(0, start + duration);
      voice.source.connect(voice.gain);
      if (typeof this.context.createStereoPanner === "function") {
        voice.panner = this.context.createStereoPanner();
        voice.panner.pan.value = spatial.pan;
        voice.gain.connect(voice.panner).connect(this.master);
      } else {
        voice.gain.connect(this.master);
      }
      voice.endTime = start + duration + 0.004;
      voice.source.onended = () => this._releaseVoice(voice);
      this.voices.add(voice);
      voice.source.start(start);
      voice.source.stop(voice.endTime);
      this.lastPlayed.set(definition.cooldownKey, start);
      if (kind === "animal") this.lastAnimal = start;
      return true;
    } catch {
      this._releaseVoice(voice, true);
      return false;
    }
  }

  bufferFor(definition, variant = 0) {
    return this.bank?.get(definition, variant) ?? null;
  }

  _releaseVoice(voice, stop = false) {
    if (voice.released) return;
    voice.released = true;
    this.voices.delete(voice);
    if (voice.source) {
      voice.source.onended = null;
      if (stop) {
        try {
          voice.source.stop();
        } catch {
          // It may have already ended, or failed before start().
        }
      }
      disconnect(voice.source);
    }
    disconnect(voice.gain);
    disconnect(voice.panner);
  }

  _clearGraph() {
    for (const voice of this.voices) this._releaseVoice(voice, true);
    this.bank?.dispose();
    disconnect(this.master);
    const context = this.context;
    this.context = null;
    this.master = null;
    this.bank = null;
    this.resuming = null;
    this.lastPlayed.clear();
    this.lastAnimal = -Infinity;
    close(context);
  }

  diagnostics() {
    return {
      state: this.disposed ? "disposed" : this.context?.state ?? "locked",
      enabled: this.enabled,
      volume: this.volume,
      paused: this.paused,
      hidden: this.hidden,
      voices: this.voices.size,
      animalVoices: [...this.voices].filter((voice) => voice.animal).length,
      cachedBuffers: this.buffers.size,
      cachedBytes: this.cachedBytes,
      limits: AUDIO_LIMITS,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleRevision++;
    this.enabled = false;
    this._clearGraph();
  }
}
