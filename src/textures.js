import * as THREE from "three";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "./blocks.js";
import { paintEquipmentItem } from "./equipment-art.js";
import { paintBuildingMaterial } from "./expansion-building-art.js";
import { paintExpansionItem } from "./expansion-item-art.js";
import { paintExpansionMaterial } from "./expansion-material-art.js";
import {
  paintProgressionItem,
  paintProgressionMaterial,
  paintQuartzDeposits,
} from "./expansion-progression-art.js";
import { getItem, isBlockItem, ITEM } from "./items.js";
import { paintNaturalMaterial, paintStone } from "./material-art.js";
import { paintOreDeposits } from "./ore-art.js";
import {
  noise,
  painter,
  rgb,
  TEXTURE_SIZE as SIZE,
  shift,
} from "./pixel-art.js";
import { paintStructureItem, paintStructureMaterial } from "./structure-art.js";

const PAD = 2;
const STRIDE = SIZE + PAD * 2;
const COLS = 16;
const icons = new Map();
const BERRY_FRUIT = [
  [4, 9],
  [10, 12],
];
const itemNames = new Map(Object.entries(ITEM).map(([name, id]) => [id, name]));
const tileEntries = [{ id: 0, face: "side" }];
const blockTiles = new Map([[0, [0, 0, 0]]]);
const blockPartTiles = new Map();
const faced = new Set([
  BLOCK.GRASS,
  BLOCK.SNOW,
  BLOCK.PODZOL,
  BLOCK.MYCELIUM,
  BLOCK.CACTUS,
  BLOCK.BAMBOO,
  BLOCK.CRAFTING_TABLE,
  BLOCK.FURNACE,
  BLOCK.CHEST,
  BLOCK.MELON,
  BLOCK.PUMPKIN,
  BLOCK.FARMLAND,
  BLOCK.TNT,
  BLOCK.RED_MUSHROOM,
  BLOCK.BROWN_MUSHROOM,
]);
for (const block of BLOCK_CATALOG) {
  if (!block?.id) continue;
  const variants = new Map();
  for (const part of block.textureParts ?? [undefined]) {
    const descriptor = {
      id: block.id,
      ...(part === undefined ? {} : { part }),
    };
    const side = tileEntries.push({ ...descriptor, face: "side" }) - 1;
    let top = side,
      bottom = side;
    if (block.texture === "log" || faced.has(block.id) || block.distinctFaces) {
      top = tileEntries.push({ ...descriptor, face: "top" }) - 1;
      bottom = tileEntries.push({ ...descriptor, face: "bottom" }) - 1;
    }
    variants.set(part, [side, top, bottom]);
  }
  blockTiles.set(block.id, variants.values().next().value);
  if (block.textureParts) blockPartTiles.set(block.id, variants);
}
const ROWS = Math.ceil(tileEntries.length / COLS);
let cachedAtlas;

const same = (id, ...names) => names.some((name) => BLOCK[name] === id);
const logCores = {
  OAK_LOG: "#ba925f",
  BIRCH_LOG: "#decf9d",
  SPRUCE_LOG: "#967247",
  ACACIA_LOG: "#d88d59",
  JUNGLE_LOG: "#bc9267",
  CHERRY_LOG: "#ecb4aa",
  DARK_OAK_LOG: "#806043",
  PALE_LOG: "#ddd8c3",
  MANGROVE_LOG: "#b07159",
  CRIMSON_STEM: "#ce7287",
  WARPED_STEM: "#54afa1",
};
const coreColors = new Map(
  Object.entries(logCores).map(([name, color]) => [BLOCK[name], rgb(color)])
);

export function tileFor(id, face = "side", part) {
  const variants = blockPartTiles.get(id);
  const entry =
    part != null && variants ? variants.get(part) : blockTiles.get(id);
  if (!entry) throw new RangeError(`No texture for block ${id}`);
  return entry[face === "top" ? 1 : face === "bottom" ? 2 : 0];
}

function paintBerries(pixels) {
  const { rect } = painter(pixels);
  for (const [x, y] of BERRY_FRUIT) {
    rect(x, y, 2, 3, "#cf893b");
    rect(x, y, 2, 1, BLOCKS[BLOCK.GLOW_BERRIES].color);
    rect(x, y, 1, 1, "#ffe2a0");
  }
}

