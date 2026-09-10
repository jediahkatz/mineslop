import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { World } from "../../src/world.js";
import { chunkMeshCounts, streamingWithinBudget } from "./mesh-budget.js";

for (const radius of [2, 3, 4, 12]) {
  test(`radius ${radius}: cold real World requests include the complete source/shape halo`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const world = new World("realtime-cold-demand", { generatorVersion: 3 });
    t.after(() => world.dispose());
    t.mock.method(world.generator, "generateChunk", () => assert.fail("no generation in this scheduler check"));
    world.updateStreaming({ x: 8, z: 8 }, radius);
    const expected = (2 * (radius + 2) + 1) ** 2;
    assert.equal(world._requests.size, expected);
    assert.equal(world._pins.size, 0);
    const maxima = {
      cachedChunks: world.chunks.size,
      requestedChunks: world._requests.size,
      inFlightChunks: world._inFlight.size,
      retainedChunkMeshes: 0, visibleChunkMeshes: 0, drawnChunkMeshes: 0,
    };
    assert.equal(streamingWithinBudget(maxima, radius), true);
    assert.equal(streamingWithinBudget({ ...maxima, requestedChunks: expected + 1 }, radius), false);
    assert.equal(streamingWithinBudget({ ...maxima, cachedChunks: expected + 1 }, radius), false);
    assert.equal(streamingWithinBudget({ ...maxima, inFlightChunks: 3 }, radius), false);
  });

  test(`radius ${radius}: hidden retention is bounded independently of visible draws`, () => {
    const scene = new THREE.Scene();
    const chunks = new Map();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial();
    for (let z = -radius - 1; z <= radius + 1; z++)
      for (let x = -radius - 1; x <= radius + 1; x++) {
        const group = new THREE.Group();
        group.visible = Math.max(Math.abs(x), Math.abs(z)) <= radius;
        group.add(new THREE.Mesh(geometry, material));
        scene.add(group);
        chunks.set(`${x},${z}`, group);
      }
    try {
      const maxima = {
        cachedChunks: (2 * (radius + 2) + 1) ** 2,
        requestedChunks: (2 * (radius + 2) + 1) ** 2,
        inFlightChunks: 2,
        ...chunkMeshCounts({ scene, chunks }),
      };
      assert.equal(maxima.retainedChunkMeshes, (2 * (radius + 1) + 1) ** 2);
      assert.equal(maxima.visibleChunkMeshes, (2 * radius + 1) ** 2);
      assert.equal(maxima.drawnChunkMeshes, maxima.visibleChunkMeshes);
      assert.equal(streamingWithinBudget(maxima, radius), true);
      for (const patch of [
        { cachedChunks: maxima.cachedChunks + 1 },
        { requestedChunks: maxima.requestedChunks + 1 },
        { inFlightChunks: 3 },
        { retainedChunkMeshes: maxima.retainedChunkMeshes + 1 },
        { visibleChunkMeshes: maxima.visibleChunkMeshes + 1 },
        { drawnChunkMeshes: maxima.visibleChunkMeshes + 1 },
        { drawnChunkMeshes: undefined },
      ])
        assert.equal(
          streamingWithinBudget({ ...maxima, ...patch }, radius),
          false
        );
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });
}

test("invalid radii cannot create an unbounded or coerced streaming allowance", () => {
  const maxima = {
    cachedChunks: 0, requestedChunks: 0, inFlightChunks: 0,
    retainedChunkMeshes: 0, visibleChunkMeshes: 0, drawnChunkMeshes: 0,
  };
  for (const radius of [-1, 13, Infinity, NaN, 2.5, "3", null, undefined])
    assert.equal(streamingWithinBudget(maxima, radius), false);
});

test("hidden, detached, empty and disabled meshes do not masquerade as drawn chunks", () => {
  const scene = new THREE.Scene();
  const chunks = new Map();
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial();
  for (let i = 0; i < 5; i++) {
    const group = new THREE.Group();
    if (i !== 4) group.add(new THREE.Mesh(geometry, material));
    if (i !== 2) scene.add(group);
    if (i === 1) group.visible = false;
    if (i === 3) group.children[0].visible = false;
    chunks.set(String(i), group);
  }
  try {
    assert.deepEqual(chunkMeshCounts({ scene, chunks }), {
      retainedChunkMeshes: 5,
      visibleChunkMeshes: 3,
      drawnChunkMeshes: 1,
    });
    geometry.setDrawRange(0, 0);
    assert.equal(chunkMeshCounts({ scene, chunks }).drawnChunkMeshes, 0);
    geometry.setDrawRange(0, Infinity);
    material.visible = false;
    assert.equal(chunkMeshCounts({ scene, chunks }).drawnChunkMeshes, 0);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
