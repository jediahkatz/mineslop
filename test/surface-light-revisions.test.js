import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { SkyColumns } from "../src/sky-columns.js";
import { churnWorld } from "./block-light-churn-fixture.js";
import { flushColumns, settleColumns } from "./light-renderer-fixture.js";

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
