import assert from "node:assert/strict";
import test from "node:test";
import { resolveShape } from "../src/block-shapes.js";
import { BLOCK_STATE, normalizeCell } from "../src/block-state.js";
import { BLOCK_LIGHT_MUTATION_CELLS } from "../src/block-light-mutations.js";
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { SkyColumns } from "../src/sky-columns.js";
import { SurfaceLightRevisions } from "../src/surface-light-revisions.js";
import { churnWorld } from "./block-light-churn-fixture.js";
import { flushColumns, settleColumns } from "./light-renderer-fixture.js";
import { rendererLightWorld } from "./renderer-block-light-fixture.js";

test("current native fluid/log-axis transactions retain verified sky and daylight without scans", (t) => {
  t.mock.method(performance, "now", () => 0);
  const fixture = churnWorld(3, true, "overworld", 3), columns = new SkyColumns(0);
  t.after(() => { columns.dispose(); fixture.dispose(); });
  fixture.observe((world, event) => columns.observeMutation(world, event));
  settleColumns(columns, fixture.world, fixture.position, 0);
  const cached = columns.surfaceLight.cache.get("0,0"), mapping = columns.surfaceLight.store.mapping.slice();
  assert.ok(cached.certified);
  for (let i = 0; i < 40; i++) {
    fixture.mutate(i);
    columns.begin(fixture.world);
    columns.updateField(fixture.position, 0);
    const transfer = flushColumns(columns);
    assert.equal(columns.surfaceLight.cache.get("0,0"), cached);
    assert.deepEqual(columns.surfaceLight.store.mapping, mapping);
    assert.equal(columns.stats.cellReads + columns.stats.surfaceCellReads + columns.stats.surfaceVoxelVisits, 0);
    assert.equal(transfer.uploadedBytes, 0);
  }
  fixture.world.set(8, 9, 2, BLOCK.STONE);
  columns.begin(fixture.world); columns.updateField(fixture.position, 0);
  assert.equal(columns.surfaceLight.store.pages.size, 0, "unsafe closure invalidates before rebuilding");
});

test("missed unsafe native mutations and replayed events cannot bless old surface topology", (t) => {
  t.mock.method(performance, "now", () => 0);
  const fixture = churnWorld(3, true, "overworld", 3), columns = new SkyColumns(0);
  t.after(() => { columns.dispose(); fixture.dispose(); });
  fixture.observe((world, event) => columns.observeMutation(world, event));
  settleColumns(columns, fixture.world, fixture.position, 0);
  fixture.mutate(1);
  const old = fixture.lastEvent();
  fixture.observe(undefined);
  fixture.world.set(8, 9, 2, BLOCK.STONE);
  columns.observeMutation(fixture.world, old);
  fixture.observe((world, event) => columns.observeMutation(world, event));
  fixture.mutate(2);
  columns.begin(fixture.world); columns.updateField(fixture.position, 0);
  assert.equal(columns.surfaceLight.store.pages.size, 0);
});

test("bamboo and air have identical empty occlusion/support, including connected neighbors", () => {
  const air = normalizeCell({ id: BLOCK.AIR }), bamboo = normalizeCell({ id: BLOCK.BAMBOO });
  for (const channel of ["occlusion", "support", "collision"])
    assert.deepEqual(resolveShape(bamboo)[channel], resolveShape(air)[channel]);
  for (const [id, states] of [
    [BLOCK.OAK_STAIRS, [0, 1, 2, 3, BLOCK_STATE.TOP]],
    [BLOCK.OAK_FENCE, [0]],
    [BLOCK.OAK_DOOR, [0, 1, 2, 3, BLOCK_STATE.PART, BLOCK_STATE.OPEN]],
    [BLOCK.LADDER, [0, 1, 2, 3]],
  ])
    for (const state of states) {
      assert.ok(Number.isSafeInteger(id));
      const cell = normalizeCell({ id, state });
      const withBamboo = resolveShape(cell, () => bamboo);
      const withAir = resolveShape(cell, () => air);
      assert.deepEqual(withBamboo.occlusion, withAir.occlusion, `${id}:${state} occlusion`);
      assert.deepEqual(withBamboo.support, withAir.support, `${id}:${state} support`);
    }
});

