import * as THREE from "three";
import { AQUATIC_KINDS, paintAquaticSkinFace } from "./aquatic-skins.js";
import { applySceneDaylight } from "./daylight-material.js";
import {
  createMobModel,
  createProjectileModel,
  MAX_GEL_PARTS_PER_MOB,
  MAX_PARTS_PER_MOB,
} from "./mob-models.js";
import {
  MOB_SKIN_FACES,
  mobSkinFaceSize,
  paintMobSkinFace,
} from "./mob-skins.js";
import { MAX_MOBS, MAX_PROJECTILES, MOB_SPECIES } from "./mob-species.js";
import { NPC_KINDS, paintNpcSkinFace } from "./npc-skins.js";

export const MOB_SKIN_ATLAS_SIZE = 512;
export const MAX_MOB_SKINS = 512;
export const MAX_GEL_INSTANCES = MAX_MOBS * MAX_GEL_PARTS_PER_MOB;
export const MOB_GEL_OPACITY = 0.32;

/** Shared atlas dispatch; mob-skins.js remains an independent legacy painter. */
export function paintMobAtlasFace(skin, face) {
  if (skin.family === "npc") return paintNpcSkinFace(skin, face);
  return skin.family === "aquatic"
    ? paintAquaticSkinFace(skin, face)
    : paintMobSkinFace(skin, face);
}

export function mobSkinTileSize(skin) {
  const [x, y, z] = skin.pixels;
  return [2 * Math.max(x, z) + 4, 2 * y + z + 6];
}

/** Inner face rectangle, in bottom-up texture pixels; a copied gutter surrounds it. */
export function mobSkinFaceRect(skin, face) {
  const index = typeof face === "number" ? face : MOB_SKIN_FACES.indexOf(face);
  const [width, height] = mobSkinFaceSize(skin, index);
  const [, y, z] = skin.pixels;
  return {
    x: (index % 2) * (width + 2) + 1,
    y: (index < 2 ? 0 : index < 4 ? y + 2 : y + z + 4) + 1,
    width,
    height,
  };
}

export function buildMobSkinAtlasData(skins) {
  const unique = new Map(skins.map((skin) => [skin.key, skin]));
  if (unique.size > MAX_MOB_SKINS)
    throw new Error("Mob skin catalog exceeds its fixed atlas budget");
  const ordered = [...unique.values()]
    .map((skin) => {
      const [width, height] = mobSkinTileSize(skin);
      return { skin, width, height };
    })
    .sort(
      (a, b) =>
        b.height - a.height ||
        b.width - a.width ||
        (a.skin.key < b.skin.key ? -1 : a.skin.key > b.skin.key ? 1 : 0)
    );
  const size = MOB_SKIN_ATLAS_SIZE;
  const data = new Uint8Array(size * size * 4);
  const entries = new Map();
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const tile of ordered) {
    if (x + tile.width > size) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (tile.width > size || y + tile.height > size)
      throw new Error(
        `Mob skins overflow the fixed atlas (${size}x${size}): ` +
          `${tile.skin.key} needs ${tile.width}x${tile.height} at ${x},${y}`
      );
    const entry = {
      ...tile,
      x,
      y,
      rect: [x / size, y / size, tile.width / size, tile.height / size],
    };
    entries.set(tile.skin.key, entry);
    for (let face = 0; face < 6; face++) {
      const source = paintMobAtlasFace(tile.skin, face);
      const rect = mobSkinFaceRect(tile.skin, face);
      for (let dy = -1; dy <= source.height; dy++) {
        for (let dx = -1; dx <= source.width; dx++) {
          const sx = Math.max(0, Math.min(source.width - 1, dx));
          // Painters use top-left origin; DataTexture uses bottom-left.
          const sy = Math.max(
            0,
            Math.min(source.height - 1, source.height - 1 - dy)
          );
          const from = (sy * source.width + sx) * 4;
          const to = ((y + rect.y + dy) * size + x + rect.x + dx) * 4;
          data.set(source.data.subarray(from, from + 4), to);
        }
      }
    }
    x += tile.width;
    rowHeight = Math.max(rowHeight, tile.height);
  }
  return { size, data, entries, usedHeight: y + rowHeight };
}

// One immutable, lazily generated CPU catalog, independent of mob count,
// world seed, absorbed blocks, spawns, reloads, and disposed GPU textures.
let catalog;
export function getMobSkinAtlasData() {
  if (!catalog) {
    // Preload supported visuals now, even before an ecology registers them.
    // The union also prevents duplicate work when that registration arrives.
    const kinds = new Set([...Object.keys(MOB_SPECIES), ...AQUATIC_KINDS, ...NPC_KINDS]);
    const models = [...kinds].map(createMobModel);
    models.push(
      createProjectileModel("arrow"),
      createProjectileModel("fireball")
    );
    catalog = buildMobSkinAtlasData(
      models.flatMap((model) => model.parts.map((part) => part.skin))
    );
  }
  return catalog;
}

