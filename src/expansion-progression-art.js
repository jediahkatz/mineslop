import { expansionPainter } from "./expansion-art-common.js";
import { painter, TEXTURE_SIZE } from "./pixel-art.js";

const QUARTZ = ["#6e6762", "#a99c90", "#cfc3b2", "#e3dccc", "#f1eddf"];
const GOLD = ["#775332", "#a47834", "#c8a046", "#e2bf66", "#efd89b"];
const PRISMARINE = ["#294d50", "#3f716e", "#609991", "#88bdb0", "#bddcca"];
const SEA_CRYSTAL = ["#315357", "#557f79", "#81ada0", "#b1d7bd", "#e4edd0"];
const NETHERITE = [
  "#282b2f",
  "#393b3f",
  "#514e4f",
  "#6d635f",
  "#8e7c6e",
  "#aa927c",
];
const DEBRIS = [
  "#342f2d",
  "#493d37",
  "#5f4f44",
  "#796858",
  "#96846d",
  "#b09b80",
];

// Original mineral silhouettes, independent of equipment tiers and registries.
const ITEM_ART = {
  quartz: {
    at: [2, 1],
    palette: QUARTZ,
    shape: [
      ".......0....",
      "......030...",
      "......0340..",
      "..0..032230.",
      ".0300322230.",
      ".0340322230.",
      "032210322230",
      "032210322210",
      ".0321222210.",
      "..03222210..",
      "...032210...",
      "....0110....",
      ".....00.....",
    ],
  },
  gold_nugget: {
    at: [4, 5],
    palette: GOLD,
    shape: [
      "..000...",
      ".03440..",
      "0342230.",
      "03222230",
      "03221210",
      ".011110.",
      "..0000..",
    ],
  },
  netherite_scrap: {
    at: [2, 3],
    palette: NETHERITE,
    shape: [
      ".....000....",
      "..0003440...",
      ".034433210..",
      "0342211100..",
      "032210..030.",
      ".03221003210",
      "..0322222110",
      "...01122110.",
      "..0032110...",
      "..011100....",
      "...00.......",
    ],
    accents: [[3, 7, 4, 1, 5]],
  },
  netherite_ingot: {
    at: [1, 4],
    palette: NETHERITE,
    shape: [
      "...00000000...",
      "..0344444430..",
      ".033333333230.",
      "03322222222230",
      "03222222222210",
      "03221111111110",
      ".011111111110.",
      "..0000000000..",
    ],
    accents: [[5, 5, 4, 1, 5]],
  },
  prismarine_shard: {
    at: [2, 2],
    palette: PRISMARINE,
    shape: [
      "........00..",
      ".......0340.",
      "......03340.",
      ".....0332340",
      "....03322310",
      "...033222310",
      "..0332222110",
      ".0332222110.",
      "0322221110..",
      "032211100...",
      ".011000.....",
      "..00........",
    ],
  },
  prismarine_crystals: {
    at: [2, 2],
    palette: SEA_CRYSTAL,
    shape: [
      "..00...00...",
      ".0340.0340..",
      ".0320032340.",
      "003221232340",
      "034222223210",
      "032222222210",
      ".0322122210.",
      "..03212110..",
      "...021110...",
      "....0110....",
      ".....00.....",
    ],
  },
};

const MATERIAL_ART = {
  ancient_debris: paintAncientDebris,
  quartz_block: paintQuartzBlock,
};

export const PROGRESSION_ITEM_KEYS = Object.freeze(Object.keys(ITEM_ART));
export const PROGRESSION_MATERIAL_KEYS = Object.freeze(
  Object.keys(MATERIAL_ART)
);
export const PROGRESSION_MATERIAL_FACES = Object.freeze([
  "side",
  "top",
  "bottom",
]);

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

function stroke(p, points, color, width = 1) {
  for (let i = 1; i < points.length; i++)
    p.line(...points[i - 1], ...points[i], color, width);
}

