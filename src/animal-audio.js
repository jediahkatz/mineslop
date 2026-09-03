import {
  AUDIO_SAMPLE_RATE,
  TAU,
  clamp,
  envelope,
  finishSample,
  resonator,
  sampleArray,
  seededNoise,
} from "./audio-dsp.js";

// These are original vocal gestures, not imitations made from game recordings.
// Fixed profiles also bound the cache and cooldown keys; unknown wildlife is quiet.
const CALLS = Object.freeze({
  cow: { duration: 1.18, pitch: 112, formants: [430, 920], cooldown: 7 },
  sheep: { duration: 0.78, pitch: 285, formants: [720, 1680], cooldown: 6 },
  goat: { duration: 0.7, pitch: 335, formants: [860, 1820], cooldown: 6 },
  pig: { duration: 0.57, pitch: 145, formants: [610, 1160], cooldown: 5 },
  chicken: { duration: 0.65, pitch: 780, formants: [1160, 2380], cooldown: 5 },
  horse: { duration: 1.45, pitch: 430, formants: [1020, 2370], cooldown: 8 },
  wolf: { duration: 1.35, pitch: 260, formants: [570, 1080], cooldown: 10 },
});

export function animalCallProfile(species) {
  const canonical = species === "mooshroom" ? "cow" : species;
  if (typeof canonical !== "string" || !Object.hasOwn(CALLS, canonical))
    return null;
  return { species: canonical, ...CALLS[canonical] };
}

function syllable(time, start, duration) {
  return envelope(time - start, duration, 0.012, 0.065);
}

function gesture(species, time, duration, voice) {
  const u = time / duration;
  switch (species) {
    case "cow":
      // An opening nasal "mm" settles into a low, rounded "oo".
      voice.pitch = 1 + 0.27 * Math.sin(Math.PI * u) - 0.16 * u;
      voice.level = envelope(time, duration, 0.075, 0.22);
      voice.breath = 0.025;
      voice.vowel = 0.25 + 0.55 * Math.sin(Math.PI * u);
      break;
    case "sheep":
    case "goat":
      // Interrupted voicing and pitch tremor make a bleat instead of a pure beep.
      voice.pitch =
        1 +
        0.13 * Math.sin(Math.PI * u) -
        0.16 * u +
        0.035 * Math.sin(TAU * 11 * time);
      voice.level =
        envelope(time, duration, 0.04, 0.14) *
        (0.64 + 0.36 * Math.sin(TAU * 12 * time) ** 2);
      voice.breath = 0.045;
      voice.vowel = 0.85;
      break;
    case "pig":
      voice.pitch = 1.12 - 0.22 * u + 0.045 * Math.sin(TAU * 23 * time);
      voice.level =
        syllable(time, 0.01, 0.22) + 0.8 * syllable(time, 0.29, 0.26);
      voice.breath = 0.22;
      voice.vowel = 0.58;
      break;
    case "chicken": {
      // Two short, falling clucks followed by a softer, longer throat rattle.
      const start = time < 0.15 ? 0 : time < 0.31 ? 0.16 : 0.33;
      const local = time - start;
      voice.pitch = 1.25 - 0.62 * clamp(local / 0.13, 0, 1);
      voice.level =
        syllable(time, 0.005, 0.13) +
        0.82 * syllable(time, 0.165, 0.13) +
        0.66 * syllable(time, 0.335, 0.3);
      voice.breath = 0.1;
      voice.vowel = 0.9;
      break;
    }
    case "horse": {
      const tail = clamp((time - 0.4) / 0.85, 0, 1);
      voice.pitch =
        (time < 0.3 ? 1 + time * 2.3 : 1.69 - tail * 1.02) *
        (1 + 0.07 * tail * Math.sin(TAU * 8.5 * time));
      voice.level =
        envelope(time, duration, 0.055, 0.22) *
        (1 - tail * 0.58 * (0.5 + 0.5 * Math.sin(TAU * 8.5 * time)));
      voice.breath = 0.035 + 0.08 * tail;
      voice.vowel = 0.7;
      break;
    }
    case "wolf":
      // A short breathy "a-woo", not a repeated bark loop or ambient howl bed.
      voice.pitch =
        0.9 +
        0.35 * Math.sin(Math.PI * u) -
        0.09 * u +
        0.009 * Math.sin(TAU * 5 * time);
      voice.level = envelope(time, duration, 0.14, 0.28);
      voice.breath = 0.045;
      voice.vowel = 0.8 - 0.55 * u;
      break;
    default:
      voice.level = 0;
  }
}

export function synthesizeAnimal(species, variant = 0) {
  const profile = animalCallProfile(species);
  if (!profile) return null;
  const variation = clamp(Math.trunc(variant) || 0, 0, 2);
  const pitchScale = 1 + (variation - 1) * 0.035;
  const data = sampleArray(profile.duration);
  const noise = seededNoise(profile.pitch * 157 + variation * 92821);
  const throat = resonator(profile.formants[0] * pitchScale, 160);
  const mouth = resonator(profile.formants[1] * pitchScale, 260);
  const voice = { pitch: 1, level: 0, breath: 0, vowel: 0 };
  let phase = 0;
  let breath = 0;
  for (let i = 0; i < data.length; i++) {
    const time = i / AUDIO_SAMPLE_RATE;
    gesture(profile.species, time, profile.duration, voice);
    phase +=
      (TAU * profile.pitch * pitchScale * voice.pitch) / AUDIO_SAMPLE_RATE;
    // A band-limited glottal pulse train feeds vocal-tract resonances.
    let voiced = 0;
    for (let harmonic = 1; harmonic <= 8; harmonic++)
      voiced += Math.sin(phase * harmonic) / harmonic;
    breath += (noise() - breath) * 0.38;
    const excitation = voiced * voice.level;
    const body =
      throat(excitation) * (1 - voice.vowel * 0.4) +
      mouth(excitation) * voice.vowel * 0.7;
    data[i] =
      (body * 0.85 +
        voiced * 0.12 * voice.level +
        breath * voice.breath * voice.level) *
      envelope(time, profile.duration, 0.012, 0.07);
  }
  return finishSample(data);
}
