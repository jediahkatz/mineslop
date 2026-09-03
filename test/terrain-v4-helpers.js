import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { defaultFluidFor } from "../src/block-state.js";

export function v4Digest(chunk) {
  const digest = createHash("sha256");
  const bytes = (plane) =>
    Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
  digest.update(bytes(chunk.blocks)).update(bytes(chunk.biomes));
  const sections =
    chunk.sections instanceof Map
      ? chunk.sections.values()
      : (chunk.sections ?? []);
  for (const { sy, states, fluids } of sections) {
    digest.update(`${sy}:`);
    if (states) digest.update(bytes(states));
    if (fluids) digest.update(bytes(fluids));
  }
  digest.update(
    JSON.stringify({
      minY: chunk.minY,
      maxY: chunk.maxY,
      structures: chunk.structures ?? [],
    })
  );
  return digest.digest("hex");
}

export function chunkCell(chunk, x, y, z) {
  const lx = x - chunk.cx * 16;
  const lz = z - chunk.cz * 16;
  if (
    ![x, y, z].every(Number.isSafeInteger) ||
    lx < 0 ||
    lx >= 16 ||
    lz < 0 ||
    lz >= 16 ||
    y < chunk.minY ||
    y >= chunk.maxY
  )
    return null;
  const at = (y - chunk.minY) * 256 + lz * 16 + lx;
  const sy = Math.floor(y / 16);
  const local = (y - sy * 16) * 256 + lz * 16 + lx;
  const section =
    chunk.sections instanceof Map
      ? chunk.sections.get(sy)
      : chunk.sections?.find((entry) => entry.sy === sy);
  const id = chunk.blocks[at];
  return {
    id,
    state: section?.states?.[local] ?? 0,
    fluid: section?.fluids?.[local] ?? defaultFluidFor(id),
  };
}

// Real field probes. These helpers never inject a flat/fabricated generator.
export function* naturalColumns(generator, { radius = 6144, step = 128 } = {}) {
  for (let z = -radius; z <= radius; z += step)
    for (let x = -radius; x <= radius; x += step)
      yield generator.sampleColumn(x, z);
}

export function findNaturalColumn(generator, predicate, label, options) {
  for (const col of naturalColumns(generator, options))
    if (col && predicate(col)) return col;
  assert.fail(`No real ${label} column found in the bounded test scan`);
}

export function findMarineFeature(generator, kind) {
  for (const col of naturalColumns(generator)) {
    if (kind === "reef" ? col.id !== "warm_ocean" : !col.frozen) continue;
    const gx = Math.floor(col.x / 32);
    const gz = Math.floor(col.z / 32);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const feature of generator.getMarineFeatures(gx + dx, gz + dz))
          if (
            feature.kind === kind &&
            (kind !== "reef" || feature.colonies.length === 5)
          )
            return feature;
  }
  assert.fail(`No real ${kind} found in the bounded test scan`);
}

export function forEachRegionCell(region, visit) {
  const layer = region.width * region.depth;
  for (let y = region.minY; y < region.maxY; y++)
    for (let z = 0; z < region.depth; z++)
      for (let x = 0; x < region.width; x++)
        visit(
          region.blocks[(y - region.minY) * layer + z * region.width + x],
          region.minX + x,
          y,
          region.minZ + z
        );
}
