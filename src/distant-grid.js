import { CHUNK_SIZE } from "./terrain.js";
import { pillarFootprint } from "./distant-landmarks.js";

// Detail chunks keep their own radius. These are visual-only sample densities;
// even the outermost cell fits inside one independently owned detail chunk.
export const DISTANT_QUALITY = Object.freeze({
  low: Object.freeze({ horizon: 160, nearRadius: 3, middleRadius: 6 }),
  medium: Object.freeze({ horizon: 320, nearRadius: 4, middleRadius: 9 }),
  high: Object.freeze({ horizon: 448, nearRadius: 5, middleRadius: 12 }),
});

export const DISTANT_GRID_LIMITS = Object.freeze({
  chunkSpan: 61,
  vertices: 8192,
  cells: 8192,
  indices: 65536,
});
export const DISTANT_NATIVE_GRID_LIMITS = Object.freeze({
  vertices: 16384, cells: 16384, indices: 131072,
});

// Native pillar foundations must not be buried by a coarse neighboring anchor.
// A two-chunk halo preserves 2:1 steps even for an isolated far-away footprint.
export function* landmarkGridRefinement(pillars) {
  const chunks = new Set();
  for (const pillar of pillars)
    for (const [dx, dz] of pillarFootprint(pillar)) {
      const cx = Math.floor((pillar.x + dx) / CHUNK_SIZE);
      const cz = Math.floor((pillar.z + dz) / CHUNK_SIZE);
      const key = `${cx},${cz}`;
      if (chunks.has(key)) continue;
      chunks.add(key);
      if (chunks.size > 40) throw new RangeError("Native landmark refinement exceeds its chunk bound");
      for (let z = -2; z <= 2; z++)
        for (let x = -2; x <= 2; x++)
          yield { key: `${cx + x},${cz + z}`, step: 2 << Math.max(Math.abs(x), Math.abs(z)) };
    }
}

// Yields one cell at a time so topology construction shares the sampling frame
// budget. Chunk-aligned bounds and 2:1 transitions make every shared edge exact:
// a coarse edge includes the fine neighbor's midpoint, not a T-junction/skirt.
export function* distantGridCells(cx, cz, bounds, quality = "medium", refinement = new Map()) {
  if (
    !Number.isSafeInteger(cx) ||
    !Number.isSafeInteger(cz) ||
    !bounds ||
    !["minX", "maxX", "minZ", "maxZ"].every(
      (key) =>
        Number.isSafeInteger(bounds[key]) && bounds[key] % CHUNK_SIZE === 0
    ) ||
    bounds.minX >= bounds.maxX ||
    bounds.minZ >= bounds.maxZ ||
    bounds.maxX - bounds.minX > DISTANT_GRID_LIMITS.chunkSpan * CHUNK_SIZE ||
    bounds.maxZ - bounds.minZ > DISTANT_GRID_LIMITS.chunkSpan * CHUNK_SIZE
  )
    throw new RangeError("Distant grids require bounded, chunk-aligned views");
  const settings = Object.hasOwn(DISTANT_QUALITY, quality)
    ? DISTANT_QUALITY[quality]
    : DISTANT_QUALITY.medium;
  const minCX = Math.floor(bounds.minX / CHUNK_SIZE);
  const maxCX = Math.ceil(bounds.maxX / CHUNK_SIZE);
  const minCZ = Math.floor(bounds.minZ / CHUNK_SIZE);
  const maxCZ = Math.ceil(bounds.maxZ / CHUNK_SIZE);
  const desiredStep = (x, z) => {
    const distance = Math.max(Math.abs(x - cx), Math.abs(z - cz));
    const base = distance <= settings.nearRadius
      ? 4
      : distance <= settings.middleRadius
        ? 8
        : CHUNK_SIZE;
    return Math.min(base, refinement.get(`${x},${z}`) ?? base);
  };
  const stepAt = refinement.size === 0 ? desiredStep : (x, z) => Math.min(
    desiredStep(x, z),
    desiredStep(x - 1, z) * 2, desiredStep(x + 1, z) * 2,
    desiredStep(x, z - 1) * 2, desiredStep(x, z + 1) * 2
  );
  for (let z = minCZ; z < maxCZ; z++) {
    for (let x = minCX; x < maxCX; x++) {
      const step = stepAt(x, z);
      const left = Math.max(bounds.minX, x * CHUNK_SIZE);
      const right = Math.min(bounds.maxX, (x + 1) * CHUNK_SIZE);
      const back = Math.max(bounds.minZ, z * CHUNK_SIZE);
      const front = Math.min(bounds.maxZ, (z + 1) * CHUNK_SIZE);
      for (let z0 = back; z0 < front; z0 += step) {
        for (let x0 = left; x0 < right; x0 += step) {
          const x1 = Math.min(right, x0 + step);
          const z1 = Math.min(front, z0 + step);
          const mx = (x0 + x1) / 2;
          const mz = (z0 + z1) / 2;
          // Clockwise in X/Z, counterclockwise when viewed from above.
          const boundary = [[x0, z0]];
          if (x0 === left && x > minCX && stepAt(x - 1, z) < step)
            boundary.push([x0, mz]);
          boundary.push([x0, z1]);
          if (z1 === front && z + 1 < maxCZ && stepAt(x, z + 1) < step)
            boundary.push([mx, z1]);
          boundary.push([x1, z1]);
          if (x1 === right && x + 1 < maxCX && stepAt(x + 1, z) < step)
            boundary.push([x1, mz]);
          boundary.push([x1, z0]);
          if (z0 === back && z > minCZ && stepAt(x, z - 1) < step)
            boundary.push([mx, z0]);
          yield {
            cx: x,
            cz: z,
            boundary,
            center: boundary.length > 4 ? [mx, mz] : null,
          };
        }
      }
    }
  }
}
