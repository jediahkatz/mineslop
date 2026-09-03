import {
  AUDIO_SAMPLE_RATE,
  AUDIO_VARIANTS,
  MAX_SAMPLE_SECONDS,
} from "./audio-dsp.js";
import { MATERIAL_SOUNDS } from "./material-sounds.js";

export const SOUND_SAMPLE_RATE = AUDIO_SAMPLE_RATE;
export const SOUND_VARIANTS = AUDIO_VARIANTS;
export const MAX_SOUND_DURATION = MAX_SAMPLE_SECONDS;
export const MAX_SOUND_PEAK = 0.65;

const TAU = Math.PI * 2;
const durations = Object.freeze({
  hit: 0.20,
  eat: 0.26,
  shoot: 0.20,
  throw: 0.24,
  xp: 0.32,
  levelup: 0.78,
  teleport: 0.60,
});

export function soundDuration({ family, material }) {
  const surface = MATERIAL_SOUNDS[material] ?? MATERIAL_SOUNDS.stone;
  if (family === "step") return surface.duration;
  if (family === "impact") return surface.duration * 1.08;
  if (family === "hoof") return Math.max(0.28, surface.duration + 0.095);
  return durations[family] ?? durations.hit;
}

function seededNoise(key) {
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++)
    seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  seed = seed || 1;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

const smooth = (value) => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};

function envelope(t, duration, attack, decay) {
  return smooth(t / attack) * Math.exp(-t / decay) *
    smooth((duration - t) / 0.018);
}

function tone(data, rate, {
  at = 0, duration, frequency, end = frequency, gain, decay = duration / 4,
  attack = 0.005,
}) {
  const start = Math.floor(at * rate);
  const count = Math.min(data.length - start, Math.ceil(duration * rate));
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const phase = TAU * (frequency * t + (end - frequency) * t * t / (2 * duration));
    data[start + i] += Math.sin(phase) * gain * envelope(t, duration, attack, decay);
  }
}

function noise(data, rate, random, {
  at = 0, duration, cutoff, gain, decay = duration / 3, attack = 0.007,
}) {
  // Two low-pass poles remove the white-noise edge; the slow pole removes DC.
  const fast = 1 - Math.exp(-TAU * cutoff / rate);
  const slow = 1 - Math.exp(-TAU * Math.min(180, cutoff * 0.15) / rate);
  let low = 0, rounded = 0, dc = 0;
  const start = Math.floor(at * rate);
  const count = Math.min(data.length - start, Math.ceil(duration * rate));
  for (let i = 0; i < count; i++) {
    low += fast * (random() * 2 - 1 - low);
    rounded += fast * (low - rounded);
    dc += slow * (rounded - dc);
    data[start + i] += (rounded - dc) * 2.6 * gain *
      envelope(i / rate, duration, attack, decay);
  }
}

function water(data, rate, random, strength) {
  noise(data, rate, random, {
    duration: 0.29, cutoff: 680, gain: 0.65 * strength, decay: 0.08, attack: 0.018,
  });
  noise(data, rate, random, {
    at: 0.045, duration: 0.19, cutoff: 1250, gain: 0.18 * strength, attack: 0.02,
  });
  for (let i = 0; i < 4; i++) {
    const frequency = 320 + random() * 240;
    tone(data, rate, {
      at: 0.025 + i * 0.055, duration: 0.09, frequency, end: frequency * 0.55,
      gain: (0.25 - i * 0.035) * strength, decay: 0.027, attack: 0.007,
    });
  }
}

function contact(data, rate, random, surface, at, strength, pitch) {
  for (let i = 0; i < surface.modes.length; i++) {
    const frequency = surface.root * surface.modes[i] * pitch;
    tone(data, rate, {
      at, duration: surface.duration * 0.8, frequency,
      end: frequency * (i === 0 ? 0.78 : 0.97),
      gain: surface.body * strength / (1 + i * 2.8),
      decay: surface.decay / (1 + i * 0.45),
    });
  }
  for (let i = 0; i < surface.grains; i++) {
    const delay = at + 0.005 + i * 0.012 + random() * 0.009;
    const duration = 0.025 + random() * 0.018;
    noise(data, rate, random, {
      at: delay, duration,
      cutoff: surface.cutoff * (0.85 + random() * 0.25),
      gain: surface.noise * strength * (1 - i / (surface.grains + 2)) /
        Math.sqrt(surface.grains),
      decay: duration * 0.42,
    });
    if (surface === MATERIAL_SOUNDS.gravel || surface === MATERIAL_SOUNDS.snow)
      tone(data, rate, {
        at: delay, duration: 0.032,
        frequency: surface.root * (1.1 + random() * 1.9),
        gain: strength * 0.065, decay: 0.009, attack: 0.004,
      });
  }
}

