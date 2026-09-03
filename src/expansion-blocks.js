import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import { marineBlocks } from "./marine-blocks.js";
import { stationBlocks } from "./station-content.js";
import { structureBlocks } from "./structure-blocks.js";
import { woodBlocks } from "./wood-content.js";

// Pure definitions. The registry supplies its existing definition helpers so
// this module never imports the assembled block/item catalogs.
export function expansionBlocks({ cube, rock, plant }) {
  const entry = (id, definition) => ({ id, drop: id, ...definition });
  return [
    entry(
      B.COPPER_BLOCK,
      rock("Block of copper", "#bc7657", "metal", {
        hardness: 3,
        tier: 2,
        art: Object.freeze({ kind: "copper_block" }),
      })
    ),
    entry(
      B.BOOKSHELF,
      cube("Bookshelf", "#ad8552", "bookshelf", 1.5, {
        tool: "axe",
        enchantingPower: 1,
        distinctFaces: true,
        art: Object.freeze({ kind: "bookshelf", variant: "oak" }),
      })
    ),
    ...woodBlocks({ cube }),
    entry(
      B.LADDER,
      plant("Ladder", "#b78b54", "ladder", {
        shape: "ladder",
        directional: true,
        waterloggable: true,
        tool: "axe",
        hardness: 0.4,
        heldSprite: true,
        art: Object.freeze({ kind: "ladder", variant: "oak" }),
      })
    ),
    entry(
      B.WHITE_BED,
      cube("White bed", "#e4e1d9", "bed", 0.2, {
        shape: "bed",
        directional: true,
        multipart: "bed",
        bedColor: "white",
        tool: "axe",
        distinctFaces: true,
        textureParts: Object.freeze(["foot", "head"]),
        art: Object.freeze({ kind: "bed", variant: "white", part: "foot" }),
      })
    ),
    entry(
      B.MAGMA_BLOCK,
      rock("Magma block", "#85402b", "magma", {
        hardness: 0.5,
        emissive: true,
        lightLevel: 3,
        art: Object.freeze({ kind: "magma" }),
      })
    ),
    entry(
      B.KELP,
      plant("Kelp", "#5a8b37", "kelp", {
        aquatic: true,
        waterloggable: true,
        art: Object.freeze({ kind: "kelp", variant: "plant" }),
      })
    ),
    entry(
      B.DEEPSLATE,
      rock("Deepslate", "#555559", "stone", {
        hardness: 3,
        drop: B.COBBLED_DEEPSLATE,
        directional: "axis",
        distinctFaces: true,
        art: Object.freeze({ kind: "deepslate" }),
      })
    ),
    entry(
      B.SEA_LANTERN,
      cube("Sea lantern", "#b6d7d1", "sea_lantern", 0.3, {
        emissive: true,
        lightLevel: 15,
        drop: I.PRISMARINE_CRYSTALS,
        dropCount: Object.freeze([2, 3]),
        silkDrop: B.SEA_LANTERN,
        art: Object.freeze({ kind: "sea_lantern" }),
      })
    ),
    entry(
      B.COBBLED_DEEPSLATE,
      rock("Cobbled deepslate", "#505057", "brick", {
        hardness: 3.5,
        resourceLocation: "minecraft:cobbled_deepslate",
        art: Object.freeze({ kind: "cobbled_deepslate" }),
      })
    ),
    ...marineBlocks({ cube, rock, plant }),
    // The existing job-site identity also opens real smithing escrow; do not
    // allocate a second table or edit the independently owned structure module.
    ...structureBlocks({ cube, rock, plant }).map((definition) =>
      definition.id === B.SMITHING_TABLE
        ? { ...definition, station: "smithing" }
        : definition
    ),
    ...stationBlocks({ cube, rock, plant }),
  ];
}
