import {
  MOB_SKIN_FACES,
  MOB_TEXELS_PER_BLOCK,
  mobSkinFaceSize,
} from "./mob-skins.js";

// Original code-authored 16x16 source art, sampled at the shared mob density.
// As in mob-skins.js, RGBA means sRGB albedo + emission, NOT transparency.
export const AQUATIC_SKIN_ART_SIZE = 16;
export const AQUATIC_KINDS = Object.freeze([
  "dolphin",
  "turtle",
  "drowned",
  "guardian",
  "elder_guardian",
]);

const guardianRoles = [
  "body",
  "eye_socket",
  "eye",
  "spike",
  "spike_tip",
  "tail",
  "tail_fin",
];

export const AQUATIC_SKIN_ROLES = Object.freeze(
  Object.fromEntries(
    Object.entries({
      dolphin: [
        "body",
        "belly",
        "head",
        "snout",
        "dorsal_fin",
        "flipper",
        "tail",
        "tail_fin",
      ],
      turtle: [
        "body",
        "belly",
        "head",
        "neck",
        "shell",
        "shell_rim",
        "flipper",
        "tail",
      ],
      drowned: [
        "head",
        "shirt",
        "sleeve",
        "arm",
        "hand",
        "pants",
        "leg",
        "foot",
        "kelp",
      ],
      guardian: guardianRoles,
      elder_guardian: [...guardianRoles, "plate"],
    }).map(([kind, roles]) => [kind, Object.freeze(roles)])
  )
);

const palettes = {
  dolphin: {
    hide: "#7799a7",
    light: "#c8d9d3",
    shade: "#486d80",
    ink: "#213f4b",
  },
  turtle: {
    hide: "#74965c",
    light: "#c3bc81",
    shade: "#506e43",
    ink: "#293f32",
    shell: "#577749",
    rim: "#a4aa68",
    eye: "#c7a85d",
  },
  drowned: {
    hide: "#679a91",
    light: "#a7c3ac",
    shade: "#436e68",
    ink: "#243d3a",
    cloth: "#8c9e91",
    pants: "#526a66",
    algae: "#4c7951",
    eye: "#c6ddd0",
    glint: "#e1ecda",
  },
  guardian: {
    hide: "#587d77",
    light: "#90aaa1",
    shade: "#3d5c58",
    ink: "#243d3c",
    rim: "#adbaa0",
    spike: "#b88852",
    tip: "#ddbd7d",
    eye: "#cfb15b",
    glint: "#f0e3b3",
  },
  elder_guardian: {
    hide: "#b9bca4",
    light: "#dfddc5",
    shade: "#85947e",
    ink: "#444e42",
    rim: "#e6d9b6",
    algae: "#71886d",
    spike: "#947876",
    tip: "#c9aaa0",
    eye: "#c67c53",
    glint: "#f3d8b1",
  },
};

const roleColors = {
  belly: "light",
  dorsal_fin: "shade",
  tail_fin: "shade",
  shell: "shell",
  shell_rim: "rim",
  shirt: "cloth",
  sleeve: "cloth",
  pants: "pants",
  kelp: "algae",
  eye_socket: "shade",
  eye: "ink",
  spike: "spike",
  spike_tip: "tip",
  plate: "light",
};

const colors = Object.fromEntries(
  Object.entries(palettes).map(([kind, palette]) => [
    kind,
    Object.fromEntries(
      Object.entries(palette).map(([name, hex]) => {
        const n = Number.parseInt(hex.slice(1), 16);
        return [name, [n >> 16, (n >> 8) & 255, n & 255]];
      })
    ),
  ])
);

function validateRole(kind, role) {
  if (!Object.hasOwn(AQUATIC_SKIN_ROLES, kind))
    throw new Error(`Unknown aquatic skin: ${kind}`);
  if (!AQUATIC_SKIN_ROLES[kind].includes(role))
    throw new Error(`Unknown aquatic skin role: ${kind}/${role}`);
}

/** Atlas-compatible descriptor only: no texture, material, canvas, or cache. */
export function createAquaticSkin(kind, role, size) {
  validateRole(kind, role);
  if (
    !Array.isArray(size) ||
    size.length !== 3 ||
    !size.every((value) => Number.isFinite(value) && value > 0)
  )
    throw new Error("Aquatic skin dimensions must be finite and positive");
  const pixels = size.map((value) =>
    Math.max(1, Math.round(value * MOB_TEXELS_PER_BLOCK))
  );
  if (pixels.some((value) => value > 64))
    throw new Error("Aquatic skin exceeds the bounded face size");
  return Object.freeze({
    family: "aquatic",
    key: `aquatic/${kind}/${role}/${pixels.join("x")}`,
    kind,
    role,
    pixels: Object.freeze(pixels),
    baseColor: palettes[kind][roleColors[role]] ?? palettes[kind].hide,
    tintable: false,
    translucent: false,
  });
}

