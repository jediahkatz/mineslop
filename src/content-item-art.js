import { expansionPainter } from "./expansion-art-common.js";

const PAPER = ["#655841", "#a8966c", "#cbbb8e", "#e2d4aa", "#f0e4c1"];
const GOLD = ["#735330", "#aa7d38", "#d4ac50", "#e8c975", "#f7e4ae"];
const FIRE = ["#693927", "#a75b30", "#d58b3e", "#edb653", "#f7d78b"];
const GREEN = ["#304638", "#506c43", "#78904e", "#a8bb73", "#d5dca0"];
const sprite = (at, palette, rows) => ({ at, palette, rows });

// Original authored forms: a tied ink sac, heaps of dust, crystalline tear,
// curled cream, chart and carved upgrade tablet. No color-only fallback glyphs.
const SPRITES = {
  ink_sac: sprite(
    [3, 2],
    ["#262a36", "#424454", "#626273", "#8c8d9c", "#b9b9bd"],
    [
      "...0000...",
      "...0330...",
      "..003300..",
      ".0342230..",
      "034222230.",
      "0322222230",
      "0322222230",
      "0322222210",
      ".03222210.",
      "..032210..",
      "...0110...",
      "....00....",
    ]
  ),
  black_dye: sprite(
    [2, 4],
    ["#26282e", "#42414c", "#64636c", "#939398", "#c5c4bb"],
    [
      ".....00.....",
      "....0340....",
      "..00322300..",
      ".0342222230.",
      "034222222230",
      "032232222210",
      ".0322222110.",
      "..01111110..",
    ]
  ),
  blaze_rod: sprite([3, 1], FIRE, [
    ".......00.",
    "......0340",
    ".....03430",
    "....034210",
    "...034210.",
    "..034210..",
    ".034210...",
    "034210....",
    "03210.....",
    ".0110.....",
    "..00......",
  ]),
  blaze_powder: sprite([2, 3], FIRE, [
    ".....00.....",
    "....0330....",
    "..0032230...",
    ".034222230..",
    "034222332300",
    "032233222230",
    "032222222210",
    ".0322222210.",
    "..01111110..",
  ]),
  sugar: sprite(
    [2, 4],
    ["#777364", "#aaa491", "#d0c9b6", "#e5dfcd", "#f5f1df"],
    [
      "....000.....",
      "...03440....",
      "..0342230...",
      ".034222230..",
      "034222232300",
      "032222222230",
      ".03222222110",
      "..01111110..",
    ]
  ),
  spider_eye: sprite(
    [2, 3],
    ["#482936", "#74313f", "#a24857", "#d17d78", "#eeb09b"],
    [
      ".....000....",
      "...0033300..",
      "..034222230.",
      ".03422222230",
      "034220022230",
      "032220032210",
      ".03220022210",
      "..032222110.",
      "...011110...",
      "....0000....",
    ]
  ),
  fermented_spider_eye: sprite(
    [2, 2],
    ["#49383e", "#745152", "#a17472", "#c59c86", "#e2c7a6"],
    [
      "....0000....",
      "...033330...",
      "..03211230..",
      ".0322222230.",
      "032200222230",
      "032244222230",
      "032244222210",
      ".0322222210.",
      "..03222210..",
      "...011110...",
      "....0000....",
    ]
  ),
  ghast_tear: sprite(
    [4, 1],
    ["#4d6970", "#7f9d9f", "#a9c5be", "#cde5de", "#f0f4df"],
    [
      "...00...",
      "...030..",
      "..0340..",
      "..03430.",
      ".0342230",
      "03422230",
      "03422230",
      "03222230",
      "03222210",
      ".032210.",
      "..0110..",
      "...00...",
    ]
  ),
  magma_cream: sprite(
    [2, 3],
    ["#594338", "#907249", "#bf7840", "#dfac57", "#efcc81"],
    [
      "....0000....",
      "..00333300..",
      ".0342222230.",
      "034223332230",
      "032230012230",
      "032232222210",
      "032222222210",
      ".0322222210.",
      "..03222210..",
      "...011110...",
      "....0000....",
    ]
  ),
  glowstone_dust: sprite(
    [2, 4],
    ["#75603c", "#a58a47", "#c4a953", "#dfc777", "#f6e7aa"],
    [
      "....00......",
      "...0340..00.",
      "..0342300340",
      ".03422203230",
      "034222232230",
      "032222222210",
      ".0322222110.",
      "..01111100..",
    ]
  ),
  dried_kelp: sprite([4, 2], GREEN, [
    ".000000.",
    "0343330.",
    "0322230.",
    ".0322230",
    ".0322230",
    "03233230",
    "03222310",
    ".0322210",
    ".0322210",
    "0322210.",
    ".011110.",
    "..0000..",
  ]),
  rotten_flesh: sprite(
    [2, 3],
    ["#4f4032", "#806343", "#a58655", "#bd9e6c", "#d7bd8d"],
    [
      "....0000....",
      "...034330...",
      "..03422230..",
      ".0342222230.",
      "034222110230",
      "032223222210",
      ".0322222110.",
      "..03221000..",
      "...01110....",
      "....000.....",
    ]
  ),
};

