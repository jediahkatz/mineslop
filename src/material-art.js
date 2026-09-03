import { BLOCK } from "./blocks.js";
import { painter, rgb, shift, TEXTURE_SIZE } from "./pixel-art.js";

const tones = (color, amounts) => {
  const base = typeof color === "string" ? rgb(color) : color;
  return amounts.map((amount) => shift(base, amount));
};

export function paintStone(pixels) {
  const p = painter(pixels);
  // Short, connected grains with quiet midtones; no broad contours or seams
  // that turn into a repeating emblem when many cave faces share this tile.
  p.stamp(
    0,
    0,
    [
      "2210223222333122",
      "2312223322222112",
      "2342222122112222",
      "2221122223222332",
      "1222123322322222",
      "1122322222112232",
      "2223321022223322",
      "2322211223322221",
      "2332222232222112",
      "2222112322212222",
      "3221122332222342",
      "2222232221122332",
      "2112233222212222",
      "2221222223322012",
      "2322221122222122",
      "2332212222432223",
    ],
    ["#878a8c", "#8d9092", "#949698", "#9a9c9e", "#a0a2a3"]
  );
}

function paintDirt(pixels) {
  const p = painter(pixels);
  p.field(["#725139", "#7e583c", "#896140", "#956c48", "#a1764f"], 142, 5);
  const clod = ["#71513b", "#825d40", "#a17a54"];
  p.stamp(1, 3, [".22", "110", ".0."], clod);
  p.stamp(9, 7, ["22..", "1110", "..0."], clod);
  p.stamp(4, 12, [".22.", "1100"], clod);
  p.stamp(12, 1, ["21", "10"], ["#776653", "#91836c", "#a8987a"]);
  p.stamp(1, 10, ["21", "10"], ["#776653", "#91836c", "#a8987a"]);
}

function paintSoil(pixels, block, face) {
  if (block.id === BLOCK.DIRT) {
    paintDirt(pixels);
    return;
  }
  const p = painter(pixels);
  p.field(tones(block.color, [-12, -5, 0, 5, 10]), block.id + 142, 3, 4);
  if (block.id === BLOCK.MUD) {
    const clay = ["#403f3b", "#4d4840", "#69604f"];
    p.stamp(1, 4, ["222...", "...110", "....00"], clay);
    p.stamp(8, 11, ["..22.", "211..", "001.."], clay);
  } else if (block.id === BLOCK.CLAY) {
    const clay = tones(block.color, [-12, -6, 7]);
    p.stamp(2, 3, ["222...", "..110.", "....0."], clay);
    p.stamp(9, 10, ["...22", ".110.", "00..."], clay);
  } else if (face === "top") {
    for (const y of [3, 7, 11, 15]) {
      p.line(0, y, 15, y, "#503b29");
      p.line(0, y - 1, 15, y - 1, "#86633d");
    }
  } else {
    p.stamp(1, 4, ["22.", "110"], tones(block.color, [-13, -4, 8]));
    p.stamp(10, 11, [".22", "110"], tones(block.color, [-13, -4, 8]));
  }
}

