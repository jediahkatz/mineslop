import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { lightField, lightWorld, settleLight } from "./block-light-fixture.js";

const point = (x = 8, y = 8, z = 8) => ({ x, y, z });

test("static field finds every source, including the thirteenth hidden mesh emitter", (t) => {
  const world = lightWorld(), field = lightField(t);
  for (let y = 0; y < 12; y++) world.put(0, y, 0, BLOCK.TORCH);
  world.put(15, 8, 15, BLOCK.TORCH);
  world.renderedGroups = new Map(); // Deliberately absent/hidden mesh ownership.
  const report = settleLight(field, world);
  assert.equal(field.topology.get("0,0,0").emitters, 13);
  assert.ok(field.sample(point(15, 8, 14))[0] > 0.5);
  assert.ok(report.maxima.scans <= 8192);
  assert.ok(report.maxima.queue <= 48 ** 3);
  world.put(15, 8, 15, BLOCK.AIR);
  field.update(world, point(), 0);
  assert.deepEqual(field.sample(point(15, 8, 14)), [0, 0, 0], "removal invalidates immediately");
  settleLight(field, world);
  assert.deepEqual(field.sample(point(15, 8, 14)), [0, 0, 0], "distant other sources cannot replace it");
});

test("fixed visible receivers survive observer and ring boundaries without a new cutoff", (t) => {
  const columns = [];
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 1; z++) columns.push([x, z]);
  const world = lightWorld({ columns }), field = lightField(t);
  world.put(13, 8, 8, BLOCK.TORCH);
  settleLight(field, world, point(8), 1);
  const receiver = point(15.98), expected = field.sample(receiver);
  assert.ok(expected[0] > 0.5);
  const page = field.cache.get("1,0,0");
  for (const x of [15.99, 16.01, 31.99, 32.01, 33]) {
    field.update(world, point(x), 1);
    assert.deepEqual(field.sample(receiver), expected, `visible boundary face at observer ${x}`);
    assert.equal(field.cache.get("1,0,0"), page, "unchanged overlapping page must not rebuild");
  }
  settleLight(field, world, point(33), 1);
  assert.deepEqual(field.sample(receiver), expected);
  field.update(world, point(64), 1);
  assert.deepEqual(field.sample(point(65)), [0, 0, 0], "ring reuse cannot expose the old torch");
  settleLight(field, world, point(64), 1);
  assert.deepEqual(field.sample(point(65)), [0, 0, 0]);
});

test("opaque closure, partial occluders, glass, fluid attenuation and reopening", (t) => {
  const world = lightWorld(), field = lightField(t);
  for (let x = 0; x < 16; x++)
    for (let y = 7; y <= 9; y++)
      for (let z = 7; z <= 9; z++)
        if (x === 0 || x === 15 || y !== 8 || z !== 8) world.put(x, y, z, BLOCK.STONE);
  world.put(4, 8, 8, BLOCK.TORCH);
  settleLight(field, world);
  const receiver = point(10), open = field.sample(receiver);
  assert.ok(open[0] > 0);
  for (const [id, state] of [[BLOCK.STONE, 0], [BLOCK.OAK_SLAB, BLOCK_STATE.TOP]]) {
    world.put(7, 8, 8, id, state);
    settleLight(field, world);
    assert.deepEqual(field.sample(receiver), [0, 0, 0], "opaque partial cells conservatively close the channel");
  }
  world.put(7, 8, 8, BLOCK.GLASS);
  settleLight(field, world);
  assert.deepEqual(field.sample(receiver), open);
  world.put(7, 8, 8, BLOCK.WATER, 0, FLUID.WATER_3);
  settleLight(field, world);
  assert.ok(field.sample(receiver)[0] > 0 && field.sample(receiver)[0] < open[0]);
  world.put(7, 8, 8, BLOCK.LAVA);
  settleLight(field, world);
  assert.ok(field.sample(receiver)[0] > open[0]);
  world.put(7, 8, 8, BLOCK.AIR);
  settleLight(field, world);
  assert.deepEqual(field.sample(receiver), open);
});

