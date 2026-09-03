import { paintContentItem } from "./content-item-art.js";
import {
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
  expansionArtKeys,
  expansionArtVariants,
  expansionPainter,
  resolveExpansionVariant,
} from "./expansion-art-common.js";
import { paintGearItem } from "./gear-item-art.js";

const POTION_PALETTES = {
  water: ["#416e92", "#629ebd", "#a5cbd6"],
  healing: ["#953f55", "#cf657d", "#efa9b5"],
  swiftness: ["#4c8292", "#78b3c5", "#b9dbe0"],
  strength: ["#824a35", "#b97843", "#ddb677"],
  poison: ["#4f753e", "#7da554", "#b8ce85"],
};

export const EXPANSION_ITEM_VARIANTS = expansionArtVariants({
  // Nether stems have plank art, but are not boat recipes. Bamboo is a raft.
  boat: EXPANSION_WOOD_FAMILIES.filter(
    (family) => !["bamboo", "crimson", "warped"].includes(family)
  ),
  raft: ["bamboo"],
  fishing_rod: ["default"],
  fish: ["cod", "salmon", "tropical", "pufferfish"],
  scute: ["turtle", "armadillo"],
  heart_of_the_sea: ["default"],
  nautilus_shell: ["default"],
  potion: ["empty", ...Object.keys(POTION_PALETTES)],
  book: ["default"],
  enchanted_book: ["default"],
  paper: ["default"],
  ender_pearl: ["default"],
  brewing_stand: ["default"],
  enchanting_table: ["default"],
  anvil: ["default"],
});
export const EXPANSION_ITEM_KEYS = expansionArtKeys(EXPANSION_ITEM_VARIANTS);

function paintBoat(p, family) {
  const palette = EXPANSION_WOOD_PALETTES[family];
  for (const [x0, x1] of [
    [2, 9],
    [12, 5],
  ]) {
    p.line(x0, 4, x1, 11, palette[0], 2);
    p.line(x0, 4, x1, 11, palette[3]);
    p.rect(x0 - 1, 3, 3, 2, palette[3]);
    p.rect(x0, 3, 1, 2, palette[4]);
  }
  p.stamp(
    1,
    6,
    [
      "..0000000000..",
      ".043333333340.",
      "04311111111340",
      "03222222222230",
      ".032222222230.",
      "..0111111110..",
      "...00000000...",
    ],
    palette
  );
  p.rect(5, 8, 1, 3, palette[4]);
  p.rect(10, 8, 1, 3, palette[3]);
  p.line(4, 10, 11, 10, palette[1]);
}

function paintRaft(p) {
  const palette = EXPANSION_WOOD_PALETTES.bamboo;
  p.line(2, 2, 11, 11, palette[0], 2);
  p.line(2, 2, 11, 11, palette[3]);
  p.rect(1, 1, 3, 2, palette[3]);
  for (const y of [5, 8, 11]) {
    p.rect(2, y, 12, 2, palette[2]);
    p.rect(3, y - 1, 10, 1, palette[3]);
    p.rect(2, y + 1, 12, 1, palette[1]);
    p.rect(2, y, 1, 1, palette[0]);
    p.rect(13, y, 1, 1, palette[0]);
    p.line(4, y, 10, y, palette[4]);
  }
  for (const x of [5, 10]) {
    p.line(x, 4, x, 13, palette[0]);
    p.line(x + 1, 4, x + 1, 13, "#d1c58c");
  }
}

function paintFishingRod(p) {
  p.line(2, 13, 9, 3, "#393d39", 2);
  p.line(9, 3, 12, 2, "#393d39", 2);
  p.line(3, 13, 10, 3, "#b58b52");
  p.line(10, 3, 12, 2, "#d3b67c");
  p.line(13, 3, 14, 5, "#c1d1bf");
  p.line(14, 5, 14, 10, "#c1d1bf");
  p.line(14, 10, 13, 12, "#779796");
  p.line(13, 12, 11, 11, "#779796");
  p.line(11, 11, 11, 10, "#d7e0c9");
  p.rect(13, 7, 2, 2, "#c65a45");
  p.rect(13, 7, 2, 1, "#eadbc0");
  p.rect(4, 9, 3, 3, "#393d39");
  p.rect(5, 10, 1, 1, "#b4c2b4");
}

const FISH_ART = {
  cod: {
    palette: ["#3f463c", "#777458", "#aba779", "#d7cd9e", "#e3dec2"],
    shape: [
      "......00......",
      ".....0330.....",
      "00..0322300...",
      "0300322222300.",
      "03203222223410",
      ".0322222222410",
      "0320122222110.",
      "010..011110...",
      ".......010....",
    ],
  },
  salmon: {
    palette: ["#4c3939", "#86514c", "#b56a5a", "#d79d78", "#e3bd95", "#627263"],
    shape: [
      "........00....",
      "......00330...",
      "00..00332230..",
      "03003555552300",
      ".0323222222240",
      "03222222222210",
      "0100011111100.",
      "......0110....",
      ".......00.....",
    ],
  },
  tropical: {
    palette: ["#3e4949", "#c26b36", "#e2ad53", "#f0d6a0", "#5dada8"],
    shape: [
      ".....000......",
      "....03430.....",
      "00.0342230....",
      "030322442230..",
      "0323224422230.",
      ".032224422240.",
      "0321224422210.",
      "010.01244210..",
      ".....011110...",
      "......000.....",
    ],
  },
  pufferfish: {
    palette: ["#544932", "#987841", "#c4a158", "#e1c17a", "#f0e0aa"],
    shape: [
      "....000....",
      "..0033300..",
      ".032222230.",
      "03223223230",
      "03222222230",
      "03222222410",
      ".0322222210",
      "..03222210.",
      "...011110..",
      ".....00....",
    ],
  },
};