function paintPlant(pixels, block) {
  const { rect, line } = painter(pixels);
  const id = block.id;
  const green = "#64883d",
    light = "#9cb651";
  if (id === BLOCK.TORCH) {
    rect(7, 6, 2, 10, "#987045");
    rect(7, 7, 1, 9, "#caa06a");
    rect(6, 2, 4, 6, "#e78131");
    rect(7, 1, 2, 6, "#ffca58");
    rect(7, 3, 2, 3, "#fff2b0");
  } else if (same(id, "CAVE_VINE", "GLOW_BERRIES")) {
    // Hanging stems touch the top edge; consecutive voxel segments join.
    rect(7, 0, 2, id === BLOCK.GLOW_BERRIES ? 12 : 16, "#486d38");
    rect(7, 0, 1, 12, "#769947");
    for (const [x, y] of [
      [3, 2],
      [9, 6],
      [3, 11],
    ]) {
      line(7, y + 2, x + 1, y + 1, green);
      rect(x, y, 4, 2, "#648c46");
      rect(x + 1, y + 1, 3, 2, "#88a64e");
    }
    if (id === BLOCK.GLOW_BERRIES) {
      for (const [x, y] of BERRY_FRUIT) line(8, y - 2, x + 1, y, green);
      paintBerries(pixels);
    }
  } else if (same(id, "BAMBOO", "SUGAR_CANE")) {
    for (const x of id === BLOCK.BAMBOO ? [7] : [3, 7, 11]) {
      rect(x, 0, 2, 16, block.color);
      rect(x, 0, 1, 16, light);
      for (const y of [3, 9, 15]) rect(x, y, 2, 1, "#526c35");
      line(x - 3, 5, x, 7, green);
      line(x, 11, x + 3, 8, green);
    }
  } else if (same(id, "RED_MUSHROOM", "BROWN_MUSHROOM")) {
    rect(6, 8, 4, 8, "#ded3b5");
    rect(9, 9, 1, 7, "#b7a889");
    rect(3, 3, 10, 6, block.color);
    rect(1, 5, 14, 5, block.color);
    rect(4, 2, 8, 1, shift(rgb(block.color), 20));
    for (const [x, y] of [
      [4, 4],
      [9, 3],
      [2, 7],
      [10, 7],
    ])
      rect(x, y, 2, 2, "#ede0c3");
  } else if (id === BLOCK.DEAD_BUSH) {
    line(7, 15, 7, 5, "#a9824d", 2);
    line(7, 11, 2, 6, "#a9824d");
    line(8, 9, 13, 4, "#bc995a");
    line(4, 9, 3, 3, "#916b3d");
    line(8, 7, 10, 2, "#bc995a");
  } else if (same(id, "TALL_GRASS", "FERN", "SEAGRASS", "WHEAT_CROP")) {
    for (const x of [3, 6, 9, 12]) {
      const tip = 2 + ((x * 3) % 6);
      line(8, 15, x, tip, block.color);
      line(7, 15, x - 2, tip + 3, light);
      if (id === BLOCK.FERN) {
        for (let y = 6; y < 14; y += 3)
          line(7, y + 2, y < 10 ? 3 : 1, y, green);
        for (let y = 5; y < 14; y += 3)
          line(8, y + 2, y < 10 ? 12 : 14, y, light);
      }
      if (id === BLOCK.WHEAT_CROP) rect(x - 1, tip, 3, 5, "#ddbc62");
    }
  } else if (id === BLOCK.PINK_PETALS) {
    for (const [x, y] of [
      [3, 9],
      [10, 6],
      [8, 13],
    ]) {
      rect(x, y - 1, 3, 5, "#f2b7c9");
      rect(x - 1, y, 5, 3, "#eaa1be");
      rect(x + 1, y + 1, 1, 1, "#ffe3a7");
    }
  } else if (id === BLOCK.SULFUR_SPIKE) {
    for (const [center, height, width] of [
      [3, 8, 3],
      [8, 15, 5],
      [12, 11, 3],
    ]) {
      for (let y = SIZE - height; y < SIZE; y++) {
        const span = Math.max(
          1,
          Math.ceil((width * (y - SIZE + height + 1)) / height)
        );
        rect(center - Math.floor(span / 2), y, span, 1, block.color);
        rect(center - Math.floor(span / 2), y, 1, 1, "#f2df79");
      }
    }
    rect(1, 15, 14, 1, "#b6a142");
  } else if (id === BLOCK.CHORUS) {
    rect(6, 0, 4, 16, "#69536f");
    rect(7, 0, 2, 16, block.color);
    rect(2, 5, 5, 3, "#a082a0");
    rect(10, 10, 4, 3, "#a082a0");
    rect(2, 1, 3, 5, block.color);
    rect(12, 6, 2, 6, block.color);
    for (const y of [3, 8, 13]) rect(6, y, 4, 1, "#b89bb0");
  } else {
    rect(7, 6, 2, 10, green);
    rect(4, 11, 4, 2, green);
    rect(9, 8, 3, 2, light);
    const sunflower = id === BLOCK.SUNFLOWER;
    rect(5, 2, 6, 6, block.color);
    rect(3, 4, 10, 3, block.color);
    rect(5, 2, 3, 2, shift(rgb(block.color), 27));
    rect(
      sunflower ? 6 : 7,
      sunflower ? 3 : 4,
      sunflower ? 4 : 2,
      sunflower ? 4 : 2,
      sunflower ? "#705137" : "#f4d075"
    );
  }
}

