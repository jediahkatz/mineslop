import * as THREE from "three";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "./blocks.js";

export const MESH_BATCHES = Object.freeze([
  "opaque",
  "foliage",
  "berryFoliage",
  "water",
  "glass",
  "emissive",
]);
export const MESH_EMITTER_LIMIT = 12;
export const emptyBatches = () =>
  Object.fromEntries(MESH_BATCHES.map((name) => [name, null]));
export const blockBatch = [];
export const opaqueBlock = new Uint8Array(65536);
export const leafBlock = new Uint8Array(65536);
export const opaqueCube = new Uint8Array(65536);

// Catalog position is not an ID. In particular, the first expansion block is
// 1024, not the element immediately following the historical 0..104 entries.
for (const block of BLOCK_CATALOG) {
  let category = "opaque";
  if (block.id === BLOCK.GLOW_BERRIES) category = "berryFoliage";
  else if (block.emissive) category = "emissive";
  else if (block.id === BLOCK.WATER) category = "water";
  else if (
    block.shape === "cross" ||
    block.shape === "ladder" ||
    block.texture === "leaves" ||
    block.cutout
  )
    category = "foliage";
  else if (block.texture === "glass") category = "glass";
  blockBatch[block.id] = category;
  opaqueBlock[block.id] = Number(
    !!block.id && !block.transparent && category !== "glass"
  );
  opaqueCube[block.id] = Number(
    !!opaqueBlock[block.id] && block.shape === "cube"
  );
  leafBlock[block.id] = Number(
    block.texture === "leaves" && block.shape !== "cross"
  );
}

const UNTINTED_LEAVES = new Set([
  BLOCK.CHERRY_LEAVES,
  BLOCK.PALE_LEAVES,
  BLOCK.CRIMSON_LEAVES,
  BLOCK.WARPED_LEAVES,
]);
const GRASS_PLANTS = new Set([
  BLOCK.TALL_GRASS,
  BLOCK.FERN,
  BLOCK.SEAGRASS,
  BLOCK.LILY_PAD,
  BLOCK.KELP,
]);
const WHITE = Object.freeze([1, 1, 1]);

export function getBiomeTint(id, face, biome) {
  const block = BLOCKS[id];
  if (!biome || !block) return WHITE;
  let color;
  let strength = 1;
  if ((id === BLOCK.GRASS && face === "top") || GRASS_PLANTS.has(id))
    color = biome.grassColor;
  else if (leafBlock[id] && !UNTINTED_LEAVES.has(id)) {
    color = biome.foliageColor;
    strength = 0.4;
  } else if (id === BLOCK.WATER) color = biome.waterColor;
  if (!color) return WHITE;
  const base = new THREE.Color(block.color);
  const tint = base.clone().lerp(new THREE.Color(color), strength);
  return ["r", "g", "b"].map(
    (channel) => tint[channel] / Math.max(base[channel], 0.015)
  );
}

export function selectEmitters(sources, limit = MESH_EMITTER_LIMIT) {
  const result = [];
  for (const emitter of sources) {
    if (result.length < limit) result.push(emitter);
    else if (emitter.id === BLOCK.TORCH) {
      const ambient = result.findIndex((source) => source.id !== BLOCK.TORCH);
      if (ambient !== -1) result[ambient] = emitter;
    }
  }
  return result;
}

export function geometryBytes(geometry) {
  if (!geometry) return 0;
  return (
    Object.values(geometry.attributes).reduce(
      (sum, attribute) => sum + attribute.array.byteLength,
      0
    ) + (geometry.index?.array.byteLength ?? 0)
  );
}

export function disposeBatches(batches) {
  for (const geometry of Object.values(batches ?? {})) geometry?.dispose();
}
