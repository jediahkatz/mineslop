import { sampleArray, seededNoise } from "./audio-dsp.js";

export const RAIN_SOUND = Object.freeze({
  family: "rain", group: "weather", gain: 0.12, duration: 1.5,
});

/** Original filtered-noise rain bed, not a recording or a musical quotation.
 * A second circular filter pass settles the boundary; no repeating attack/tail.
 * One 1.5-second mono PCM entry uses the existing SoundBank allocation limits.
 */
export function synthesizeRain() {
  const noise = sampleArray(RAIN_SOUND.duration);
  const samples = new Float32Array(noise.length);
  const random = seededNoise(0x72a1f04);
  for (let i = 0; i < noise.length; i++) noise[i] = random();
  let low = 0, body = 0, mean = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < noise.length; i++) {
      low += 0.28 * (noise[i] - low);
      body += 0.018 * (low - body);
      samples[i] = low - body * 0.7;
    }
  for (const value of samples) mean += value / samples.length;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] -= mean;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak > 0)
    for (let i = 0; i < samples.length; i++) samples[i] *= 0.68 / peak;
  return samples;
}
