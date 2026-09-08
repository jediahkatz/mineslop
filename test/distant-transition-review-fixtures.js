import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";

export const REVIEW_POSITION = Object.freeze({ x: 8, z: 8 });
export const REVIEW_OPTIONS = Object.freeze({
  radius: 12, quality: "medium", outdoors: true, budgetMs: 4,
});
export const REVIEW_BIOME = Object.freeze({
  id: "plains", category: "grassland", dimension: "overworld",
  grassColor: "#83ac52", waterColor: "#4e9cac",
});

// A control for sampling density, not a reconstruction of the parent revision.
// All geometry, cutouts and publication still use the actual implementation.
export function forceReviewRefinement(lod) {
  const request = lod._request;
  lod._request = function (position, radius, quality, dimension, coverage) {
    return request.call(this, position, radius, quality, dimension, coverage, false);
  };
}

export function syntheticReviewTerrain(height, { refined = false, scene = new THREE.Scene() } = {}) {
  const world = {
    dimension: "overworld", generatorVersion: 3, seed: "transition-review",
    chunks: new Map(),
    generator: { terrainHeight: height, getBiome: () => REVIEW_BIOME },
  };
  const lod = new DistantTerrain(scene, world);
  if (refined) forceReviewRefinement(lod);
  return lod;
}

export function publishReviewSurface(lod, options = REVIEW_OPTIONS, position = REVIEW_POSITION) {
  for (let frame = 0; frame < 2400 && !lod._active; frame++) lod.update(position, options);
  if (!lod._active) throw new Error("Review fixture did not publish a terrain surface");
  return lod._active;
}

// Count backing buffers once, including unused typed capacity, not just views.
// This is a terrain-only lower bound: JS maps/cells, canopies, the mask and GPU
// allocations are deliberately NOT represented as a full renderer budget.
export function reviewTerrainBacking(lod) {
  const buffers = new Set();
  const retain = (value) => {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  };
  const data = (value) => {
    if (!value) return;
    Object.values(value).forEach(retain);
    Object.values(value.terraces ?? {}).forEach(retain);
    Object.values(value.terraceBuilder ?? {}).forEach(retain);
  };
  data(lod._active?.data);
  data(lod._job);
  lod._active?.group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    retain(mesh.geometry.index?.array);
    Object.values(mesh.geometry.attributes).forEach((attribute) => retain(attribute.array));
  });
  return [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
}

export function reviewPendingBacking(lod) {
  return reviewTerrainBacking({ _job: lod._job });
}