test("current bamboo edits preserve certified roofed daylight without scans or uploads", (t) => {
  t.mock.method(performance, "now", () => 0);
  const fixture = churnWorld(3, false, "overworld", 3), columns = new SkyColumns(0);
  t.after(() => { columns.dispose(); fixture.dispose(); });
  assert.equal(fixture.world.set(8, 9, 2, BLOCK.BAMBOO), true);
  fixture.observe((world, event) => columns.observeMutation(world, event));
  settleColumns(columns, fixture.world, fixture.position, 0);
  const cached = columns.surfaceLight.cache.get("0,0");
  const mapping = columns.surfaceLight.store.mapping.slice();
  const point = { x: 8.5, y: 8.02, z: 2.5 }, light = sampleDaylightAt(columns, point);
  assert.ok(cached.certified);
  assert.equal(light.direct, 0, "a bamboo edit does not brighten a roofed receiver");
  for (let i = 0; i < 8; i++) {
    assert.equal(fixture.world.set(8, 9, 2, i % 2 ? BLOCK.BAMBOO : BLOCK.AIR), true);
    columns.begin(fixture.world); columns.updateField(fixture.position, 0);
    const transfer = flushColumns(columns);
    assert.ok(columns.surfaceLight.cache.get("0,0") === cached, "the certified roofed tile is retained");
    assert.deepEqual(columns.surfaceLight.store.mapping, mapping);
    assert.deepEqual(sampleDaylightAt(columns, point), light);
    assert.equal(columns.stats.cellReads + columns.stats.surfaceCellReads + columns.stats.surfaceVoxelVisits, 0);
    assert.equal(transfer.uploadedBytes, 0);
  }
});

for (const missed of [false, true]) {
  test(`bamboo removal cannot certify a ${missed ? "missed" : "same-transaction"} roof closure`, (t) => {
    t.mock.method(performance, "now", () => 0);
    const fixture = churnWorld(3, false, "overworld", 3), columns = new SkyColumns(0);
    t.after(() => { columns.dispose(); fixture.dispose(); });
    assert.equal(fixture.world.set(8, 9, 2, BLOCK.BAMBOO), true);
    fixture.observe((world, event) => columns.observeMutation(world, event));
    settleColumns(columns, fixture.world, fixture.position, 0);
    const before = columns.chunkStamp(0, 0);
    const changes = [
      { x: 8, y: 9, z: 2, before: fixture.world.getCell(8, 9, 2), after: normalizeCell({ id: BLOCK.AIR }) },
      { x: 8, y: 10, z: 2, before: fixture.world.getCell(8, 10, 2), after: normalizeCell({ id: BLOCK.STONE }) },
    ];
    if (missed) {
      fixture.observe(undefined);
      assert.equal(fixture.world.applyCells([changes[1]]), true);
      fixture.observe((world, event) => columns.observeMutation(world, event));
      assert.equal(fixture.world.applyCells([changes[0]]), true);
    } else assert.equal(fixture.world.applyCells(changes), true);
    columns.begin(fixture.world); columns.updateField(fixture.position, 0);
    assert.notEqual(columns.chunkStamp(0, 0), before);
    assert.equal(columns.surfaceLight.store.pages.size, 0, "unsafe data is invalid before publication");
  });
}

test("a cold incomplete column stays unknown across a current bamboo harvest transaction", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = rendererLightWorld(t, [[8, 8, 8, BLOCK.BAMBOO]], { x: 8, y: 9, z: 8 });
  const columns = new SkyColumns(0), position = { x: 8.5, y: 9.62, z: 8.5 };
  t.after(() => columns.dispose());
  world.onMutation = (event) => columns.observeMutation(world, event);
  settleColumns(columns, world, position, 0);
  assert.equal(columns.cache.get("0,0").complete, false, "missing native shape halo");
  assert.deepEqual(sampleDaylightAt(columns, position), { direct: 0, ambient: 0 });
  assert.equal(world.set(8, 8, 8, BLOCK.AIR), true);
  columns.begin(world); columns.updateField(position, 0); flushColumns(columns);
  assert.deepEqual(sampleDaylightAt(columns, position), { direct: 0, ambient: 0 });
});

test("bamboo proofs respect the existing cumulative native mutation-cell bound", (t) => {
  const fixture = churnWorld(3, false, "overworld", 3), revisions = new SurfaceLightRevisions();
  t.after(() => fixture.dispose());
  const world = fixture.world;
  revisions.begin(world);
  fixture.observe((source, event) => revisions.observe(source, event));
  const before = revisions.token(world, 0, 0);
  const changes = Array.from({ length: BLOCK_LIGHT_MUTATION_CELLS + 1 }, (_, i) => {
    const x = i % 16, z = Math.floor(i / 16) % 16, y = 13 + Math.floor(i / 256);
    return { x, y, z, before: world.getCell(x, y, z), after: normalizeCell({ id: BLOCK.BAMBOO }) };
  });
  assert.equal(world.applyCells(changes.slice(0, 512)), true);
  assert.equal(world.applyCells(changes.slice(512, 1024)), true);
  assert.equal(revisions.cells, BLOCK_LIGHT_MUTATION_CELLS);
  assert.equal(revisions.token(world, 0, 0), before, "only proved consecutive transactions retain a stamp");
  assert.equal(world.applyCells(changes.slice(1024)), true);
  assert.notEqual(revisions.token(world, 0, 0), before, "the first over-budget cell fails closed");
});
