import assert from "node:assert/strict";
import test from "node:test";
import { World } from "../src/world.js";
import { checkStagingGeneration } from "./terrain-v7-staging-generation.js";

const state = (saved, count = saved ? 0 : 9, version = 7) => ({
  generatorVersion: version,
  generator: { counters: count === null ? undefined : { chunkGenerations: count } },
  _nextRequestId: saved ? 49 : 40, _requests: new Map(), _inFlight: new Map(),
});

test("exact spawn allowance accepts 9 new-world chunks and zero saved-pose chunks", () => {
  assert.deepEqual(checkStagingGeneration(state(false), false),
    { spawnChunks: 9, mainThreadChunks: 9, queuedChunks: 40 });
  assert.deepEqual(checkStagingGeneration(state(true), true),
    { spawnChunks: 0, mainThreadChunks: 0, queuedChunks: 49 });
});

test("one unexpected fallback fails even while the worker remains live", () => {
  for (const saved of [false, true]) {
    const world = state(saved, saved ? 1 : 10);
    world._worker = {}; world._workerDisabled = false;
    assert.throws(() => checkStagingGeneration(world, saved), /no silent staging fallback/);
  }
  for (const count of [0, 8, 40, 49])
    assert.throws(() => checkStagingGeneration(state(false, count), false), /no silent staging fallback/);
});

test("saved versions 4 through 7 never inherit the new-world allowance", () => {
  for (const version of [4, 5, 6, 7]) {
    assert.doesNotThrow(() => checkStagingGeneration(state(true, 0, version), true));
    assert.throws(() => checkStagingGeneration(state(true, 9, version), true), /no silent staging fallback/);
    assert.throws(() => checkStagingGeneration(state(true, null, version), true), /counters required/);
  }
});

test("legacy counters remain optional but completed request cardinality is exact", () => {
  for (const saved of [false, true]) {
    for (const version of [1, 2, 3])
      assert.doesNotThrow(() => checkStagingGeneration(state(saved, null, version), saved));
    const extra = state(saved); extra._nextRequestId++;
    assert.throws(() => checkStagingGeneration(extra, saved), /remaining staging chunks/);
    for (const key of ["_requests", "_inFlight"]) {
      const pending = state(saved); pending[key].set(1, {});
      assert.throws(() => checkStagingGeneration(pending, saved), /requests completed/);
    }
  }
});

test("immutable production World.getSpawn generates exactly the v7 radius-one footprint", () => {
  const world = new World("cedar-valley", { generatorVersion: 7 });
  try {
    assert.equal(world.generator.counters.chunkGenerations, 0);
    const spawn = world.getSpawn();
    assert.deepEqual(spawn, { x: -5.5, y: 117.01, z: -15.5 });
    assert.equal(world.generator.counters.chunkGenerations, 9);
    assert.equal(world.generator.counters.regionGenerations, 2);
    assert.equal(world.generator.counters.spawnCandidates, 1);
    assert.equal(world.chunks.size, 9);
    assert.deepEqual([...world.chunks.keys()].sort(),
      ["-2,-2", "-2,-1", "-2,0", "-1,-2", "-1,-1", "-1,0", "0,-2", "0,-1", "0,0"].sort());
    assert.equal(world._nextRequestId, 0);
    assert.equal(world._worker, null);
    assert.equal(world._workerDisabled, false);
  } finally { world.dispose(); }
});
