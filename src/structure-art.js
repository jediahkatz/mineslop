import {
  EXPANSION_WOOD_PALETTES,
  expansionPainter,
} from "./expansion-art-common.js";

// Original, compact pigment ramps. Alpha is only opacity, never light output.
const GOLD = ["#926c2c", "#b38b37", "#d3ad4c", "#e4c264", "#f3dc8d", "#fae9ae"];
const STONE = ["#515953", "#616962", "#727971", "#838980", "#979d92"];
const MOSS = ["#4b5f3f", "#5a7046", "#6a7e4d", "#80935b"];
const BRICK = ["#281e26", "#3d2632", "#50303c", "#643b46", "#7c4c52"];
const WART = ["#43202b", "#6b2c39", "#963e49", "#bd5658", "#d87768"];
const METAL = ["#252d33", "#364149", "#4a5960", "#65747a", "#84918f"];
const PAPER = ["#857658", "#b7a789", "#d7ccb0", "#efe3c3"];

const ITEM_ART = {
  nether_wart: {
    at: [2, 2],
    palette: WART,
    shape: [
      ".....00.....",
      "....0340....",
      "....03230...",
      "..00032210..",
      ".0340322100.",
      "034230210340",
      "032230103230",
      "032221032210",
      ".1221102210.",
      "..01122110..",
      "...011110...",
      ".....00.....",
    ],
  },
  nether_brick: {
    at: [1, 3],
    palette: BRICK,
    shape: [
      "....000000000.",
      "..003333333310",
      "00334433332110",
      "03222222111110",
      "03222222111110",
      "03222222111110",
      "032222221110..",
      "0322222210....",
      ".01111110.....",
    ],
  },
};

const MATERIAL_ART = {
  gold_block: paintGold,
  mossy_cobblestone: paintMossyCobblestone,
  nether_bricks: paintNetherBricks,
  nether_wart_crop: paintWartCrop,
  spawner: paintSpawner,
  composter: paintComposter,
  lectern: paintLectern,
  cartography_table: paintCartographyTable,
  smithing_table: paintSmithingTable,
};

export const STRUCTURE_ITEM_KEYS = Object.freeze(Object.keys(ITEM_ART));
export const STRUCTURE_MATERIAL_KEYS = Object.freeze(Object.keys(MATERIAL_ART));
export const STRUCTURE_MATERIAL_FACES = Object.freeze([
  "side",
  "top",
  "bottom",
]);
export const STRUCTURE_ITEM_DESCRIPTORS = Object.freeze(
  STRUCTURE_ITEM_KEYS.map((kind) => Object.freeze({ kind }))
);
export const STRUCTURE_MATERIAL_DESCRIPTORS = Object.freeze(
  STRUCTURE_MATERIAL_KEYS.flatMap((kind) =>
    STRUCTURE_MATERIAL_FACES.map((face) => Object.freeze({ kind, face }))
  )
);

const ITEM_FIELDS = new Set(["kind"]);
const MATERIAL_FIELDS = new Set(["kind", "face"]);

function supported(options, keys, fields) {
  return (
    options !== null &&
    typeof options === "object" &&
    typeof options.kind === "string" &&
    keys.includes(options.kind) &&
    Reflect.ownKeys(options).every((key) => fields.has(key))
  );
}

function paintGold(p) {
  // A broad metal face with a narrow bevel and short, low-contrast reflections.
  p.rect(0, 0, 16, 16, GOLD[2]);
  p.line(0, 0, 15, 0, GOLD[3]);
  p.line(0, 0, 0, 15, GOLD[3]);
  p.line(15, 0, 15, 15, GOLD[0]);
  p.line(0, 15, 15, 15, GOLD[0]);
  p.line(1, 1, 14, 1, GOLD[5]);
  p.line(1, 2, 1, 13, GOLD[4]);
  p.line(2, 14, 14, 14, GOLD[1]);
  p.line(14, 2, 14, 13, GOLD[1]);
  p.line(4, 3, 9, 3, GOLD[3]);
  p.line(3, 4, 6, 4, GOLD[3]);
  p.line(10, 11, 12, 11, GOLD[3]);
}