function paintFish(p, variant) {
  const { palette, shape } = FISH_ART[variant];
  p.stamp(
    variant === "pufferfish" ? 3 : 1,
    variant === "pufferfish" ? 2 : 3,
    shape,
    palette
  );
  if (variant === "pufferfish") {
    for (const [x, y, width, height] of [
      [2, 6, 1, 2],
      [14, 5, 1, 2],
      [7, 1, 1, 2],
      [9, 12, 1, 1],
    ])
      p.rect(x, y, width, height, palette[1]);
  }
  p.rect(12, variant === "tropical" ? 8 : 7, 1, 1, "#283b3e");
}

function paintScute(p, variant) {
  const turtle = variant === "turtle";
  p.stamp(
    3,
    3,
    turtle
      ? [
          "...0000...",
          "..033330..",
          ".03222230.",
          "0323322230",
          "0322222230",
          "0322112230",
          ".03211230.",
          "..032230..",
          "...0110...",
          "....00....",
        ]
      : [
          "..000000..",
          ".03333330.",
          "0322222230",
          "0321111230",
          "0323322230",
          "0321111230",
          "0323322230",
          ".03222210.",
          "..011110..",
          "...0000...",
        ],
    turtle
      ? ["#374a38", "#597447", "#88a65d", "#bfcd85"]
      : ["#5b4039", "#8b6553", "#ba9273", "#ddbc96"]
  );
}

function paintSeaHeart(p) {
  p.stamp(
    2,
    2,
    [
      "....0000....",
      "..00333300..",
      ".0344444330.",
      "034422222230",
      "034220012230",
      "032203332230",
      "032203212230",
      "032222212210",
      ".0322222210.",
      "..03222210..",
      "...011110...",
      "....0000....",
    ],
    ["#25475d", "#316c87", "#439ab3", "#7dc2d2", "#c0e2d9"]
  );
}

function paintNautilus(p) {
  p.stamp(
    2,
    2,
    [
      "...000000...",
      "..03444330..",
      ".0343222230.",
      "034320012230",
      "032210331230",
      "032203432230",
      "032203212210",
      ".0322211110.",
      "..03222210..",
      "...032210...",
      "....0110....",
      ".....00.....",
    ],
    ["#715c49", "#ab8763", "#d1b28a", "#ead4ae", "#f3e8cd"]
  );
}

function paintPotion(p, variant) {
  p.stamp(
    4,
    3,
    [
      "..0000..",
      "..0330..",
      ".033330.",
      "03222230",
      "03222230",
      "03222230",
      "03222230",
      "03222230",
      ".032230.",
      "..0110..",
    ],
    ["#34484d", "#719397", "#a3beba", "#d4e2d3"]
  );
  p.rect(6, 1, 4, 2, "#72503d");
  p.rect(7, 1, 2, 1, "#bc9762");
  if (variant !== "empty") {
    const [shade, liquid, meniscus] = POTION_PALETTES[variant];
    p.rect(5, 8, 6, 4, liquid);
    p.rect(5, 8, 6, 1, meniscus);
    p.rect(6, 12, 4, 1, shade);
  }
  p.rect(5, 7, 1, 3, "#e9eed9");
  p.rect(6, 6, 2, 1, "#d4e2d3");
}

function paintBook(p, enchanted) {
  const palette = enchanted
    ? ["#353043", "#584169", "#815f9d", "#b497c4"]
    : ["#463936", "#704c3d", "#9b6a48", "#c19764"];
  p.rect(4, 2, 9, 11, palette[0]);
  p.rect(3, 3, 9, 11, palette[0]);
  p.rect(4, 3, 8, 9, palette[2]);
  p.rect(4, 3, 2, 9, palette[1]);
  p.rect(6, 3, 6, 1, palette[3]);
  p.rect(5, 11, 7, 1, "#eadcb9");
  p.rect(4, 12, 8, 1, "#b7a47d");
  if (enchanted) {
    p.line(7, 5, 9, 7, "#9fcbc4");
    p.line(9, 7, 7, 9, "#9fcbc4");
    p.rect(10, 7, 3, 2, "#bb974d");
    p.rect(11, 7, 1, 1, "#e8cf87");
  } else {
    p.line(7, 5, 10, 5, palette[3]);
    p.line(7, 8, 10, 8, palette[1]);
  }
}

