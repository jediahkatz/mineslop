// Original procedural sound building blocks. No network, decoded files or worklets.
export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_VARIANTS = 3;
export const MAX_SAMPLE_SECONDS = 1.5;
export const TAU = Math.PI * 2;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function seededNoise(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x80000000 - 1;
  };
}

/** Smooth finite attack/release, including short syllables inside a call. */
export function envelope(time, duration, attack = 0.008, release = 0.04) {
  if (time <= 0 || time >= duration) return 0;
  const rise = clamp(time / attack, 0, 1);
  const fall = clamp((duration - time) / release, 0, 1);
  return rise * rise * (3 - 2 * rise) * fall * fall * (3 - 2 * fall);
}

/** Stable two-pole vocal/body resonance; coefficients are not rebuilt per sample. */
export function resonator(frequency, bandwidth) {
  const radius = Math.exp((-Math.PI * bandwidth) / AUDIO_SAMPLE_RATE);
  const a = 2 * radius * Math.cos((TAU * frequency) / AUDIO_SAMPLE_RATE);
  const b = radius * radius;
  let previous = 0;
  let older = 0;
  return (input) => {
    const next = (1 - radius) * input + a * previous - b * older;
    older = previous;
    previous = next;
    return next;
  };
}

export function sampleArray(duration) {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_SAMPLE_SECONDS
  )
    throw new RangeError("Sound duration exceeds the finite sample budget");
  return new Float32Array(Math.ceil(duration * AUDIO_SAMPLE_RATE));
}

/** Remove DC, retain headroom and taper both ends even after resonant filtering. */
export function finishSample(data) {
  let mean = 0;
  for (const value of data) mean += value;
  mean /= data.length;
  let peak = 0;
  const fade = Math.ceil(AUDIO_SAMPLE_RATE * 0.004);
  for (let i = 0; i < data.length; i++) {
    data[i] =
      (data[i] - mean) *
      Math.min(1, i / fade, (data.length - 1 - i) / fade);
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > 0) {
    const scale = 0.68 / peak;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
  return data;
}
