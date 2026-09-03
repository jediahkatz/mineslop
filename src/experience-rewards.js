import { BLOCK, BLOCKS } from "./blocks.js";

const oreRewards = new Map([
  [BLOCK.COAL_ORE, [0, 2]],
  [BLOCK.DIAMOND_ORE, [3, 7]],
  [BLOCK.REDSTONE_ORE, [1, 5]],
  [BLOCK.EMERALD_ORE, [3, 7]],
  [BLOCK.LAPIS_ORE, [2, 5]],
]);

function between(minimum, maximum, random) {
  const sample = Number(random());
  const value = Number.isFinite(sample)
    ? Math.max(0, Math.min(1 - Number.EPSILON, sample))
    : 0;
  return minimum + Math.floor(value * (maximum - minimum + 1));
}

/** Only a successful, appropriately harvested ore earns XP; raw metals earn it at smelting. */
export function miningExperience(id, drops, mode, random = Math.random) {
  const block = BLOCKS[id];
  const reward = block?.oreExperience ?? oreRewards.get(block?.harvestAs ?? id);
  if (
    mode !== "survival" ||
    !reward ||
    !Array.isArray(drops) ||
    !drops.some(
      (drop) =>
        drop.id !== id && Number.isSafeInteger(drop.count) && drop.count > 0
    )
  )
    return 0;
  return between(reward[0], reward[1], random);
}

/** Called only for a confirmed player-caused kill, never generic loot callbacks. */
export function playerKillExperience(
  entity,
  result,
  mode,
  random = Math.random
) {
  if (mode !== "survival" || !result?.hit || !result.killed || !entity?.spec)
    return 0;
  if (entity.kind === "slime") return 1;
  if (["hostile", "watchful"].includes(entity.spec.temperament)) return 5;
  return between(1, 3, random);
}
