import {
  paintAnvilFace,
  paintContentBlockMaterial,
} from "./content-block-art.js";
import {
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
  expansionArtKeys,
  expansionArtVariants,
  expansionPainter,
  resolveExpansionVariant,
} from "./expansion-art-common.js";

export {
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
} from "./expansion-art-common.js";

const CORAL_PALETTES = {
  tube: ["#303e68", "#455d99", "#6284bf", "#91add6"],
  brain: ["#784254", "#a05b76", "#c8829b", "#e5adbd"],
  bubble: ["#583761", "#7c508d", "#a075b0", "#c59acc"],
  fire: ["#793c35", "#aa4e43", "#d17158", "#e99d7a"],
  horn: ["#77602c", "#a68b38", "#c8b34f", "#e6d482"],
};
const DEAD_CORAL = ["#53574f", "#71776b", "#939a88", "#b7bea7"];
export const EXPANSION_CORAL_FAMILIES = Object.freeze(
  Object.keys(CORAL_PALETTES)
);
export const EXPANSION_MATERIAL_CUTOUT_KINDS = Object.freeze([
  "kelp",
  "coral",
  "dead_coral",
  "coral_fan",
  "dead_coral_fan",
]);
export const EXPANSION_MATERIAL_VARIANTS = expansionArtVariants({
  planks: EXPANSION_WOOD_FAMILIES,
  prismarine: ["rough", "bricks", "dark"],
  sea_lantern: ["default"],
  sponge: ["dry", "wet"],
  kelp: ["plant", "tip"],
  coral_block: EXPANSION_CORAL_FAMILIES,
  dead_coral_block: EXPANSION_CORAL_FAMILIES,
  coral: EXPANSION_CORAL_FAMILIES,
  dead_coral: EXPANSION_CORAL_FAMILIES,
  coral_fan: EXPANSION_CORAL_FAMILIES,
  dead_coral_fan: EXPANSION_CORAL_FAMILIES,
  magma: ["default"],
  enchanting_table: ["default"],
  anvil: ["default"],
});
export const EXPANSION_MATERIAL_KEYS = expansionArtKeys(
  EXPANSION_MATERIAL_VARIANTS
);

function paintPlanks(p, family) {
  const palette = EXPANSION_WOOD_PALETTES[family];
  p.field(palette.slice(1, 4), 911, 2, 7);
  if (family === "bamboo") {
    for (const x of [0, 4, 8, 12]) {
      p.rect(x, 0, 1, 16, palette[0]);
      p.rect(x + 1, 0, 1, 16, palette[3]);
      const y = x % 8 === 0 ? 5 : 11;
      p.rect(x + 1, y, 3, 1, palette[1]);
      p.rect(x + 1, y + 1, 3, 1, palette[4]);
    }
    return;
  }
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    const joint = row % 2 ? 11 : 4;
    p.rect(0, y, 16, 1, palette[0]);
    p.rect(0, y + 1, 16, 1, palette[3]);
    p.rect(joint, y + 1, 1, 3, palette[0]);
    p.rect(joint + 1, y + 2, 1, 2, palette[1]);
    p.line(row % 2 ? 2 : 8, y + 2, row % 2 ? 6 : 12, y + 2, palette[4]);
  }
  // Two short knots follow the board grain rather than scattering speckles.
  p.stamp(8, 2, ["210", "121"], [palette[1], palette[2], palette[3]]);
  p.stamp(0, 10, ["2210", "1121"], palette);
}