function paintSurface(pixels, block, face) {
  if (face === "bottom") {
    paintDirt(pixels);
    return;
  }
  const surface = new Uint8ClampedArray(pixels.length);
  const p = painter(surface);
  if (block.id === BLOCK.SNOW) {
    p.field(["#d7e1df", "#e3e9e3", "#edf1e9", "#f4f5ed"], 112, 3);
    p.line(3, 4, 7, 4, "#f8f8ef");
    p.line(10, 12, 13, 12, "#e0e7e1");
  } else if (block.id === BLOCK.PODZOL) {
    p.field(tones(block.color, [-13, -6, 0, 9, 14]), 135, 4, 5);
    p.line(2, 4, 5, 5, "#a58551");
    p.line(9, 3, 10, 5, "#655044");
    p.line(5, 12, 8, 11, "#ad8350");
    p.line(12, 10, 14, 12, "#624834");
  } else if (block.id === BLOCK.MYCELIUM) {
    p.field(tones(block.color, [-15, -7, 0, 7, 14]), 137, 4);
    const threads = ["#85737c", "#a8969d", "#c0b1b2"];
    p.stamp(1, 3, ["2...2", ".112.", "..0.."], threads);
    p.stamp(8, 10, [".2..", "211.", "..02"], threads);
  } else {
    // Keep the palette centered on block.color: the mesh applies target/base
    // biome tint once, so baking a second biome color here would distort it.
    p.field(tones(block.color, [-15, -7, 0, 7, 13]), 151, 5, 4);
    const blades = tones(block.color, [-13, -2, 10]);
    for (const [x, y] of [
      [1, 2],
      [9, 1],
      [5, 8],
      [12, 12],
      [0, 13],
    ]) {
      p.stamp(x, y, [".2..", "21.2", ".10."], blades, true);
    }
  }
  if (face === "top") {
    pixels.set(surface);
    return;
  }
  paintDirt(pixels);
  const fringe = [3, 3, 4, 4, 3, 3, 5, 4, 3, 4, 4, 3, 3, 4, 5, 4];
  const side = painter(pixels);
  for (let x = 0; x < TEXTURE_SIZE; x++) {
    for (let y = 0; y < fringe[x]; y++) {
      const at = (y * TEXTURE_SIZE + x) * 4;
      side.rect(
        x,
        y,
        1,
        1,
        shift(surface.subarray(at, at + 3), y === fringe[x] - 1 ? -15 : 0)
      );
    }
  }
}

function paintSediment(pixels, block) {
  const p = painter(pixels);
  p.field(tones(block.color, [-9, -4, 0, 4, 8]), block.id + 171, 3, 5);
  const palette = tones(block.color, [-15, -7, 8]);
  if (block.id === BLOCK.SANDSTONE) {
    p.stamp(0, 3, ["222222........22", "1111100001111111"], palette);
    p.stamp(0, 10, [".......222222...", "0000111111100000"], palette);
    p.line(3, 14, 8, 14, palette[1]);
  } else {
    p.stamp(1, 3, ["2222.", "..11."], palette);
    p.stamp(9, 10, [".2222", "11..."], palette);
    if (block.id !== BLOCK.SNOW_BLOCK) {
      p.rect(6, 8, 1, 1, palette[1]);
      p.rect(12, 1, 2, 1, palette[2]);
      p.rect(2, 13, 1, 1, palette[1]);
    }
  }
}

function paintRubble(pixels, block) {
  const p = painter(pixels);
  if (block.id === BLOCK.GRAVEL) {
    p.field(tones(block.color, [-26, -15, -6, 3]), 152, 5);
    const pebble = tones(block.color, [-31, -10, 10, 22]);
    for (const [x, y, shape] of [
      [0, 1, [".32", "221", ".10"]],
      [6, 0, ["332", "221", ".10"]],
      [11, 4, [".32.", "3221", ".210"]],
      [4, 6, [".33", "221", "100"]],
      [0, 10, ["332", "221", ".10"]],
      [8, 11, [".32.", "3221", ".210"]],
      [13, 14, ["332", "221"]],
    ])
      p.stamp(x, y, shape, pebble, true);
  } else if (block.id === BLOCK.BEDROCK) {
    p.field(["#303235", "#424447", "#51534f", "#626560"], 113, 5, 4);
    const faults = ["#292c2d", "#393e3b", "#777a70"];
    p.stamp(0, 3, ["000.....", "..011...", "....0022"], faults, true);
    p.stamp(7, 10, ["222....", "..000..", "....100"], faults, true);
    p.stamp(10, 1, ["00..", ".10.", "..00"], faults);
  } else {
    const base = rgb(block.color);
    p.field(tones(base, [-33, -25, -19]), block.id + 122, 4);
    const stone = tones(base, [-18, -3, 10, 23]);
    for (const [x, y, shape] of [
      [-1, 0, ["..3332.", ".322221", "1222221", ".11110."]],
      [8, -1, [".3332.", "322221", "122221", "122210", ".1100."]],
      [3, 5, ["..3332", ".32221", "122221", "122210", ".1100."]],
      [11, 5, [".3332", "32221", "12221", ".1110"]],
      [-2, 7, [".332", "3221", "1221", ".110"]],
      [0, 12, [".33322.", "3222221", "1222221", ".11110."]],
      [8, 11, ["..3332.", ".322221", "1222221", ".122210", "..1100."]],
    ])
      p.stamp(x, y, shape, stone, true);
  }
}