const drownedFace = [
  "....aa..........",
  "...aaas.........",
  "...ass..........",
  "....s...........",
  "..ssss....ssss..",
  "..sdds....sdds..",
  "..sdes....seds..",
  "..sdds....sdds..",
  "....s...ss......",
  "........sd......",
  ".....sssss......",
  "....sd...ds.....",
  "....sdddsds.....",
  ".....s.ss.......",
  "......s.........",
  "................",
];

const featureColors = {
  d: "ink",
  s: "shade",
  l: "light",
  a: "algae",
  e: "eye",
  E: "glint",
};
const priorities = { d: 3, s: 2, l: 1, a: 1, e: 4, E: 5 };

function seedFor(kind, role) {
  let seed = 2166136261;
  for (const char of `${kind}/${role}`)
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed;
}

function grain(seed, x, y, face) {
  let n =
    seed ^
    Math.imul(x + 13, 374761393) ^
    Math.imul(y + 41, 668265263) ^
    Math.imul(face + 3, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) & 7) - 3;
}

function bodyPixel(kind, role, face, x, y, p) {
  let color = p[roleColors[role]] ?? p.hide;
  if (kind === "dolphin") {
    if (["body", "head", "tail", "snout"].includes(role)) {
      if (face === 2 || (face !== 3 && y < 4)) color = p.shade;
      if (face === 3 || (face !== 2 && y > 10)) color = p.light;
      if (face < 2 && y === 10 && x % 5 < 3) color = p.light;
    }
    if (["flipper", "tail_fin", "dorsal_fin"].includes(role)) {
      color = face === 3 ? p.light : p.shade;
      if (face === 2 && (x + y) % 7 === 0) color = p.hide;
    }
  } else if (kind === "turtle") {
    if (role === "shell") {
      const scute = (x + (Math.floor(y / 5) % 2) * 3) % 7;
      color = scute === 0 || y % 5 === 0 ? p.shade : p.shell;
      if (scute === 1 && y % 5 === 1) color = p.rim;
    } else if (role === "shell_rim") {
      color = (x + y) % 5 === 0 ? p.shade : p.rim;
    } else if (role === "belly") {
      if (x === 7 || x === 8 || y % 5 === 0) color = p.rim;
    } else {
      if ((x + (y % 4 < 2 ? 0 : 2)) % 5 === 0) color = p.shade;
      if (face === 3) color = p.light;
      if (role === "flipper" && (x === 0 || x === 15)) color = p.shade;
    }
  } else if (kind === "drowned") {
    if (["shirt", "sleeve", "pants"].includes(role)) {
      if (x === 1 || x === 14 || (y === 5 && role === "shirt")) color = p.shade;
      // Ragged cuffs and exposed patches are opaque skin, never alpha holes.
      if (y > 11 + ((x * 3) % 4)) color = p.hide;
      if (role === "shirt" && face === 4 && y < 3 && x > 5 && x < 10)
        color = p.hide;
      if (x > 10 && y > 7 && (x + y) % 4 < 2) color = p.algae;
      if ((x * 3 + y * 5 + face) % 29 === 0) color = p.light;
    } else if (role === "kelp") {
      color = x % 4 === 1 ? p.shade : p.algae;
    } else {
      if ((x * 3 + y * 5 + face) % 19 < 3) color = p.shade;
      if (role === "head" && y < 3 && (x + face * 3) % 7 < 3) color = p.algae;
      if (["leg", "foot", "hand"].includes(role) && y > 12) color = p.shade;
    }
  } else if (role === "eye_socket") {
    color = x < 2 || x > 13 || y < 2 || y > 13 ? p.rim : p.ink;
  } else if (role === "eye") {
    color = p.ink;
  } else if (role === "spike" || role === "spike_tip") {
    if (face === 2 || y < 3) color = p.tip;
    else if (y % 5 === 0) color = p.shade;
  } else if (role === "tail_fin") {
    color = (x + Math.floor(y / 3)) % 4 === 0 ? p.light : p.shade;
  } else {
    if ((x + 2 * Math.floor(y / 4)) % 7 === 0 || y % 5 === 0) color = p.shade;
    else if ((x * 3 + y + face) % 13 === 0) color = p.light;
    if (kind === "elder_guardian") {
      if (x === 4 + Math.floor(y / 4) && y > 2) color = p.shade;
      if (y > 11 && (x + face) % 5 < 2) color = p.algae;
    }
  }
  return color;
}

