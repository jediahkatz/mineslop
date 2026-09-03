import { MOB_SKIN_FACES, MOB_TEXELS_PER_BLOCK, mobSkinFaceSize } from "./mob-skins.js";

export const NPC_KINDS = Object.freeze(["villager", "blaze"]);
export const NPC_SKIN_ROLES = Object.freeze({
  villager: Object.freeze(["head", "nose", "robe", "apron", "sleeve", "hand", "boot", "cap"]),
  blaze: Object.freeze(["head", "core", "rod", "ember"]),
});
const palettes = Object.freeze({
  villager: Object.freeze({
    head: "#b89072", nose: "#a97b5b", robe: "#76654c", apron: "#b3a27d",
    sleeve: "#76654c", hand: "#b89072", boot: "#493f33", cap: "#65533d",
    shade: "#715040", light: "#d1b395", ink: "#302f28", eye: "#64896a",
  }),
  blaze: Object.freeze({
    head: "#d7a13f", core: "#795532", rod: "#d99a32", ember: "#f1cc65",
    shade: "#92602e", light: "#edc968", ink: "#523f2b", eye: "#fff0a6",
  }),
});
const rgb = (hex) => {
  const number = Number.parseInt(hex.slice(1), 16);
  return [number >> 16, (number >> 8) & 255, number & 255];
};
const colors = Object.fromEntries(Object.entries(palettes).map(([kind, palette]) => [
  kind, Object.fromEntries(Object.entries(palette).map(([name, hex]) => [name, rgb(hex)])),
]));

function validRole(kind, role) {
  if (!Object.hasOwn(NPC_SKIN_ROLES, kind) || !NPC_SKIN_ROLES[kind].includes(role))
    throw new RangeError("Unknown NPC skin role");
}

/** Bounded original CPU descriptors. Parent adds family="npc" to its ONE atlas
 * painter/catalog dispatch; this factory never allocates GPU resources.
 * Profession is deliberately not a palette dimension: claims/trade UI own it.
 */
export function createNpcSkin(kind, role, size) {
  validRole(kind, role);
  if (!Array.isArray(size) || size.length !== 3 ||
    !size.every((n) => Number.isFinite(n) && n > 0 && n <= 4))
    throw new RangeError("NPC skin dimensions must fit bounded cuboids");
  const pixels = size.map((n) => Math.max(1, Math.round(n * MOB_TEXELS_PER_BLOCK)));
  return Object.freeze({
    family: "npc", key: `npc/${kind}/${role}/${pixels.join("x")}`,
    kind, role, pixels: Object.freeze(pixels), baseColor: palettes[kind][role],
    tintable: false, translucent: false,
  });
}

function pixel(kind, role, face, x, y, palette) {
  let color = palette[role], emission = 0;
  if (kind === "villager") {
    if (["robe", "sleeve", "apron"].includes(role)) {
      if ((x + (Math.floor(y / 4) % 2)) % 7 === 0) color = palette.shade;
      if (y === 13 || y === 14) color = palette.boot;
      if (role === "apron" && (x < 2 || x > 13)) color = palette.robe;
    }
    if (role === "cap" && (y > 10 || (face === 2 && (x + y) % 5 === 0)))
      color = palette.robe;
    if (role === "head" && face === 4) {
      if (y === 5 && x >= 2 && x <= 13) color = palette.ink;
      if (y >= 7 && y <= 8 && ((x >= 3 && x <= 5) || (x >= 10 && x <= 12)))
        color = x === 4 || x === 11 ? palette.eye : palette.light;
      if (y === 12 && x >= 5 && x <= 10) color = palette.shade;
    }
    if (role === "head" && face === 5 && y < 6) color = palette.cap;
    if (role === "nose" && (face === 3 || y > 12)) color = palette.shade;
  } else {
    emission = role === "ember" ? 0.8 : role === "rod" ? 0.28 : 0.12;
    if (role === "rod") {
      if (y % 5 === 0) color = palette.shade;
      if (x === 3 || x === 12) color = palette.light;
    }
    if (role === "core" && (x + y) % 5 < 2) color = palette.ink;
    if (role === "head" && face === 4) {
      const eye = (x >= 2 && x <= 5) || (x >= 10 && x <= 13);
      if (eye && y >= 5 && y <= 7) { color = palette.eye; emission = 0.95; }
      if (eye && y === 4) { color = palette.ink; emission = 0; }
      if (y >= 11 && y <= 12 && x >= 4 && x <= 11) { color = palette.ink; emission = 0; }
    }
    if (role === "head" && (face === 2 || y === 0)) color = palette.light;
  }
  return { color, emission };
}

/** Same face order and RGBA meaning as paintMobSkinFace (alpha = emission,
 * never transparency). Authored pixel pattern; no downloaded game assets.
 */
export function paintNpcSkinFace(skin, face) {
  validRole(skin?.kind, skin?.role);
  if (!Array.isArray(skin.pixels) || skin.pixels.length !== 3 ||
    !skin.pixels.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 64))
    throw new RangeError("NPC skin pixels exceed face budget");
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  const [width, height] = mobSkinFaceSize(skin, index);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = Math.floor((x + 0.5) * 16 / width);
      const py = Math.floor((y + 0.5) * 16 / height);
      const { color, emission } = pixel(skin.kind, skin.role, index, px, py, colors[skin.kind]);
      const noise = ((px * 13 + py * 7 + index * 3) % 5) - 2;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.max(0, Math.min(255, color[channel] + noise));
      data[offset + 3] = Math.round(emission * 255);
    }
  return { width, height, data };
}