function paintMoss(pixels) {
  const p = painter(pixels);
  const moss = ["#5e7b40", "#668345", "#6d8a49", "#748f4d", "#7b9652"];
  p.field(moss, 754, 7, 8);
  // Dense pile with short interleaved fibers, not individually outlined leaves.
  const fibers = ["#78944f", "#698747", "#839451"];
  for (const [x, y, shape] of [
    [1, 1, ["0.", "01"]],
    [6, 0, ["00", "1."]],
    [11, 3, [".0", "10"]],
    [3, 5, ["10", ".0"]],
    [8, 7, ["02", ".1"]],
    [13, 9, ["0", "0"]],
    [0, 11, ["21", "0."]],
    [5, 12, ["00", "1."]],
    [10, 14, [".0", "10"]],
    [14, 15, ["00"]],
  ])
    p.stamp(x, y, shape, fibers, true);
}

function paintDripstone(pixels, block) {
  const p = painter(pixels);
  p.field(tones(block.color, [-16, -7, 0, 7, 13]), 255, 3, 5);
  const calcite = ["#7e6b5b", "#99816b", "#b49a7d"];
  p.stamp(
    1,
    0,
    [".2..", ".21.", ".210", "..10", "..21", "..21", "...1"],
    calcite
  );
  p.stamp(7, 5, ["..2.", ".221", ".210", "..10", "..21", "...1"], calcite);
  p.stamp(
    12,
    -2,
    [".2..", ".21.", ".210", ".210", "..10", "..21", "...1"],
    calcite,
    true
  );
  p.stamp(3, 12, ["..2.", ".21.", ".210", "..10"], calcite, true);
  p.line(7, 2, 10, 2, "#8e7663");
  p.line(9, 13, 12, 14, "#baa287");
}

function paintSculk(pixels) {
  const p = painter(pixels);
  p.field(["#071c22", "#0b252b", "#0d3035", "#153b3e"], 256, 5);
  p.line(0, 8, 4, 5, "#1c484a");
  p.line(4, 5, 8, 6, "#1c484a");
  p.line(8, 6, 11, 3, "#1c484a");
  p.line(6, 15, 8, 11, "#1b4546");
  p.line(8, 11, 12, 10, "#1b4546");
  const nodules = ["#1d5051", "#377a78", "#70ada3"];
  p.stamp(2, 3, [".0.", "012", ".10"], nodules);
  p.stamp(10, 1, ["01", "12", "00"], nodules);
  p.stamp(7, 10, [".01", "012", ".00"], nodules);
}

function paintLeaves(pixels, block) {
  const p = painter(pixels);
  p.field(tones(block.color, [-25, -12, 0, 8, 14]), block.id + 193, 4);
  let palette = tones(block.color, [-22, -9, 3, 14]);
  let shape = [".22..", "23321", "12221", ".110."];
  if (block.id === BLOCK.SPRUCE_LEAVES) {
    shape = ["..3..", ".232.", "12321", ".121.", "..1.."];
  } else if (block.id === BLOCK.CHERRY_LEAVES) {
    palette = ["#b97d94", "#d58fa8", "#eda8bf", "#f4ced4"];
    shape = [".22.", "2332", "1221", ".11."];
  } else if (block.id === BLOCK.PALE_LEAVES) {
    palette = ["#8c9b8c", "#a1ae9a", "#b4c0a9", "#d0d5c0"];
  }
  for (const [x, y] of [
    [0, 0],
    [8, 1],
    [3, 5],
    [11, 8],
    [1, 11],
    [8, 13],
  ]) {
    p.stamp(x, y, shape, palette, true);
  }
  // Small connected gaps between foliage masses, not random pinholes.
  for (const [x, y, gap] of [
    [5, 1, ["00", ".0"]],
    [11, 4, [".00", "00."]],
    [6, 9, ["00", ".0"]],
    [0, 7, ["0", "0"]],
    [14, 12, ["00", "0."]],
    [3, 15, ["00"]],
  ])
    p.stamp(x, y, gap, [[0, 0, 0, 0]]);
}