// The CPU pixel source is shared by the atlas, icons, and headless coverage tests.
export function blockTexturePixels(id, face = "side", part) {
  const block = BLOCKS[id];
  if (!block) throw new RangeError(`No texture for block ${id}`);
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  if (!id) return pixels;
  if (block.art) {
    const descriptor = {
      ...block.art,
      face,
      ...(part != null && block.textureParts ? { part } : {}),
    };
    if (
      !paintBuildingMaterial(pixels, descriptor) &&
      !paintExpansionMaterial(pixels, descriptor) &&
      !paintProgressionMaterial(pixels, descriptor) &&
      !paintStructureMaterial(pixels, descriptor)
    )
      throw new RangeError(`No registered material painter for block ${id}`);
    return pixels;
  }
  if (block.shape === "cross" && id !== BLOCK.LILY_PAD) {
    paintPlant(pixels, block);
    return pixels;
  }
  if (block.texture === "ore") {
    if (block.oreHost === "deepslate")
      paintBuildingMaterial(pixels, { kind: "deepslate", face });
    else if (block.oreHost === "netherrack")
      pixels.set(blockTexturePixels(BLOCK.NETHERRACK, face));
    else paintStone(pixels);
    if (block.oreArt === "quartz") paintQuartzDeposits(pixels);
    else paintOreDeposits(pixels, block.oreArt ?? id);
    return pixels;
  }
  if (paintNaturalMaterial(pixels, block, face)) return pixels;
  const base = rgb(block.color);
  const kind = block.texture;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const n = noise(x, y, id + 7);
      const coarse = noise(Math.floor(x / 3), Math.floor(y / 3), id + 29);
      let color = base;
      let variation = (n - 0.5) * 23 + (coarse - 0.5) * 17;
      let alpha = 255;
      if (kind === "log" && id !== BLOCK.MUSHROOM_STEM) {
        if (face !== "side") {
          const ring = Math.floor(
            Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5))
          );
          color = ring === 7 ? base : (coreColors.get(id) ?? shift(base, 44));
          variation += ring % 3 === 0 ? -28 : 9;
        } else {
          variation +=
            Math.floor(x / (id === BLOCK.SPRUCE_LOG ? 2 : 3)) % 2 ? 15 : -18;
          if (noise(x, Math.floor(y / 5), id) > 0.77) variation -= 22;
          if (
            id === BLOCK.BIRCH_LOG &&
            (y === 4 || y === 5 || y === 11) &&
            (x + y * 3) % 11 < 5
          )
            color = rgb("#54524c");
          if (id === BLOCK.CHERRY_LOG && (y + (x % 3)) % 7 === 0)
            variation += 23;
          if (id === BLOCK.PALE_LOG && x % 5 === 0) variation -= 20;
        }
      } else if (id === BLOCK.LILY_PAD) {
        alpha = n < 0.11 && coarse > 0.36 ? 0 : 255;
        variation += coarse > 0.5 ? 14 : -12;
      } else if (kind === "mushroom") {
        if (face === "bottom") {
          color = rgb("#c8b9a6");
          variation += (x + y) % 4 === 0 ? -27 : 7;
        } else if (noise(Math.floor(x / 3), Math.floor(y / 3), id) > 0.68) {
          color = rgb(id === BLOCK.RED_MUSHROOM ? "#f0e1cc" : "#d7c6ac");
        }
      } else if (kind === "planks") {
        if (y % 4 === 0 || x === (Math.floor(y / 4) % 2 ? 11 : 4))
          variation -= 36;
        if (y % 4 === 1) variation += 12;
      } else if (kind === "brick" && id !== BLOCK.PURPUR) {
        if (y % 5 === 0 || (x + Math.floor(y / 5) * 4) % 8 === 0)
          color = rgb("#b9aa93");
        else if (y % 5 === 1) variation += 16;
      } else if (id === BLOCK.GLASS) {
        alpha = x === 0 || y === 0 || x === 15 || y === 15 ? 225 : 30;
        if (x + y === 7 || x + y === 8 || x + y === 21) alpha = 155;
        variation = 0;
      } else if (same(id, "ICE", "PACKED_ICE", "BLUE_ICE")) {
        variation = (n - 0.5) * 8 + (coarse - 0.5) * 12;
        if ((x + y * 2) % 17 < 2 || (x + y) % 23 === 0) variation += 31;
        if (id === BLOCK.ICE) alpha = 210;
      } else if (kind === "water") {
        variation = (n - 0.5) * 6;
        if ((y === 3 && x > 2 && x < 9) || (y === 11 && x > 8 && x < 15))
          variation += 20;
      } else if (kind === "lava") {
        const flow = noise(
          Math.floor((x + (y % 3)) / 3),
          Math.floor(y / 3),
          81
        );
        color =
          flow > 0.6
            ? rgb("#ffd053")
            : flow > 0.27
              ? rgb("#f67b25")
              : rgb("#b93a21");
        variation = (n - 0.5) * 15;
      } else if (id === BLOCK.GLOWSTONE) {
        color = x % 5 === 0 || y % 5 === 0 ? rgb("#99733d") : rgb("#fbd87a");
      } else if (kind === "cactus" && !same(id, "MELON", "PUMPKIN")) {
        if (face !== "side") {
          const edge = Math.min(x, y, 15 - x, 15 - y);
          color = edge < 2 ? rgb("#467e3d") : rgb("#a1ba62");
          if (x === 8 || y === 8) variation -= 17;
        } else {
          variation += x % 4 < 2 ? -22 : 14;
          if ((x + y * 3) % 17 === 0) color = rgb("#d4c793");
        }
      } else if (
        same(
          id,
          "TERRACOTTA",
          "RED_TERRACOTTA",
          "ORANGE_TERRACOTTA",
          "YELLOW_TERRACOTTA",
          "WHITE_TERRACOTTA"
        )
      ) {
        variation =
          (n - 0.5) * 8 + (noise(0, Math.floor(y / 3), id) - 0.5) * 10;
      } else if (id === BLOCK.SOUL_SAND) {
        const sx = x % 7,
          sy = y % 7;
        if (
          (sy === 2 && (sx === 2 || sx === 4)) ||
          (sy === 4 && sx > 1 && sx < 5)
        )
          variation -= 40;
      } else if (id === BLOCK.PURPUR) {
        if (x % 8 === 0 || y % 8 === 0) variation -= 26;
        if (x % 8 === 1 || y % 8 === 1) variation += 16;
      } else if (id === BLOCK.CHORUS) {
        if (x < 2 || x > 13) variation -= 20;
        if (y % 6 === 0) variation += 18;
      } else if (same(id, "NETHER_PORTAL", "END_PORTAL")) {
        const r = Math.max(Math.abs(x - 7), Math.abs(y - 7));
        variation = Math.sin(r * 1.9 + id) * 28 + (n - 0.5) * 15;
        if (id === BLOCK.END_PORTAL)
          color = n > 0.94 ? rgb("#b2eedc") : rgb("#142e39");
      } else if (id === BLOCK.MUSHROOM_STEM) {
        variation +=
          face === "side"
            ? noise(Math.floor(x / 2), Math.floor(y / 8), id) * 25 - 12
            : coarse * 16 + 5;
      } else if (same(id, "MELON", "PUMPKIN")) {
        variation +=
          face === "side"
            ? x % 4 < 2
              ? -19
              : 14
            : x === 7 || y === 7
              ? -18
              : 0;
        if (face === "top" && x > 5 && x < 10 && y > 5 && y < 10)
          color = rgb("#638044");
      } else if (id === BLOCK.WOOL) {
        variation = (n - 0.5) * 10 + ((x + y) % 3 === 0 ? -13 : 5);
      } else if (id === BLOCK.CORAL)
        variation += (x + y * 3) % 5 === 0 ? -37 : 11;
      const at = (y * SIZE + x) * 4;
      pixels.set([...shift(color, variation), alpha], at);
    }
  }
  paintUtility(pixels, id, face);
  return pixels;
}