function paintPrismarine(p, variant) {
  const palette =
    variant === "dark"
      ? ["#1d3835", "#284c47", "#35625a", "#47796b", "#5c907e"]
      : ["#416861", "#527e75", "#64958a", "#80ad9c", "#a1c6ad"];
  p.field(palette.slice(1, 4), 917, 4, 5);
  if (variant === "rough") {
    for (const [x, y, shape] of [
      [-1, 1, [".4432", "43221", "22110", ".100."]],
      [8, -1, ["..443.", ".43221", "322210", ".1100."]],
      [3, 6, [".4432.", "432221", "221100", ".100.."]],
      [11, 7, [".443", "4321", "2210", ".10."]],
      [0, 12, ["4432.", "32221", "21100"]],
      [8, 13, [".4432", "43221", "21100"]],
    ])
      p.stamp(x, y, shape, palette, true);
    return;
  }
  const size = variant === "dark" ? 4 : 8;
  for (let y = 0; y < 16; y += size) {
    const offset = size === 8 && y === 0 ? -4 : 0;
    for (let x = offset; x < 16; x += size) {
      p.rect(x, y, size, size, palette[0]);
      p.rect(x + 1, y + 1, size - 1, size - 2, palette[2]);
      p.line(x + 1, y + 1, x + size - 2, y + 1, palette[4]);
      p.rect(x + 1, y + 2, 1, size - 3, palette[3]);
      p.rect(x + 2, y + size - 2, size - 2, 1, palette[1]);
    }
  }
}

function paintSeaLantern(p) {
  p.rect(0, 0, 16, 16, "#4a786f");
  p.rect(1, 1, 14, 14, "#9bbca5");
  p.rect(2, 2, 12, 12, "#bed4b9");
  p.rect(3, 3, 10, 10, "#dce7d2");
  p.rect(5, 5, 6, 6, "#edf1d9");
  const frame = ["#4a786f", "#6b9785", "#bad0ac"];
  for (const [x, y] of [
    [0, 0],
    [13, 0],
    [0, 13],
    [13, 13],
  ])
    p.stamp(x, y, ["010", "121", "010"], frame);
  p.line(5, 3, 9, 3, "#edf1d9");
  p.line(4, 12, 10, 12, "#cbdcc1");
}

function paintSponge(p, variant) {
  const palette =
    variant === "wet"
      ? ["#4c5833", "#778248", "#929951", "#b7b56a"]
      : ["#897236", "#b19945", "#cfb75b", "#e4d082"];
  p.field(palette.slice(1), 923, 4, 4);
  for (const [x, y] of [
    [1, 1],
    [9, 0],
    [5, 6],
    [11, 8],
    [0, 11],
    [8, 13],
  ])
    p.stamp(x, y, [".33.", "3001", "211.", "..1."], palette, true);
  p.stamp(12, 4, ["33.", "001", "11."], palette);
  if (variant === "wet") {
    p.stamp(2, 8, ["11.", ".10", "..1"], palette);
    p.line(11, 14, 14, 14, palette[1]);
  }
}

function paintKelp(p, variant) {
  const palette = ["#355c36", "#527b3d", "#7b9b49", "#acba59"];
  const top = variant === "tip" ? 3 : 0;
  p.rect(7, top, 2, 16 - top, palette[0]);
  p.rect(7, top, 1, 16 - top, palette[2]);
  p.stamp(3, 2, ["33...", "233..", ".231.", "..211", "...11"], palette);
  p.stamp(8, 7, ["...33", "..332", ".332.", "132..", "11..."], palette);
  p.stamp(2, 10, ["33....", "233...", "1233..", ".12211", "...111"], palette);
  if (variant === "tip") p.stamp(6, 1, [".3.", "232", "121", ".1."], palette);
}

function paintCoralBlock(p, family, palette) {
  p.field(palette.slice(1), 929, 5, 4);
  if (family === "brain") {
    for (const [x, y] of [
      [-2, 1],
      [7, 0],
      [2, 8],
      [11, 9],
    ]) {
      p.stamp(
        x,
        y,
        ["333333.", "100003.", "103333.", "103000.", "1033333", "1111111"],
        palette,
        true
      );
    }
    return;
  }
  const shape = {
    tube: [".33.", "3003", "2112", ".11."],
    bubble: [".33.", "3223", "1221", ".11."],
    fire: [".3.3.", ".212.", "32123", ".101.", "..1.."],
    horn: ["3...3", "23.32", ".212.", ".101.", "..1.."],
  }[family];
  for (const [x, y] of [
    [0, 0],
    [8, 1],
    [3, 6],
    [12, 7],
    [-1, 11],
    [7, 12],
  ])
    p.stamp(x, y, shape, palette, true);
}

