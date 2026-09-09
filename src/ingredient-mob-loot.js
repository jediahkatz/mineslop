import { ITEM } from "./items.js";
import { mobLootRoll } from "./mob-loot-roll.js";

export const INGREDIENT_LOOT_VERSION = 1;
const resources = Object.freeze({
  spider: ITEM.STRING, ghast: ITEM.GUNPOWDER, cod: ITEM.RAW_COD, squid: ITEM.INK_SAC,
});
export const isIngredientMob = (mob) =>
  typeof mob?.kind === "string" && Object.hasOwn(resources, mob.kind);

/**
 * Immutable death quote. Independent named rolls keep environmental base loot
 * identical to player loot and never consume Wildlife's AI RNG. No save fields.
 * Immediate player kills only: delayed credit/reflected fireballs are not inferred.
 */
export function ingredientMobLoot(world, mob, directPlayer = false) {
  if (!isIngredientMob(mob) || typeof mob.id !== "string" ||
      typeof directPlayer !== "boolean") return null;
  const roll = mobLootRoll(world, mob, INGREDIENT_LOOT_VERSION);
  const drops = [{
    id: resources[mob.kind],
    count: mob.kind === "cod" ? 1 : 1 + Math.floor(roll("base-count") * 3),
  }];
  // Preserve legacy base counts. Eyes: 1/3, player only. Tears: 0–1, any death.
  if (mob.kind === "spider" && directPlayer && roll("ingredient") < 1 / 3)
    drops.push({ id: ITEM.SPIDER_EYE, count: 1 });
  if (mob.kind === "ghast" && roll("ingredient") < 1 / 2)
    drops.push({ id: ITEM.GHAST_TEAR, count: 1 });
  const passive = mob.kind === "cod" || mob.kind === "squid";
  return Object.freeze({
    drops: Object.freeze(drops.map((drop) => Object.freeze(drop))),
    experience: directPlayer ? passive ? 1 + Math.floor(roll("experience") * 3) : 5 : 0,
  });
}