function paintMossyCobblestone(p) {
  p.rect(0, 0, 16, 16, STONE[1]);
  // Small angular stones and short moss trails continue through tile borders.
  // The gray body remains dominant; no random speckles or broad moss blobs.
  for (const [x, y, shape] of [
    [-1, 0, ["..333.", ".32221", "322221", "222110", ".110.."]],
    [6, -1, [".3333.", "322221", "322221", "221110", ".100.."]],
    [12, 2, [".333.", "32221", "32221", "21110"]],
    [2, 5, [".4333.", "332221", "322221", "221110"]],
    [9, 7, [".3333.", "322221", "322221", "221110", ".110.."]],
    [-1, 10, [".3333.", "322221", "322221", "211110"]],
    [4, 12, [".43333.", "3322221", "3222210", "221110."]],
  ])
    p.stamp(x, y, shape, STONE, true);
  for (const [x, y, shape] of [
    [1, 3, ["..2..", "123..", ".1232", "..010"]],
    [10, 1, [".32.", "221.", ".120", "..0."]],
    [7, 10, ["..3.", "1232", "021.", ".10."]],
    [14, 13, [".23.", "1220", ".110"]],
  ])
    p.stamp(x, y, shape, MOSS, true);
}

function paintNetherBricks(p) {
  p.rect(0, 0, 16, 16, BRICK[0]);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    for (let x = row % 2 ? -4 : 0; x < 16; x += 8) {
      p.rect(x + 1, y + 1, 7, 3, BRICK[2]);
      p.line(x + 1, y + 1, x + 7, y + 1, BRICK[3]);
      p.line(x + 1, y + 3, x + 7, y + 3, BRICK[1]);
      p.rect(x + 1, y + 2, 1, 1, BRICK[3]);
    }
  }
  for (const [x, y] of [
    [2, 1],
    [6, 5],
    [10, 9],
  ])
    p.rect(x, y, 2, 1, BRICK[4]);
}

function paintWartCrop(p) {
  // Three uneven red lobes share a rooted stalk, not a solid red billboard.
  p.rect(7, 8, 2, 8, WART[1]);
  p.line(7, 10, 7, 15, WART[2]);
  p.line(4, 10, 7, 13, WART[1], 2);
  p.line(11, 9, 8, 12, WART[1], 2);
  p.stamp(
    5,
    1,
    [
      "..00..",
      ".0340.",
      "034430",
      "032230",
      "132210",
      ".0210.",
      "..10..",
      "..10..",
    ],
    WART
  );
  p.stamp(
    1,
    6,
    [".00...", "0340..", "03230.", "032230", ".12210", "..110.", "...1.."],
    WART
  );
  p.stamp(
    9,
    4,
    ["..00..", ".0340.", "032430", "032230", ".12210", "..110.", "...1.."],
    WART
  );
}

function paintSpawner(p) {
  // An open cage: continuous corner rails, two uprights, one crossbar. The
  // unpainted windows really are transparent, not an opaque dark background.
  p.rect(0, 0, 16, 2, METAL[1]);
  p.rect(0, 14, 16, 2, METAL[0]);
  p.rect(0, 2, 2, 12, METAL[1]);
  p.rect(14, 2, 2, 12, METAL[0]);
  p.line(0, 0, 15, 0, METAL[2]);
  p.line(0, 0, 0, 15, METAL[2]);
  p.line(1, 1, 14, 1, METAL[3]);
  p.line(1, 1, 1, 14, METAL[3]);
  p.line(14, 1, 14, 14, METAL[1]);
  p.line(1, 14, 14, 14, METAL[1]);
  for (const x of [5, 10]) {
    p.rect(x, 2, 2, 12, METAL[0]);
    p.line(x, 2, x, 13, METAL[2]);
  }
  p.rect(2, 7, 12, 2, METAL[0]);
  p.line(2, 7, 13, 7, METAL[2]);
  for (const [x, y] of [
    [1, 1],
    [14, 1],
    [1, 14],
    [14, 14],
  ])
    p.rect(x, y, 1, 1, METAL[4]);
}