function paintCoralPlant(p, family, palette) {
  p.rect(7, 11, 2, 5, palette[0]);
  p.rect(7, 12, 1, 4, palette[2]);
  if (family === "tube") {
    p.rect(4, 11, 9, 2, palette[1]);
    for (const [x, top, bottom] of [
      [3, 6, 12],
      [7, 3, 15],
      [11, 2, 12],
    ]) {
      p.rect(x, top, 3, bottom - top, palette[1]);
      p.rect(x, top + 1, 2, bottom - top - 2, palette[2]);
      p.rect(x, top, 3, 1, palette[3]);
      p.rect(x + 1, top + 1, 1, 1, palette[0]);
    }
  } else if (family === "brain") {
    p.stamp(
      2,
      3,
      [
        "...333333...",
        "..32222223..",
        ".3221122223.",
        "321332112221",
        "321221332221",
        "321132122221",
        ".2112222221.",
        "..21111121..",
        "...211112...",
        "....1111....",
      ],
      palette
    );
  } else if (family === "bubble") {
    for (const [x, y] of [
      [6, 4],
      [3, 7],
      [11, 7],
      [10, 11],
    ])
      p.line(7, 14, x, y, palette[1], 2);
    for (const [x, y] of [
      [2, 5],
      [5, 2],
      [10, 5],
      [4, 9],
      [9, 10],
    ])
      p.stamp(x, y, [".33.", "3223", "1221", ".11."], palette);
  } else if (family === "fire") {
    for (const [x0, y0, x1, y1] of [
      [7, 14, 8, 4],
      [8, 11, 3, 6],
      [3, 6, 3, 2],
      [8, 9, 12, 6],
      [12, 6, 12, 3],
      [5, 8, 1, 6],
    ])
      p.line(x0, y0, x1, y1, palette[1], 2);
    p.line(7, 13, 8, 5, palette[2]);
    p.line(4, 7, 7, 10, palette[2]);
    for (const [x, y] of [
      [2, 1],
      [7, 3],
      [11, 2],
      [1, 5],
    ])
      p.stamp(x, y, [".3.", "232", ".1."], palette);
  } else {
    for (const [x0, y0, x1, y1] of [
      [7, 15, 8, 8],
      [8, 11, 3, 7],
      [3, 7, 2, 2],
      [8, 9, 12, 6],
      [12, 6, 13, 3],
      [8, 10, 7, 3],
      [3, 5, 5, 3],
      [11, 7, 10, 2],
    ])
      p.line(x0, y0, x1, y1, palette[1], 2);
    p.line(7, 14, 8, 9, palette[2]);
    for (const [x, y] of [
      [2, 2],
      [5, 3],
      [7, 3],
      [10, 2],
      [13, 3],
    ])
      p.rect(x, y, 1, 3, palette[3]);
  }
}

const FAN_TIPS = {
  tube: [
    [2, 7],
    [4, 3],
    [7, 2],
    [10, 4],
    [12, 6],
  ],
  brain: [
    [2, 6],
    [4, 4],
    [7, 3],
    [10, 4],
    [12, 6],
  ],
  bubble: [
    [2, 6],
    [3, 3],
    [7, 2],
    [11, 3],
    [12, 7],
  ],
  fire: [
    [2, 8],
    [4, 2],
    [7, 4],
    [10, 2],
    [12, 7],
  ],
  horn: [
    [2, 5],
    [5, 2],
    [7, 5],
    [9, 2],
    [12, 5],
  ],
};

function paintCoralFan(p, family, palette) {
  p.rect(7, 12, 2, 4, palette[0]);
  let previous;
  for (const [x, y] of FAN_TIPS[family]) {
    p.line(7, 14, x, y, palette[1], 2);
    p.line(7, 13, x, y, palette[2]);
    p.stamp(x - 1, y - 1, [".3.", "232", ".1."], palette);
    const junction = [Math.round((7 + x) / 2), Math.round((14 + y) / 2)];
    if (previous) p.line(...previous, ...junction, palette[3]);
    previous = junction;
  }
}