function surfaceSound(data, rate, random, { family, material }) {
  const surface = MATERIAL_SOUNDS[material] ?? MATERIAL_SOUNDS.stone;
  const pitch = 0.93 + random() * 0.14;
  if (material === "water") {
    water(data, rate, random, family === "hoof" ? 0.8 : 1);
  } else {
    contact(data, rate, random, surface, 0, family === "hoof" ? 0.5 : 0.9, pitch);
    if (family === "step")
      contact(data, rate, random, surface, 0.037 + random() * 0.014, 0.33, pitch * 0.94);
  }
  if (family === "hoof") {
    const hard = ["stone", "wood", "metal", "glass", "gravel"].includes(material);
    // One admitted stride mixes a hoof pair into one buffer, never a gait loop.
    for (const [at, strength] of [[0, 1], [0.095, 0.76]]) {
      const hoofPitch = pitch * (at ? 0.94 : 1);
      if (at && material !== "water")
        contact(data, rate, random, surface, at, 0.5 * strength, hoofPitch);
      tone(data, rate, {
        at, duration: 0.13, frequency: 310 * hoofPitch, end: 265 * hoofPitch,
        gain: (hard ? 0.46 : 0.20) * strength, decay: 0.027,
      });
      tone(data, rate, {
        at: at + 0.018, duration: 0.09, frequency: 540 * hoofPitch,
        gain: (hard ? 0.20 : 0.07) * strength, decay: 0.018,
      });
    }
  }
}

function specialSound(data, rate, random, family) {
  if (family === "xp") {
    tone(data, rate, { duration: 0.30, frequency: 720, gain: 0.47, decay: 0.07, attack: 0.008 });
    tone(data, rate, { duration: 0.17, frequency: 1443, gain: 0.10, decay: 0.037 });
  } else if (family === "levelup") {
    // Original, restrained three-note bloom; no sampled or transcribed game cue.
    for (const [i, frequency] of [330, 415.3, 554.37].entries()) {
      tone(data, rate, {
        at: i * 0.085, duration: 0.55, frequency,
        gain: 0.32 - i * 0.025, decay: 0.15, attack: 0.018,
      });
      tone(data, rate, {
        at: i * 0.085, duration: 0.30, frequency: frequency * 2.003,
        gain: 0.055, decay: 0.09, attack: 0.015,
      });
    }
  } else if (family === "teleport") {
    tone(data, rate, {
      duration: 0.56, frequency: 190, end: 570, gain: 0.37, decay: 0.18, attack: 0.055,
    });
    tone(data, rate, {
      at: 0.07, duration: 0.47, frequency: 475, end: 310, gain: 0.22, decay: 0.17, attack: 0.045,
    });
    noise(data, rate, random, {
      duration: 0.46, cutoff: 780, gain: 0.28, decay: 0.16, attack: 0.06,
    });
  } else if (family === "eat") {
    for (let i = 0; i < 3; i++) {
      noise(data, rate, random, {
        at: i * 0.068, duration: 0.07, cutoff: 900 + random() * 250, gain: 0.32,
      });
      tone(data, rate, {
        at: i * 0.068, duration: 0.08, frequency: 145 + random() * 35, gain: 0.20,
      });
    }
  } else if (family === "shoot" || family === "throw") {
    noise(data, rate, random, {
      duration: 0.17, cutoff: family === "throw" ? 570 : 1000,
      gain: 0.45, attack: 0.012, decay: 0.046,
    });
    if (family === "shoot")
      tone(data, rate, {
        duration: 0.17, frequency: 280, end: 140, gain: 0.40, decay: 0.035,
      });
  } else {
    tone(data, rate, {
      duration: 0.19, frequency: 115, end: 62, gain: 0.72, decay: 0.036,
    });
    noise(data, rate, random, {
      duration: 0.09, cutoff: 1100, gain: 0.35, attack: 0.005,
    });
  }
}

/** Fill the cached mono buffer directly: deterministic, original PCM, no audio APIs. */
export function synthesizeSound(data, sampleRate, definition, variant = 0) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96_000)
    throw new RangeError("Unsupported synthesis sample rate");
  data.fill(0);
  const random = seededNoise(`${definition.family}:${definition.material}:${variant}`);
  if (["step", "impact", "hoof"].includes(definition.family))
    surfaceSound(data, sampleRate, random, definition);
  else
    specialSound(data, sampleRate, random, definition.family);

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] *= smooth(i / (sampleRate * 0.006)) *
      smooth((data.length - 1 - i) / (sampleRate * 0.028));
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > MAX_SOUND_PEAK) {
    const scale = MAX_SOUND_PEAK / peak;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}
