import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { CaveDaylight } from "../src/cave-daylight.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { SkyColumns, SKY_COLUMN_LIMITS } from "../src/sky-columns.js";
import { SURFACE_DAYLIGHT_LIMITS } from "../src/surface-daylight.js";
import { ENTRANCE_SURFACES, surfaceAccess, surfaceAirPoint, surfaceTunnel } from "./daylight-surface-fixture.js";
import { daylightTunnel } from "./daylight-fixture.js";
import { authoredColumns } from "./shape-fixture.js";

function setup(t, fixture = surfaceTunnel(true)) {
  const columns = new SkyColumns(), daylight = new CaveDaylight(columns);
  t.after(() => columns.dispose());
  const tick = (x = 4.5, radius = 4) => {
    columns.begin(fixture.world);
    columns.updateField(fixture.position(x), radius);
    assert.ok(columns.stats.surfaceBuilds <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds);
    assert.ok(columns.stats.surfaceCellReads <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds * 9 * 256 * SKY_COLUMN_LIMITS.height);
    assert.ok(columns.stats.surfaceVoxelVisits <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds * 2 * 48 * 48 * SKY_COLUMN_LIMITS.height);
    assert.ok(columns.stats.surfaceFloodVisits <= SURFACE_DAYLIGHT_LIMITS.chunkBuilds * 48 * 48 * SKY_COLUMN_LIMITS.height);
    assert.ok(columns.stats.surfaceStampChecks <= 169);
    return columns.surfaceLight.pending;
  };
  const settle = (x = 4.5, radius = 4) => {
    let frames = 0;
    do {
      tick(x, radius);
      frames++;
    } while (columns.surfaceLight.pending && frames <= 41);
    assert.equal(columns.surfaceLight.pending, 0);
    return frames;
  };
  return { fixture, columns, daylight, tick, settle, at: () => sampleDaylightAt(columns, surfaceAirPoint(ENTRANCE_SURFACES[0])) };
}

test("cold geometry-owned entrance lighting is identical over the full 79-block approach and look-back", (t) => {
  const fixture = surfaceTunnel(true);
  let expected;
  for (const x of [-28.5, -16.5, -0.5, 4.5, 15.5, 16.5, 32.5, 40.5, 50.5]) {
    const { columns, daylight } = setup(t, fixture);
    const state = surfaceAccess(fixture, columns, daylight, x);
    const actual = state.surfaces.map((face) => face.mask);
    expected ??= actual;
    assert.deepEqual(actual, expected, `cold observer x=${x}`);
    assert.ok(actual.every((mask) => mask.direct === 0 && mask.ambient > 0.5));
    if (x > 16) assert.equal(state.access.exposure, 0);
  }
});

test("closures and missing or replaced halo chunks clear every dependent tile before budgeted rebuilding", (t) => {
  const { fixture, columns, settle, tick, at } = setup(t);
  settle();
  const open = at();
  assert.ok(open.ambient > 0.8);
  fixture.close();
  // The mouth tile is remote from this observer and will not win this slice.
  tick(50.5);
  assert.deepEqual(at(), { direct: 0, ambient: 0 });
  settle(50.5);
  assert.deepEqual(at(), { direct: 0, ambient: 0 });
  fixture.close(false);
  settle(50.5);
  assert.deepEqual(at(), open);
  const entrance = fixture.world.chunks.get("-1,0");
  fixture.world.chunks.delete("-1,0");
  tick(50.5);
  assert.deepEqual(at(), { direct: 0, ambient: 0 });
  settle(50.5);
  assert.deepEqual(at(), { direct: 0, ambient: 0 }, "unknown cannot be an open-sky boundary");
  fixture.world.chunks.set("-1,0", { ...entrance, blocks: entrance.blocks.slice() });
  settle(50.5);
  assert.deepEqual(at(), open, "legacy replacement identity works even with reused revision/incarnation");
  fixture.world.epoch++;
  columns.begin(fixture.world);
  assert.equal(columns.surfaceLight.cache.size, 0);
  assert.ok(columns.surfaceLight.data.every((value) => value === 0));
  settle(50.5);
  assert.deepEqual(at(), open);
  fixture.world.generator = {};
  columns.begin(fixture.world);
  assert.equal(columns.surfaceLight.cache.size, 0);
  assert.ok(columns.surfaceLight.data.every((value) => value === 0));
});