const ROCK_PALETTES = new Map([
  [BLOCK.OBSIDIAN, ["#211e2a", "#2d2938", "#393245", "#443b51"]],
  [BLOCK.NETHERRACK, ["#633a38", "#74413b", "#824a43", "#93534a"]],
  [BLOCK.END_STONE, ["#c5c393", "#d2d0a1", "#dedbb0", "#e7e3b9"]],
  [BLOCK.SULFUR, ["#a99544", "#beac52", "#d0be67", "#dfd180"]],
  [BLOCK.CINNABAR, ["#733d39", "#93483e", "#ae5b4b", "#c4755c"]],
  [BLOCK.POTENT_SULFUR, ["#617638", "#7b8f42", "#9aaa50", "#b9c866"]],
]);

function paintMineralRock(pixels, block) {
  const p = painter(pixels);
  const palette = ROCK_PALETTES.get(block.id);
  p.field(palette, block.id + 281, 4, 5);
  if (block.id === BLOCK.OBSIDIAN) {
    p.stamp(1, 2, ["..333", ".3221", "3221.", "121.."], palette);
    p.stamp(8, 10, ["..3332", ".3221.", "1221..", ".11..."], palette);
  } else {
    const pore =
      block.id === BLOCK.END_STONE
        ? ["#aaa77f", "#b9b58a", "#e7e4b9"]
        : tones(palette[1], [-24, -9, 24]);
    p.stamp(1, 3, [".22.", "1001", ".11."], pore);
    p.stamp(10, 8, ["22.", "001", "11."], pore);
    p.stamp(5, 13, [".22", "101", ".1."], pore);
    if (block.id === BLOCK.CINNABAR) {
      p.line(6, 2, 8, 4, "#743b37");
      p.line(9, 4, 12, 4, "#743b37");
    }
  }
}

function paintBasalt(pixels, face) {
  const p = painter(pixels);
  const palette = ["#3e4143", "#4b4f50", "#595c5b", "#666a65"];
  p.field(palette, 272, face === "side" ? 6 : 3, face === "side" ? 2 : 4);
  if (face === "side") {
    p.stamp(2, -1, ["20", "21", ".1", ".0", ".0", "10", "21"], palette, true);
    p.stamp(10, 5, ["20", "21", "21", ".1", ".0", ".1", ".0"], palette);
  } else {
    p.stamp(1, 4, ["000...", "..011.", "....20"], palette);
    p.stamp(9, 10, ["..00", ".012", "021."], palette);
  }
}

// Pixel-only dispatch: block metadata, biome tint, atlas layout, and lighting
// are deliberately independent of the material artwork.
export function paintNaturalMaterial(pixels, block, face) {
  switch (block.id) {
    case BLOCK.STONE:
      paintStone(pixels);
      break;
    case BLOCK.DIRT:
    case BLOCK.MUD:
    case BLOCK.CLAY:
    case BLOCK.FARMLAND:
      paintSoil(pixels, block, face);
      break;
    case BLOCK.GRASS:
    case BLOCK.SNOW:
    case BLOCK.PODZOL:
    case BLOCK.MYCELIUM:
      paintSurface(pixels, block, face);
      break;
    case BLOCK.SAND:
    case BLOCK.RED_SAND:
    case BLOCK.SANDSTONE:
    case BLOCK.SNOW_BLOCK:
      paintSediment(pixels, block);
      break;
    case BLOCK.GRAVEL:
    case BLOCK.COBBLESTONE:
    case BLOCK.BLACKSTONE:
    case BLOCK.BEDROCK:
      paintRubble(pixels, block);
      break;
    case BLOCK.MOSS:
      paintMoss(pixels);
      break;
    case BLOCK.DRIPSTONE:
      paintDripstone(pixels, block);
      break;
    case BLOCK.SCULK:
      paintSculk(pixels);
      break;
    case BLOCK.BASALT:
      paintBasalt(pixels, face);
      break;
    default:
      if (ROCK_PALETTES.has(block.id)) paintMineralRock(pixels, block);
      else if (block.texture === "leaves" && block.shape === "cube")
        paintLeaves(pixels, block);
      else return false;
  }
  return true;
}
