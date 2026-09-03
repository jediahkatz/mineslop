import { HORSE_TAMING_TICKS, HORSE_TICKS_PER_SECOND } from "./horse-definitions.js";

export function horseStableDraw(context, id, dimension, key) {
  // Length-prefixed JSON fields preserve raw seed spelling and avoid delimiter
  // aliases. Never advance Wildlife's appearance/spawn RNG during preparation.
  const text = JSON.stringify([String(context.seed), context.generatorVersion, id, dimension, key]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4294967296;
}

export const pendingHorseBuck = (entry) =>
  entry?.alive === true && !entry.tamed && entry.rider !== null &&
  entry.tamingTicksLeft === 0 && entry.failedAttempts > 0;

/** Pure, bounded next state. A completed blocked failure has no new RNG draw. */
export function advanceHorseTaming(entry, seconds, context) {
  if (!entry.alive || entry.tamed || entry.rider === null || pendingHorseBuck(entry) ||
    !Number.isFinite(seconds) || seconds <= 0) return { entry, outcome: null };
  const remaining = Math.max(0, entry.tamingTicksLeft -
    Math.min(seconds, 0.2) * HORSE_TICKS_PER_SECOND);
  if (remaining > 1e-8)
    return { entry: { ...entry, tamingTicksLeft: remaining }, outcome: null };
  const succeeds = entry.temper >= 100 ||
    horseStableDraw(context, entry.id, entry.dimension, `tame:${entry.failedAttempts}`) * 100 < entry.temper;
  if (succeeds)
    return { entry: { ...entry, tamed: true, tamingTicksLeft: 0 }, outcome: "tamed" };
  return {
    entry: { ...entry, tamingTicksLeft: 0,
      temper: Math.min(100, entry.temper + 5),
      failedAttempts: Math.min(20, entry.failedAttempts + 1) },
    outcome: "failed",
  };
}

export function unseatHorse(entry) {
  return {
    ...entry, rider: null,
    tamingTicksLeft: pendingHorseBuck(entry) ? HORSE_TAMING_TICKS : entry.tamingTicksLeft,
    // Momentum/fall remains owned until landing, including an airborne travel.
    motion: entry.motion?.grounded ? null : entry.motion,
  };
}