const POTION_COLORS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      water: ["#416e92", "#629ebd", "#a5cbd6"],
      awkward: ["#446883", "#658ea7", "#a8bdc9"],
      mundane: ["#545e7f", "#7c8fa5", "#bcc8d0"],
      thick: ["#60677d", "#8d9dad", "#c5d4d8"],
      water_breathing: ["#354a94", "#546fbe", "#9cb8df"],
      night_vision: ["#3d4282", "#605ab0", "#aca0d9"],
      fire_resistance: ["#935b30", "#c98745", "#edc080"],
      swiftness: ["#4c8292", "#78b3c5", "#b9dbe0"],
      strength: ["#824a35", "#b97843", "#ddb677"],
      healing: ["#953f55", "#cf657d", "#efa9b5"],
      regeneration: ["#9b4d83", "#c878ad", "#ebb6d7"],
      poison: ["#4f753e", "#7da554", "#b8ce85"],
      weakness: ["#555967", "#80868e", "#b8c2c0"],
      slowness: ["#535f67", "#7b959d", "#b2c6cb"],
      harming: ["#593153", "#8c5077", "#c38ca9"],
    }).map(([id, ramp]) => [id, Object.freeze(ramp)])
  )
);

export const CONTENT_POTION_ART_TYPES = Object.freeze(
  Object.keys(POTION_COLORS)
);
const resourceKinds = Object.freeze([
  ...Object.keys(SPRITES),
  "treasure_map",
  "netherite_upgrade_template",
  "carrot",
  "golden_carrot",
  "melon_slice",
  "glistering_melon_slice",
  "shears",
]);
export const CONTENT_ITEM_ART_DESCRIPTORS = Object.freeze([
  ...resourceKinds.map((kind) => Object.freeze({ kind })),
  ...["cod", "salmon"].map((variant) =>
    Object.freeze({ kind: "cooked_fish", variant })
  ),
  ...CONTENT_POTION_ART_TYPES.flatMap((variant) =>
    ["drinkable", "splash"].map((form) =>
      Object.freeze({ kind: "brewed_potion", variant, form })
    )
  ),
]);

/** The UI can derive this from stack.data.potion without mutating the catalog. */
export function potionArtDescriptor(potion) {
  if (
    !potion ||
    !Object.hasOwn(POTION_COLORS, potion.id) ||
    !["drinkable", "splash"].includes(potion.form)
  )
    return null;
  return Object.freeze({
    kind: "brewed_potion",
    variant: potion.id,
    form: potion.form,
  });
}

function paintMap(p) {
  p.stamp(
    2,
    2,
    [
      ".0000000000.",
      "034444443330",
      "032222222230",
      "032222222230",
      "032222222230",
      "032222222230",
      "032222222230",
      "032222222230",
      "032222222230",
      "032222222230",
      "011111111110",
      ".0000000000.",
    ],
    PAPER
  );
  p.line(5, 4, 5, 6, "#759e95");
  p.line(5, 6, 8, 7, "#759e95");
  p.line(8, 7, 8, 10, "#759e95");
  p.line(4, 10, 6, 9, "#a39060");
  p.line(9, 4, 11, 6, "#a95447");
  p.line(9, 6, 11, 4, "#a95447");
  p.rect(3, 4, 1, 7, PAPER[3]);
}

function paintTemplate(p) {
  const tones = ["#46323e", "#705058", "#a67c77", "#c29a8f", "#e0b9a5"];
  p.stamp(
    3,
    2,
    [
      ".00000000.",
      "0343333330",
      "0322222220",
      "0322222220",
      "0322222220",
      "0322222220",
      "0322222220",
      "0322222220",
      "0322222220",
      "0322222220",
      "0111111110",
      ".00000000.",
    ],
    tones
  );
  p.stamp(
    5,
    4,
    ["..00..", ".0330.", "034430", "000000", "..30..", "..30..", "..00.."],
    GOLD
  );
}

function paintCarrot(p, golden) {
  const tones = golden
    ? GOLD
    : ["#653d2b", "#9d5c2e", "#cf883e", "#e6ad62", "#f2ce91"];
  p.stamp(
    3,
    4,
    [
      ".....0000.",
      "....034430",
      "...0342230",
      "..03422210",
      ".03422210.",
      "03422210..",
      "0322210...",
      ".01110....",
      "..00......",
    ],
    tones
  );
  p.line(11, 5, 10, 2, GREEN[1], 2);
  p.line(11, 5, 13, 2, GREEN[2], 2);
  p.rect(10, 2, 1, 2, GREEN[4]);
  p.rect(13, 2, 1, 2, GREEN[3]);
  p.line(6, 10, 7, 10, tones[1]);
  p.line(8, 7, 9, 8, tones[1]);
}

