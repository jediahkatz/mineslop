import {
  EXPANSION_GEAR_PALETTES,
  EXPANSION_WOOD_PALETTES,
  expansionPainter,
} from "./expansion-art-common.js";

const tools = Object.freeze(["pickaxe", "axe", "sword", "shovel", "hoe"]);
const toolMaterials = Object.freeze([
  "wood",
  "stone",
  "copper",
  "iron",
  "gold",
  "diamond",
  "netherite",
]);
const slots = Object.freeze(["head", "chest", "legs", "feet"]);
const armorMaterials = Object.freeze([
  "leather",
  "copper",
  "gold",
  "chainmail",
  "iron",
  "diamond",
  "netherite",
]);
const CLEAR = [0, 0, 0, 0];

export const GEAR_ITEM_ART_DESCRIPTORS = Object.freeze([
  ...toolMaterials.flatMap((material) =>
    tools.map((tool) => Object.freeze({ kind: "gear_tool", material, tool }))
  ),
  ...armorMaterials.flatMap((material) =>
    slots.map((slot) => Object.freeze({ kind: "gear_armor", material, slot }))
  ),
  Object.freeze({ kind: "gear_armor", material: "turtle", slot: "head" }),
]);

function paintTool(p, tones, tool) {
  const wood = EXPANSION_WOOD_PALETTES.oak;
  p.line(3, 12, 10, 6, wood[0], 3);
  p.line(3, 12, 10, 6, wood[2], 2);
  p.line(4, 13, 10, 7, wood[4]);
  if (tool === "pickaxe") {
    p.stamp(
      3,
      2,
      [
        ".00000000...",
        "0344444430..",
        "03222222230.",
        ".01111222230",
        ".....0112230",
        ".......01210",
        "........010.",
      ],
      tones
    );
  } else if (tool === "axe") {
    p.stamp(
      5,
      1,
      [
        "..000000.",
        ".0344430.",
        "03422230.",
        "032222230",
        "032222230",
        "032222210",
        ".0112210.",
        "..00110..",
      ],
      tones
    );
  } else if (tool === "sword") {
    p.line(7, 9, 11, 4, tones[0], 3);
    p.line(7, 9, 13, 3, tones[2], 2);
    p.line(8, 8, 13, 3, tones[4]);
    p.rect(12, 2, 2, 2, tones[3]);
    p.line(4, 8, 8, 12, tones[0], 3);
    p.line(4, 8, 8, 12, tones[3]);
    p.rect(3, 12, 2, 2, tones[1]);
  } else if (tool === "shovel") {
    p.stamp(
      7,
      1,
      [
        "....00..",
        "...0340.",
        "..034430",
        ".0342230",
        "03422210",
        "0322210.",
        ".01110..",
        "..00....",
      ],
      tones
    );
  } else {
    p.stamp(
      3,
      2,
      [
        ".00000000..",
        "0344444430.",
        "03222222210",
        "0321111100.",
        "03210......",
        ".010.......",
      ],
      tones
    );
  }
}

function paintArmor(p, tones, slot, material) {
  if (slot === "head") {
    p.rect(4, 2, 8, 2, tones[0]);
    p.rect(2, 4, 12, 8, tones[0]);
    p.rect(3, 4, 10, 5, tones[2]);
    p.rect(5, 3, 6, 1, tones[4]);
    p.rect(3, 5, 2, 6, tones[3]);
    p.rect(11, 5, 2, 6, tones[1]);
    p.rect(5, 9, 6, 4, CLEAR);
    p.line(4, 4, 11, 4, tones[4]);
    p.line(3, 10, 4, 10, tones[1]);
    if (material === "turtle") {
      p.rect(6, 1, 4, 2, tones[0]);
      p.rect(6, 2, 4, 1, tones[4]);
      p.line(7, 4, 7, 8, tones[0]);
      p.line(4, 6, 10, 6, tones[1]);
      p.line(8, 4, 8, 5, tones[3]);
    }
  } else if (slot === "chest") {
    p.stamp(
      1,
      2,
      [
        "..000....000..",
        ".0340....0430.",
        "03423000032230",
        "03222222222230",
        "03222222222210",
        ".011222222110.",
        "...03222230...",
        "...03222230...",
        "...03222210...",
        "...03222210...",
        "...01111110...",
      ],
      tones
    );
    p.line(5, 6, 5, 10, tones[4]);
    p.line(10, 7, 10, 10, tones[1]);
  } else if (slot === "legs") {
    p.rect(3, 2, 10, 5, tones[0]);
    p.rect(3, 6, 4, 8, tones[0]);
    p.rect(9, 6, 4, 8, tones[0]);
    p.rect(4, 3, 8, 4, tones[2]);
    p.rect(4, 7, 2, 6, tones[3]);
    p.rect(10, 7, 2, 6, tones[1]);
    p.line(4, 3, 11, 3, tones[4]);
    p.line(4, 8, 4, 12, tones[4]);
    p.line(7, 5, 8, 5, tones[0]);
  } else {
    for (const x of [2, 9]) {
      p.rect(x + 1, 4, 4, 8, tones[0]);
      p.rect(x, 10, 5, 4, tones[0]);
      p.rect(x + 2, 5, 2, 6, tones[2]);
      p.rect(x + 1, 11, 3, 2, tones[3]);
      p.line(x + 2, 5, x + 3, 5, tones[4]);
      p.line(x + 1, 13, x + 3, 13, tones[1]);
    }
  }
}

function paintWeave(p, pixels) {
  // Chainmail has real optical openings within the authored armor silhouette.
  for (let y = 4; y < 12; y += 2)
    for (let x = 3 + (y % 4); x < 13; x += 3)
      if (pixels[(y * 16 + x) * 4 + 3] === 255) p.rect(x, y, 1, 1, CLEAR);
}

/** Strict, catalog-independent descriptors; unsupported combinations are inert. */
export function paintGearItem(pixels, options) {
  if (!options || typeof options !== "object") return false;
  const isTool = options.kind === "gear_tool";
  if (!isTool && options.kind !== "gear_armor") return false;
  const fields = isTool
    ? ["kind", "material", "tool"]
    : ["kind", "material", "slot"];
  if (Reflect.ownKeys(options).some((key) => !fields.includes(key)))
    return false;
  const valid = isTool
    ? toolMaterials.includes(options.material) && tools.includes(options.tool)
    : slots.includes(options.slot) &&
      (armorMaterials.includes(options.material) ||
        (options.material === "turtle" && options.slot === "head"));
  if (!valid) return false;
  const p = expansionPainter(pixels);
  const palette = EXPANSION_GEAR_PALETTES[options.material];
  if (isTool) paintTool(p, palette, options.tool);
  else {
    paintArmor(p, palette, options.slot, options.material);
    if (options.material === "chainmail") paintWeave(p, pixels);
  }
  return true;
}