function paintPlankFace(p, wood) {
  p.rect(0, 0, 16, 16, wood[2]);
  for (const [y, joint] of [
    [0, 6],
    [5, 12],
    [10, 4],
  ]) {
    p.line(0, y, 15, y, wood[0]);
    p.line(0, y + 1, 15, y + 1, wood[3]);
    p.line(joint, y + 1, joint, y + 4, wood[1]);
  }
  p.line(2, 3, 5, 3, wood[1]);
  p.line(7, 8, 10, 8, wood[4]);
  p.line(8, 13, 13, 13, wood[1]);
}

function paintBracedBase(p, wood) {
  paintPlankFace(p, wood);
  for (const x of [2, 12]) {
    p.rect(x, 0, 2, 16, wood[1]);
    p.line(x, 0, x, 15, wood[3]);
    for (const y of [2, 13]) p.rect(x + 1, y, 1, 1, wood[0]);
  }
}

function paintComposter(p, face) {
  const wood = EXPANSION_WOOD_PALETTES.spruce;
  if (face === "bottom") {
    paintBracedBase(p, wood);
    return;
  }
  if (face === "top") {
    // Nested rim/inner-wall shadows imply depth on the full cube; no hole.
    p.rect(0, 0, 16, 16, wood[1]);
    p.rect(1, 1, 14, 14, wood[3]);
    p.rect(2, 2, 12, 12, wood[0]);
    p.rect(3, 3, 10, 10, "#342c24");
    p.rect(3, 3, 10, 2, "#2b241e");
    p.rect(3, 5, 2, 8, "#3f3428");
    p.rect(5, 5, 8, 8, "#504032");
    const scraps = ["#4b4230", "#635333", "#6f6941", "#88905a"];
    p.stamp(5, 8, ["23.", "120", ".10"], scraps);
    p.stamp(9, 6, ["32", "10"], scraps);
    p.stamp(10, 11, ["12", "00"], scraps);
    p.line(0, 0, 15, 0, wood[4]);
    p.line(0, 0, 0, 15, wood[3]);
    p.line(0, 15, 15, 15, wood[0]);
    p.line(15, 0, 15, 15, wood[0]);
    p.rect(7, 0, 1, 2, wood[1]);
    p.rect(0, 9, 2, 1, wood[1]);
    return;
  }
  p.rect(0, 0, 16, 16, wood[2]);
  for (const x of [0, 4, 8, 12]) {
    p.line(x, 0, x, 15, wood[0]);
    p.line(x + 1, 0, x + 1, 15, wood[3]);
  }
  p.line(2, 4, 2, 8, wood[1]);
  p.line(6, 8, 6, 11, wood[3]);
  p.line(10, 2, 10, 5, wood[1]);
  p.line(14, 8, 14, 13, wood[3]);
  p.rect(0, 0, 16, 2, wood[1]);
  p.line(0, 0, 15, 0, wood[4]);
  p.rect(0, 13, 16, 3, wood[1]);
  p.line(0, 13, 15, 13, wood[3]);
  p.line(0, 15, 15, 15, wood[0]);
  for (const [x, y] of [
    [2, 1],
    [10, 1],
    [2, 14],
    [10, 14],
  ])
    p.rect(x, y, 1, 1, METAL[1]);
}

