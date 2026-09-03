import {
  AUDIO_SAMPLE_RATE,
  AUDIO_VARIANTS,
  clamp,
} from "./audio-dsp.js";
import {
  soundSampleKey,
  synthesizeSound,
} from "./audio-samples.js";

export const MAX_SOUND_BUFFERS = 48;
export const MAX_SOUND_BYTES = 2 * 1024 * 1024;

/** Cache hits reuse PCM; lazy misses have both entry and byte ceilings. */
export class SoundBank {
  constructor(context) {
    this.context = context;
    this.buffers = new Map();
    this.variants = new Map();
    this.bytes = 0;
    this.disposed = false;
    this.seed = 0x9e3779b9;
  }

  next(definition) {
    if (this.disposed) return null;
    const familyKey = soundSampleKey(definition);
    if (!familyKey) return null;
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    const variant =
      ((this.variants.get(familyKey) ?? 0) + 1 + (this.seed & 1)) % AUDIO_VARIANTS;
    if (!this.variants.has(familyKey) && this.variants.size >= MAX_SOUND_BUFFERS)
      this.variants.delete(this.variants.keys().next().value);
    this.variants.set(familyKey, variant);
    const buffer = this.get(definition, variant);
    return buffer ? { buffer, variant } : null;
  }

  /** Explicit variant access shares the same canonical LRU as next(). */
  get(definition, variant = 0) {
    if (this.disposed) return null;
    const familyKey = soundSampleKey(definition);
    if (!familyKey) return null;
    const selected = clamp(Math.trunc(variant) || 0, 0, AUDIO_VARIANTS - 1);
    const key = `${familyKey}:${selected}`;
    const cached = this.buffers.get(key);
    if (cached) {
      this.buffers.delete(key);
      this.buffers.set(key, cached);
      return cached;
    }
    const samples = synthesizeSound(definition, selected);
    if (!samples || samples.byteLength > MAX_SOUND_BYTES) return null;
    const buffer = this.context.createBuffer(
      1,
      samples.length,
      AUDIO_SAMPLE_RATE
    );
    buffer.getChannelData(0).set(samples);
    while (
      this.buffers.size >= MAX_SOUND_BUFFERS ||
      this.bytes + samples.byteLength > MAX_SOUND_BYTES
    ) {
      const oldest = this.buffers.keys().next().value;
      this.bytes -= this.buffers.get(oldest).length * Float32Array.BYTES_PER_ELEMENT;
      this.buffers.delete(oldest);
    }
    this.buffers.set(key, buffer);
    this.bytes += samples.byteLength;
    return buffer;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.buffers.clear();
    this.variants.clear();
    this.bytes = 0;
    this.context = null;
  }
}
