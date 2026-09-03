import {
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
  expansionArtVariants,
  expansionPainter,
  resolveExpansionVariant,
} from "./expansion-art-common.js";

// Original cloth ramps: hem/shadow, body, raised thread. These are pigment
// colors; alpha in this module always means ordinary opacity, never emission.
const WOOL = {
  white: ["#b5bebc", "#d5dad2", "#ebece0"],
  orange: ["#b46632", "#d48242", "#e59e56"],
  magenta: ["#8f477e", "#b865a1", "#d384b8"],
  light_blue: ["#548eae", "#78b0c8", "#a0cfdb"],
  yellow: ["#b89c3d", "#d8be55", "#ecd57c"],
  lime: ["#6d8f3a", "#92b84d", "#b6d070"],
  pink: ["#b5788f", "#d99aad", "#ecb9c6"],
  gray: ["#4a5155", "#636b6e", "#7b8585"],
  light_gray: ["#8d9797", "#aab3af", "#c4ccc4"],
  cyan: ["#347982", "#4b9da2", "#70bbb8"],
  purple: ["#63427e", "#875aa0", "#aa7fbc"],
  blue: ["#354f85", "#4b6aa2", "#708abe"],
  brown: ["#654c3b", "#896b50", "#ab8967"],
  green: ["#455f34", "#658245", "#8ba260"],
  red: ["#8d4240", "#b65b52", "#d7816b"],
  black: ["#282e32", "#3b4347", "#525d60"],
};

export const BUILDING_WOOL_COLORS = Object.freeze(Object.keys(WOOL));
export const BUILDING_MATERIAL_FACES = Object.freeze(["side", "top", "bottom"]);
export const BUILDING_MATERIAL_VARIANTS = expansionArtVariants({
  copper_block: ["default"],
  deepslate: ["default"],
  cobbled_deepslate: ["default"],
  bookshelf: EXPANSION_WOOD_FAMILIES,
  ladder: EXPANSION_WOOD_FAMILIES,
  door: EXPANSION_WOOD_FAMILIES,
  trapdoor: EXPANSION_WOOD_FAMILIES,
  bed: BUILDING_WOOL_COLORS,
});
export const BUILDING_MATERIAL_PARTS = expansionArtVariants({
  door: ["lower", "upper"],
  bed: ["foot", "head"],
});

// Fully specified, frozen inputs for callers that need to enumerate tiles.
// Duplicate images (e.g. the wooden undersides of colored beds) are intentional;
// an atlas owner can deduplicate them rather than assigning meaning to indices.
export const BUILDING_MATERIAL_DESCRIPTORS = Object.freeze(
  Object.entries(BUILDING_MATERIAL_VARIANTS).flatMap(([kind, variants]) =>
    variants.flatMap((variant) =>
      (BUILDING_MATERIAL_PARTS[kind] ?? [undefined]).flatMap((part) =>
        BUILDING_MATERIAL_FACES.map((face) =>
          Object.freeze({
            kind,
            variant,
            face,
            ...(part === undefined ? {} : { part }),
          })
        )
      )
    )
  )
);

const OPTION_KEYS = new Set(["kind", "variant", "face", "part"]);
const CLEAR = [0, 0, 0, 0];
const SLATE = ["#353c42", "#3b4349", "#424a50", "#495158", "#50585e"];

function paintCopper(p) {
  const palette = ["#734733", "#955c40", "#b77750", "#cf9163", "#e3b17c"];
  p.rect(0, 0, 16, 16, palette[2]);
  for (const y of [0, 8]) {
    for (const x of [0, 8]) {
      p.line(x, y, x + 7, y, palette[1]);
      p.line(x, y, x, y + 7, palette[1]);
      p.line(x + 1, y + 1, x + 6, y + 1, palette[4]);
      p.line(x + 1, y + 2, x + 1, y + 6, palette[3]);
      p.line(x + 2, y + 6, x + 6, y + 6, palette[1]);
      p.rect(x + 5, y + 3, 2, 2, palette[3]);
      p.rect(x + 5, y + 3, 1, 1, palette[4]);
      p.rect(x + 6, y + 4, 1, 1, palette[0]);
    }
  }
}

