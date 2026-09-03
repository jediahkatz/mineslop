import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { sampleFluid } from "../src/fluid-sampling.js";
import { travelLandingValid } from "../src/game-travel-stage.js";
import { findSafeLanding } from "../src/world-interactions.js";
import {
  changeCell,
  emptyFixtureGenerator,
  fixtureWorld,
} from "./world-foundation-fixtures.js";

const destination = Object.freeze({ x: 8, y: 21, z: 8 });
const firstLanding = Object.freeze({ x: 8.5, y: 21.01, z: 8.5 });

// Authored cells in real World chunks; no replacement geometry or safety verdicts.
function cellWorld(t, entries, options = {}) {
  const world = fixtureWorld(t, { generatorVersion: 4, ...options }).generate(1);
  put(world, entries);
  return world;
}

function put(world, entries) {
  const changes = entries.map(([x, y, z, value]) =>
    changeCell(
      world, x, y, z,
      normalizeCell(typeof value === "number" ? { id: value } : value)
    )
  );
  assert.equal(world.applyCells(changes), true);
}

const select = (world, at = destination, options = {}) =>
  findSafeLanding(world, at, {
    ...options,
    allowPlatform: false,
    validateLanding: (candidate) => travelLandingValid(world, candidate),
  });

for (const id of [BLOCK.KELP, BLOCK.SEAGRASS]) {
  test(`landing validation skips waterlogged non-WATER block ${id} for a later dry column`, (t) => {
    const world = cellWorld(t, [
      [8, 20, 8, BLOCK.STONE],
      [8, 21, 8, { id, fluid: FLUID.WATER_SOURCE }],
      [8, 22, 8, { id, fluid: FLUID.WATER_SOURCE }],
      [9, 20, 8, BLOCK.STONE],
    ]);
    const before = world.serialize();
    assert.notEqual(id, BLOCK.WATER);
    assert.equal(world.isSolid(8, 21, 8), false);
    assert.deepEqual(world.getCell(8, 21, 8), {
      id, state: 0, fluid: FLUID.WATER_SOURCE,
    });
    const fluid = sampleFluid(world, firstLanding);
    assert.equal(fluid.waterImmersion, 1);
    assert.equal(fluid.eyeFluid, FLUID.WATER_SOURCE);
    assert.equal(travelLandingValid(world, firstLanding), false);
    assert.deepEqual(
      findSafeLanding(world, destination, { allowPlatform: false }),
      firstLanding,
      "callers that omit validation retain their existing coarse selection"
    );
    const landing = select(world);
    assert.deepEqual(landing, { x: 9.5, y: 21.01, z: 8.5 });
    assert.equal(travelLandingValid(world, landing), true);
    assert.deepEqual(world.serialize(), before, "search is read-only");
  });
}

for (const id of [BLOCK.OAK_SLAB, BLOCK.OAK_FENCE, BLOCK.MAGMA_BLOCK]) {
  test(`landing validation skips shape/unsafe support ${id} for a lower safe candidate in the same column`, (t) => {
    const world = cellWorld(t, [
      [8, 30, 8, id],
      [8, 20, 8, BLOCK.STONE],
    ]);
    const at = { ...destination, y: 46 };
    const before = world.serialize();
    const coarse = findSafeLanding(world, at, { allowPlatform: false });
    assert.deepEqual(coarse, { x: 8.5, y: 31.01, z: 8.5 });
    assert.equal(travelLandingValid(world, coarse), false);
    const landing = select(world, at);
    assert.deepEqual(landing, firstLanding);
    assert.equal(travelLandingValid(world, landing), true);
    assert.deepEqual(world.serialize(), before);
  });
}

