import assert from "node:assert/strict";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { getWorldSpec } from "../src/world-spec.js";
import { authoredColumns } from "./shape-fixture.js";
import { lightRenderer } from "./light-renderer-fixture.js";

export function lightWorld({ version = 3, dimension = "overworld", columns = [[0, 0]], exactColumns = false } = {}) {
  const world = authoredColumns([]);
  world.generatorVersion = version;
  world.dimension = dimension;
  world.spec = getWorldSpec(version, dimension);
  const admitted = new Set();
  for (const [x, z] of columns)
    for (let dz = exactColumns ? 0 : -2; dz <= (exactColumns ? 0 : 2); dz++)
      for (let dx = exactColumns ? 0 : -2; dx <= (exactColumns ? 0 : 2); dx++) {
        const key = `${x + dx},${z + dz}`;
        if (!admitted.has(key)) { world.admit(x + dx, z + dz); admitted.add(key); }
      }
  return world;
}

export function lightField(t) {
  t.mock.method(performance, "now", () => 0);
  const field = new BlockLightField();
  t.after(() => field.dispose());
  return field;
}

export function settleLight(field, world, position = { x: 8, y: 8, z: 8 }, radius = 0) {
  const maxima = { scans: 0, visits: 0, uploadBytes: 0, queue: 0 };
  let updates = 0;
  const renderer = lightRenderer();
  do {
    field.update(world, position, radius);
    const s = field.stats;
    assert.ok(s.scans <= BLOCK_LIGHT_LIMITS.scans);
    assert.ok(s.visits <= BLOCK_LIGHT_LIMITS.visits);
    assert.ok(s.uploadLayers <= BLOCK_LIGHT_LIMITS.uploads);
    const upload = field.store.flush(renderer);
    assert.ok(upload.uploadedBytes <= 131072);
    maxima.scans = Math.max(maxima.scans, s.scans);
    maxima.visits = Math.max(maxima.visits, s.visits);
    maxima.uploadBytes = Math.max(maxima.uploadBytes, s.uploadBytes);
    maxima.queue = Math.max(maxima.queue, field.solver.peak ?? 0);
    if (++updates > 10000) throw new Error(`Block light did not settle: ${field.pending}`);
  } while (field.pending || field.store.queue.size);
  return { updates, maxima, resources: field.resources() };
}
