import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { SkyColumns, SKY_COLUMN_LIMITS } from "../src/sky-columns.js";
import { SURFACE_DAYLIGHT_LIMITS } from "../src/surface-daylight.js";
import { ENTRANCE_SURFACES, surfaceAirPoint, surfaceTunnel } from "./daylight-surface-fixture.js";

function setup(t, radius = 3) {
  const f = surfaceTunnel(true), columns = new SkyColumns();
  const point = surfaceAirPoint(ENTRANCE_SURFACES[0]), samples = [];
  t.after(() => columns.dispose());
  for (let z = -radius; z <= radius; z++)
    for (let x = 3 - radius; x <= 3 + radius; x++)
      if (!f.world.chunks.has(`${x},${z}`)) f.world.admit(x, z);
  f.world.chunks.values = f.world.chunks[Symbol.iterator] = () => assert.fail("No resident-map scan");
  const tick = () => {
    const start = performance.now();
    columns.begin(f.world);
    columns.updateField(f.position(50.5), radius);
    const stats = columns.stats, light = columns.surfaceLight;
    assert.ok(stats.surfaceBuilds <= 2);
    assert.ok(stats.surfaceTopologyBuilds <= 18);
    assert.ok(stats.surfaceCellReads <= 18 * 256 * SKY_COLUMN_LIMITS.height);
    assert.ok(stats.surfaceMaskReads <= 2 * 9 * 256 * SKY_COLUMN_LIMITS.height);
    assert.ok(stats.surfaceTopologyComparisons <= 18 * (256 * SKY_COLUMN_LIMITS.height / 32 + 256));
    assert.ok(stats.surfaceStampChecks <= 169);
    assert.ok(stats.surfaceDependencyChecks <= (121 + 81 + 81) * 9);
    assert.ok(stats.surfaceQueueComparisons <= 4096);
    assert.ok(light.waiting.size <= 81);
    assert.ok(light.topology.waiting.size <= 121);
    assert.ok(light.topology.cache.size <= SURFACE_DAYLIGHT_LIMITS.topologyChunks);
    const sample = { milliseconds: performance.now() - start, ambient: sampleDaylightAt(columns, point).ambient,
      pending: light.pending, work: { ...stats } };
    samples.push(sample);
    return sample;
  };
  const settle = () => {
    for (let i = 0; i < 41; i++) if (!tick().pending) return;
    assert.fail("Cold/warm source and tile queues must settle within the original 41-frame bound");
  };
  return { f, columns, tick, settle, samples };
}

test("AIR/water and fluid-level changes retain surface daylight without rebuilds or uploads", (t) => {
  const { f, columns, tick, settle, samples } = setup(t);
  settle();
  const before = tick(), light = columns.surfaceLight, version = light.texture.version;
  const begin = samples.length;
  for (let i = 0; i < 36; i++) {
    if (i % 6 === 0) f.world.put(20, 20, 12, BLOCK.WATER, 0, i % 12 ? FLUID.WATER_2 : FLUID.WATER_1);
    const result = tick();
    assert.equal(result.ambient, before.ambient);
    assert.equal(result.work.surfaceBuilds, 0);
    assert.equal(result.work.surfaceUploadBytes, 0);
    assert.equal(light.texture.version, version);
  }
  f.world.put(20, 20, 12, BLOCK.AIR);
  assert.equal(tick().ambient, before.ambient);
  f.close();
  assert.equal(tick().ambient, 0, "Filtering fluid noise must not retain light through an opaque closure");
  settle();
  assert.equal(tick().ambient, 0);
  f.close(false);
  settle();
  assert.equal(tick().ambient, before.ambient);
  const fluidFrames = samples.slice(begin, begin + 36), peak = {};
  const times = fluidFrames.map((frame) => frame.milliseconds).sort((a, b) => a - b);
  for (const frame of fluidFrames) for (const [key, value] of Object.entries(frame.work))
    peak[key] = Math.max(peak[key] ?? 0, value);
  t.diagnostic(JSON.stringify({ baseline: before.ambient, darkFrames: fluidFrames.filter((frame) => !frame.ambient).length,
    frames: fluidFrames.length, p50Ms: times[18], p95Ms: times[34], peak, resources: light.resources() }));
});

test("older entrance tiles make progress despite continuously changing nearer opaque topology", (t) => {
  const { f, columns, tick } = setup(t);
  let firstLit = -1;
  for (let frame = 0; frame < 60; frame++) {
    f.world.put(50, 20, 12, frame % 2 ? BLOCK.AIR : BLOCK.DIRT);
    const result = tick();
    if (firstLit < 0 && result.ambient > 0) firstLit = frame;
  }
  assert.ok(firstLit >= 0 && firstLit < 41, `Entrance starved at frame ${firstLit}`);
  const before = columns.stats.surfaceTopologyBuilds;
  columns.updateField(f.position(50.5), 3);
  assert.equal(columns.stats.surfaceTopologyBuilds, before, "A second update cannot acquire a fresh topology budget");
  t.diagnostic(JSON.stringify({ firstLit, resources: columns.surfaceLight.resources() }));
});