export function patchMobSkinShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
attribute float mobFace;
attribute vec4 mobSkinRect;
attribute vec3 mobSkinSize;
attribute float mobFlash;
varying float vMobFlash;
varying vec3 vMobTint;`
    )
    .replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
vec2 mobFaceSize = mobFace < 1.5 ? mobSkinSize.zy :
  (mobFace < 3.5 ? mobSkinSize.xz : mobSkinSize.xy);
vec2 mobTileSize = vec2(2.0 * max(mobSkinSize.x, mobSkinSize.z) + 4.0,
  2.0 * mobSkinSize.y + mobSkinSize.z + 6.0);
vec2 mobFaceOrigin = vec2(mod(mobFace, 2.0) * (mobFaceSize.x + 2.0) + 1.0,
  (mobFace < 1.5 ? 0.0 : mobFace < 3.5 ? mobSkinSize.y + 2.0 :
  mobSkinSize.y + mobSkinSize.z + 4.0) + 1.0);
// Full texel coverage plus duplicated gutters: no adjacent face can bleed.
vec2 mobFaceUV = mobFaceOrigin + clamp(uv, vec2(0.0001), vec2(0.9999)) * mobFaceSize;
vMapUv = mobSkinRect.xy + mobFaceUV / mobTileSize * mobSkinRect.zw;
vMobFlash = mobFlash;
#ifdef USE_INSTANCING_COLOR
  vMobTint = instanceColor;
#else
  vMobTint = vec3(1.0);
#endif`
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
varying float vMobFlash;
varying vec3 vMobTint;`
    )
    .replace(
      "#include <map_fragment>",
      `
// sRGB conversion is handled by the texture format. Alpha is emission only.
vec4 mobSkinTexel = texture2D(map, vMapUv);
diffuseColor.rgb *= mobSkinTexel.rgb;`
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vMobTint, clamp(vMobFlash, 0.0, 1.0));`
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
totalEmissiveRadiance += mix(mobSkinTexel.rgb, vMobTint, vMobFlash) * mobSkinTexel.a;`
    );
}

/** Owns the sole atlas texture and the opaque batch's fixed-size attributes. */
export function createMobSkinResources(capacity) {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_MOBS * MAX_PARTS_PER_MOB + MAX_PROJECTILES * 3
  )
    throw new Error("Invalid mob skin instance capacity");
  const atlas = getMobSkinAtlasData();
  const texture = new THREE.DataTexture(
    atlas.data,
    atlas.size,
    atlas.size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.name = "Original pixel creature skins";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return createSkinBatch(capacity, atlas, texture, false);
}

/** One optional gel batch borrows the same atlas; it never owns the texture. */
export function createMobGelResources({ atlas, texture }) {
  return createSkinBatch(MAX_GEL_INSTANCES, atlas, texture, true);
}

function createSkinBatch(capacity, atlas, texture, translucent) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.clearGroups();
  const face = new Float32Array(24);
  for (let i = 0; i < face.length; i++) face[i] = Math.floor(i / 4);
  geometry.setAttribute("mobFace", new THREE.BufferAttribute(face, 1));
  const rects = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 4),
    4
  );
  const sizes = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3
  );
  const flashes = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity),
    1
  );
  for (const [name, attribute] of [
    ["mobSkinRect", rects],
    ["mobSkinSize", sizes],
    ["mobFlash", flashes],
  ]) {
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
  }
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    transparent: translucent,
    opacity: translucent ? MOB_GEL_OPACITY : 1,
    depthWrite: !translucent,
    // Cull the back wall: a closed cube needs only its visible exterior faces,
    // not the two draw calls Three uses for double-sided transparent materials.
    side: THREE.FrontSide,
  });
  material.name = translucent
    ? "Lit translucent slime gel"
    : "Lit pixel creature skins";
  material.onBeforeCompile = patchMobSkinShader;
  material.customProgramCacheKey = () => "voxelcraft-mob-skin-atlas-v1";
  material.onBeforeRender = function (_renderer, scene) {
    applySceneDaylight(scene, this);
  };
  let disposed = false;
  return {
    atlas,
    texture,
    geometry,
    material,
    rects,
    sizes,
    flashes,
    write(index, skin, flash = 0) {
      if (!Number.isInteger(index) || index < 0 || index >= capacity)
        throw new Error("Mob skin instance budget exceeded");
      const entry = atlas.entries.get(skin.key);
      if (!entry) throw new Error(`Unregistered mob skin: ${skin.key}`);
      rects.setXYZW(
        index,
        entry.rect[0],
        entry.rect[1],
        entry.rect[2],
        entry.rect[3]
      );
      sizes.setXYZ(index, skin.pixels[0], skin.pixels[1], skin.pixels[2]);
      flashes.setX(index, flash);
    },
    update() {
      rects.needsUpdate = sizes.needsUpdate = flashes.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!translucent) texture.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
