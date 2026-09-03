// Original, code-authored pixel art. No downloaded skins or game assets.
// RGB is sRGB albedo; A is an emission mask, never surface transparency.
export const MOB_TEXELS_PER_BLOCK = 16;
export const MOB_SKIN_FACES = Object.freeze([
  "right",
  "left",
  "top",
  "bottom",
  "front",
  "back",
]);

const palettes = {
  sheep: {
    hide: "#a18c79",
    light: "#bbaa95",
    shade: "#746758",
    wool: "#dfd9c7",
    ink: "#34382e",
    hoof: "#4f4b40",
  },
  pig: {
    hide: "#ce9487",
    light: "#e1ac9d",
    shade: "#b37e77",
    pink: "#bc7f78",
    ink: "#61453e",
    hoof: "#70534b",
  },
  cow: {
    hide: "#674b38",
    light: "#d8d0b7",
    shade: "#4d392d",
    pink: "#ab8980",
    ink: "#312d26",
    hoof: "#413a30",
    horn: "#bfb99c",
  },
  chicken: {
    hide: "#e3dfcc",
    light: "#f1e8d3",
    shade: "#bdbfad",
    ink: "#393b2b",
    accent: "#c59a42",
    pink: "#a84832",
  },
  horse: {
    hide: "#976540",
    light: "#ccae7e",
    shade: "#724d34",
    ink: "#362e27",
    hoof: "#443a31",
    pink: "#826650",
  },
  rabbit: {
    hide: "#a38e75",
    light: "#cbbb9b",
    shade: "#80715d",
    pink: "#bf9784",
    ink: "#37332c",
    hoof: "#b9a48a",
  },
  wolf: {
    hide: "#979b8e",
    light: "#cfccba",
    shade: "#686e65",
    ink: "#30382e",
    hoof: "#676b60",
    pink: "#ae9a87",
    accent: "#9d4936",
    eye: "#bcac6e",
  },
  fox: {
    hide: "#b36b36",
    light: "#d8c8a2",
    shade: "#8b4d29",
    ink: "#3b342c",
    hoof: "#493c2f",
    pink: "#a48e70",
    eye: "#9b985b",
  },
  goat: {
    hide: "#c3b28e",
    light: "#ded1ae",
    shade: "#968b70",
    ink: "#474433",
    hoof: "#514a37",
    horn: "#766b52",
    pink: "#aa9070",
  },
  polar_bear: {
    hide: "#dedcc7",
    light: "#ebe7d2",
    shade: "#b9c0af",
    ink: "#374139",
    hoof: "#919d8c",
    pink: "#9eaa96",
  },
  panda: {
    hide: "#dbd6bd",
    light: "#eee4c9",
    shade: "#b3b69e",
    ink: "#343e39",
    hoof: "#3c4640",
    pink: "#9c9e89",
    eye: "#a7ac8c",
  },
  camel: {
    hide: "#ba965a",
    light: "#d1b177",
    shade: "#957344",
    ink: "#514532",
    hoof: "#655136",
    pink: "#a48a61",
  },
  frog: {
    hide: "#809051",
    light: "#c3bb7d",
    shade: "#596e41",
    ink: "#354530",
    eye: "#c7b670",
    pink: "#9caa68",
  },
  mooshroom: {
    hide: "#984534",
    light: "#decdb0",
    shade: "#74362b",
    pink: "#b78170",
    ink: "#423129",
    hoof: "#583e31",
    horn: "#c8b797",
    accent: "#bc4631",
  },
  zombie: {
    hide: "#7a8656",
    light: "#a0a370",
    shade: "#586548",
    ink: "#353d2c",
    cloth: "#527d79",
    pants: "#565a69",
    hoof: "#3e4742",
    pink: "#778159",
  },
  skeleton: {
    hide: "#c5c4ac",
    light: "#dcd8bd",
    shade: "#969d87",
    ink: "#39433b",
    wood: "#80613e",
  },
  creeper: {
    hide: "#648048",
    light: "#97a760",
    shade: "#465f36",
    ink: "#283b27",
    hoof: "#405735",
  },
  spider: {
    hide: "#3e3836",
    light: "#66564a",
    shade: "#2d2d2b",
    ink: "#222622",
    eye: "#b44932",
    eyeLight: "#ce6541",
    horn: "#9b9b7c",
  },
  enderman: {
    hide: "#29292c",
    light: "#38353b",
    shade: "#202226",
    ink: "#191e20",
    eye: "#a074b5",
    eyeLight: "#d6afd8",
  },
  slime: {
    hide: "#729951",
    light: "#a4bb72",
    shade: "#527644",
    ink: "#355738",
  },
  sulfur_cube: {
    hide: "#d7b947",
    light: "#e8d271",
    shade: "#af9138",
    ink: "#675b2e",
    accent: "#c89e3f",
  },
  husk: {
    hide: "#a39770",
    light: "#c1b18a",
    shade: "#7a7757",
    ink: "#494c34",
    cloth: "#95825d",
    pants: "#68644b",
    hoof: "#4e503b",
  },
  stray: {
    hide: "#b3bfaf",
    light: "#d2d8c5",
    shade: "#8f9e91",
    ink: "#3d514b",
    cloth: "#617b7b",
    wood: "#6c6650",
  },
  piglin: {
    hide: "#bd9075",
    light: "#d4ab85",
    shade: "#996d58",
    pink: "#a37962",
    ink: "#513b2e",
    cloth: "#66533e",
    pants: "#4e4435",
    hoof: "#3e3b30",
    accent: "#c7aa59",
    horn: "#d6c5a0",
  },
  ghast: {
    hide: "#d7d9cc",
    light: "#e5e5d8",
    shade: "#b4bdb6",
    ink: "#5a6661",
    pink: "#7b7b71",
  },
  cod: {
    hide: "#a1926d",
    light: "#c4b997",
    shade: "#797557",
    ink: "#393f31",
    accent: "#a79664",
  },
  squid: {
    hide: "#526b70",
    light: "#83968c",
    shade: "#3d5660",
    ink: "#283e44",
    eye: "#c1c7a4",
    pink: "#677c7a",
  },
  arrow: {
    hide: "#886943",
    light: "#c9c6a6",
    shade: "#615139",
    ink: "#515c52",
    horn: "#aeb6a6",
  },
  fireball: {
    hide: "#c56834",
    light: "#eebc58",
    shade: "#90482a",
    ink: "#6b3f28",
  },
};