function paintLectern(p, face) {
  const wood = EXPANSION_WOOD_PALETTES.oak;
  paintPlankFace(p, wood);
  if (face === "bottom") {
    p.rect(5, 5, 6, 6, wood[0]);
    p.rect(6, 6, 4, 4, wood[1]);
    p.line(6, 6, 9, 6, wood[3]);
    p.rect(8, 8, 1, 1, wood[0]);
    return;
  }
  if (face === "top") {
    p.rect(0, 0, 16, 2, wood[1]);
    p.line(0, 0, 15, 0, wood[4]);
    p.rect(2, 3, 12, 9, "#3c5555");
    p.rect(3, 3, 10, 8, PAPER[1]);
    p.rect(3, 4, 4, 6, PAPER[3]);
    p.rect(8, 3, 4, 7, PAPER[2]);
    p.line(3, 3, 6, 3, PAPER[2]);
    p.line(8, 3, 11, 3, PAPER[3]);
    p.line(7, 4, 7, 10, PAPER[0]);
    p.line(4, 5, 5, 5, PAPER[0]);
    p.line(4, 7, 6, 7, PAPER[1]);
    p.line(9, 5, 10, 5, PAPER[0]);
    p.line(9, 7, 10, 7, PAPER[0]);
    p.line(7, 10, 7, 13, WART[2]);
    p.rect(0, 13, 16, 2, wood[1]);
    p.line(0, 13, 15, 13, wood[4]);
    p.line(0, 15, 15, 15, wood[0]);
    return;
  }
  p.rect(0, 0, 16, 4, wood[1]);
  p.line(0, 0, 15, 0, wood[4]);
  p.line(0, 3, 15, 3, wood[0]);
  p.line(2, 1, 13, 1, PAPER[1]);
  p.line(3, 1, 6, 1, PAPER[3]);
  p.line(8, 1, 12, 1, PAPER[2]);
  p.rect(7, 1, 1, 2, "#3c5555");
  p.rect(3, 5, 10, 8, wood[1]);
  p.rect(6, 4, 4, 9, wood[0]);
  p.line(6, 4, 6, 12, wood[3]);
  p.rect(7, 4, 2, 9, wood[2]);
  p.line(4, 6, 6, 8, wood[3]);
  p.line(11, 6, 9, 8, wood[1]);
  p.rect(0, 13, 16, 3, wood[1]);
  p.line(0, 13, 15, 13, wood[4]);
  p.line(0, 15, 15, 15, wood[0]);
}

function paintCartographyTable(p, face) {
  const wood = EXPANSION_WOOD_PALETTES.jungle;
  if (face === "bottom") {
    paintBracedBase(p, wood);
    return;
  }
  paintPlankFace(p, wood);
  if (face === "top") {
    p.line(0, 0, 15, 0, wood[4]);
    p.line(15, 0, 15, 15, wood[0]);
    p.line(0, 15, 15, 15, wood[0]);
    p.rect(1, 2, 11, 11, PAPER[0]);
    p.rect(2, 2, 9, 10, PAPER[2]);
    p.line(2, 2, 10, 2, PAPER[3]);
    p.line(2, 11, 10, 11, PAPER[1]);
    p.stamp(
      3,
      4,
      ["..11.", ".110.", "000..", ".0...", "00..."],
      ["#77906a", "#a0ac7d"]
    );
    p.stamp(
      7,
      4,
      ["1..", "01.", ".1.", ".01", "..1", ".1."],
      ["#94adb0", "#648793"]
    );
    p.line(4, 8, 4, 10, WART[2]);
    p.line(3, 9, 5, 9, WART[2]);
    // A small pair of dividers alongside the map and a pencil below it.
    p.stamp(
      12,
      4,
      [".3.", "343", ".2.", ".1.", "1.1"],
      [METAL[0], GOLD[1], GOLD[2], GOLD[3], GOLD[4]]
    );
    p.line(2, 13, 9, 13, wood[0]);
    p.line(3, 13, 8, 13, GOLD[3]);
    p.rect(10, 13, 1, 1, METAL[2]);
    return;
  }
  p.rect(0, 0, 16, 2, wood[1]);
  p.line(0, 0, 15, 0, wood[4]);
  p.rect(2, 3, 12, 4, wood[0]);
  p.rect(3, 4, 10, 2, wood[1]);
  for (const x of [4, 7, 10]) {
    p.rect(x, 4, 2, 2, PAPER[2]);
    p.rect(x + 1, 5, 1, 1, PAPER[0]);
  }
  p.rect(2, 9, 12, 5, wood[0]);
  p.rect(3, 10, 10, 3, wood[2]);
  p.line(3, 10, 12, 10, wood[3]);
  p.line(7, 11, 9, 11, GOLD[1]);
  p.rect(7, 11, 1, 1, GOLD[3]);
}