function paintDeepslate(p, face) {
  // Small, connected tonal grains. No broad value-noise contours, concentric
  // outlines, or large bright/dark patches to camouflage a cave wall.
  p.stamp(
    0,
    0,
    [
      "2223322221122232",
      "2332211222233222",
      "2222112223322212",
      "1122223322221122",
      "2223312221122223",
      "2232222112233222",
      "2221122322222112",
      "3322222223322211",
      "2222331222212222",
      "2211222233222112",
      "2222221122233222",
      "1223322222112223",
      "2222211223322221",
      "2332222122221122",
      "2221122232222332",
      "3222222331122222",
    ],
    SLATE
  );
  p.stamp(1, 4, ["33..", "..10"], SLATE);
  p.stamp(8, 10, ["443..", "..210"], SLATE);
  if (face === "side") {
    p.stamp(1, 3, ["333..", "..211"], SLATE);
    p.stamp(9, 9, ["3333.", "..211"], SLATE);
    p.stamp(4, 14, ["2333", "111."], SLATE);
  } else {
    p.stamp(6, 2, [".3.", "321", ".1."], SLATE);
  }
}

function paintCobbledDeepslate(p) {
  const palette = ["#2b3237", "#353e45", "#424c53", "#535e65", "#646e74"];
  p.rect(0, 0, 16, 16, palette[0]);
  // Offset, straight-edged fracture faces tile through the border. Each face
  // has a lit ledge and a dark lower edge instead of a rounded pebble outline.
  for (const [x, y, shape] of [
    [-1, 0, ["..44443.", ".4322231", "43222221", "32222210", ".211110."]],
    [8, -1, ["444443.", "3222231", "3222221", "3222210", "211110."]],
    [3, 5, ["444443..", "32222310", "32222221", "32222210", "2111110."]],
    [-2, 9, [".44443.", "4322231", "3222221", "3222210", "211110."]],
    [10, 7, [".44443", "432221", "322221", "322210", "11110."]],
    [5, 12, ["444443.", "3222231", "3222221", "2111110"]],
    [12, 13, [".443.", "43221", "32221", "21110"]],
  ])
    p.stamp(x, y, shape, palette, true);
}

function paintBoards(p, palette) {
  p.field(palette.slice(1, 4), 971, 2, 7);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    p.rect(0, y, 16, 1, palette[1]);
    p.rect(0, y + 1, 16, 1, palette[3]);
    p.rect(row % 2 ? 11 : 4, y + 1, 1, 3, palette[0]);
  }
  p.line(7, 2, 12, 2, palette[4]);
  p.stamp(2, 10, ["32.", ".21"], palette);
}

function paintWoodEdge(p, palette) {
  p.line(0, 0, 15, 0, palette[4]);
  p.line(0, 15, 15, 15, palette[0]);
  p.line(2, 6, 6, 6, palette[1]);
  p.line(8, 10, 13, 10, palette[3]);
}

function paintBookshelf(p, palette, face) {
  paintBoards(p, palette);
  if (face !== "side") return;
  const books = [
    ["#553e38", "#8a5242", "#b37657"],
    ["#35434c", "#52737b", "#89a2a0"],
    ["#48503a", "#768250", "#a6af78"],
    ["#70573c", "#ad874e", "#d4b175"],
    ["#514254", "#81617e", "#b092a6"],
  ];
  for (const [row, y] of [2, 9].entries()) {
    p.rect(2, y, 12, 5, "#322d29");
    for (const [index, [x, width]] of [
      [2, 2],
      [4, 3],
      [7, 2],
      [9, 3],
      [12, 2],
    ].entries()) {
      const tones = books[(index + row * 2) % books.length];
      const offset = (index + row) % 3 === 0 ? 1 : 0;
      const top = y + offset;
      p.rect(x, top, width, 5 - offset, tones[0]);
      p.rect(x + 1, top, width - 1, 4 - offset, tones[1]);
      p.line(x + 1, top, x + width - 1, top, tones[2]);
      if (index % 2 === row) p.rect(x + 1, top + 2, width - 1, 1, "#d2c3a0");
    }
  }
  for (const y of [0, 7, 14]) {
    p.rect(0, y, 16, 2, palette[1]);
    p.line(0, y, 15, y, palette[3]);
  }
  p.rect(0, 0, 2, 16, palette[0]);
  p.rect(14, 0, 2, 16, palette[0]);
  p.line(1, 0, 1, 15, palette[3]);
  p.line(14, 0, 14, 15, palette[1]);
}