test("exact blocked bits distinguish equal ceilings and revalidate shape-neighbor revisions", (t) => {
  const { f, columns, tick, settle } = setup(t);
  settle();
  f.world.put(1, 9, 2, BLOCK.DIRT);
  tick();
  const first = columns.surfaceLight.topology.cache.get("0,0");
  f.world.put(1, 9, 2, BLOCK.AIR);
  f.world.put(2, 9, 2, BLOCK.DIRT);
  tick();
  const moved = columns.surfaceLight.topology.cache.get("0,0");
  assert.deepEqual(moved.heights, first.heights);
  assert.notDeepEqual(moved.blocked, first.blocked);
  assert.notEqual(moved.serial, first.serial, "No hash-only or ceiling-only equality");
  f.world.put(15, 20, 2, BLOCK.OAK_STAIRS, BLOCK_STATE.TOP);
  tick();
  const shape = columns.surfaceLight.topology.cache.get("0,0");
  f.world.put(16, 20, 2, BLOCK.OAK_STAIRS, 1);
  tick();
  const connected = columns.surfaceLight.topology.cache.get("0,0");
  assert.notEqual(connected.stamp, shape.stamp);
  assert.ok(columns.stats.surfaceShapeReads > 0, "The neighbor-dependent shape must be resolved again");
  const original = f.world.chunks.get("0,0");
  f.world.chunks.set("0,0", { ...original, blocks: original.blocks.slice() });
  tick();
  assert.notEqual(columns.surfaceLight.topology.cache.get("0,0").serial, connected.serial,
    "Equal content with reused revision/incarnation still has a new identity");
});

test("over-budget topology verification clears closures immediately and remains bounded under a large edit burst", (t) => {
  const { f, columns, tick, settle } = setup(t, 4);
  for (let z = -5; z <= 5; z++)
    for (let x = -2; x <= 8; x++)
      if (!f.world.chunks.has(`${x},${z}`)) f.world.admit(x, z);
  settle();
  assert.ok(tick().ambient > 0.8);
  f.close();
  for (let z = -5; z <= 5; z++)
    for (let x = -2; x <= 8; x++) f.world.put(x * 16 + 8, 20, z * 16 + 8, BLOCK.DIRT);
  const first = tick();
  assert.ok(columns.surfaceLight.topology.waiting.size > 0);
  assert.equal(first.ambient, 0, "Unverified closures are not allowed to borrow the previous light");
  const builds = columns.stats.surfaceTopologyBuilds;
  columns.updateField(f.position(50.5), 4);
  assert.equal(columns.stats.surfaceTopologyBuilds, builds);
  settle();
  assert.equal(tick().ambient, 0);
  assert.ok(columns.surfaceLight.resources().topologyBytes <= 169 * (256 * 384 / 8 + 256 * 4));
  columns.begin({ ...f.world, epoch: f.world.epoch + 1 });
  assert.equal(columns.surfaceLight.topology.cache.size, 0);
  assert.equal(columns.surfaceLight.topology.waiting.size, 0);
  assert.ok(columns.surfaceLight.data.every((value) => value === 0));
});

test("complete oldest-tile input groups progress even when all 121 sources change every frame", (t) => {
  const { f, columns, tick } = setup(t, 4);
  for (let z = -5; z <= 5; z++)
    for (let x = -2; x <= 8; x++)
      if (!f.world.chunks.has(`${x},${z}`)) f.world.admit(x, z);
  const seen = new Set(), build = columns.surfaceLight.build.bind(columns.surfaceLight);
  columns.surfaceLight.build = (x, z) => {
    seen.add(`${x},${z}`);
    return build(x, z);
  };
  for (let frame = 0; frame < 41; frame++) {
    for (let z = -5; z <= 5; z++)
      for (let x = -2; x <= 8; x++)
        f.world.put(x * 16 + 8, 20, z * 16 + 8, frame % 2 ? BLOCK.AIR : BLOCK.DIRT);
    tick();
  }
  assert.equal(seen.size, 81, "Independent source verification used to build only two tiles after 100 frames");
  assert.ok(seen.has("0,0"));
  t.diagnostic(JSON.stringify({ changingSources: 121, frames: 41, uniqueTilesBuilt: seen.size,
    work: columns.stats, resources: columns.surfaceLight.resources() }));
});