// The lit foliage material samples this mask, not the whole green sprite.
// Other luminous blocks retain their existing unlit rendering path.
export function blockEmissionPixels(id) {
  if (!BLOCKS[id]) throw new RangeError(`No texture for block ${id}`);
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  if (id === BLOCK.GLOW_BERRIES) paintBerries(pixels);
  return pixels;
}

function paintUtility(pixels, id, face) {
  const { rect, line } = painter(pixels);
  if (id === BLOCK.CRAFTING_TABLE) {
    rect(0, 0, 16, 2, "#64432d");
    rect(0, 14, 16, 2, "#64432d");
    rect(0, 0, 2, 16, "#64432d");
    rect(14, 0, 2, 16, "#64432d");
    if (face === "top") {
      for (const p of [5, 10]) {
        rect(p, 2, 1, 12, "#775336");
        rect(2, p, 12, 1, "#775336");
      }
    } else {
      rect(3, 4, 10, 1, "#573e2c");
      rect(4, 5, 1, 6, "#c6c4ae");
      rect(10, 5, 2, 6, "#584333");
      rect(8, 5, 5, 2, "#bcb7a0");
    }
  } else if (id === BLOCK.FURNACE) {
    rect(0, 0, 16, 2, "#454b4f");
    rect(0, 14, 16, 2, "#454b4f");
    if (face === "side") {
      rect(3, 3, 10, 3, "#33383e");
      rect(3, 8, 10, 5, "#272e35");
      rect(4, 11, 8, 1, "#645548");
    }
  } else if (id === BLOCK.CHEST) {
    rect(0, 0, 16, 2, "#62452c");
    rect(0, 14, 16, 2, "#62452c");
    rect(0, 0, 2, 16, "#62452c");
    rect(14, 0, 2, 16, "#62452c");
    if (face === "side") {
      rect(0, 6, 16, 1, "#62452c");
      rect(7, 5, 2, 5, "#e2c971");
    }
  } else if (id === BLOCK.TNT) {
    if (face === "side") {
      rect(0, 5, 16, 6, "#e9dfc3");
      for (const x of [1, 6, 11]) {
        rect(x, 6, 4, 1, "#57463e");
        rect(x + 1, 7, 1, 3, "#57463e");
      }
    } else {
      for (const x of [2, 7, 12]) rect(x, 2, 2, 12, "#973f30");
      line(7, 6, 10, 2, "#47423a");
    }
  } else if (id === BLOCK.LILY_PAD) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        if (
          Math.hypot(x - 7.5, y - 7.5) > 7.5 ||
          (x > 7 && y < 7 && x - 7 > 7 - y)
        )
          pixels[(y * 16 + x) * 4 + 3] = 0;
      }
    line(4, 11, 10, 5, "#80a64c");
  }
}

