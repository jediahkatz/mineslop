import { BLOCK, BLOCKS } from "./blocks.js";

export const V4_CORAL_FAMILIES = Object.freeze([
  "TUBE",
  "BRAIN",
  "BUBBLE",
  "FIRE",
  "HORN",
]);
export const V4_ORES = Object.freeze([
  "COAL",
  "IRON",
  "COPPER",
  "GOLD",
  "REDSTONE",
  "DIAMOND",
  "LAPIS",
  "EMERALD",
]);

const cube = Object.freeze({ shape: "cube", solid: true });
const aquatic = Object.freeze({
  shape: "cross",
  solid: false,
  transparent: true,
  aquatic: true,
  waterloggable: true,
});
const axis = Object.freeze({ directional: "axis", solid: true });

// Semantic requirements only. The lead-owned registry assigns every actual ID.
// Coral blocks displace water; coral plants/floor fans contain source water.
export const V4_CONTENT_REQUIREMENTS = Object.freeze([
  ...["DEEPSLATE", "COBBLED_DEEPSLATE", "MAGMA_BLOCK"].map((name) =>
    Object.freeze({ name, properties: cube })
  ),
  ...["KELP", "SEAGRASS"].map((name) =>
    Object.freeze({ name, properties: aquatic })
  ),
  ...V4_CORAL_FAMILIES.flatMap((family) => [
    Object.freeze({ name: `${family}_CORAL_BLOCK`, properties: cube }),
    Object.freeze({ name: `${family}_CORAL`, properties: aquatic }),
    Object.freeze({ name: `${family}_CORAL_FAN`, properties: aquatic }),
  ]),
  ...[
    ...V4_ORES.map((ore) => `DEEPSLATE_${ore}_ORE`),
    "NETHER_GOLD_ORE",
    "NETHER_QUARTZ_ORE",
    "ANCIENT_DEBRIS",
  ].map((name) => Object.freeze({ name, properties: cube })),
  ...[
    "OAK_LOG",
    "BIRCH_LOG",
    "SPRUCE_LOG",
    "ACACIA_LOG",
    "JUNGLE_LOG",
    "CHERRY_LOG",
    "DARK_OAK_LOG",
    "PALE_LOG",
    "MANGROVE_LOG",
    "CRIMSON_STEM",
    "WARPED_STEM",
  ].map((name) => Object.freeze({ name, properties: axis })),
]);

/**
 * Validate at factory creation, not module import: missing v4 content must not
 * prevent a historical generator from loading. Never coerce undefined into
 * Uint16 zero (AIR) or substitute an unrelated historical material.
 */
export function requireTerrainV4Content(ids = BLOCK, definitions = BLOCKS) {
  const failures = [];
  for (const { name, properties } of V4_CONTENT_REQUIREMENTS) {
    const id = ids[name];
    const entry = definitions[id];
    if (!Number.isInteger(id) || id < 0 || id > 65535 || entry?.id !== id) {
      failures.push(name);
      continue;
    }
    for (const [property, expected] of Object.entries(properties))
      if (entry[property] !== expected)
        failures.push(`${name}.${property}=${JSON.stringify(expected)}`);
    if (
      (name.endsWith("_CORAL_BLOCK") || name.endsWith("_ORE")) &&
      entry.aquatic === true
    )
      failures.push(`${name}.aquatic must be absent/false`);
  }
  if (failures.length)
    throw new Error(
      `Terrain v4 requires registered content/metadata: ${failures.join(", ")}`
    );
}