const roleColors = {
  wool: "wool",
  belly: "light",
  muzzle: "light",
  hoof: "hoof",
  ear: "hide",
  mane: "ink",
  tail_tip: "light",
  horn: "horn",
  claw: "horn",
  shirt: "cloth",
  pants: "pants",
  cloak: "cloth",
  wrap: "cloth",
  collar: "accent",
  blade: "accent",
  hilt: "wood",
  bow: "wood",
  string: "light",
  beak: "accent",
  wattle: "pink",
  comb: "pink",
  fin: "shade",
  mushroom: "accent",
  stem: "light",
  gel_cap: "light",
  crystal: "light",
  tentacle: "shade",
  arrowhead: "horn",
  feather: "light",
  flame: "light",
  ember: "shade",
  udder: "pink",
  wing: "shade",
  hump: "shade",
};
const fire = { light: rgbColor("#e7b757"), shade: rgbColor("#b85f2e") };

function rgbColor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

const colors = Object.fromEntries(
  Object.entries(palettes).map(([kind, p]) => [
    kind,
    Object.fromEntries(
      Object.entries({
        light: p.hide,
        shade: p.hide,
        ink: "#343b30",
        hoof: p.shade,
        pink: p.shade,
        horn: "#c6bda0",
        accent: p.light,
        cloth: p.hide,
        pants: p.shade,
        wood: "#80613e",
        eye: p.ink,
        eyeLight: p.eye,
        wool: p.light,
        ...p,
      })
        .filter(([, color]) => color)
        .map(([key, color]) => [key, rgbColor(color)])
    ),
  ])
);

