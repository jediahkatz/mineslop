import * as THREE from "three";
import {
  mobSkinFaceRect,
  mobSkinTileSize,
  patchMobSkinShader,
} from "./mob-skin-atlas.js";
import { MOB_SKIN_FACES, mobSkinFaceSize } from "./mob-skins.js";

export const PLAYER_SKIN_ATLAS_SIZE = 128;
export const MAX_PLAYER_PARTS = 48;

function skin(role, pixels) {
  return Object.freeze({
    key: `player/${role}`,
    kind: "player",
    role,
    pixels: Object.freeze(pixels),
  });
}

// A separate, fixed catalog: creating an avatar never repacks the NPC atlas.
export const PLAYER_SKINS = Object.freeze({
  head: skin("head", [8, 8, 8]),
  coat: skin("coat", [8, 10, 5]),
  sleeve: skin("sleeve", [4, 7, 4]),
  hand: skin("hand", [4, 3, 4]),
  trousers: skin("trousers", [4, 5, 4]),
  boot: skin("boot", [4, 2, 5]),
  metal: skin("metal", [8, 8, 5]),
  wood: skin("wood", [2, 8, 2]),
  tint: skin("tint", [6, 6, 6]),
});

const palette = {
  skin: [194, 145, 105],
  skinLight: [215, 172, 126],
  skinShade: [167, 114, 85],
  hair: [62, 45, 35],
  hairLight: [92, 66, 43],
  iris: [97, 111, 70],
  ink: [43, 39, 33],
  mouth: [139, 86, 65],
  coat: [172, 91, 53],
  coatLight: [196, 122, 68],
  coatShade: [123, 64, 43],
  lining: [226, 205, 162],
  brass: [198, 158, 79],
  trousers: [57, 73, 87],
  trousersLight: [75, 91, 101],
  boot: [66, 51, 39],
  sole: [43, 38, 32],
  metal: [207, 213, 216],
  metalLight: [239, 242, 241],
  metalShade: [150, 163, 169],
  wood: [143, 103, 59],
  woodShade: [108, 76, 45],
  white: [250, 250, 246],
  whiteShade: [211, 217, 211],
};

// Original copper-jacket explorer: a side-part, olive eyes and warm human skin.
// This is neither a recolored hostile model nor a downloaded player skin.
const faceArt = [
  "hhhhhhHh",
  "hHh...hh",
  "h......h",
  ".de..ed.",
  "....s...",
  "...ss...",
  "..lmm...",
  "........",
];
const faceColors = {
  h: palette.hair,
  H: palette.hairLight,
  d: palette.ink,
  e: palette.iris,
  s: palette.skinShade,
  l: palette.skinLight,
  m: palette.mouth,
};

function skinPixel(role, face, x, y, width, height) {
  const u = (x + 0.5) / width;
  const v = (y + 0.5) / height;
  if (role === "head") {
    if (face === 4)
      return (
        faceColors[faceArt[Math.floor(v * 8)][Math.floor(u * 8)]] ??
        palette.skin
      );
    if (face === 2) return x % 4 === 1 ? palette.hairLight : palette.hair;
    if (face === 3) return palette.skinShade;
    if (face === 5) return v < 0.78 ? palette.hair : palette.skinShade;
    const forward = face === 0 ? 1 - u : u;
    if (v < 0.25 || (forward < 0.35 && v < 0.72)) return palette.hair;
    if (forward < 0.65 && v > 0.38 && v < 0.7) return palette.skinLight;
    return palette.skin;
  }
  if (role === "coat") {
    if (face === 3 || v > 0.87)
      return face === 4 && Math.abs(u - 0.5) < 0.15
        ? palette.brass
        : palette.boot;
    if (face === 2 || v < 0.13) return palette.lining;
    if (face === 4) {
      if (Math.abs(u - 0.5) < 0.08)
        return y % 3 === 0 ? palette.brass : palette.coatShade;
      if (u > 0.65 && v > 0.26 && v < 0.5)
        return v < 0.36 ? palette.coatLight : palette.coatShade;
    }
    if (x === 0 || x === width - 1) return palette.coatShade;
    return palette.coat;
  }
  if (role === "sleeve")
    return face === 3 || v > 0.84
      ? palette.lining
      : face === 2
        ? palette.coatLight
        : palette.coat;
  if (role === "hand") return face === 3 ? palette.skinShade : palette.skin;
  if (role === "trousers")
    return x === 0 || (face === 4 && y === height - 2)
      ? palette.trousersLight
      : palette.trousers;
  if (role === "boot") {
    if (face === 3 || v > 0.72) return palette.sole;
    return face === 4 && u > 0.2 && u < 0.8 ? palette.brass : palette.boot;
  }
  if (role === "metal") {
    if (face === 2 || x === 0 || y === 0) return palette.metalLight;
    if (face === 3 || x === width - 1 || y === height - 1)
      return palette.metalShade;
    return palette.metal;
  }
  if (role === "wood")
    return (x + Math.floor(y / 3)) % 3 === 0 ? palette.woodShade : palette.wood;
  return x === 0 || y === height - 1 ? palette.whiteShade : palette.white;
}

