import {
  AUDIO_SAMPLE_RATE, TAU, envelope, finishSample, sampleArray, seededNoise,
} from "./audio-dsp.js";

// Original six-note palette, not a transcription of any existing soundtrack.
export const MUSIC_PITCHES = Object.freeze([174.614, 220, 261.626, 293.665, 349.228, 440]);

export function extraSoundDescription(kind, id) {
  const common = { kind, rate: 1, material: null, priority: false };
  if (kind === "music" && Number.isInteger(id) && id >= 0 && id < MUSIC_PITCHES.length)
    return { ...common, family: "music", note: id, key: `music:${id}`,
      cooldownKey: "music", cooldown: 0.6, group: "music", limit: 2, gain: 0.027, duration: 1.5 };
  if (kind === "ui-click")
    return { ...common, family: "ui-click", key: "ui-click", cooldownKey: "ui-click",
      cooldown: 0.055, group: "ui", limit: 2, gain: 0.045, duration: 0.075 };
  if (kind === "water-entry" || kind === "water-jump")
    return { ...common, family: "splash", key: "splash", cooldownKey: kind,
      cooldown: 0.28, group: "water", limit: 2, gain: kind === "water-entry" ? 0.085 : 0.055,
      rate: kind === "water-entry" ? 1 : 1.18, duration: 0.68 };
  return null;
}

export function extraSampleKey(definition) {
  if (definition.family === "music")
    return Number.isInteger(definition.note) && MUSIC_PITCHES[definition.note]
      ? `music:${definition.note}` : null;
  return ["ui-click", "splash"].includes(definition.family) ? definition.family : null;
}

export function synthesizeExtra(definition, variant) {
  const duration = definition.family === "music" ? 1.5 : definition.family === "splash" ? 0.68 : 0.075;
  const data = sampleArray(duration);
  const random = seededNoise(0x7c49a + variant * 7919);
  let low = 0, rounded = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / AUDIO_SAMPLE_RATE;
    if (definition.family === "music") {
      const phase = TAU * MUSIC_PITCHES[definition.note] * t;
      data[i] = (Math.sin(phase) + 0.15 * Math.sin(phase * 2) * Math.exp(-t * 4)) *
        envelope(t, duration, 0.065, 0.48) * Math.exp(-t * 1.8);
    } else if (definition.family === "ui-click") {
      data[i] = Math.sin(TAU * (410 * t - 650 * t * t)) *
        envelope(t, duration, 0.003, 0.025) * Math.exp(-t * 55);
    } else {
      low += 0.15 * (random() - low);
      rounded += 0.12 * (low - rounded);
      let bubbles = 0;
      for (let b = 0; b < 4; b++) {
        const local = t - 0.065 - b * 0.095;
        if (local > 0 && local < 0.14)
          bubbles += Math.sin(TAU * ((430 + variant * 27 + b * 48) * local - 540 * local * local)) *
            envelope(local, 0.14, 0.009, 0.065) * Math.exp(-local * 25) * 0.12;
      }
      data[i] = (rounded * Math.exp(-t * 7) * 3 + bubbles) *
        envelope(t, duration, 0.022, 0.16);
    }
  }
  return finishSample(data);
}