function paintAncientDebris(p, face) {
  p.field(DEBRIS.slice(1, 4), 983, 4, 6);
  if (face === "side") {
    const layers = [
      [
        [0, 3],
        [5, 3],
        [7, 2],
        [12, 2],
        [15, 3],
      ],
      [
        [0, 8],
        [4, 8],
        [6, 9],
        [11, 9],
        [13, 7],
        [15, 8],
      ],
      [
        [0, 14],
        [3, 14],
        [6, 13],
        [10, 13],
        [12, 14],
        [15, 14],
      ],
    ];
    for (const layer of layers) {
      stroke(p, layer, DEBRIS[0], 3);
      stroke(p, layer, DEBRIS[2], 2);
      stroke(p, layer, DEBRIS[4]);
    }
    p.stamp(2, 5, [".54.", "4321", ".10."], DEBRIS);
    p.stamp(10, 10, ["543.", "2210"], DEBRIS);
  } else {
    // A fractured cross-section with flat lamellae, not concentric log rings.
    p.stamp(
      1,
      1,
      ["..444443..", ".432222231", "4322222231", "3222222210", ".21111110."],
      DEBRIS
    );
    p.stamp(
      6,
      9,
      ["..44443..", ".43222231", "432222221", "322222210", ".2111110."],
      DEBRIS
    );
    const fracture = [
      [0, 12],
      [5, 8],
      [10, 8],
      [15, 4],
    ];
    stroke(p, fracture, DEBRIS[0], 2);
    stroke(p, fracture, DEBRIS[3]);
    p.stamp(2, 7, [".54.", "4321", ".10."], DEBRIS);
    p.line(5, 3, 7, 3, DEBRIS[5]);
  }
}

function paintQuartzBlock(p) {
  const stone = ["#c8c5ba", "#d4d1c5", "#dedccf", "#e8e6d8", "#f0eee0"];
  p.field(stone.slice(1, 4), 991, 4, 5);
  // Restrained cleavage marks over a quiet pale surface, without tile borders.
  p.stamp(2, 4, ["44..", "..10"], stone);
  p.stamp(9, 11, [".44..", "211..", "..1.."], stone);
  p.line(10, 2, 13, 2, stone[3]);
}

/**
 * Replace a complete 16×16 RGBA tile with an original item cutout.
 * Options contain only {kind}, using PROGRESSION_ITEM_KEYS. Unknown descriptors
 * return false without touching pixels. Recognized descriptors require exactly
 * 1024 Uint8Array/Uint8ClampedArray elements. Invalid types throw TypeError and
 * invalid lengths throw RangeError, both before mutation. Success returns true.
 * Alpha is ordinary opacity, never emission.
 */
export function paintProgressionItem(pixels, options) {
  if (!supported(options, PROGRESSION_ITEM_KEYS, ITEM_FIELDS)) return false;
  const p = expansionPainter(pixels);
  const art = ITEM_ART[options.kind];
  p.stamp(...art.at, art.shape, art.palette);
  for (const [x, y, width, height, ink] of art.accents ?? [])
    p.rect(x, y, width, height, art.palette[ink]);
  return true;
}

/**
 * Replace a complete tile with opaque material art. Options contain only
 * {kind, face?}; face defaults to "side" and accepts side/top/bottom. Debris
 * top/bottom share a cross-section; quartz stone is face-independent.
 * Unknown descriptors return false untouched, invalid recognized buffers throw
 * before mutation, and success returns true, as with paintProgressionItem.
 */
export function paintProgressionMaterial(pixels, options) {
  if (!supported(options, PROGRESSION_MATERIAL_KEYS, MATERIAL_FIELDS))
    return false;
  const face = options.face === undefined ? "side" : options.face;
  if (!PROGRESSION_MATERIAL_FACES.includes(face)) return false;
  MATERIAL_ART[options.kind](expansionPainter(pixels), face);
  return true;
}

/**
 * Overlay three connected quartz deposits, preserving every other host byte.
 * Paint the intended host rock first; this function never clears, recolors, or
 * chooses it. Deposit ink is opaque, with no lighting/emission interpretation.
 * Targets must be exactly 1024 Uint8Array/Uint8ClampedArray elements. Invalid
 * types throw TypeError and lengths throw RangeError BEFORE any write.
 * Success returns true.
 */
export function paintQuartzDeposits(pixels) {
  // The shared expansionPainter clears its target, so overlays validate here.
  if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray))
    throw new TypeError(
      "Quartz deposits need a Uint8Array or Uint8ClampedArray"
    );
  if (pixels.length !== TEXTURE_SIZE * TEXTURE_SIZE * 4)
    throw new RangeError("Quartz deposits need exactly 16 × 16 RGBA pixels");
  const p = painter(pixels);
  for (const [x, y, shape] of [
    [1, 2, ["...3...", "..342..", ".23421.", "012210.", "..110.."]],
    [10, 1, ["..3..", ".342.", "03221", "12210", ".110.", "..0.."]],
    [5, 10, ["...3..", "..342.", ".03221", "032210", ".110.."]],
  ])
    p.stamp(x, y, shape, QUARTZ);
  return true;
}
