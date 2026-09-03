import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";

const coralFamilies = Object.freeze([
  ["TUBE", "Tube", "#6284bf"],
  ["BRAIN", "Brain", "#c8829b"],
  ["BUBBLE", "Bubble", "#a075b0"],
  ["FIRE", "Fire", "#d17158"],
  ["HORN", "Horn", "#c8b34f"],
]);

export function marineBlocks({ cube, rock, plant }) {
  const entries = [];
  const add = (id, definition) => entries.push({ id, drop: id, ...definition });
  for (const [family, name, color] of coralFamilies) {
    for (const dead of [false, true]) {
      const prefix = dead ? "DEAD_" : "";
      const title = dead ? `Dead ${name.toLowerCase()}` : name;
      const variant = family.toLowerCase();
      const block = B[`${prefix}${family}_CORAL_BLOCK`];
      add(
        block,
        rock(`${title} coral block`, dead ? "#939a88" : color, "special", {
          coralFamily: variant,
          deadCoral: dead,
          deadBlock: B[`DEAD_${family}_CORAL_BLOCK`],
          silkDrop: block,
          drop: B[`DEAD_${family}_CORAL_BLOCK`],
          art: Object.freeze({
            kind: dead ? "dead_coral_block" : "coral_block",
            variant,
          }),
        })
      );
      for (const fan of [false, true]) {
        const suffix = fan ? "_CORAL_FAN" : "_CORAL";
        const id = B[`${prefix}${family}${suffix}`];
        add(
          id,
          plant(
            `${title} coral${fan ? " fan" : ""}`,
            dead ? "#939a88" : color,
            "special",
            {
              aquatic: !dead,
              waterloggable: true,
              coralFamily: variant,
              deadCoral: dead,
              deadBlock: B[`DEAD_${family}${suffix}`],
              silkDrop: id,
              drop: B[`DEAD_${family}${suffix}`],
              art: Object.freeze({
                kind: `${dead ? "dead_" : ""}coral${fan ? "_fan" : ""}`,
                variant,
              }),
            }
          )
        );
      }
    }
  }
  for (const [key, name, color, tier, drop] of [
    ["COAL", "Coal", "#60646a", 1, I.COAL],
    ["IRON", "Iron", "#caa58a", 2, I.RAW_IRON],
    ["COPPER", "Copper", "#be8261", 2, I.RAW_COPPER],
    ["GOLD", "Gold", "#e4bd59", 3, I.RAW_GOLD],
    ["REDSTONE", "Redstone", "#c54c49", 3, I.REDSTONE],
    ["DIAMOND", "Diamond", "#6de0d8", 3, I.DIAMOND],
    ["LAPIS", "Lapis", "#4d71b8", 2, I.LAPIS],
    ["EMERALD", "Emerald", "#56c284", 3, I.EMERALD],
  ]) {
    const id = B[`DEEPSLATE_${key}_ORE`];
    add(
      id,
      rock(`Deepslate ${name.toLowerCase()} ore`, color, "ore", {
        hardness: 4.5,
        tier,
        drop,
        silkDrop: id,
        harvestAs: B[`${key}_ORE`],
        oreArt: B[`${key}_ORE`],
        oreHost: "deepslate",
        distinctFaces: true,
      })
    );
  }
  add(
    B.NETHER_GOLD_ORE,
    rock("Nether gold ore", "#cd9b4b", "ore", {
      hardness: 3,
      drop: I.GOLD_NUGGET,
      dropCount: Object.freeze([2, 6]),
      oreExperience: Object.freeze([0, 1]),
      silkDrop: B.NETHER_GOLD_ORE,
      oreArt: B.GOLD_ORE,
      oreHost: "netherrack",
    })
  );
  add(
    B.NETHER_QUARTZ_ORE,
    rock("Nether quartz ore", "#ded6bd", "ore", {
      hardness: 3,
      drop: I.QUARTZ,
      oreExperience: Object.freeze([2, 5]),
      silkDrop: B.NETHER_QUARTZ_ORE,
      oreArt: "quartz",
      oreHost: "netherrack",
    })
  );
  add(
    B.ANCIENT_DEBRIS,
    rock("Ancient debris", "#665047", "special", {
      hardness: 30,
      tier: 4,
      blastProof: true,
      distinctFaces: true,
      art: Object.freeze({ kind: "ancient_debris" }),
    })
  );
  add(
    B.QUARTZ_BLOCK,
    rock("Block of quartz", "#e6e0cf", "special", {
      hardness: 0.8,
      distinctFaces: true,
      art: Object.freeze({ kind: "quartz_block" }),
    })
  );
  for (const [id, name, color, variant] of [
    [B.PRISMARINE, "Prismarine", "#64958a", "rough"],
    [B.PRISMARINE_BRICKS, "Prismarine bricks", "#80ad9c", "bricks"],
    [B.DARK_PRISMARINE, "Dark prismarine", "#35625a", "dark"],
  ])
    add(
      id,
      rock(name, color, "special", {
        art: Object.freeze({ kind: "prismarine", variant }),
      })
    );
  add(
    B.SPONGE,
    cube("Sponge", "#cfb75b", "special", 0.6, {
      tool: "hoe",
      wetBlock: B.WET_SPONGE,
      art: Object.freeze({ kind: "sponge", variant: "dry" }),
    })
  );
  add(
    B.WET_SPONGE,
    cube("Wet sponge", "#929951", "special", 0.6, {
      tool: "hoe",
      dryBlock: B.SPONGE,
      art: Object.freeze({ kind: "sponge", variant: "wet" }),
    })
  );
  return entries;
}