function paintPaper(p) {
  p.rect(3, 2, 7, 12, "#887b60");
  p.rect(10, 5, 3, 9, "#887b60");
  p.rect(4, 3, 5, 10, "#f0e6c8");
  p.rect(9, 5, 3, 8, "#e0d4b3");
  p.stamp(
    10,
    2,
    ["0..", "30.", "330"],
    ["#887b60", "#b6a887", "#e0d4b3", "#f0e6c8"]
  );
  p.line(9, 2, 9, 5, "#b6a887");
  p.line(9, 5, 12, 5, "#b6a887");
  p.line(5, 8, 9, 8, "#d3c5a2");
  p.line(5, 10, 8, 10, "#d3c5a2");
}

function paintPearl(p) {
  p.stamp(
    3,
    3,
    [
      "...0000...",
      "..033330..",
      ".03444230.",
      "0344222230",
      "0322222230",
      "0322222210",
      "0322222110",
      ".03222110.",
      "..011110..",
      "...0000...",
    ],
    ["#253d42", "#315955", "#4b8176", "#7ba996", "#b5d1b3"]
  );
}

function paintBrewingStand(p) {
  p.rect(2, 12, 12, 2, "#41484b");
  p.rect(3, 11, 10, 1, "#87928a");
  p.rect(3, 14, 10, 1, "#606e6c");
  p.rect(7, 2, 2, 10, "#b88944");
  p.rect(7, 1, 2, 1, "#e5c576");
  p.rect(7, 3, 1, 8, "#e5c576");
  p.rect(6, 3, 4, 1, "#b88944");
  p.line(4, 6, 12, 6, "#b88944");
  for (const [x, liquid] of [
    [2, "#bf778f"],
    [10, "#72aeb4"],
  ]) {
    p.rect(x + 1, 7, 2, 2, "#41484b");
    p.rect(x, 9, 4, 3, "#41484b");
    p.rect(x + 1, 9, 2, 2, liquid);
    p.rect(x + 1, 7, 2, 1, "#ccd6c3");
    p.rect(x, 9, 1, 2, "#ccd6c3");
  }
}

function paintEnchantingTable(p) {
  p.rect(2, 8, 12, 5, "#292d38");
  p.rect(3, 9, 10, 3, "#494054");
  p.rect(2, 8, 12, 1, "#bd6b68");
  p.rect(3, 7, 10, 1, "#994c55");
  for (const x of [3, 10]) {
    p.rect(x, 13, 3, 2, "#292d38");
    p.rect(x, 10, 2, 2, "#6bb4af");
    p.rect(x, 10, 1, 1, "#acd2bc");
  }
  p.stamp(
    3,
    2,
    [
      ".000..000.",
      "0344004430",
      "0344334430",
      "0344334430",
      ".03433430.",
      "..033330..",
      "...0110...",
    ],
    ["#51464a", "#9d724d", "#cbb38a", "#eadbb8", "#f2e9cd"]
  );
  p.rect(5, 5, 2, 1, "#b9aa81");
  p.rect(9, 4, 2, 1, "#b9aa81");
}

function paintAnvil(p) {
  p.stamp(
    1,
    3,
    [
      "..00000000000.",
      "00344444444330",
      "03322222222210",
      ".011222222110.",
      "...01111110...",
      ".....0220.....",
      ".....0320.....",
      "....032230....",
      "...03222230...",
      "..0344444430..",
      "..0111111110..",
    ],
    ["#343c40", "#475157", "#5c696d", "#728184", "#a1b0ac"]
  );
  p.line(6, 5, 8, 5, "#475157");
}

/**
 * Replace one 16×16 RGBA tile with a bounded, original item cutout.
 * `variant` is required for multi-variant kinds; singleton variants may omit it.
 * Unsupported kind/variant pairs return false without mutation. Supported keys
 * validate the byte buffer before clearing it. This is art, not item/recipe,
 * equipment-tier, interaction, enchantment, or potion-effect registration.
 */
export function paintExpansionItem(pixels, options) {
  if (paintContentItem(pixels, options) || paintGearItem(pixels, options))
    return true;
  const variant = resolveExpansionVariant(options, EXPANSION_ITEM_VARIANTS);
  if (variant === null) return false;
  const p = expansionPainter(pixels);
  switch (options.kind) {
    case "boat":
      paintBoat(p, variant);
      break;
    case "raft":
      paintRaft(p);
      break;
    case "fishing_rod":
      paintFishingRod(p);
      break;
    case "fish":
      paintFish(p, variant);
      break;
    case "scute":
      paintScute(p, variant);
      break;
    case "heart_of_the_sea":
      paintSeaHeart(p);
      break;
    case "nautilus_shell":
      paintNautilus(p);
      break;
    case "potion":
      paintPotion(p, variant);
      break;
    case "book":
      paintBook(p, false);
      break;
    case "enchanted_book":
      paintBook(p, true);
      break;
    case "paper":
      paintPaper(p);
      break;
    case "ender_pearl":
      paintPearl(p);
      break;
    case "brewing_stand":
      paintBrewingStand(p);
      break;
    case "enchanting_table":
      paintEnchantingTable(p);
      break;
    case "anvil":
      paintAnvil(p);
      break;
  }
  return true;
}
