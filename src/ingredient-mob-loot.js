import { ITEM } from "./items.js";

export const INGREDIENT_LOOT_VERSION = 1;
export const isIngredientMob = (mob) => mob?.kind === "spider" || mob?.kind === "ghast";

/**
 * Immutable death quote. Independent named rolls keep environmental base loot
 * identical to player loot and never consume Wildlife's AI RNG. No save fields.
 * Immediate player kills only: delayed credit/reflected fireballs are not inferred.
 */
export function ingredientMobLoot(world, mob, directPlayer = false) {
  if (!isIngredientMob(mob) || typeof mob.id !== "string" ||
      typeof directPlayer !== "boolean") return null;
  const key = JSON.stringify([
    String(world.seed), world.dimension, world.generatorVersion, mob.id,
    mob.kind, INGREDIENT_LOOT_VERSION,
  ]);
  const roll = (name) => {
    let hash = 2166136261;
    for (const char of `${key}:${name}`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    // Avalanche neighboring site identities before converting to a fraction.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
  };
  const drops = [{
    id: mob.kind === "spider" ? ITEM.STRING : ITEM.GUNPOWDER,
    count: 1 + Math.floor(roll("base-count") * 3),
  }];
  // Preserve legacy base counts. Eyes: 1/3, player only. Tears: 0–1, any death.
  if (mob.kind === "spider" ? directPlayer && roll("ingredient") < 1 / 3
    : roll("ingredient") < 1 / 2)
    drops.push({ id: mob.kind === "spider" ? ITEM.SPIDER_EYE : ITEM.GHAST_TEAR, count: 1 });
  return Object.freeze({
    drops: Object.freeze(drops.map((drop) => Object.freeze(drop))),
    experience: directPlayer ? 5 : 0,
  });
}
