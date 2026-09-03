import { BLOCK, BLOCKS } from "./blocks.js";
import { MAX_BLOCK_ID } from "./content-ids.js";

const cube = Object.freeze({ shape: "cube", solid: true });
const properties = {};
for (const name of [
  "PLANKS",
  "GLASS",
  "CHEST",
  "SAND",
  "SANDSTONE",
  "TERRACOTTA",
  "MOSSY_COBBLESTONE",
  "COBBLESTONE",
  "PRISMARINE",
  "PRISMARINE_BRICKS",
  "DARK_PRISMARINE",
  "SEA_LANTERN",
  "WET_SPONGE",
  "GOLD_BLOCK",
  "DIRT",
  "GRAVEL",
  "FARMLAND",
  "CRAFTING_TABLE",
  "FURNACE",
  "BOOKSHELF",
  "COMPOSTER",
  "LECTERN",
  "CARTOGRAPHY_TABLE",
  "SMITHING_TABLE",
  "NETHER_BRICKS",
  "SOUL_SAND",
  "GLOWSTONE",
  "SPAWNER",
  "BLACKSTONE",
])
  properties[name] = cube;
for (const name of ["AIR", "WATER", "LAVA"])
  properties[name] = Object.freeze({ shape: "cube", solid: false });
for (const name of ["OAK_LOG", "SPRUCE_LOG", "ACACIA_LOG", "BASALT"])
  properties[name] = Object.freeze({ ...cube, directional: "axis" });
for (const name of ["WHEAT_CROP", "NETHER_WART_CROP", "TORCH"])
  properties[name] = Object.freeze({ shape: "cross", solid: false });
for (const [name, shape] of [
  ["OAK_SLAB", "slab"],
  ["OAK_STAIRS", "stairs"],
  ["OAK_TRAPDOOR", "trapdoor"],
  ["OAK_FENCE", "fence"],
])
  properties[name] = Object.freeze({ shape, solid: true, waterloggable: true });
for (const [name, shape] of [
  ["OAK_DOOR", "door"],
  ["OAK_FENCE_GATE", "fence_gate"],
  ["WHITE_BED", "bed"],
  ["NETHER_BRICK_STAIRS", "stairs"],
  ["NETHER_BRICK_SLAB", "slab"],
  ["NETHER_BRICK_FENCE", "fence"],
])
  properties[name] = Object.freeze({ shape, solid: true });
properties.LADDER = Object.freeze({
  shape: "ladder",
  solid: false,
  waterloggable: true,
});

export const STRUCTURE_CONTENT_PROPERTIES = Object.freeze(properties);

/**
 * Validate lazily at decorator registration. No module import allocates IDs or
 * registers content. All missing names/metadata are reported in one failure;
 * missing gold, spawners, crops or jobs never silently become stone or AIR.
 */
export function requireStructureContent(
  names,
  ids = BLOCK,
  definitions = BLOCKS
) {
  const failures = [];
  const resolved = {};
  const aliases = new Map();
  for (const [name, id] of Object.entries(ids)) {
    if (!aliases.has(id)) aliases.set(id, []);
    aliases.get(id).push(name);
  }
  for (const name of [...new Set(names)].sort()) {
    const expected = STRUCTURE_CONTENT_PROPERTIES[name];
    if (!expected) throw new Error(`Undeclared structure material: ${name}`);
    const id = ids[name];
    const definition = definitions[id];
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id > MAX_BLOCK_ID ||
      definition?.id !== id
    ) {
      failures.push(name);
      continue;
    }
    if (aliases.get(id)?.length !== 1)
      failures.push(`${name} must have its own registered ID`);
    for (const [property, value] of Object.entries(expected))
      if (definition[property] !== value)
        failures.push(`${name}.${property}=${JSON.stringify(value)}`);
    if (definition.aquatic === true)
      failures.push(`${name}.aquatic must be absent/false`);
    resolved[name] = id;
  }
  if (failures.length)
    throw new Error(
      `Structures require registered content/metadata: ${failures.join(", ")}`
    );
  return Object.freeze(resolved);
}
