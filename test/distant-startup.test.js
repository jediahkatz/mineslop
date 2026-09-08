import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { distantGridCells } from "../src/distant-grid.js";
import { createGenerator } from "../src/terrain.js";

const biome = { id: "plains", category: "grassland", dimension: "overworld",
  color: "#83ac52", grassColor: "#83ac52", waterColor: "#4e9cac" };
const at = new THREE.Vector3(8, 64, 8);
const options = { radius: 12, quality: "medium", outdoors: true, budgetMs: 4 };
function fixture(height) {
  // Fast-path tests use the production total-field contract. Custom unknown
  // fields below remain uncertified and must validate their interiors.
  const generator = height ? { terrainHeight: height } : createGenerator("startup", "overworld", 3);
  const world = { dimension: "overworld", generatorVersion: 3, seed: "startup",
    chunks: new Map(), generator: Object.assign(generator, { getBiome: () => biome,
      getTrees: () => [] }) };
  return new DistantTerrain(new THREE.Scene(), world);
}
function until(lod, condition, settings = options) {
  for (let i = 0; i < 1000; i++) {
    lod.update(at, settings);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    if (condition()) return;
  }
  assert.fail("bounded startup did not reach the expected state");
}

test("coarse startup grid preserves independent chunk ownership and shared edges", () => {
  const cells = [...distantGridCells(0, 0,
    { minX: -224, maxX: 240, minZ: -224, maxZ: 240 }, "medium", new Map(), true)];
  assert.equal(cells.length, 29 ** 2);
  const points = new Set();
  for (const cell of cells) {
    assert.equal(cell.boundary.length, 4);
    for (const [x, z] of cell.boundary) {
      assert.ok(x >= cell.cx * 16 && x <= (cell.cx + 1) * 16);
      assert.ok(z >= cell.cz * 16 && z <= (cell.cz + 1) * 16);
      points.add(`${x},${z}`);
    }
  }
  assert.equal(points.size, 30 ** 2);
});

test("R12 publishes real coarse ground before canopy completion, then atomically refines", (t) => {
  const lod = fixture();
  t.after(() => lod.dispose());
  const updateVegetation = lod._updateVegetation;
  lod._updateVegetation = () => {};
  until(lod, () => lod.ready);
  const first = lod._active;
  assert.equal(first.data.request.radius, 12);
  assert.equal(first.data.request.bootstrap, true);
  assert.equal(first.data.count, 900);
  assert.equal(lod.fogDistance, 192);
  assert.equal(lod.terrainCoverageComplete, true);
  assert.equal(lod._vegetation, null);
  assert.ok(first.terrain.geometry.drawRange.count > 0);
  assert.equal(lod.world.chunks.size, 0, "visual fallback never earns native readiness");
  lod.update(new THREE.Vector3(56, 64, 8), options);
  assert.equal(lod._active, first);
  assert.equal(lod.ready, true, "moving three chunks retains the actual coarse ground");
  assert.equal(lod.fogDistance, 176, "fog contracts to the old surface's real edge");
  // Refinement may complete before the canopy; the visible coarse layer stays.
  until(lod, () => lod._job?.phase === "publish");
  lod.update(at, options);
  assert.equal(lod._active, first);
  assert.equal(lod.ready, true);
  lod._updateVegetation = updateVegetation;
  until(lod, () => lod._active !== first);
  assert.equal(lod._active.data.request.bootstrap, false);
  assert.equal(first.group.parent, null);
  assert.equal(lod.ready, true);
  assert.equal(lod.fogDistance, 304, "refinement started at the moved camera, so its real west edge still caps fog");
});

test("startup does not claim missing ground and retains native cutout ownership", (t) => {
  const lod = fixture((x, z) => x === 0 && z === 0 ? NaN : 31);
  t.after(() => lod.dispose());
  until(lod, () => !!lod._active);
  assert.equal(lod.ready, false, "unknown origin cannot be hidden by distant ground");
  assert.equal(lod.fogDistance, 0);
  const coverage = new Set(lod._active.data.unknownChunks);
  lod.update(at, { ...options, coverage });
  assert.equal(lod.ready, true);
  assert.equal(lod.terrainCoverageComplete, true);
  // With every coarse chunk authoritatively native, no fallback triangles draw.
  const all = new Set(lod._active.data.cells.map((cell) => cell.key));
  lod.update(at, { ...options, coverage: all });
  assert.equal(lod._active.terrain.geometry.drawRange.count, 0);
});

test("low quality never silently shrinks R12 below its selected 192-block horizon", (t) => {
  const lod = fixture();
  t.after(() => lod.dispose());
  until(lod, () => lod.ready, { ...options, quality: "low" });
  assert.equal(lod._active.data.request.radius, 12);
  assert.equal(lod.fogDistance, 192);
});