function paintLadder(p, palette) {
  for (const x of [3, 11]) {
    p.rect(x, 0, 2, 16, palette[0]);
    p.rect(x, 0, 1, 16, palette[3]);
  }
  for (const y of [2, 6, 10, 14]) {
    p.rect(4, y, 8, 2, palette[1]);
    p.line(4, y, 11, y, palette[4]);
    p.rect(4, y + 1, 1, 1, palette[2]);
    p.rect(10, y + 1, 1, 1, palette[0]);
  }
}

function paintDoor(p, palette, face, part) {
  paintBoards(p, palette);
  if (face !== "side") {
    paintWoodEdge(p, palette);
    return;
  }
  p.rect(0, 0, 2, 16, palette[0]);
  p.rect(14, 0, 2, 16, palette[0]);
  p.line(1, 0, 1, 15, palette[3]);
  p.line(14, 0, 14, 15, palette[1]);
  p.rect(2, 0, 12, 2, palette[1]);
  p.rect(2, 14, 12, 2, palette[1]);
  if (part === "upper") {
    p.line(2, 0, 13, 0, palette[4]);
    p.line(2, 14, 13, 14, palette[3]);
    p.rect(3, 3, 10, 10, palette[0]);
    p.line(3, 3, 12, 3, palette[4]);
    p.rect(4, 4, 8, 8, CLEAR);
    p.rect(7, 4, 2, 8, palette[2]);
    p.line(7, 4, 7, 11, palette[3]);
    p.rect(4, 7, 8, 2, palette[2]);
    p.line(4, 7, 11, 7, palette[3]);
  } else {
    p.line(2, 1, 13, 1, palette[3]);
    p.line(2, 14, 13, 14, palette[4]);
    p.rect(3, 3, 10, 10, palette[0]);
    p.rect(4, 4, 8, 8, palette[2]);
    p.line(4, 4, 11, 4, palette[3]);
    p.line(4, 11, 11, 11, palette[1]);
    p.line(8, 5, 8, 10, palette[1]);
    p.stamp(5, 8, ["33.", ".21"], palette);
    p.rect(11, 3, 3, 3, "#4c4535");
    p.rect(12, 3, 1, 2, "#e0c784");
    p.rect(11, 4, 2, 1, "#b99b57");
  }
}

function paintTrapdoor(p, palette, face) {
  paintBoards(p, palette);
  if (face === "side") {
    paintWoodEdge(p, palette);
    return;
  }
  p.rect(3, 3, 10, 10, palette[0]);
  p.rect(3, 7, 10, 2, palette[2]);
  p.line(3, 7, 12, 7, palette[3]);
  p.rect(4, 4, 8, 3, CLEAR);
  p.rect(4, 9, 8, 3, CLEAR);
  p.line(0, 0, 15, 0, palette[4]);
  p.line(0, 15, 15, 15, palette[0]);
  if (face === "top") {
    for (const y of [3, 10]) {
      p.rect(1, y, 2, 3, "#4c5555");
      p.rect(1, y, 1, 2, "#adb9ac");
    }
    p.rect(13, 7, 2, 2, "#b99b57");
    p.rect(13, 7, 1, 1, "#e0c784");
  } else {
    p.line(2, 2, 2, 13, palette[0]);
    p.line(13, 2, 13, 13, palette[1]);
  }
}

function paintFabric(p, palette, x, y, width, height) {
  p.rect(x, y, width, height, palette[1]);
  for (const [dx, dy] of [
    [2, 2],
    [7, 5],
    [4, 10],
    [10, 12],
  ]) {
    if (dx + 2 <= width && dy + 2 <= height)
      p.stamp(x + dx, y + dy, ["22", ".0"], palette);
  }
}

function paintPillow(p, x, y, width, height) {
  p.rect(x + 1, y, width - 2, height, "#a6b4af");
  p.rect(x, y + 1, width, height - 2, "#a6b4af");
  p.rect(x + 1, y + 1, width - 2, height - 2, "#d5ddcf");
  p.rect(x + 2, y + 1, width - 4, height - 3, "#ecefe0");
  p.line(x + width - 2, y + 2, x + width - 2, y + height - 2, "#c3cec0");
}

