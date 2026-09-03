import {
  EXPANSION_WOOD_PALETTES,
  expansionPainter,
} from "./expansion-art-common.js";
import { paintExpansionItem } from "./expansion-item-art.js";

const kinds = Object.freeze([
  "bamboo_block",
  "barrel",
  "blast_furnace",
  "brewing_stand",
  "chipped_anvil",
  "damaged_anvil",
  "iron_block",
  "smooth_stone",
  "conduit",
  "turtle_egg",
  "carrot_crop",
  "dried_kelp_block",
]);
const faces = Object.freeze(["side", "top", "bottom"]);
export const CONTENT_BLOCK_ART_DESCRIPTORS = Object.freeze(
  kinds.flatMap((kind) => faces.map((face) => Object.freeze({ kind, face })))
);
const METAL = ["#455358", "#6c7b7e", "#a3b4b3", "#c5d0c8", "#e0e6d7"];
const KELP = ["#293d32", "#41563c", "#617148", "#8b9863", "#b3b986"];

// Shared intact/worn face primitive; never calls back into material dispatch.
export function paintAnvilFace(p, face) {
  const palette = ["#343c40", "#475157", "#5c696d", "#728184", "#90a0a0"];
  p.field(
    face === "bottom" ? palette.slice(0, 3) : palette.slice(1, 4),
    947,
    2,
    5
  );
  if (face === "bottom") {
    p.line(2, 5, 7, 5, palette[2]);
    p.line(3, 6, 6, 6, palette[0]);
    p.line(9, 11, 13, 11, palette[1]);
    return;
  }
  if (face === "top") {
    p.rect(0, 0, 16, 1, palette[4]);
    p.rect(0, 15, 16, 1, palette[0]);
    p.stamp(3, 5, ["33...", ".211.", "...10"], palette);
    p.stamp(9, 10, ["333.", ".210"], palette);
  } else {
    p.rect(0, 0, 16, 2, palette[3]);
    p.rect(0, 2, 16, 1, palette[0]);
    p.rect(0, 13, 16, 1, palette[4]);
    p.rect(0, 14, 16, 2, palette[0]);
    p.line(4, 6, 6, 7, palette[1]);
    p.line(10, 9, 12, 9, palette[3]);
  }
}

function paintBamboo(p, face) {
  const tones = EXPANSION_WOOD_PALETTES.bamboo;
  p.field(tones.slice(1, 4), 1039, 3, 7);
  if (face === "side") {
    for (let x = 0; x < 16; x += 4) {
      p.line(x, 0, x, 15, tones[0]);
      p.line(x + 1, 0, x + 1, 15, tones[4]);
      const y = x % 8 === 0 ? 4 : 10;
      p.line(x + 1, y, x + 3, y, tones[0]);
      p.line(x + 1, y + 1, x + 3, y + 1, tones[3]);
    }
  } else {
    for (let y = 0; y < 16; y += 4)
      for (let x = 0; x < 16; x += 4)
        p.stamp(x, y, ["0110", "1341", "1431", "0110"], tones);
  }
}

function paintBarrel(p, face) {
  const wood = EXPANSION_WOOD_PALETTES.oak;
  p.field(wood.slice(1, 4), 1049, 2, 6);
  for (const x of [0, 4, 8, 12]) {
    p.line(x, 0, x, 15, wood[0]);
    p.line(x + 1, 0, x + 1, 15, wood[3]);
  }
  if (face === "side") {
    for (const y of [2, 12]) {
      p.rect(0, y, 16, 2, METAL[0]);
      p.line(0, y, 15, y, METAL[2]);
      for (const x of [2, 10]) p.rect(x, y, 1, 1, METAL[4]);
    }
  } else {
    p.line(0, 0, 15, 0, METAL[2]);
    p.line(0, 15, 15, 15, METAL[0]);
    p.line(0, 0, 0, 15, METAL[1]);
    p.line(15, 0, 15, 15, METAL[0]);
    if (face === "top") {
      p.rect(5, 6, 6, 4, wood[0]);
      p.rect(6, 7, 4, 2, wood[2]);
      p.line(6, 7, 9, 7, wood[4]);
    }
  }
}

function paintBlastFurnace(p, face) {
  p.field(METAL.slice(0, 3), 1061, 3, 6);
  p.line(0, 0, 15, 0, METAL[3]);
  p.line(0, 15, 15, 15, METAL[0]);
  if (face === "side") {
    p.rect(2, 2, 12, 12, METAL[0]);
    for (const y of [3, 6, 9, 12]) {
      p.line(3, y, 12, y, METAL[2]);
      p.line(3, y + 1, 12, y + 1, "#2c353a");
    }
    for (const x of [1, 14]) {
      p.rect(x, 3, 1, 2, METAL[4]);
      p.rect(x, 11, 1, 2, METAL[3]);
    }
  } else {
    p.rect(3, 3, 10, 10, METAL[0]);
    p.rect(4, 4, 8, 8, METAL[1]);
    p.line(5, 4, 11, 4, METAL[2]);
    p.line(4, 5, 4, 11, METAL[3]);
  }
}