test("missing source columns, admission, replacement and negative coordinates", (t) => {
  const world = lightWorld({ columns: [[-1, -1]] }), field = lightField(t);
  const observer = point(-8, 8, -8), receiver = point(-1, 8, -8);
  settleLight(field, world, observer);
  assert.deepEqual(field.sample(receiver), [0, 0, 0]);
  world.admit(0, -1);
  world.put(0, 8, -8, BLOCK.TORCH);
  settleLight(field, world, observer);
  assert.ok(field.sample(receiver)[0] > 0.5);
  world.admit(0, -1); // Same coordinates/revisions; distinct incarnation.
  settleLight(field, world, observer);
  assert.deepEqual(field.sample(receiver), [0, 0, 0]);
  world.put(0, 8, -8, BLOCK.TORCH);
  settleLight(field, world, observer);
  world.chunks.delete("0,-1");
  field.update(world, observer, 0);
  assert.deepEqual(field.sample(receiver), [0, 0, 0]);
});

for (const version of [3, 4, 6])
  for (const dimension of ["overworld", "nether", "end"])
    test(`complete height and bounded storage for v${version} ${dimension}`, (t) => {
      const world = lightWorld({ version, dimension }), field = lightField(t);
      for (const y of [world.spec.minY + 1, world.spec.maxY - 2]) world.put(8, y, 8, BLOCK.TORCH);
      const report = settleLight(field, world, point(8, world.spec.minY + 2));
      for (const y of [world.spec.minY + 1, world.spec.maxY - 2])
        assert.ok(field.sample(point(9, y))[0] > 0.5);
      assert.equal(report.resources.atlasBytes, (world.spec.maxY - world.spec.minY) * 400 * 4);
      assert.ok(report.resources.topologySections <= (world.spec.maxY - world.spec.minY) / 16);
      assert.ok(report.maxima.visits <= 32768);
    });

test("far section changes retain existing light; epoch/reload/disposal cannot retain it", (t) => {
  const world = lightWorld({ version: 4 }), field = lightField(t);
  world.put(8, 0, 8, BLOCK.TORCH);
  settleLight(field, world, point(8, 0));
  const expected = field.sample(point(9, 0)), page = field.cache.get("0,0,0");
  world.put(8, 200, 8, BLOCK.STONE);
  field.update(world, point(8, 0), 0);
  assert.equal(field.cache.get("0,0,0"), page);
  assert.deepEqual(field.sample(point(9, 0)), expected);
  const fresh = lightWorld({ version: 4 });
  field.update(fresh, point(8, 0), 0);
  assert.deepEqual(field.sample(point(9, 0)), [0, 0, 0]);
  settleLight(field, fresh, point(8, 0));
  fresh.put(8, 0, 8, BLOCK.TORCH);
  settleLight(field, fresh, point(8, 0));
  fresh.epoch++;
  field.update(fresh, point(8, 0), 0);
  assert.deepEqual(field.sample(point(9, 0)), [0, 0, 0]);
  field.dispose();
  assert.equal(field.resources().cachedSections, 0);
  assert.deepEqual(field.sample(point(9, 0)), [0, 0, 0]);
});

test("revision changes cancel partially scanned/flooded jobs before publication", (t) => {
  const world = lightWorld({ columns: [[0, 0], [1, 0]] }), field = lightField(t);
  world.put(8, 8, 8, BLOCK.TORCH);
  field.update(world, point(), 0);
  assert.ok(field.job);
  world.put(8, 8, 8, BLOCK.AIR);
  settleLight(field, world);
  assert.deepEqual(field.sample(point(9)), [0, 0, 0]);
  world.put(8, 8, 8, BLOCK.TORCH);
  t.mock.method(performance, "now", () => field.solver.phase === "flood" ? 100 : 0);
  for (let i = 0; i < 100 && field.solver.phase !== "flood"; i++) field.update(world, point(), 0);
  assert.equal(field.solver.phase, "flood");
  t.mock.method(performance, "now", () => 0);
  world.put(8, 8, 8, BLOCK.AIR);
  settleLight(field, world);
  assert.deepEqual(field.sample(point(9)), [0, 0, 0]);
});