function faceFeature(kind, role, face, x, y) {
  if (role === "head" && kind === "drowned" && face === 4)
    return drownedFace[y][x];
  if (role === "head" && (kind === "dolphin" || kind === "turtle")) {
    if (face === 4) {
      const eye =
        kind === "dolphin"
          ? (x >= 2 && x <= 3) || (x >= 12 && x <= 13)
          : (x >= 2 && x <= 4) || (x >= 11 && x <= 13);
      if (eye && y >= 5 && y <= 7) {
        if (kind === "turtle" && (x === 3 || x === 12) && y === 6) return "e";
        return "d";
      }
      if (eye && y === 4) return "s";
      if (kind === "turtle" && y === 11 && x >= 4 && x <= 11) return "d";
    } else if (face < 2) {
      // Right-face U runs toward -Z; left-face U runs toward +Z.
      const forward = face === 0 ? 15 - x : x;
      if (forward >= 10 && forward <= 12 && y >= 5 && y <= 7) {
        if (kind === "turtle" && forward === 11 && y === 6) return "e";
        return "d";
      }
    } else if (
      kind === "dolphin" &&
      face === 2 &&
      x >= 7 &&
      x <= 8 &&
      y >= 7 &&
      y <= 9
    )
      return "d";
  }
  if (
    kind === "dolphin" &&
    role === "snout" &&
    (face < 2 || face === 4) &&
    y === 11 &&
    x > 2 &&
    x < 14
  )
    return "s";
  if (role === "eye" && face === 4) {
    const dx = Math.abs(x - 7.5),
      dy = Math.abs(y - 7.5);
    if (dx > 6 || dy > 6) return ".";
    if (dx + dy > 10) return "s";
    if (dx > 5 || dy > 5) return "l";
    if (x >= 6 && x <= 9 && y >= 5 && y <= 10) return "d";
    if (x === 5 && y === 4) return "E";
    return "e";
  }
  return ".";
}

/** Same face order/origin/output as paintMobSkinFace; dispatch by skin.family. */
export function paintAquaticSkinFace(skin, face) {
  validateRole(skin?.kind, skin?.role);
  if (
    !Array.isArray(skin.pixels) ||
    skin.pixels.length !== 3 ||
    !skin.pixels.every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 64
    )
  )
    throw new Error("Aquatic skin pixels must fit the bounded face size");
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  const [width, height] = mobSkinFaceSize(skin, index);
  const size = AQUATIC_SKIN_ART_SIZE;
  const art = new Uint8Array(size * size * 4);
  const importance = new Uint8Array(size * size);
  const p = colors[skin.kind];
  const seed = seedFor(skin.kind, skin.role);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const symbol = faceFeature(skin.kind, skin.role, index, x, y);
      const detail = p[featureColors[symbol]];
      const color = detail ?? bodyPixel(skin.kind, skin.role, index, x, y, p);
      const noise = detail ? 0 : grain(seed, x, y, index);
      for (let channel = 0; channel < 3; channel++)
        art[i * 4 + channel] = Math.max(
          0,
          Math.min(255, color[channel] + noise)
        );
      if (symbol === "e" || symbol === "E") {
        const glow =
          skin.kind === "drowned"
            ? 0.12
            : skin.kind === "guardian"
              ? 0.3
              : skin.kind === "elder_guardian"
                ? 0.38
                : 0;
        art[i * 4 + 3] = Math.round(glow * 255);
      }
      // A small guardian eye must retain its dark pupil inside the bright iris.
      importance[i] =
        skin.role === "eye" && symbol === "d" ? 6 : (priorities[symbol] ?? 0);
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(((x + 0.5) * size) / width),
        cy = Math.floor(((y + 0.5) * size) / height);
      let chosen = cy * size + cx;
      const x0 = width < size ? Math.floor((x * size) / width) : cx;
      const x1 = width < size ? Math.ceil(((x + 1) * size) / width) : cx + 1;
      const y0 = height < size ? Math.floor((y * size) / height) : cy;
      const y1 = height < size ? Math.ceil(((y + 1) * size) / height) : cy + 1;
      // Coverage-preserving downsampling keeps tiny side eyes from vanishing.
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const candidate = sy * size + sx;
          if (importance[candidate] > importance[chosen]) chosen = candidate;
        }
      data.set(art.subarray(chosen * 4, chosen * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