test("unchanged geometry and camera torque consume no rebuilds, cell scans, or texture uploads", (t) => {
  const { fixture, columns, daylight, settle, at } = setup(t);
  fixture.world.getBiome = fixture.world.ensureArea = fixture.world.generate = () => assert.fail("surface lighting is non-generating");
  fixture.world.chunks.values = fixture.world.chunks[Symbol.iterator] = () => assert.fail("no resident-map scan");
  settle();
  const expected = at(), texture = columns.surfaceLight.texture, version = texture.version;
  const ceilingVersion = columns.texture.version, resources = columns.surfaceLight.resources();
  for (let i = 0; i < 64; i++) {
    columns.begin(fixture.world);
    columns.updateField(fixture.position(4.5), 4);
    daylight.sample(fixture.world, fixture.position(4.5), { x: Math.cos(i), y: Math.sin(i * 0.7), z: Math.sin(i) });
    assert.deepEqual(at(), expected);
    assert.equal(columns.stats.surfaceBuilds, 0);
    assert.equal(columns.stats.surfaceCellReads, 0);
    assert.equal(columns.stats.surfaceFloodVisits, 0);
    assert.equal(columns.stats.surfaceUploadBytes, 0);
    assert.equal(columns.stats.chunkBuilds, 0);
    assert.equal(columns.texture.version, ceilingVersion);
    assert.equal(texture.version, version);
  }
  assert.deepEqual(columns.surfaceLight.resources(), resources);
  assert.equal(resources.atlasBytes, 81 * 256 * 384);
  assert.equal(resources.scratchBytes, 48 * 48 * 384 * 5);
});

test("tile budgets cannot be bypassed by repeated updates and texture layers stay finite across streaming", (t) => {
  const fixture = daylightTunnel();
  const { columns, tick, settle } = setup(t, fixture);
  for (let z = -4; z <= 4; z++)
    for (let x = -4; x <= 4; x++)
      if (!fixture.world.chunks.has(`${x},${z}`)) fixture.world.admit(x, z);
  const firstPending = tick();
  assert.equal(firstPending, 79);
  const builds = columns.stats.surfaceBuilds;
  columns.updateField(fixture.position(4.5), 4);
  assert.equal(columns.stats.surfaceBuilds, builds, "begin, not a second updateField, owns the rebuild allowance");
  assert.equal(columns.surfaceLight.pending, firstPending);
  assert.ok(settle() <= 40);
  for (let x = 5; x < 22; x++) {
    fixture.world.admit(x, 0);
    settle(x * 16 + 0.5);
    const resource = columns.surfaceLight.resources();
    assert.ok(resource.cachedChunks <= SURFACE_DAYLIGHT_LIMITS.cachedChunks);
    assert.ok(resource.cacheBytes <= SURFACE_DAYLIGHT_LIMITS.cachedChunks * 256 * 384);
    assert.equal(resource.layers, 81);
    assert.equal(resource.atlasBytes, 81 * 256 * 384);
  }
});

test("negative Y, world replacement and disposal keep render-only caches separate from world data", (t) => {
  const fixture = daylightTunnel(-32);
  const { columns, settle } = setup(t, fixture);
  settle();
  const before = [...fixture.world.chunks.values()].map((chunk) => chunk.revision);
  const mask = sampleDaylightAt(columns, fixture.position(4.5));
  assert.ok(mask.ambient > 0);
  fixture.close();
  settle();
  assert.deepEqual(sampleDaylightAt(columns, fixture.position(4.5)), { direct: 0, ambient: 0 });
  const changed = [...fixture.world.chunks.values()].map((chunk) => chunk.revision);
  assert.ok(changed[0] > before[0]);
  settle();
  assert.deepEqual([...fixture.world.chunks.values()].map((chunk) => chunk.revision), changed);
  const other = authoredColumns();
  other.put(0, 5, 0, BLOCK.STONE);
  columns.begin(other);
  assert.equal(columns.surfaceLight.cache.size, 0);
  assert.ok(columns.surfaceLight.data.every((value) => value === 0));
  let disposed = 0;
  columns.surfaceLight.texture.addEventListener("dispose", () => disposed++);
  columns.dispose();
  assert.equal(disposed, 1);
});
