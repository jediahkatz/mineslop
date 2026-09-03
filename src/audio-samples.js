import { animalCallProfile, synthesizeAnimal } from "./animal-audio.js";
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_VARIANTS,
  clamp,
  sampleArray,
} from "./audio-dsp.js";
import { BLOCK } from "./blocks.js";
import {
  MATERIAL_SOUNDS,
  materialForBlock,
  soundDefinition,
} from "./material-sounds.js";
import {
  soundDuration,
  synthesizeSound as synthesizeAction,
} from "./sound-synthesis.js";

const SURFACE_FAMILIES = new Set(["step", "impact", "hoof"]);
const ACTION_FAMILIES = new Set([
  ...SURFACE_FAMILIES,
  "hit",
  "eat",
  "shoot",
  "throw",
  "xp",
  "levelup",
  "teleport",
]);

/** Preserve the standalone material catalog, including boats and soft sponges. */
export function soundMaterial(id) {
  return Number.isInteger(id) && id !== BLOCK.AIR ? materialForBlock(id) : null;
}

/** Canonical keys never include raw entity IDs, amounts, levels or coordinates. */
export function soundSampleKey(definition) {
  if (!definition) return null;
  if (definition.family === "animal") {
    const call = animalCallProfile(definition.species);
    return call ? `animal:${call.species}` : null;
  }
  if (!ACTION_FAMILIES.has(definition.family)) return null;
  if (SURFACE_FAMILIES.has(definition.family)) {
    if (!Object.hasOwn(MATERIAL_SOUNDS, definition.material)) return null;
    return `${definition.family}:${definition.material}`;
  }
  return definition.family;
}

/** Add animal calls to the existing material/action definitions, not a second bank. */
export function soundDescription(kind = "mine", id = BLOCK.STONE) {
  if (kind === "animal") {
    const call = animalCallProfile(id);
    if (!call) return null;
    return {
      ...call,
      kind,
      family: "animal",
      material: null,
      key: `animal:${call.species}`,
      cooldownKey: `animal:${call.species}`,
      group: "animal",
      limit: 2,
      interval: call.cooldown,
      rate: 1,
      gain: call.species === "chicken" ? 0.1 : 0.14,
    };
  }
  const definition = soundDefinition(kind, id);
  if (!definition) return null;
  return {
    ...definition,
    key: soundSampleKey(definition),
    cooldownKey: definition.kind,
    cooldown: definition.interval,
    duration: soundDuration(definition),
  };
}

/** The material/action DSP is retained; animal PCM uses its own vocal gestures. */
export function synthesizeSound(description, variant = 0) {
  if (!soundSampleKey(description)) return null;
  const variation = clamp(Math.trunc(variant) || 0, 0, AUDIO_VARIANTS - 1);
  if (description.family === "animal")
    return synthesizeAnimal(description.species, variation);
  const data = sampleArray(soundDuration(description));
  synthesizeAction(data, AUDIO_SAMPLE_RATE, description, variation);
  return data;
}