function paintBed(p, color, face, part) {
  const wood = EXPANSION_WOOD_PALETTES.oak;
  const cloth = WOOL[color];
  if (face === "bottom") {
    paintBoards(p, wood);
    return;
  }
  p.rect(0, 0, 16, 16, wood[2]);
  if (face === "top") {
    paintFabric(p, cloth, 1, 0, 14, 16);
    p.line(1, 0, 1, 15, cloth[0]);
    p.line(14, 0, 14, 15, cloth[0]);
    if (part === "head") {
      p.line(0, 0, 15, 0, wood[3]);
      paintPillow(p, 2, 1, 12, 6);
      p.rect(2, 7, 12, 2, cloth[2]);
      p.line(2, 9, 13, 9, cloth[0]);
    } else {
      p.line(2, 13, 13, 13, cloth[2]);
      p.line(1, 14, 14, 14, cloth[0]);
      p.line(0, 15, 15, 15, wood[1]);
    }
  } else {
    paintFabric(p, cloth, 0, 0, 16, 8);
    p.line(0, 0, 15, 0, cloth[2]);
    p.line(0, 7, 15, 7, cloth[0]);
    p.line(0, 8, 15, 8, "#bfcbbf");
    p.line(0, 9, 15, 9, "#dee3d5");
    p.line(0, 10, 15, 10, wood[3]);
    p.line(0, 15, 15, 15, wood[0]);
    p.line(3, 12, 10, 12, wood[1]);
    p.line(6, 14, 12, 14, wood[3]);
    if (part === "head") paintPillow(p, 1, 1, 6, 5);
    const post = part === "head" ? 0 : 14;
    p.rect(post, 9, 2, 7, wood[0]);
    p.rect(post + (part === "head" ? 1 : 0), 10, 1, 6, wood[4]);
  }
}

/**
 * Original 16×16 building art, independent of registries, species, and geometry.
 *
 * Options contain only {kind, variant?, face?, part?}. Face defaults to "side"
 * and accepts side/top/bottom; the flat ladder sprite is shared by all faces.
 * The three stone/metal kinds default to variant "default". Wooden kinds need
 * an explicit 26.2 wood-family variant; beds need an explicit wool-color variant
 * and always use an oak frame. Part is REQUIRED for door (lower/upper) and bed
 * (foot/head), and must be absent or undefined for every other kind.
 *
 * Door side: join upper above lower, handle on image right. Bed top: image top
 * points toward the head, so join head above foot. Bed side: image left points
 * toward the head, so join head left of foot. These are longitudinal bed sides;
 * the geometry/atlas owner handles short-end sampling and rotates/mirrors UVs
 * for world facing, opposite sides, and door hinges.
 *
 * Unknown descriptors (including extra option keys) return false untouched.
 * Valid descriptors replace exactly one Uint8Array/Uint8ClampedArray RGBA tile;
 * invalid buffers throw before mutation. Door/trapdoor/ladder holes are only
 * optical cutouts, NOT collision or interaction definitions.
 */
export function paintBuildingMaterial(pixels, options) {
  const variant = resolveExpansionVariant(options, BUILDING_MATERIAL_VARIANTS);
  if (variant === null) return false;
  if (Reflect.ownKeys(options).some((key) => !OPTION_KEYS.has(key)))
    return false;
  const face = options.face === undefined ? "side" : options.face;
  if (!BUILDING_MATERIAL_FACES.includes(face)) return false;
  const parts = BUILDING_MATERIAL_PARTS[options.kind];
  if (parts ? !parts.includes(options.part) : options.part !== undefined)
    return false;
  const p = expansionPainter(pixels);
  const wood = EXPANSION_WOOD_PALETTES[variant];
  switch (options.kind) {
    case "copper_block":
      paintCopper(p);
      break;
    case "deepslate":
      paintDeepslate(p, face);
      break;
    case "cobbled_deepslate":
      paintCobbledDeepslate(p);
      break;
    case "bookshelf":
      paintBookshelf(p, wood, face);
      break;
    case "ladder":
      paintLadder(p, wood);
      break;
    case "door":
      paintDoor(p, wood, face, options.part);
      break;
    case "trapdoor":
      paintTrapdoor(p, wood, face);
      break;
    case "bed":
      paintBed(p, variant, face, options.part);
      break;
  }
  return true;
}