function paintMelon(p, golden) {
  const tones = golden
    ? GOLD
    : ["#563b36", "#854a43", "#bd6b5e", "#dd9680", "#f0c4a0"];
  p.stamp(
    2,
    3,
    [
      "000000000000",
      "034444444430",
      ".0322222230.",
      ".0322222210.",
      "..03222210..",
      "..03222210..",
      "...032210...",
      "....0110....",
    ],
    tones
  );
  p.line(3, 4, 7, 12, GREEN[1]);
  p.line(7, 12, 12, 4, GREEN[2]);
  p.line(4, 4, 7, 10, golden ? GOLD[4] : GREEN[3]);
  p.line(7, 10, 11, 4, golden ? GOLD[4] : GREEN[3]);
  p.rect(6, 5, 1, 2, tones[0]);
  p.rect(9, 5, 1, 1, tones[0]);
  p.rect(8, 7, 1, 1, tones[0]);
}

function paintShears(p) {
  const metal = ["#343e45", "#73868a", "#b8c9c7", "#e0e8df"];
  p.line(5, 9, 12, 2, metal[0], 3);
  p.line(10, 9, 5, 2, metal[0], 3);
  p.line(5, 9, 12, 2, metal[3]);
  p.line(10, 9, 5, 2, metal[2]);
  p.rect(7, 7, 2, 2, metal[1]);
  for (const x of [2, 9])
    p.stamp(x, 9, [".000.", "03230", "03.30", "03210", ".000."], metal);
}

function paintCookedFish(p, variant) {
  const salmon = variant === "salmon";
  const tones = salmon
    ? ["#57382e", "#8e5841", "#c58562", "#e0b18a", "#f1d4aa"]
    : ["#554735", "#887049", "#b79562", "#d7bb84", "#ead9b1"];
  p.stamp(
    2,
    salmon ? 4 : 5,
    salmon
      ? [
          "000.....0000",
          "034000003330",
          ".03222222230",
          "032222222210",
          "032222222210",
          ".0111111110.",
          "00....0000..",
        ]
      : [
          "00....0000..",
          "034003333300",
          "032222222230",
          ".03222222210",
          "032222222210",
          "01000111110.",
          "......0000..",
        ],
    tones
  );
  for (const x of [7, 10]) p.line(x, 6, x - 2, 9, tones[1]);
  p.line(6, 6, 11, 6, tones[4]);
}

function paintPotion(p, variant, form) {
  const glass = ["#34484d", "#719397", "#a3beba", "#d4e2d3", "#ecf0df"];
  if (form === "drinkable") {
    p.rect(6, 1, 4, 2, "#72503d");
    p.rect(7, 1, 2, 1, "#bc9762");
    p.rect(6, 3, 4, 4, glass[0]);
    p.rect(7, 3, 2, 3, glass[3]);
  } else {
    p.line(8, 6, 11, 3, glass[0], 3);
    p.line(8, 5, 11, 2, glass[3]);
    p.line(10, 2, 12, 4, "#72503d", 2);
    p.line(10, 2, 11, 3, "#bc9762");
  }
  p.stamp(
    4,
    6,
    [
      ".000000.",
      "03433330",
      "03222230",
      "03222230",
      "03222230",
      "03222230",
      ".032210.",
      "..0110..",
    ],
    glass
  );
  const [shade, liquid, light] = POTION_COLORS[variant];
  p.rect(5, 9, 6, 3, liquid);
  p.line(5, 9, 10, 9, light);
  p.line(6, 12, 9, 12, shade);
  p.line(5, 7, 5, 8, glass[4]);
  p.rect(6, 7, 1, 1, glass[3]);
}

export function paintContentItem(pixels, options) {
  if (!options || typeof options !== "object") return false;
  const { kind } = options;
  let fields;
  if (resourceKinds.includes(kind)) fields = ["kind"];
  else if (
    kind === "cooked_fish" &&
    ["cod", "salmon"].includes(options.variant)
  )
    fields = ["kind", "variant"];
  else if (
    kind === "brewed_potion" &&
    CONTENT_POTION_ART_TYPES.includes(options.variant) &&
    ["drinkable", "splash"].includes(options.form)
  )
    fields = ["kind", "variant", "form"];
  else return false;
  if (Reflect.ownKeys(options).some((key) => !fields.includes(key)))
    return false;
  const p = expansionPainter(pixels);
  if (Object.hasOwn(SPRITES, kind)) {
    const { at, palette, rows } = SPRITES[kind];
    p.stamp(...at, rows, palette);
  } else if (kind === "treasure_map") paintMap(p);
  else if (kind === "netherite_upgrade_template") paintTemplate(p);
  else if (kind === "carrot" || kind === "golden_carrot")
    paintCarrot(p, kind === "golden_carrot");
  else if (kind === "melon_slice" || kind === "glistering_melon_slice")
    paintMelon(p, kind === "glistering_melon_slice");
  else if (kind === "shears") paintShears(p);
  else if (kind === "cooked_fish") paintCookedFish(p, options.variant);
  else paintPotion(p, options.variant, options.form);
  return true;
}