function paintSmithingTable(p, face) {
  const wood = EXPANSION_WOOD_PALETTES.dark_oak;
  if (face === "bottom") {
    paintBracedBase(p, wood);
    for (const [x, y] of [
      [0, 0],
      [13, 0],
      [0, 13],
      [13, 13],
    ]) {
      p.rect(x, y, 3, 3, METAL[0]);
      p.rect(x + 1, y + 1, 1, 1, METAL[2]);
    }
    return;
  }
  if (face === "top") {
    p.rect(0, 0, 16, 16, METAL[0]);
    p.rect(1, 1, 14, 14, METAL[1]);
    p.line(1, 1, 14, 1, METAL[3]);
    p.line(1, 1, 1, 14, METAL[2]);
    p.rect(3, 3, 7, 7, METAL[2]);
    p.line(3, 3, 9, 3, METAL[3]);
    p.line(3, 9, 9, 9, METAL[0]);
    p.line(3, 4, 6, 4, METAL[3]);
    p.line(3, 8, 4, 8, METAL[0]);
    p.line(9, 7, 6, 11, wood[1], 2);
    p.line(9, 7, 6, 10, wood[3]);
    p.stamp(8, 4, [".333.", "34431", "12210", ".110."], METAL);
    for (const [x, y] of [
      [1, 1],
      [14, 1],
      [1, 14],
      [14, 14],
    ])
      p.rect(x, y, 1, 1, METAL[4]);
    return;
  }
  paintPlankFace(p, wood);
  p.rect(0, 0, 16, 3, METAL[0]);
  p.line(0, 0, 15, 0, METAL[3]);
  p.line(0, 1, 15, 1, METAL[1]);
  p.rect(0, 3, 2, 13, METAL[0]);
  p.line(1, 3, 1, 14, METAL[2]);
  p.rect(14, 3, 2, 13, METAL[0]);
  p.line(14, 3, 14, 14, METAL[1]);
  p.rect(2, 4, 12, 4, wood[0]);
  p.rect(3, 5, 10, 2, wood[1]);
  p.line(3, 5, 12, 5, wood[3]);
  p.line(7, 6, 8, 6, METAL[3]);
  p.rect(2, 9, 12, 5, wood[1]);
  p.line(4, 10, 6, 12, METAL[2]);
  p.line(6, 10, 4, 12, METAL[1]);
  p.line(10, 10, 10, 13, wood[3]);
  p.line(9, 10, 11, 10, METAL[3]);
}

/**
 * Paint an original 16×16 RGBA structure material using only {kind, face?}.
 * Face defaults to "side" for horizontal faces; "top"/"bottom" are their planes.
 * Composter, lectern, cartography_table and smithing_table have three distinct,
 * fully opaque cube faces. Other kinds share one image on every face. Nether
 * brick stairs/slabs/fences use {kind: "nether_bricks"}, not separate art kinds.
 * Spawner windows and the wart crop silhouette use alpha 0/255; every other
 * material is opaque. Geometry, cutout flags, IDs and lighting are caller-owned.
 *
 * Unsupported descriptors (including extra keys) return false untouched.
 * Recognized descriptors replace exactly 1024 Uint8Array/Uint8ClampedArray
 * elements and return true. Invalid types throw TypeError and invalid lengths
 * throw RangeError, both before any mutation.
 */
export function paintStructureMaterial(pixels, options) {
  if (!supported(options, STRUCTURE_MATERIAL_KEYS, MATERIAL_FIELDS))
    return false;
  const face = options.face === undefined ? "side" : options.face;
  if (!STRUCTURE_MATERIAL_FACES.includes(face)) return false;
  MATERIAL_ART[options.kind](expansionPainter(pixels), face);
  return true;
}

/**
 * Paint an original cutout item sprite using only {kind}: nether_wart or
 * nether_brick. Buffer validation, full-tile replacement and return values
 * follow paintStructureMaterial. Transparent pixels are cleared RGBA zero;
 * visible pixels are opaque pigment, not an emission/lighting channel.
 */
export function paintStructureItem(pixels, options) {
  if (!supported(options, STRUCTURE_ITEM_KEYS, ITEM_FIELDS)) return false;
  const art = ITEM_ART[options.kind];
  const p = expansionPainter(pixels);
  p.stamp(...art.at, art.shape, art.palette);
  return true;
}
