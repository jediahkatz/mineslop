import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { WeatherExposure, WEATHER_MUTATION_LIMIT } from "../src/weather-exposure.js";
import { World } from "../src/world.js";

async function fixture(t) {
  const world = new World("weather-mutation-safety", {
    generatorVersion: 4, useWorker: false,
  });
  t.after(() => world.dispose());
  await world.ensureArea({ x: 8, z: 8 }, 0);
  const exposure = new WeatherExposure();
  let reads = 0, lastEvent, accepted;
  const getCell = world.getCell.bind(world);
  world.getCell = (...args) => { reads++; return getCell(...args); };
  world.onMutation = (event) => {
    lastEvent = event;
    assert.equal(event.revision, world._editRevision);
    const before = reads;
    accepted = exposure.onMutation(world, event);
    assert.equal(reads, before, "notifications cannot scan terrain");
  };
  const roof = (x = 8, z = 8) => {
    exposure.beginFrame(world);
    const result = exposure.roof(x, z);
    assert.equal(result.known, true);
    return result;
  };
  return { world, exposure, roof, get event() { return lastEvent; },
    get accepted() { return accepted; } };
}

test("current publications retain unrelated scans but invalidate changed roofs", async (t) => {
  const f = await fixture(t);
  const original = f.roof();
  const entry = f.exposure.cache.get("8,8");
  const high = f.world.maxY - 2;
  assert.equal(f.world.set(15, high, 15, BLOCK.GLASS), true);
  assert.equal(f.accepted, true);
  assert.equal(Object.isFrozen(f.event), true);
  assert.equal(f.exposure.cache.get("8,8"), entry);
  assert.deepEqual(f.roof(), original);
  assert.equal(f.exposure.reads, 0);
  assert.equal(f.world.set(8, high, 8, BLOCK.GLASS), true);
  assert.equal(f.roof().y, high);
  assert.equal(f.exposure.reads, 1);
  assert.equal(f.world.set(8, high - 1, 8, BLOCK.WATER), true);
  assert.equal(f.roof().y, high);
  assert.equal(f.exposure.reads, 0, "a change beneath a known roof is irrelevant");
  const before = f.world.getCell(8, high - 1, 8);
  assert.equal(f.world.applyCells([{
    x: 8, y: high - 1, z: 8, before,
    after: { id: BLOCK.WATER, state: 0, fluid: FLUID.WATER_1 },
  }]), true);
  assert.equal(f.roof().y, high);
  assert.equal(f.exposure.reads, 0);
  assert.equal(f.world.set(8, high, 8, BLOCK.AIR), true);
  assert.equal(f.roof().y, high - 1);
});

test("replaying an old event cannot conceal a missed real roof mutation", async (t) => {
  const f = await fixture(t);
  f.roof();
  const high = f.world.maxY - 2;
  assert.equal(f.world.set(15, high, 15, BLOCK.GLASS), true);
  const old = f.event;
  f.world.onMutation = undefined;
  assert.equal(f.world.set(8, high, 8, BLOCK.GLASS), true);
  assert.equal(f.exposure.onMutation(f.world, old), false);
  assert.equal(f.roof().y, high);
  assert.ok(f.exposure.reads > 0, "missed publication requires a fresh scan");
  assert.equal(f.exposure.onMutation(f.world, old), false);
  assert.equal(f.roof().y, high);
});

test("a later current event cannot carry a cache across missing chunk revisions", async (t) => {
  const f = await fixture(t);
  f.roof();
  const original = f.exposure.cache.get("8,8");
  const hook = f.world.onMutation;
  const high = f.world.maxY - 2;
  f.world.onMutation = undefined;
  assert.equal(f.world.set(8, high, 8, BLOCK.GLASS), true);
  f.world.onMutation = hook;
  assert.equal(f.world.set(15, high, 15, BLOCK.GLASS), true);
  assert.equal(f.exposure.cache.has("8,8"), false);
  assert.equal(f.roof().y, high);
  assert.notEqual(f.exposure.cache.get("8,8"), original);
});

test("large publications use bounded invalidation and conservative resampling", async (t) => {
  const f = await fixture(t);
  f.roof();
  const high = f.world.maxY - 2;
  const changes = [];
  for (let y = high - 2; y <= high; y++)
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++)
      changes.push({ x, y, z, before: f.world.getCell(x, y, z), after: { id: BLOCK.GLASS } });
  assert.ok(changes.length > WEATHER_MUTATION_LIMIT);
  assert.equal(f.world.applyCells(changes), true);
  assert.equal(f.accepted, false);
  assert.equal(f.roof().y, high);
  assert.ok(f.exposure.reads > 0);
});
