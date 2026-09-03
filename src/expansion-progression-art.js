import { expansionPainter } from "./expansion-art-common.js";
import { painter, TEXTURE_SIZE } from "./pixel-art.js";

const QUARTZ = ["#6e6762", "#a99c90", "#cfc3b2", "#e3dccc", "#f1eddf"];
// Ore seams have warm host-facing edges; keep the unrelated item ramp intact.
const QUARTZ_ORE = ["#735848", "#ad7e73", "#baa994", "#d4cbbb", "#ece5db"];
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
  "#341a12",
  "#45241b",
  "#503127",
  "#633c32",
  "#6d4e45",
  "#82645a",
  "#9b8b80",
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

function paintAncientDebris(p, face) {
  p.field(DEBRIS.slice(2, 5), 983, 4, 6);
  // Java 26.2 has broad side strata and a winding end, not isolated ore chips.
  // The paths and interruptions here are hand-authored, not sampled bitmaps.
  if (face === "side") {
    // Unequal folded courses and a thicker side plate, as in the reference;
    // retain strata rather than replacing them with isolated mineral flecks.
    for (const [x, y, shape] of [
      [-2, 0, ["..45566543..", ".43223332210", "43223322110.", ".210011112.."]],
      [9, -2, [".4554.", "456654", "433221", "321110", ".112.."]],
      [3, 5, ["...45443..", ".456655321", "4323322210", "322233210.", ".211110..."]],
      [-2, 9, [".4544...", "5665432.", "43333221", "32223321", "2100011.", ".1122..."]],
      [11, 7, ["..454.", ".45654", "432332", "322232", "322321", "223210", ".2110."]],
    ])
      p.stamp(x, y, shape, DEBRIS, true);
    return;
  }
  const winding = [
    [0, 2],
    [12, 2],
    [12, 13],
    [2, 13],
    [2, 5],
    [8, 5],
    [8, 10],
    [5, 10],
    [5, 8],
  ];
  for (let i = 1; i < winding.length; i++)
    p.line(...winding[i - 1], ...winding[i], DEBRIS[0], 3);
  for (let i = 1; i < winding.length; i++)
    p.line(...winding[i - 1], ...winding[i], DEBRIS[5], 2);
  for (const [x0, y0, x1, y1] of [
    [3, 2, 5, 2],
    [8, 2, 10, 2],
    [12, 4, 12, 6],
    [7, 13, 10, 13],
    [2, 10, 2, 11],
    [4, 5, 7, 5],
    [8, 8, 8, 9],
  ])
    p.line(x0, y0, x1, y1, DEBRIS[6]);
  p.rect(6, 2, 2, 1, DEBRIS[4]);
  p.rect(12, 7, 1, 2, DEBRIS[3]);
  p.rect(4, 13, 2, 1, DEBRIS[4]);
  p.rect(2, 8, 1, 1, DEBRIS[2]);
  p.rect(8, 6, 1, 1, DEBRIS[3]);
  p.rect(5, 8, 1, 1, DEBRIS[1]);
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
 * Overlay narrow quartz seams, preserving every other host byte.
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
  // The reference mixes bent, short and near-vertical cuts, not equal
  // parallel sticks. Keep the existing quartz/host transition palette.
  for (const [x, y, shape] of [
    [4, 1, ["...32", "..431", ".321.", "210.."]],
    [1, 6, [".343", "3210"]],
    [10, 5, ["...3", "..42", ".321", ".10."]],
    [5, 8, ["..32", ".421", ".31.", "210.", "10.."]],
    [2, 12, [".3", "42", "10"]],
    [11, 11, [".32", ".41", "321", "10."]],
  ])
    p.stamp(x, y, shape, QUARTZ_ORE);
  return true;
}
