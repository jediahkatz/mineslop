import { mobLootRoll } from "./mob-loot-roll.js";

export const ECOLOGY_LOOT_VERSION = 1;

/**
 * Symbolic, retained death quotes. The live Ecology owner supplies its saved
 * world/resident identity and committed baby flag. Unbound helper calls remain
 * deterministic; they do not grant anything or acquire a world entitlement.
 *
 * Base material is identical for player/environmental death. Copper and XP
 * require the existing explicit player-credit path. Unarmed drowned do not
 * invent carried shells, equipment or tridents; shells remain fishing loot.
 */
export function ecologyDeathReward(kind, playerKill = false, {
  seed = "unbound-ecology-quote", dimension = "overworld", generatorVersion = 1,
  id = kind, baby = false,
} = {}) {
  let drops = [], experience = 0;
  const roll = mobLootRoll({ seed, dimension, generatorVersion }, { id, kind }, ECOLOGY_LOOT_VERSION);
  const add = (name, count) => { if (count > 0) drops.push({ name, count }); };
  if (kind === "guardian") {
    drops = [{ name: "PRISMARINE_SHARD", count: 2 }, { name: "PRISMARINE_CRYSTALS", count: 1 }];
    experience = 5;
  } else if (kind === "elder_guardian") {
    drops = [
      { name: "WET_SPONGE", count: 1 }, { name: "PRISMARINE_SHARD", count: 3 },
      { name: "PRISMARINE_CRYSTALS", count: 2 },
    ];
    experience = 10;
  } else if (kind === "blaze" && playerKill) {
    drops = [{ name: "BLAZE_ROD", count: 1 }];
    experience = 10;
  } else if (kind === "drowned") {
    add("ROTTEN_FLESH", Math.floor(roll("base-count") * 3));
    if (playerKill && roll("copper") < 0.11) add("COPPER_INGOT", 1);
    experience = 5;
  } else if (kind === "dolphin") {
    add("RAW_COD", Math.floor(roll("base-count") * 2));
    experience = 1 + Math.floor(roll("experience") * 3);
  } else if (kind === "turtle" && !baby) {
    add("SEAGRASS", Math.floor(roll("base-count") * 3));
    experience = 1 + Math.floor(roll("experience") * 3);
  }
  return Object.freeze({
    drops: Object.freeze(drops.map((drop) => Object.freeze(drop))),
    experience: playerKill ? experience : 0,
  });
}