test("cave preference also continues after a wet candidate without choosing the surface", (t) => {
  const world = cellWorld(t, [
    [8, 20, 8, BLOCK.STONE],
    [8, 21, 8, BLOCK.KELP],
    [8, 22, 8, BLOCK.KELP],
    [8, 50, 8, BLOCK.STONE],
    [9, 20, 8, BLOCK.STONE],
  ], {
    generatorFactory: (...args) => ({
      ...emptyFixtureGenerator(...args),
      getBiome: (_x, _z, y) => y < 30
        ? { id: "lush_caves", category: "cave" }
        : { id: "forest", category: "forest" },
    }),
  });
  assert.deepEqual(
    findSafeLanding(world, destination, {
      allowPlatform: false, preferUnderground: true,
    }),
    firstLanding
  );
  const before = world.serialize();
  const landing = select(world, destination, { preferUnderground: true });
  assert.deepEqual(landing, { x: 9.5, y: 21.01, z: 8.5 });
  assert.equal(travelLandingValid(world, landing), true);
  assert.deepEqual(world.serialize(), before);
});

test("an obstructed creative ocean candidate does not suppress a later safe natural landing", (t) => {
  const world = cellWorld(t, [
    [8, 20, 8, BLOCK.STONE],
    [8, 63, 8, BLOCK.WATER],
    [8, 66, 8, BLOCK.OAK_FENCE],
  ]);
  const before = world.serialize();
  const coarse = findSafeLanding(world, destination, {
    allowFlying: true, allowPlatform: false,
  });
  assert.deepEqual(coarse, { x: 8.5, y: 67, z: 8.5, flying: true });
  assert.equal(travelLandingValid(world, coarse), false);
  assert.deepEqual(select(world, destination, { allowFlying: true }), firstLanding);
  assert.deepEqual(world.serialize(), before);
});

test("the final creative fallback also passes canonical collision/fluid validation", (t) => {
  const world = cellWorld(t, [
    [8, 68, 8, BLOCK.LAVA],
    [8, 69, 8, BLOCK.LAVA],
  ]);
  const before = world.serialize();
  const coarse = findSafeLanding(world, destination, {
    allowFlying: true, allowPlatform: false,
  });
  assert.deepEqual(coarse, { x: 8.5, y: 68, z: 8.5, flying: true });
  assert.equal(travelLandingValid(world, coarse), false);
  assert.equal(select(world, destination, { allowFlying: true }), null);
  assert.deepEqual(world.serialize(), before);
});

test("rejecting every in-range candidate keeps the inclusive radius-12 bound and never writes", (t) => {
  const world = cellWorld(t, [
    [8, 20, 8, BLOCK.STONE],
    [8, 21, 8, BLOCK.KELP],
    [8, 22, 8, BLOCK.KELP],
    [21, 20, 8, BLOCK.STONE],
  ]);
  const before = world.serialize(), chunks = new Map(world.chunks);
  assert.equal(travelLandingValid(world, { x: 21.5, y: 21.01, z: 8.5 }), true);
  assert.equal(select(world), null, "a safe column at radius 13 is not searched");
  assert.deepEqual(world.serialize(), before);
  assert.deepEqual(world.chunks, chunks);
  assert.equal(world._requests.size, 0);
  put(world, [[20, 20, 8, BLOCK.STONE]]);
  assert.deepEqual(select(world), { x: 20.5, y: 21.01, z: 8.5 });
});

test("unavailable terrain cannot become an air landing or an implicit load", (t) => {
  const world = fixtureWorld(t, { generatorVersion: 4 });
  const at = { x: 64, y: 40, z: 64 };
  const before = world.serialize(), chunks = new Map(world.chunks);
  assert.equal(world.isLoaded(at.x, at.z), false);
  assert.equal(world.get(at.x, at.y, at.z), BLOCK.AIR);
  assert.equal(world.getCell(at.x, at.y, at.z), null);
  assert.equal(select(world, at), null);
  assert.equal(select(world, at, { allowFlying: true }), null);
  assert.deepEqual(world.serialize(), before);
  assert.deepEqual(world.chunks, chunks);
  assert.equal(world._requests.size, 0);
});
