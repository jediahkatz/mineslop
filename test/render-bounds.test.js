import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { createDistantVegetationJob } from "../src/distant-vegetation.js";
import { hasTerrainRoof, terrainFogRange } from "../src/renderer.js";
import { getWorldSpec } from "../src/world-spec.js";
import { shapeWorld } from "./shape-fixture.js";

const position = { x: 0.5, y: 350, z: 0.5 };
const settings = { radius: 0, quality: "low", budgetMs: 4, outdoors: true };

// Authored native-height/descriptor probes only, not a v4 generation claim.
function fixture(t, height, dimension = "overworld") {
  t.mock.method(performance, "now", () => 0);
  const world = {
    seed: "authored-render-bounds",
    generatorVersion: 4,
    dimension,
    epoch: 1,
    spec: getWorldSpec(4, dimension),
    generator: {
      terrainHeight: height,
      getBiome: () => ({
        id: dimension === "end" ? "the_end" : "plains",
        dimension,
        color: "#839574",
        waterColor: "#489fbb",
      }),
    },
    getCell: () => assert.fail("LOD cannot read detail"),
    ensureArea: () => assert.fail("LOD cannot request detail"),
  };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  t.after(() => lod.dispose());
  return { world, lod };
}

function complete(lod) {
  for (let frame = 0; frame < 100 && !lod.ready; frame++)
    lod.update(position, settings);
  assert.equal(lod.ready, true);
  return lod.group.getObjectByName("Distant terrain surface").geometry;
}

test("authored signed terrain heights include -1 and use the declared sea/ceiling", (t) => {
  const { lod } = fixture(t, (x) => (x < 0 ? -1 : 319));
  const geometry = complete(lod);
  const points = geometry.getAttribute("position");
  const heights = new Set(
    Array.from({ length: points.count }, (_, i) => points.getY(i))
  );
  assert.deepEqual(heights, new Set([0, 320]));
  assert.equal(geometry.boundingBox.min.y, -64);
  assert.equal(geometry.boundingBox.max.y, 320);
  assert.ok(geometry.drawRange.count > 0);
  const water = lod.group
    .getObjectByName("Distant water")
    .geometry.getAttribute("position");
  for (let i = 0; i < water.count; i++)
    assert.ok(Math.abs(water.getY(i) - 63.88) < 1e-5);
});

test("authored End void stays empty and never acquires an ocean", (t) => {
  const { world, lod } = fixture(t, () => null, "end");
  const geometry = complete(lod);
  assert.equal(world.spec.seaLevel, null);
  assert.equal(geometry.drawRange.count, 0);
  assert.equal(geometry.boundingBox.min.y, 0);
  assert.equal(geometry.boundingBox.max.y, 256);
  assert.equal(lod.group.getObjectByName("Distant water"), undefined);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 500, 0);
  camera.rotation.x = -Math.PI / 2;
  const fog = terrainFogRange(camera, undefined, 20, 100);
  assert.ok(Math.abs(fog.near) < 1e-6);
  assert.equal(fog.far, 8);
});

test("public world epochs discard LOD samples even when native generator identity is unchanged", (t) => {
  let height = -10;
  const { world, lod } = fixture(t, () => height);
  const geometry = complete(lod);
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++);
  height = 120;
  world.epoch++;
  lod.update(position, { ...settings, budgetMs: 0 });
  assert.equal(lod.ready, false);
  assert.equal(disposed, 1);
  const points = complete(lod).getAttribute("position");
  for (let i = 0; i < points.count; i++) assert.equal(points.getY(i), 121);
});

test("authored canopies clip to signed world bounds instead of the historical 96-cell ceiling", (t) => {
  t.mock.method(performance, "now", () => 0);
  const trees = [-72, 312].map((y) => ({
    type: "oak",
    parts: [
      {
        kind: "trunk",
        x: 4,
        y,
        z: 4,
        width: 1,
        height: 10,
        block: BLOCK.OAK_LOG,
      },
      { kind: "crown", x: 4, y: y + 10, z: 4, radius: 3, block: BLOCK.LEAVES },
    ],
  }));
  const job = createDistantVegetationJob(
    { getTrees: (gx, gz) => (gx === 0 && gz === 0 ? trees : []) },
    { minX: -16, maxX: 16, minZ: -16, maxZ: 16 },
    { spec: getWorldSpec(4, "overworld") }
  );
  for (let frame = 0; frame < 100 && !job.done; frame++)
    job.step({ budgetMs: 4 });
  assert.equal(job.done, true);
  const layer = job.build();
  t.after(() => layer.dispose());
  const geometry = layer.mesh.geometry;
  const points = geometry.getAttribute("position");
  const heights = Array.from({ length: points.count }, (_, i) =>
    points.getY(i)
  );
  assert.ok(points.count > 0);
  assert.equal(Math.min(...heights), -64);
  assert.equal(Math.max(...heights), 320);
  assert.equal(geometry.boundingBox.min.y, -64);
  assert.equal(geometry.boundingBox.max.y, 320);
});

test("roof queries use the exact occlusion channel throughout the signed build range", () => {
  const world = shapeWorld([[0, -10, 0, BLOCK.OAK_FENCE]]);
  assert.equal(hasTerrainRoof(world, { x: 0.5, y: -12, z: 0.5 }), true);
  assert.equal(hasTerrainRoof(world, { x: 0.1, y: -12, z: 0.1 }), false);
  world.put(0, 319, 0, BLOCK.STONE);
  assert.equal(hasTerrainRoof(world, { x: 0.1, y: 100, z: 0.1 }), true);
  assert.equal(hasTerrainRoof(world, { x: 0.5, y: 320, z: 0.5 }), false);
});