export function createMobSkin(kind, role, size) {
  if (!Object.hasOwn(palettes, kind))
    throw new Error(`Unknown mob skin: ${kind}`);
  const palette = palettes[kind];
  if (
    !Array.isArray(size) ||
    size.length !== 3 ||
    !size.every((value) => Number.isFinite(value) && value > 0)
  )
    throw new Error("Mob skin dimensions must be finite and positive");
  const pixels = size.map((value) =>
    Math.max(1, Math.round(value * MOB_TEXELS_PER_BLOCK))
  );
  if (pixels.some((value) => value > 64))
    throw new Error("Mob skin exceeds the bounded face size");
  return {
    key: `${kind}/${role}/${pixels.join("x")}`,
    kind,
    role,
    pixels,
    baseColor:
      role === "flame"
        ? "#e7b757"
        : (palette[roleColors[role]] ?? palette.hide),
    tintable: role === "absorbed",
    // Sulfur cubes share gel_cap's art role, but never its render layer.
    translucent:
      kind === "slime" && ["gel_shell", "gel_cap", "gel_foot"].includes(role),
  };
}

export function mobSkinFaceSize(skin, face) {
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  if (!Number.isInteger(index) || index < 0 || index >= 6)
    throw new Error(`Unknown skin face: ${face}`);
  const [x, y, z] = skin.pixels;
  return index < 2 ? [z, y] : index < 4 ? [x, z] : [x, y];
}