function paintIron(p) {
  p.field(METAL.slice(2), 1063, 4, 5);
  p.line(0, 0, 15, 0, METAL[1]);
  p.line(0, 0, 0, 15, METAL[1]);
  p.line(1, 1, 14, 1, METAL[4]);
  p.line(1, 2, 1, 14, METAL[3]);
  p.line(0, 15, 15, 15, METAL[0]);
  p.line(15, 0, 15, 15, METAL[0]);
  p.line(5, 6, 10, 6, METAL[3]);
  p.line(6, 7, 9, 7, METAL[2]);
}

function paintConduit(p) {
  const tones = ["#315258", "#5a8584", "#8db9ae", "#c0d9c3", "#e4ead0"];
  p.stamp(
    2,
    2,
    [
      "...000000...",
      "..03444330..",
      ".0342222230.",
      "034220022230",
      "032203302230",
      "032203432230",
      "032203232210",
      "032220022210",
      ".0322222210.",
      "..03222210..",
      "...011110...",
      "....0000....",
    ],
    tones
  );
  p.rect(7, 7, 2, 2, "#429ca9");
  p.rect(7, 7, 1, 1, "#91d3cf");
}

function paintEgg(p) {
  const tones = ["#667451", "#929e71", "#bcc69a", "#d6dfb9", "#edf0cf"];
  p.stamp(
    4,
    4,
    [
      "..0000..",
      ".034430.",
      "03444430",
      "03433330",
      "03233330",
      "03233330",
      "03233310",
      ".0322210",
      "..01110.",
      "...00...",
    ],
    tones
  );
  for (const [x, y] of [
    [6, 6],
    [9, 8],
    [5, 10],
    [8, 11],
  ])
    p.stamp(x, y, ["10", ".1"], ["#436c57", "#709269"]);
}

function paintCarrotCrop(p) {
  const green = ["#365434", "#577540", "#7f9f51", "#b1c275"];
  for (const [x, top] of [
    [3, 7],
    [7, 2],
    [12, 5],
  ]) {
    p.line(x, 15, x, top, green[1], 2);
    p.line(x, 14, x + 2, top + 1, green[2]);
    p.stamp(x - 2, top, ["..3..", ".232.", "22122", "..1.."], green);
  }
  p.rect(2, 13, 3, 3, "#ba743b");
  p.rect(3, 13, 1, 2, "#e5af68");
  p.rect(10, 14, 4, 2, "#a96535");
  p.rect(11, 14, 2, 1, "#df9b51");
}

function paintKelpBlock(p) {
  p.field(KELP.slice(1, 4), 1069, 2, 5);
  for (let y = 0; y < 16; y += 4)
    for (let x = y % 8 === 0 ? 0 : -2; x < 16; x += 5)
      p.stamp(x, y, [".332.", "32210", ".221.", "..10."], KELP, true);
  for (const y of [2, 12]) {
    p.line(0, y, 15, y, "#9a8e62");
    p.line(0, y + 1, 15, y + 1, "#c6b57c");
  }
}

export function paintContentBlockMaterial(pixels, options) {
  if (
    !options ||
    !kinds.includes(options.kind) ||
    Reflect.ownKeys(options).some((key) => !["kind", "face"].includes(key))
  )
    return false;
  const face = options.face ?? "side";
  if (!faces.includes(face)) return false;
  if (options.kind === "brewing_stand")
    return paintExpansionItem(pixels, { kind: "brewing_stand" });
  if (["chipped_anvil", "damaged_anvil"].includes(options.kind)) {
    const p = expansionPainter(pixels);
    paintAnvilFace(p, face);
    p.line(5, 2, 7, 6, "#30353c");
    p.line(7, 6, 5, 9, "#30353c");
    if (options.kind === "damaged_anvil") {
      p.line(7, 6, 11, 8, "#30353c", 2);
      p.line(11, 8, 9, 13, "#30353c");
      p.line(6, 4, 8, 4, "#9aa9a6");
    }
    return true;
  }
  const p = expansionPainter(pixels);
  switch (options.kind) {
    case "bamboo_block":
      paintBamboo(p, face);
      break;
    case "barrel":
      paintBarrel(p, face);
      break;
    case "blast_furnace":
      paintBlastFurnace(p, face);
      break;
    case "iron_block":
      paintIron(p);
      break;
    case "smooth_stone":
      p.field(["#8a9293", "#969e9f", "#a3aaab", "#b0b5b3"], 1087, 5, 6);
      p.line(0, 0, 15, 0, "#b7bcba");
      p.line(0, 15, 15, 15, "#7f898c");
      break;
    case "conduit":
      paintConduit(p);
      break;
    case "turtle_egg":
      paintEgg(p);
      break;
    case "carrot_crop":
      paintCarrotCrop(p);
      break;
    case "dried_kelp_block":
      paintKelpBlock(p);
      break;
  }
  return true;
}