export function paintPlayerSkinFace(descriptor, face) {
  if (!descriptor || PLAYER_SKINS[descriptor.role] !== descriptor)
    throw new Error("Unknown player skin");
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  const [width, height] = mobSkinFaceSize(descriptor, index);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = skinPixel(descriptor.role, index, x, y, width, height);
      const grain = ((x * 3 + y * 5 + index * 7) % 5) - 2;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = color[channel] + grain;
      // The shared shader interprets alpha as emission, not transparency.
      data[offset + 3] = 0;
    }
  }
  return { width, height, data };
}

let catalog;
export function getPlayerSkinAtlasData() {
  if (catalog) return catalog;
  const size = PLAYER_SKIN_ATLAS_SIZE;
  const data = new Uint8Array(size * size * 4);
  const entries = new Map();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const descriptor of Object.values(PLAYER_SKINS)) {
    const [width, height] = mobSkinTileSize(descriptor);
    if (x + width > size) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (width > size || y + height > size)
      throw new Error("Player skins overflow their fixed atlas");
    entries.set(descriptor.key, {
      skin: descriptor,
      x,
      y,
      width,
      height,
      rect: [x / size, y / size, width / size, height / size],
    });
    for (let face = 0; face < 6; face++) {
      const source = paintPlayerSkinFace(descriptor, face);
      const rect = mobSkinFaceRect(descriptor, face);
      for (let dy = -1; dy <= source.height; dy++) {
        const sy = Math.max(
          0,
          Math.min(source.height - 1, source.height - 1 - dy)
        );
        for (let dx = -1; dx <= source.width; dx++) {
          const sx = Math.max(0, Math.min(source.width - 1, dx));
          const from = (sy * source.width + sx) * 4;
          const to = ((y + rect.y + dy) * size + x + rect.x + dx) * 4;
          data.set(source.data.subarray(from, from + 4), to);
        }
      }
    }
    x += width;
    rowHeight = Math.max(rowHeight, height);
  }
  catalog = { size, data, entries, usedHeight: y + rowHeight };
  return catalog;
}

export function createPlayerSkinResources() {
  const atlas = getPlayerSkinAtlasData();
  const texture = new THREE.DataTexture(
    atlas.data,
    atlas.size,
    atlas.size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.name = "Original copper-jacket player skin";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.clearGroups();
  const face = new Float32Array(24);
  for (let i = 0; i < face.length; i++) face[i] = Math.floor(i / 4);
  geometry.setAttribute("mobFace", new THREE.BufferAttribute(face, 1));
  const rects = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PLAYER_PARTS * 4),
    4
  );
  const sizes = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PLAYER_PARTS * 3),
    3
  );
  const flashes = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PLAYER_PARTS),
    1
  );
  rects.setUsage(THREE.DynamicDrawUsage);
  sizes.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("mobSkinRect", rects);
  geometry.setAttribute("mobSkinSize", sizes);
  geometry.setAttribute("mobFlash", flashes);
  const material = new THREE.MeshLambertMaterial({ map: texture });
  material.name = "Lit original player skin";
  material.onBeforeCompile = patchMobSkinShader;
  material.customProgramCacheKey = () => "voxelcraft-mob-skin-atlas-v1";
  let disposed = false;
  return {
    atlas,
    texture,
    geometry,
    material,
    rects,
    sizes,
    flashes,
    write(index, descriptor) {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_PLAYER_PARTS)
        throw new Error("Player skin instance budget exceeded");
      const entry = atlas.entries.get(descriptor.key);
      if (!entry) throw new Error("Unregistered player skin");
      rects.setXYZW(
        index,
        entry.rect[0],
        entry.rect[1],
        entry.rect[2],
        entry.rect[3]
      );
      sizes.setXYZ(
        index,
        descriptor.pixels[0],
        descriptor.pixels[1],
        descriptor.pixels[2]
      );
    },
    update() {
      rects.needsUpdate = sizes.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      texture.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
