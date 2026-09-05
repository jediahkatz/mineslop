import assert from "node:assert/strict";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { getWorldSpec } from "../src/world-spec.js";
import { authoredColumns } from "./shape-fixture.js";

export function lightWorld({ version = 3, dimension = "overworld", columns = [[0, 0]] } = {}) {
  const world = authoredColumns([]);
  world.generatorVersion = version;
  world.dimension = dimension;
  world.spec = getWorldSpec(version, dimension);
  for (const [x, z] of columns) world.admit(x, z);
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
  do {
    field.update(world, position, radius);
    const s = field.stats;
    assert.ok(s.scans <= BLOCK_LIGHT_LIMITS.scans);
    assert.ok(s.visits <= BLOCK_LIGHT_LIMITS.visits);
    assert.ok(s.uploadLayers <= BLOCK_LIGHT_LIMITS.uploads);
    assert.ok(s.uploadBytes <= 2 * field.layerBytes + field.valid.byteLength);
    maxima.scans = Math.max(maxima.scans, s.scans);
    maxima.visits = Math.max(maxima.visits, s.visits);
    maxima.uploadBytes = Math.max(maxima.uploadBytes, s.uploadBytes);
    maxima.queue = Math.max(maxima.queue, field.solver.peak ?? 0);
    assert.ok(field.texture.layerUpdates.size <= BLOCK_LIGHT_LIMITS.uploads);
    // CPU tests acknowledge the upload that WebGLTextures performs on a draw.
    field.texture.clearLayerUpdates();
    if (++updates > 10000) throw new Error(`Block light did not settle: ${field.pending}`);
  } while (field.pending);
  return { updates, maxima, resources: field.resources() };
}