function hash(seed, x, y, z = 0) {
  let n = Math.imul(seed ^ Math.imul(x + 41, 374761393), 668265263);
  n ^= Math.imul(y + 59, 1274126177) ^ Math.imul(z + 23, 1597334677);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function seedFor(value) {
  let seed = 2166136261;
  for (const char of value)
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}

// Coordinates on the same cuboid, so hide patches continue around its edges.
function surface(face, u, v) {
  switch (face) {
    case 0:
      return [0.5, 0.5 - v, 0.5 - u];
    case 1:
      return [-0.5, 0.5 - v, u - 0.5];
    case 2:
      return [u - 0.5, 0.5, v - 0.5];
    case 3:
      return [u - 0.5, -0.5, 0.5 - v];
    case 4:
      return [u - 0.5, 0.5 - v, 0.5];
    default:
      return [0.5 - u, 0.5 - v, -0.5];
  }
}

const hidePatches = [
  [-0.48, 0.18, -0.18, 0.3, 0.36, 0.3],
  [0.48, 0.14, 0.3, 0.28, 0.3, 0.27],
  [-0.15, 0.49, 0.38, 0.36, 0.22, 0.24],
  [0.4, -0.28, -0.3, 0.36, 0.24, 0.34],
  [0.05, 0.39, -0.48, 0.4, 0.28, 0.22],
];

function hidePatch(point, seed) {
  const rough =
    hash(seed, ...point.map((value) => Math.floor((value + 0.5) * 12))) * 0.23;
  return hidePatches.some(
    ([x, y, z, sx, sy, sz]) =>
      ((point[0] - x) / sx) ** 2 +
        ((point[1] - y) / sy) ** 2 +
        ((point[2] - z) / sz) ** 2 <
      1 + rough
  );
}

// Each face is drawn into the skin itself, not suspended in front of a head.
// Dots preserve the hide underneath; these are deliberately different faces,
// not a shared "white eyeballs + black pupils" stamp.
const faces = {
  sheep: [
    "........",
    "........",
    ".s....s.",
    ".d....d.",
    "........",
    "...ss...",
    "...dd...",
    "....s...",
  ],
  pig: [
    "........",
    "........",
    ".s....s.",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
  ],
  cow: [
    "...ll...",
    "...ll...",
    ".d.ll.d.",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
  ],
  chicken: [
    "........",
    "........",
    ".d....d.",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
  ],
  horse: [
    "...l....",
    "...ll...",
    "...ll...",
    "........",
    ".s....s.",
    ".d....d.",
    "........",
    "........",
  ],
  rabbit: [
    "........",
    "........",
    ".d....d.",
    ".d....d.",
    "...ll...",
    "...pp...",
    "..lssl..",
    "........",
  ],
  wolf: [
    "...ss...",
    "..ssss..",
    ".s....s.",
    ".e....e.",
    "ll....ll",
    "lll..lll",
    "llllllll",
    "llllllll",
  ],
  fox: [
    "...ss...",
    "..ssss..",
    ".d....d.",
    ".e....e.",
    "ll....ll",
    "lll..lll",
    "llllllll",
    "llllllll",
  ],
  goat: [
    "...l....",
    "...ll...",
    ".dd..dd.",
    "........",
    "...ss...",
    "...dd...",
    "........",
    "........",
  ],
  polar_bear: [
    "........",
    "........",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
    "........",
  ],
  panda: [
    "........",
    ".ss..ss.",
    "sddssdds",
    ".es..se.",
    "........",
    "........",
    "........",
    "........",
  ],
  camel: [
    "........",
    "..llll..",
    ".d....d.",
    ".s....s.",
    "........",
    "........",
    ".d....d.",
    "........",
  ],
  frog: [
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    ".ssssss.",
    "........",
  ],
  mooshroom: [
    "...ll...",
    "..lll...",
    ".d.ll.d.",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
  ],
  zombie: [
    "..ss....",
    "..sss...",
    ".ss..ss.",
    ".dd..dd.",
    "...s....",
    "...ss...",
    "..sdd...",
    "...sds..",
  ],
  skeleton: [
    ".....s..",
    "......s.",
    ".ss..ss.",
    ".dd..dd.",
    ".dd..dd.",
    "...d....",
    "..sdds..",
    "..d.d...",
  ],
  creeper: [
    // Match the physical 10x9 head face so eye and mouth rows never collapse.
    "..........",
    ".dd....dd.",
    ".dd....dd.",
    "..........",
    "....dd....",
    "...dddd...",
    "..dddddd..",
    "..dd..dd..",
    "..d....d..",
  ],
  spider: [
    "..........",
    "..e....e..",
    ".e.e..e.e.",
    "...E..E...",
    ".e......e.",
    "..........",
  ],
  enderman: [
    "........",
    "........",
    "........",
    ".eE..Ee.",
    "........",
    "........",
    "........",
    "........",
  ],
  slime: [
    "............",
    "............",
    "..ss....ss..",
    "..dd....dd..",
    "..dd....dd..",
    "............",
    "............",
    ".....dd.....",
    "......d.....",
    "............",
    "............",
    "............",
  ],
  sulfur_cube: [
    "............",
    "............",
    "...d....d...",
    "...d....d...",
    "............",
    "....s..s....",
    ".....ss.....",
    "............",
    "............",
    "............",
    "............",
    "............",
  ],
  husk: [
    "..ss....",
    "...sss..",
    ".ss..ss.",
    ".dd..dd.",
    "...s....",
    "...ss...",
    "..sdds..",
    "...ss...",
  ],
  stray: [
    ".....s..",
    "......s.",
    ".ss..ss.",
    ".dd..dd.",
    ".dd..dd.",
    "...d....",
    "..sdds..",
    "..d.d...",
  ],
  piglin: [
    "........",
    ".s....s.",
    ".d....d.",
    "........",
    "........",
    "........",
    "........",
    "........",
  ],
  ghast: [
    "................",
    "................",
    "................",
    "................",
    "...sss....sss...",
    "...ddd....ddd...",
    "....s......s....",
    "....s......s....",
    "....s......s....",
    ".....s....s.....",
    ".......ss.......",
    "......sdds......",
    "......sdds......",
    ".......ss.......",
    "................",
    "................",
  ],
  cod: [
    "........",
    "........",
    "........",
    "........",
    "...ss...",
    "..sdds..",
    "........",
    "........",
  ],
  squid: [
    "........",
    "........",
    "........",
    "........",
    ".ee..ee.",
    ".dd..dd.",
    "........",
    "........",
  ],
};

function stamp(rows, u, v, width, height) {
  const row = rows[Math.min(rows.length - 1, Math.floor(v * rows.length))];
  let symbol = row[Math.min(row.length - 1, Math.floor(u * row.length))];
  // Preserve single-pixel features when a small animal's physical head has
  // fewer texels than the drawing. Naive downsampling drops one or both eyes.
  const tx = Math.floor(u * width),
    ty = Math.floor(v * height);
  const startX = Math.max(0, Math.ceil((tx * row.length) / width - 0.5));
  const endX = Math.min(
    row.length,
    Math.ceil(((tx + 1) * row.length) / width - 0.5)
  );
  const startY = Math.max(0, Math.ceil((ty * rows.length) / height - 0.5));
  const endY = Math.min(
    rows.length,
    Math.ceil(((ty + 1) * rows.length) / height - 0.5)
  );
  const priority = {
    ".": 0,
    h: 1,
    l: 1,
    w: 1,
    s: 2,
    p: 2,
    a: 2,
    d: 3,
    e: 4,
    E: 5,
  };
  for (let y = startY; y < endY; y++)
    for (let x = startX; x < endX; x++)
      if (priority[rows[y][x]] > priority[symbol]) symbol = rows[y][x];
  return symbol;
}

const featureColors = {
  d: "ink",
  s: "shade",
  l: "light",
  h: "hide",
  a: "accent",
  p: "pink",
  w: "wool",
  e: "eye",
  E: "eyeLight",
};

function bodyPixel(skin, face, x, y, width, height, p, seed) {
  const { kind, role } = skin;
  const u = (x + 0.5) / width,
    v = (y + 0.5) / height;
  const point = surface(face, u, v);
  const noise = hash(seed, x >> 1, y >> 1, face);
  let color = p[roleColors[role]] ?? p.hide;
  if (role === "flame")
    return { color: noise > 0.36 ? fire.light : fire.shade, shade: 0 };
  if (role === "wool") {
    // Interlocking tufts, deliberately quieter than the terrain's grain.
    const tuft = (x + Math.floor(y / 3) * 2) % 4;
    return {
      color: p.wool,
      shade:
        tuft === 0 && y % 3 === 1 ? -15 : tuft === 2 && y % 3 === 0 ? 7 : 0,
    };
  }
  if (
    ["shirt", "cloak", "wrap", "pants"].includes(role) ||
    (role === "arm" &&
      ["zombie", "husk", "piglin"].includes(kind) &&
      (face === 2 || (face !== 3 && v < 0.4 + (x % 3) * 0.035)))
  ) {
    color = role === "pants" ? p.pants : p.cloth;
    let shade = (x + y) % 3 === 0 ? -4 : 0;
    if (x === 0 || x === width - 1) shade -= 10;
    if (face === 4 && role === "shirt" && v < 0.2 && Math.abs(u - 0.5) < 0.22)
      color = v < 0.08 ? p.hide : p.shade;
    if (role === "shirt" && v > 0.82 && (x % 4 === 1 || x % 5 === 2))
      shade -= 16;
    if (face < 2 && v > 0.48 && v < 0.72 && u > 0.35 && u < 0.7)
      shade += (x + y) % 3 === 0 ? 5 : -12;
    return { color, shade };
  }
  if (role === "ear" && face === 4 && u > 0.2 && u < 0.8 && v > 0.2 && v < 0.85)
    color = p.pink;
  if (role === "hoof")
    return {
      color: p.hoof,
      shade: face === 4 && x === Math.floor(width / 2) && v > 0.5 ? -17 : 0,
    };
  if (role === "horn" || role === "claw")
    return { color, shade: y % 3 === 1 ? -11 : 2 };
  if (role === "collar")
    return {
      color: p.accent,
      shade: face === 4 && u > 0.4 && u < 0.6 ? 20 : -3,
    };
  if (role === "bow" || role === "hilt" || role === "shaft")
    return { color, shade: (x + Math.floor(y / 4)) % 3 === 0 ? -12 : 3 };
  if (role === "string" || role === "feather")
    return { color: p.light, shade: x % 2 === 0 ? -4 : 1 };
  if (role === "mushroom") {
    const spores = (Math.floor(x / 2) + Math.floor(y / 2) * 3 + face) % 7;
    return {
      color:
        face === 3
          ? p.light
          : spores === 1 || spores === 5
            ? p.light
            : p.accent,
      shade: 0,
    };
  }
  if (role === "stem") return { color: p.light, shade: x % 3 === 0 ? -13 : -3 };
  if (kind === "creeper") {
    if (role === "head" && face === 4)
      return {
        color: p.hide,
        shade: noise < 0.28 ? -7 : noise > 0.74 ? 8 : 0,
      };
    color = noise < 0.2 ? p.shade : noise > 0.8 ? p.light : p.hide;
  } else if (skin.translucent) {
    // Wet pixel rims surround a genuinely translucent volume. No painted
    // fake nucleus or face: those now sit on the separate opaque inner cube.
    color = p.hide;
    if (x === 0 || x === width - 1 || y === height - 1) color = p.shade;
    if (
      (x === 1 && y > 1 && y < height / 2) ||
      (y === 1 && x > 1 && x < width / 2) ||
      noise > 0.965
    )
      color = p.light;
    if (role === "gel_cap") color = p.light;
  } else if (kind === "slime" && role === "gel") {
    color = face === 2 || (v < 0.2 && noise > 0.5) ? p.hide : p.shade;
  } else if (kind === "sulfur_cube") {
    if ((y + Math.floor(x / 4)) % 6 === 0) color = p.shade;
    else if (face === 2 || x === 0 || role === "crystal") color = p.light;
  } else if ((kind === "cow" || kind === "mooshroom") && role === "body") {
    if (hidePatch(point, seed)) color = p.light;
  } else if (kind === "panda") {
    if (role === "body" && point[2] > 0.08) color = p.ink;
    if (role === "leg" || role === "ear") color = p.ink;
    if (
      role === "head" &&
      face === 4 &&
      ((u - 0.23) ** 2 / 0.028 + (v - 0.4) ** 2 / 0.07 < 1 ||
        (u - 0.77) ** 2 / 0.028 + (v - 0.4) ** 2 / 0.07 < 1)
    )
      color = p.ink;
  } else if (kind === "wolf" || kind === "fox") {
    if (role === "body" && point[1] > 0 && point[2] < 0.24)
      color = kind === "wolf" ? p.shade : p.hide;
    if (role === "body" && point[1] < -0.18) color = p.light;
    if (role === "leg" && v > 0.63) color = p.hoof;
    if (role === "ear" && v < 0.3) color = p.ink;
  } else if (kind === "skeleton" || kind === "stray") {
    if (face === 3 || (x === width - 1 && noise < 0.65)) color = p.shade;
    if (role === "rib" && face === 4 && y === 0) color = p.light;
  } else if (kind === "enderman") {
    return { color, shade: x % 3 === 1 && noise > 0.6 ? 5 : -1 };
  } else if (kind === "spider") {
    if (role === "body" && Math.abs(point[0]) < 0.15 && point[1] > 0.1)
      color = p.shade;
    if (role === "leg" && y % 4 === 0) color = p.light;
  } else if (kind === "ghast") {
    if (v > 0.42 && hash(seed, Math.floor(x / 2), 0, face) > 0.68)
      color = p.shade;
    if (role === "tentacle" && y % 4 === 3) color = p.light;
  } else if (kind === "squid") {
    if (role === "tentacle" && face === 5 && y % 3 === 1) color = p.light;
    if (role === "mantle" && v < 0.35) color = p.shade;
  } else if (kind === "cod") {
    if (role === "head" && v < 0.3) color = p.shade;
    else if (role === "head" && v > 0.68) color = p.light;
    if (role === "fin") return { color, shade: x % 2 ? -10 : 7 };
  } else if (kind === "frog" && role !== "belly") {
    if (noise > 0.73) color = p.shade;
  } else if (
    (kind === "pig" || kind === "zombie" || kind === "husk") &&
    noise < 0.11
  ) {
    color = p.shade;
  }
  return { color, shade: 0 };
}

function detailPixel(skin, face, u, v, p, width, height) {
  const { kind, role } = skin;
  if (["head", "skull", "gel", "shell", "mantle"].includes(role)) {
    if (face === 4 && faces[kind]) {
      const symbol = stamp(faces[kind], u, v, width, height);
      const color = p[featureColors[symbol]];
      if (color) {
        const emission =
          kind === "enderman" && (symbol === "e" || symbol === "E")
            ? 0.65
            : kind === "spider" && (symbol === "e" || symbol === "E")
              ? 0.24
              : 0;
        return { color, emission };
      }
    }
    if (
      face < 2 &&
      [
        "sheep",
        "pig",
        "cow",
        "mooshroom",
        "chicken",
        "horse",
        "camel",
        "wolf",
        "fox",
        "rabbit",
        "goat",
        "polar_bear",
        "panda",
        "cod",
      ].includes(kind)
    ) {
      const forward = face === 0 ? 1 - u : u;
      const eyeX = kind === "horse" || kind === "camel" ? 0.46 : 0.78;
      if (Math.abs(forward - eyeX) < 0.085 && Math.abs(v - 0.38) < 0.09)
        return { color: p.ink, emission: 0 };
    }
  }
  if (role === "eye" && face === 4) {
    return { color: v > 0.38 && v < 0.65 ? p.ink : p.eye, emission: 0 };
  }
  if (role === "muzzle" && face === 4) {
    if (
      kind === "wolf" ||
      kind === "fox" ||
      kind === "polar_bear" ||
      kind === "panda"
    ) {
      if (Math.abs(u - 0.5) < 0.27 && v < 0.48)
        return { color: p.ink, emission: 0 };
      if (v > 0.7 && v < 0.85) return { color: p.shade, emission: 0 };
    } else {
      if (
        (Math.abs(u - 0.25) < 0.09 || Math.abs(u - 0.75) < 0.09) &&
        v > 0.25 &&
        v < 0.62
      )
        return { color: p.ink, emission: 0 };
      if (v > 0.83 && u > 0.2 && u < 0.8)
        return { color: p.shade, emission: 0 };
    }
  }
  return null;
}

export function paintMobSkinFace(skin, face) {
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  const [width, height] = mobSkinFaceSize(skin, index);
  const data = new Uint8Array(width * height * 4);
  const p = colors[skin.kind];
  const seed = seedFor(`${skin.kind}/${skin.role}`);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (skin.tintable) {
        data.set([255, 255, 255, 0], offset);
        continue;
      }
      const base = bodyPixel(skin, index, x, y, width, height, p, seed);
      const detail = detailPixel(
        skin,
        index,
        (x + 0.5) / width,
        (y + 0.5) / height,
        p,
        width,
        height
      );
      const color = detail?.color ?? base.color;
      const grain = Math.round((hash(seed, x, y, index) - 0.5) * 8);
      const value = detail ? 0 : base.shade + grain;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.max(
          0,
          Math.min(255, color[channel] + value)
        );
      data[offset + 3] = Math.round(
        255 *
          (skin.role === "flame"
            ? 0.85
            : skin.kind === "fireball"
              ? 0.65
              : (detail?.emission ?? 0))
      );
    }
  }
  return { width, height, data };
}
