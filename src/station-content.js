import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";

/** Declarations only; Settlement/ProgressionStations own the physical records. */
export function stationBlocks({ cube, rock, plant }) {
  const entry = (symbol, definition) => ({
    id: B[symbol],
    drop: B[symbol],
    resourceLocation: `minecraft:${symbol.toLowerCase()}`,
    ...definition,
  });
  const anvil = (symbol, name, stage, next) =>
    entry(
      symbol,
      rock(name, "#5c696d", "metal", {
        hardness: 5,
        directional: true,
        distinctFaces: true,
        station: "anvil",
        anvilStage: stage,
        nextDamagedBlock: next,
        art: Object.freeze({
          kind: stage === 0 ? "anvil" : symbol.toLowerCase(),
        }),
      })
    );
  return [
    entry(
      "BARREL",
      cube("Barrel", "#99734e", "planks", 2.5, {
        tool: "axe",
        directional: true,
        distinctFaces: true,
        container: "barrel",
        containerSlots: 27,
        jobSite: "fisher",
        art: Object.freeze({ kind: "barrel" }),
      })
    ),
    entry(
      "BLAST_FURNACE",
      rock("Blast furnace", "#788184", "metal", {
        hardness: 3.5,
        directional: true,
        distinctFaces: true,
        station: "blast_furnace",
        jobSite: "armorer",
        art: Object.freeze({ kind: "blast_furnace" }),
      })
    ),
    entry(
      "BREWING_STAND",
      plant("Brewing stand", "#b88944", "special", {
        hardness: 0.5,
        tool: "pickaxe",
        tier: 1,
        cutout: true,
        heldSprite: true,
        station: "brewing",
        jobSite: "cleric",
        art: Object.freeze({ kind: "brewing_stand" }),
      })
    ),
    entry(
      "ENCHANTING_TABLE",
      rock("Enchanting table", "#994c55", "special", {
        hardness: 5,
        station: "enchanting",
        distinctFaces: true,
        art: Object.freeze({ kind: "enchanting_table" }),
      })
    ),
    anvil("ANVIL", "Anvil", 0, B.CHIPPED_ANVIL),
    anvil("CHIPPED_ANVIL", "Chipped anvil", 1, B.DAMAGED_ANVIL),
    anvil("DAMAGED_ANVIL", "Damaged anvil", 2, null),
    entry(
      "IRON_BLOCK",
      rock("Block of iron", "#b8c9c7", "metal", {
        hardness: 5,
        tier: 2,
        art: Object.freeze({ kind: "iron_block" }),
      })
    ),
    entry(
      "SMOOTH_STONE",
      rock("Smooth stone", "#9fa7a8", "stone", {
        hardness: 2,
        art: Object.freeze({ kind: "smooth_stone" }),
      })
    ),
    entry(
      "CONDUIT",
      plant("Conduit", "#70ada9", "special", {
        hardness: 3,
        tool: "pickaxe",
        waterloggable: true,
        cutout: true,
        heldSprite: true,
        waterDevice: "conduit",
        art: Object.freeze({ kind: "conduit" }),
      })
    ),
    entry(
      "TURTLE_EGG",
      plant("Turtle egg", "#d0d7b5", "special", {
        hardness: 0.5,
        drop: B.AIR,
        silkDrop: B.TURTLE_EGG,
        substrate: B.SAND,
        ecologyBlock: "turtle_egg",
        cutout: true,
        art: Object.freeze({ kind: "turtle_egg" }),
      })
    ),
    entry(
      "CARROT_CROP",
      plant("Carrot crop", "#739447", "leaves", {
        drop: I.CARROT,
        dropCount: Object.freeze([2, 5]),
        crop: "carrot",
        substrate: B.FARMLAND,
        cutout: true,
        resourceLocation: "minecraft:carrots",
        art: Object.freeze({ kind: "carrot_crop" }),
      })
    ),
    entry(
      "DRIED_KELP_BLOCK",
      cube("Dried kelp block", "#516247", "special", 0.5, {
        tool: "hoe",
        art: Object.freeze({ kind: "dried_kelp_block" }),
      })
    ),
  ];
}
