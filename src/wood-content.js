import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import { EXPANSION_WOOD_PALETTES } from "./expansion-art-common.js";

// Sources are persisted identities, not inferred from names or texture colors.
// Oak's historical PLANKS (7) and pale oak's PALE_LOG (30) stay canonical.
export const WOOD_FAMILIES = Object.freeze(
  [
    ["oak", "Oak", "OAK", B.OAK_LOG, B.PLANKS],
    ["birch", "Birch", "BIRCH", B.BIRCH_LOG, B.BIRCH_PLANKS],
    ["spruce", "Spruce", "SPRUCE", B.SPRUCE_LOG, B.SPRUCE_PLANKS],
    ["acacia", "Acacia", "ACACIA", B.ACACIA_LOG, B.ACACIA_PLANKS],
    ["jungle", "Jungle", "JUNGLE", B.JUNGLE_LOG, B.JUNGLE_PLANKS],
    ["cherry", "Cherry", "CHERRY", B.CHERRY_LOG, B.CHERRY_PLANKS],
    ["dark_oak", "Dark oak", "DARK_OAK", B.DARK_OAK_LOG, B.DARK_OAK_PLANKS],
    ["pale_oak", "Pale oak", "PALE_OAK", B.PALE_LOG, B.PALE_OAK_PLANKS],
    ["mangrove", "Mangrove", "MANGROVE", B.MANGROVE_LOG, B.MANGROVE_PLANKS],
    ["crimson", "Crimson", "CRIMSON", B.CRIMSON_STEM, B.CRIMSON_PLANKS],
    ["warped", "Warped", "WARPED", B.WARPED_STEM, B.WARPED_PLANKS],
    ["bamboo", "Bamboo", "BAMBOO", B.BAMBOO_BLOCK, B.BAMBOO_PLANKS],
  ].map(([key, name, prefix, source, planks]) => {
    const fireproof = key === "crimson" || key === "warped";
    const vehicle = fireproof ? null : key === "bamboo" ? "raft" : "boat";
    return Object.freeze({
      key,
      name,
      prefix,
      source,
      planks,
      fireproof,
      vehicle,
      plankCount: key === "bamboo" ? 2 : 4,
      slab: B[`${prefix}_SLAB`],
      stairs: B[`${prefix}_STAIRS`],
      door: B[`${prefix}_DOOR`],
      trapdoor: B[`${prefix}_TRAPDOOR`],
      fence: B[`${prefix}_FENCE`],
      fence_gate: B[`${prefix}_FENCE_GATE`],
      boat: vehicle === null ? null : I[`${prefix}_${vehicle.toUpperCase()}`],
    });
  })
);

export const PLANK_ITEMS = Object.freeze(
  WOOD_FAMILIES.map(({ planks }) => planks)
);
export const WOOD_SLAB_ITEMS = Object.freeze(
  WOOD_FAMILIES.map(({ slab }) => slab)
);
export const WOOD_LOG_ITEMS = Object.freeze(
  WOOD_FAMILIES.filter(({ key }) => key !== "bamboo").map(
    ({ source }) => source
  )
);
export const CHARCOAL_LOG_ITEMS = Object.freeze(
  WOOD_FAMILIES.filter(
    ({ key, fireproof }) => key !== "bamboo" && !fireproof
  ).map(({ source }) => source)
);

const shapes = Object.freeze({
  planks: "cube",
  slab: "slab",
  stairs: "stairs",
  door: "door",
  trapdoor: "trapdoor",
  fence: "fence",
  fence_gate: "fence_gate",
});
const partTags = Object.freeze({
  planks: "planks",
  slab: "wooden_slabs",
  stairs: "wooden_stairs",
  door: "wooden_doors",
  trapdoor: "wooden_trapdoors",
  fence: "wooden_fences",
  fence_gate: "fence_gates",
});

export function woodBlockProperties(family, part) {
  if (!WOOD_FAMILIES.includes(family) || !Object.hasOwn(shapes, part))
    throw new RangeError("Unknown wood family or part");
  const special = part === "door" || part === "trapdoor";
  return {
    woodFamily: family.key,
    resourceLocation: `minecraft:${family.key}_${part}`,
    tags: Object.freeze([`minecraft:${partTags[part]}`]),
    fireproof: family.fireproof,
    art: Object.freeze({
      kind: special ? part : "planks",
      variant: family.key,
      ...(part === "door" ? { part: "lower" } : {}),
    }),
  };
}

export function woodBlocks({ cube }) {
  const entries = [];
  for (const family of WOOD_FAMILIES) {
    for (const [part, shape] of Object.entries(shapes)) {
      if (family.key === "oak" && part === "planks") continue;
      const id = family[part];
      const doorway = part === "door" || part === "trapdoor";
      entries.push({
        id,
        drop: id,
        ...cube(
          `${family.name} ${part.replaceAll("_", " ")}`,
          family.key === "oak"
            ? "#bd955d"
            : EXPANSION_WOOD_PALETTES[family.key][3],
          "planks",
          doorway ? 3 : 2,
          {
            tool: "axe",
            shape,
            ...woodBlockProperties(family, part),
            ...(["slab", "stairs", "trapdoor", "fence"].includes(part)
              ? { waterloggable: true }
              : {}),
            ...(["stairs", "door", "trapdoor", "fence_gate"].includes(part)
              ? { directional: true }
              : {}),
            ...(["fence", "fence_gate"].includes(part)
              ? { fenceGroup: "wood" }
              : {}),
            ...(doorway
              ? { transparent: true, cutout: true, distinctFaces: true }
              : {}),
            ...(part === "door"
              ? {
                  multipart: "door",
                  heldSprite: true,
                  textureParts: Object.freeze(["lower", "upper"]),
                }
              : {}),
          }
        ),
      });
    }
  }
  entries.push({
    id: B.BAMBOO_BLOCK,
    drop: B.BAMBOO_BLOCK,
    ...cube("Block of bamboo", "#bca65a", "log", 2, {
      tool: "axe",
      directional: "axis",
      distinctFaces: true,
      woodFamily: "bamboo",
      resourceLocation: "minecraft:bamboo_block",
      art: Object.freeze({ kind: "bamboo_block" }),
    }),
  });
  return entries;
}

/** Fuel seconds match the existing ten-second smelting accounting. */
export const WOOD_FUELS = Object.freeze(
  WOOD_FAMILIES.filter(({ fireproof }) => !fireproof).flatMap((family) =>
    [
      [family.source, 15],
      [family.planks, 15],
      [family.slab, 7.5],
      [family.stairs, 15],
      [family.door, 10],
      [family.trapdoor, 15],
      [family.fence, 15],
      [family.fence_gate, 15],
      [family.boat, 60],
    ].map((entry) => Object.freeze(entry))
  )
);