function paintMagma(p) {
  p.field(["#4f3633", "#633d34", "#754739", "#86523c"], 937, 4, 5);
  const cracks = [
    [0, 4, 4, 5],
    [4, 5, 7, 3],
    [7, 3, 12, 4],
    [12, 4, 15, 2],
    [7, 3, 8, 9],
    [8, 9, 5, 12],
    [5, 12, 6, 15],
    [8, 9, 13, 11],
    [13, 11, 15, 10],
    [5, 12, 0, 10],
  ];
  for (const edge of cracks) p.line(...edge, "#b6532d", 2);
  for (const edge of cracks) p.line(...edge, "#e28939");
  p.line(6, 4, 7, 3, "#f2b654");
  p.line(8, 9, 10, 10, "#f2b654");
  p.line(3, 11, 5, 12, "#f2b654");
  p.stamp(1, 1, ["22.", ".10"], ["#4f3633", "#633d34", "#86523c"]);
  p.stamp(10, 13, ["222", ".10"], ["#4f3633", "#633d34", "#86523c"]);
}

function paintEnchantingTable(p, face) {
  const stone = ["#252731", "#303140", "#3e3b4f", "#50465d"];
  p.field(stone, 941, 4);
  p.stamp(2, 5, [".332", "3221", "110."], stone);
  p.stamp(9, 11, ["332.", "2210", ".10."], stone);
  if (face === "bottom") return;
  if (face === "top") {
    p.rect(1, 1, 14, 14, "#693c49");
    p.rect(2, 2, 12, 12, "#994c55");
    p.rect(3, 3, 10, 1, "#bb6b69");
    for (const [x, y] of [
      [1, 1],
      [12, 1],
      [1, 12],
      [12, 12],
    ])
      p.stamp(
        x,
        y,
        [".2.", "231", ".1."],
        ["#30464c", "#448e94", "#72beb5", "#b5d8c2"]
      );
    p.line(5, 12, 10, 12, "#733f4c");
  } else {
    p.rect(0, 0, 16, 3, "#994c55");
    p.rect(0, 0, 16, 1, "#bb6b69");
    p.rect(0, 3, 16, 1, "#b79c61");
    p.stamp(
      5,
      7,
      ["..2...", ".232..", "232323", ".131..", "..1..."],
      ["#30464c", "#448e94", "#72beb5", "#b5d8c2"]
    );
  }
}

/**
 * Replace one 16×16 RGBA tile using original, catalog-independent artwork.
 * `variant` is required for multi-variant kinds; singleton variants may omit it.
 * `face` defaults to "side" and accepts only "side", "top", or "bottom".
 * Unknown kinds/variants/faces return false without touching pixels. A known
 * key with an invalid pixel buffer throws before mutation. No lighting/tint,
 * emission, geometry, or catalog registration is implied by these pixels.
 */
export function paintExpansionMaterial(pixels, options) {
  if (paintContentBlockMaterial(pixels, options)) return true;
  const variant = resolveExpansionVariant(options, EXPANSION_MATERIAL_VARIANTS);
  if (variant === null) return false;
  const face = options.face === undefined ? "side" : options.face;
  if (!["side", "top", "bottom"].includes(face)) return false;
  const p = expansionPainter(pixels);
  const palette = options.kind.startsWith("dead_")
    ? DEAD_CORAL
    : CORAL_PALETTES[variant];
  switch (options.kind) {
    case "planks":
      paintPlanks(p, variant);
      break;
    case "prismarine":
      paintPrismarine(p, variant);
      break;
    case "sea_lantern":
      paintSeaLantern(p);
      break;
    case "sponge":
      paintSponge(p, variant);
      break;
    case "kelp":
      paintKelp(p, variant);
      break;
    case "coral_block":
    case "dead_coral_block":
      paintCoralBlock(p, variant, palette);
      break;
    case "coral":
    case "dead_coral":
      paintCoralPlant(p, variant, palette);
      break;
    case "coral_fan":
    case "dead_coral_fan":
      paintCoralFan(p, variant, palette);
      break;
    case "magma":
      paintMagma(p);
      break;
    case "enchanting_table":
      paintEnchantingTable(p, face);
      break;
    case "anvil":
      paintAnvilFace(p, face);
      break;
  }
  return true;
}
