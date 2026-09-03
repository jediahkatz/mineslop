import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";

/** Construction materials and job sites; generation declares their controllers. */
export function structureBlocks({ cube, rock, plant }) {
  const entry = (id, definition) => ({ id, drop: id, ...definition });
  const netherBrick = (id, name, extra = {}) =>
    entry(
      id,
      rock(name, "#492d35", "brick", {
        hardness: 2,
        art: Object.freeze({ kind: "nether_bricks" }),
        ...extra,
      })
    );
  const jobSite = (id, name, color, profession, kind, extra = {}) =>
    entry(
      id,
      cube(name, color, "planks", 2.5, {
        tool: "axe",
        jobSite: profession,
        distinctFaces: true,
        art: Object.freeze({ kind }),
        ...extra,
      })
    );
  return [
    entry(
      B.GOLD_BLOCK,
      rock("Block of gold", "#d9b851", "metal", {
        hardness: 3,
        tier: 3,
        art: Object.freeze({ kind: "gold_block" }),
      })
    ),
    entry(
      B.MOSSY_COBBLESTONE,
      rock("Mossy cobblestone", "#74856b", "brick", {
        hardness: 2,
        art: Object.freeze({ kind: "mossy_cobblestone" }),
      })
    ),
    netherBrick(B.NETHER_BRICKS, "Nether bricks"),
    netherBrick(B.NETHER_BRICK_STAIRS, "Nether brick stairs", {
      shape: "stairs",
      directional: true,
      waterloggable: true,
    }),
    netherBrick(B.NETHER_BRICK_SLAB, "Nether brick slab", {
      shape: "slab",
      waterloggable: true,
    }),
    netherBrick(B.NETHER_BRICK_FENCE, "Nether brick fence", {
      shape: "fence",
      fenceGroup: "nether_brick",
      waterloggable: true,
    }),
    entry(
      B.NETHER_WART_CROP,
      plant("Nether wart crop", "#a7474f", "flower", {
        drop: I.NETHER_WART,
        dropCount: Object.freeze([2, 4]),
        crop: "nether_wart",
        substrate: B.SOUL_SAND,
        cutout: true,
        art: Object.freeze({ kind: "nether_wart_crop" }),
      })
    ),
    entry(
      B.SPAWNER,
      rock("Monster spawner", "#4f6060", "special", {
        hardness: 5,
        drop: B.AIR,
        transparent: true,
        cutout: true,
        art: Object.freeze({ kind: "spawner" }),
      })
    ),
    jobSite(B.COMPOSTER, "Composter", "#97734c", "farmer", "composter", {
      hardness: 0.6,
    }),
    jobSite(B.LECTERN, "Lectern", "#b99566", "librarian", "lectern"),
    jobSite(
      B.CARTOGRAPHY_TABLE,
      "Cartography table",
      "#866849",
      "cartographer",
      "cartography_table"
    ),
    jobSite(
      B.SMITHING_TABLE,
      "Smithing table",
      "#625a55",
      "toolsmith",
      "smithing_table"
    ),
  ];
}