function canvasFromPixels(pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(SIZE, SIZE);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function getAtlasCanvas() {
  if (cachedAtlas) return cachedAtlas;
  const canvas = document.createElement("canvas");
  canvas.width = COLS * STRIDE;
  canvas.height = ROWS * STRIDE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const sources = tileEntries.map(({ id, face, part }) =>
    canvasFromPixels(blockTexturePixels(id, face, part))
  );
  for (let tile = 0; tile < sources.length; tile++) {
    const source = sources[tile];
    const x = (tile % COLS) * STRIDE + PAD;
    const y = Math.floor(tile / COLS) * STRIDE + PAD;
    ctx.drawImage(source, x, y);
    // Extrude all edges and corners so atlas gutters never leak adjacent blocks.
    for (const [sx, sy, sw, sh, dx, dy, dw, dh] of [
      [0, 0, 1, SIZE, x - PAD, y, PAD, SIZE],
      [SIZE - 1, 0, 1, SIZE, x + SIZE, y, PAD, SIZE],
      [0, 0, SIZE, 1, x, y - PAD, SIZE, PAD],
      [0, SIZE - 1, SIZE, 1, x, y + SIZE, SIZE, PAD],
      [0, 0, 1, 1, x - PAD, y - PAD, PAD, PAD],
      [SIZE - 1, 0, 1, 1, x + SIZE, y - PAD, PAD, PAD],
      [0, SIZE - 1, 1, 1, x - PAD, y + SIZE, PAD, PAD],
      [SIZE - 1, SIZE - 1, 1, 1, x + SIZE, y + SIZE, PAD, PAD],
    ])
      ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  const emissiveCanvas = document.createElement("canvas");
  emissiveCanvas.width = canvas.width;
  emissiveCanvas.height = canvas.height;
  const berryTile = tileFor(BLOCK.GLOW_BERRIES);
  // Fruit stays inside the tile, so the emission gutters remain black.
  emissiveCanvas
    .getContext("2d")
    .drawImage(
      canvasFromPixels(blockEmissionPixels(BLOCK.GLOW_BERRIES)),
      (berryTile % COLS) * STRIDE + PAD,
      Math.floor(berryTile / COLS) * STRIDE + PAD
    );
  cachedAtlas = { canvas, sources, emissiveCanvas };
  return cachedAtlas;
}

function atlasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function createAtlas() {
  const { canvas, emissiveCanvas } = getAtlasCanvas();
  const texture = atlasTexture(canvas);
  const emissiveTexture = atlasTexture(emissiveCanvas);
  const uvs = tileEntries.map((_, tile) => {
    const x = (tile % COLS) * STRIDE + PAD;
    const y = Math.floor(tile / COLS) * STRIDE + PAD;
    return [
      x / canvas.width,
      1 - (y + SIZE) / canvas.height,
      (x + SIZE) / canvas.width,
      1 - y / canvas.height,
    ];
  });
  return {
    texture,
    emissiveTexture,
    canvas,
    uvFor: (id, face = "side", part) => uvs[tileFor(id, face, part)],
  };
}

export function blockIcon(id) {
  if (!isBlockItem(id)) return itemIcon(id);
  if (icons.has(id)) return icons.get(id);
  const { sources } = getAtlasCanvas();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  if (BLOCKS[id]?.shape === "door" && blockPartTiles.has(id)) {
    ctx.drawImage(sources[tileFor(id, "side", "upper")], 16, 0, 32, 32);
    ctx.drawImage(sources[tileFor(id, "side", "lower")], 16, 32, 32, 32);
  } else if (BLOCKS[id]?.shape === "cross" || BLOCKS[id]?.heldSprite) {
    ctx.drawImage(sources[tileFor(id)], 8, 4, 48, 48);
  } else if (id && BLOCKS[id]) {
    const draw = (face, matrix, shade) => {
      ctx.save();
      ctx.setTransform(...matrix);
      ctx.drawImage(sources[tileFor(id, face)], 0, 0);
      if (shade) {
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(0, 0, SIZE, SIZE);
      }
      ctx.restore();
    };
    draw("top", [1.7, 0.85, -1.7, 0.85, 32, 4], 0);
    draw("side", [1.7, 0.85, 0, 1.8, 4.8, 17.6], 0.12);
    draw("side", [1.7, -0.85, 0, 1.8, 32, 31.2], 0.28);
  }
  const url = canvas.toDataURL();
  icons.set(id, url);
  return url;
}

// Small original sprites use silhouettes as well as color to distinguish items.
export function itemTexturePixels(id) {
  const item = getItem(id);
  if (!item) throw new RangeError(`No icon for item ${id}`);
  if (isBlockItem(id)) return blockTexturePixels(id);
  const name =
    itemNames.get(id) ?? item.name.toUpperCase().replaceAll(" ", "_");
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  if (item.art) {
    if (
      !paintExpansionItem(pixels, item.art) &&
      !paintProgressionItem(pixels, item.art) &&
      !paintStructureItem(pixels, item.art)
    )
      throw new RangeError(`No registered sprite painter for item ${id}`);
    return pixels;
  }
  if (paintEquipmentItem(pixels, name)) return pixels;
  const { rect, line } = painter(pixels);
  const outline = "#343a3b",
    handle = "#956b42",
    handleLight = "#c79b61";
  const material = name.startsWith("DIAMOND")
    ? "#66d9cb"
    : name.startsWith("IRON")
      ? "#d0d8d3"
      : name.startsWith("STONE")
        ? "#9aabae"
        : "#ba8d50";
  if (/(PICKAXE|AXE|SWORD|SHOVEL)$/.test(name)) {
    line(3, 13, 11, 5, outline, 3);
    line(4, 13, 11, 6, handle, 2);
    line(4, 13, 11, 6, handleLight);
    if (name.endsWith("PICKAXE")) {
      line(4, 3, 11, 3, outline, 3);
      line(11, 3, 13, 6, outline, 3);
      line(4, 4, 11, 4, material, 2);
      line(11, 4, 13, 7, material);
      rect(5, 3, 5, 1, shift(rgb(material), 26));
    } else if (name.endsWith("AXE")) {
      rect(6, 1, 7, 8, outline);
      rect(5, 3, 2, 5, outline);
      rect(7, 2, 5, 6, material);
      rect(6, 4, 2, 3, material);
      rect(7, 2, 4, 1, shift(rgb(material), 25));
    } else if (name.endsWith("SWORD")) {
      line(6, 10, 12, 4, outline, 3);
      rect(12, 1, 3, 4, outline);
      line(7, 10, 12, 5, material, 2);
      line(8, 9, 13, 4, shift(rgb(material), 25));
      rect(13, 2, 1, 3, material);
      line(4, 8, 8, 12, "#c4a667", 2);
    } else {
      line(9, 4, 12, 1, outline, 3);
      line(10, 5, 13, 2, outline, 3);
      line(10, 4, 12, 2, material, 2);
      line(11, 5, 13, 3, material, 2);
    }
  } else if (name.includes("INGOT")) {
    const color = name.includes("GOLD")
      ? "#e5b845"
      : name.includes("COPPER")
        ? "#c47a52"
        : "#bdcfcd";
    rect(2, 7, 12, 6, outline);
    rect(4, 4, 8, 3, outline);
    rect(3, 7, 10, 5, color);
    rect(5, 5, 6, 3, shift(rgb(color), 28));
    line(4, 7, 11, 7, shift(rgb(color), 40));
    rect(4, 11, 8, 1, shift(rgb(color), -28));
  } else if (name === "APPLE") {
    rect(4, 5, 9, 8, "#a64238");
    rect(2, 6, 12, 5, "#d75b42");
    rect(4, 4, 4, 8, "#e66d4a");
    rect(5, 5, 2, 2, "#f7a572");
    rect(7, 2, 2, 4, handle);
    rect(9, 2, 4, 2, "#7ea64a");
  } else if (name === "BREAD") {
    rect(2, 6, 12, 7, "#a86f38");
    rect(4, 4, 8, 2, "#bb873e");
    rect(3, 6, 10, 5, "#d6a659");
    rect(5, 4, 6, 2, "#e7bd6b");
    for (const x of [5, 8, 11]) line(x, 6, x - 2, 9, "#f3d597");
  } else if (/BEEF|STEAK|PORK|CHICKEN|MUTTON/.test(name)) {
    const cooked = name === "STEAK" || name.startsWith("COOKED");
    const color = item.color ?? (cooked ? "#a5683d" : "#d48079");
    line(3, 13, 8, 8, "#e5d8b5", 2);
    rect(2, 12, 2, 3, "#f4e9d4");
    rect(6, 4, 7, 7, outline);
    rect(8, 3, 5, 9, outline);
    rect(7, 5, 5, 5, color);
    rect(9, 4, 4, 7, color);
    line(8, 5, 11, 8, cooked ? "#d29a57" : "#f6bbb0", 2);
  } else if (
    sameItem(
      name,
      "DIAMOND",
      "ENDER_PEARL",
      "COAL",
      "RAW_IRON",
      "RAW_GOLD",
      "RAW_COPPER",
      "FLINT_AND_STEEL",
      "GUNPOWDER",
      "EMERALD",
      "REDSTONE",
      "LAPIS",
      "FLINT",
      "SLIME_BALL"
    )
  ) {
    const color = item.color ?? "#69dcd4";
    rect(5, 2, 6, 12, outline);
    rect(3, 4, 10, 8, outline);
    rect(5, 3, 6, 10, color);
    rect(4, 5, 8, 6, color);
    rect(5, 4, 3, 3, shift(rgb(color), 46));
    rect(8, 10, 3, 2, shift(rgb(color), -24));
  } else if (name.includes("BUCKET")) {
    rect(3, 3, 10, 2, "#d1d9d5");
    rect(3, 5, 2, 7, "#91a5a7");
    rect(11, 5, 2, 7, "#718c92");
    rect(5, 12, 6, 2, "#85999e");
    rect(5, 5, 6, 7, name === "WATER_BUCKET" ? "#62b1d3" : "#4d6168");
    rect(5, 6, 5, 1, name === "WATER_BUCKET" ? "#aadfe2" : "#819798");
  } else if (name === "BOW") {
    line(7, 2, 12, 5, handle, 2);
    line(12, 5, 12, 10, handle, 2);
    line(12, 10, 7, 14, handleLight, 2);
    line(7, 2, 7, 14, "#d5d2b3");
  } else if (name === "IRON_ARMOR") {
    rect(2, 3, 12, 5, outline);
    rect(4, 7, 8, 7, outline);
    rect(3, 4, 10, 3, "#a7bbbd");
    rect(5, 7, 6, 6, "#bacdcd");
    rect(6, 3, 4, 3, [0, 0, 0, 0]);
    rect(6, 8, 2, 4, "#e0e8de");
  } else if (name === "WHEAT" || name === "SEEDS") {
    for (const x of [4, 8, 11]) {
      line(8, 14, x, 4, "#8a9f48");
      for (let y = 4; y < 10; y += 3)
        rect(x - 1, y, 3, 2, name === "WHEAT" ? "#dcc56b" : "#afbd69");
    }
  } else if (name === "EGG") {
    rect(5, 3, 6, 10, "#c9c9af");
    rect(3, 6, 10, 6, "#dddcc4");
    rect(6, 2, 4, 11, "#f1ecd5");
    rect(4, 8, 2, 3, "#efead6");
  } else if (name === "LEATHER") {
    rect(3, 3, 3, 10, "#a96e44");
    rect(10, 3, 3, 10, "#a96e44");
    rect(5, 5, 6, 7, "#be8656");
    rect(6, 11, 4, 3, "#935e3a");
  } else if (name === "STRING") {
    line(3, 5, 10, 2, "#e2e3cd");
    line(10, 2, 13, 8, "#b6bdaf");
    line(13, 8, 5, 12, "#e2e3cd");
    line(5, 12, 4, 6, "#b6bdaf");
    line(4, 6, 9, 5, "#e2e3cd");
    line(9, 5, 10, 9, "#b6bdaf");
  } else {
    line(3, 13, 12, 3, outline, 2);
    line(4, 13, 13, 3, name === "STICK" ? handleLight : "#d6d7c2");
    if (name === "ARROW") {
      rect(11, 2, 3, 3, "#a8c0c3");
      line(3, 11, 5, 13, "#e6d8be", 2);
    }
    if (name === "FEATHER")
      for (let y = 3; y < 11; y += 2) line(12 - y / 2, y, 13, y, "#ebe9d3", 2);
    if (name === "BONE") {
      rect(2, 11, 3, 3, "#e8e4ca");
      rect(11, 2, 3, 3, "#e8e4ca");
    }
  }
  return pixels;
}

const sameItem = (name, ...names) => names.includes(name);

export function itemIcon(id) {
  if (isBlockItem(id)) return blockIcon(id);
  if (icons.has(id)) return icons.get(id);
  if (!getItem(id)) return blockIcon(0);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvasFromPixels(itemTexturePixels(id)), 0, 0, 64, 64);
  const url = canvas.toDataURL();
  icons.set(id, url);
  return url;
}
