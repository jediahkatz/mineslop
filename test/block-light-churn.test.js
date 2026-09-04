import assert from "node:assert/strict";
import test from "node:test";
import { BlockLightField } from "../src/block-light-field.js";
import { BLOCK_LIGHT_MUTATION_CELLS, benignBlockLightChange } from "../src/block-light-mutations.js";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { GameRenderer } from "../src/renderer.js";
import { churnWorld } from "./block-light-churn-fixture.js";
import { settleLight } from "./block-light-fixture.js";

function setup(t, dimension = "overworld") {
  t.mock.method(performance, "now", () => 0);
  const fixture = churnWorld(4, true, dimension), field = new BlockLightField();
  const renderer = { world: fixture.world, blockLight: field };
  fixture.observe((world, event) => GameRenderer.prototype.onWorldMutation.call(renderer, world, event));
  t.after(() => { field.dispose(); fixture.dispose(); });
  const tick = (x = fixture.position.x) => {
    field.update(fixture.world, { ...fixture.position, x }, 1);
    field.texture.clearLayerUpdates();
    return fixture.points.map((p) => field.sample(p));
  };
  const settle = () => settleLight(field, fixture.world, fixture.position, 1);
  return { fixture, field, renderer, tick, settle };
}

test("native fluid/log-state churn converges cold and preserves warm radiance without work", (t) => {
  const { fixture, field, tick, settle } = setup(t);
  let firstLit;
  for (let i = 0; i < 120; i++) {
    if (i % 5 === 0) fixture.mutate(i / 5);
    const rgb = tick();
    if (!firstLit && rgb.every((color) => color[0] > 0)) firstLit = i + 1;
    assert.equal(field.stats.staleJobs, 0);
  }
  assert.ok(firstLit, "nearby receivers must light while churn continues");
  settle();
  const expected = tick();
  for (const kind of ["fluid", "state", "both"]) for (let i = 0; i < 30; i++) {
    fixture.mutate(i, kind);
    assert.deepEqual(tick(), expected);
    assert.equal(field.stats.scans, 0);
    assert.equal(field.stats.visits, 0);
    assert.equal(field.stats.uploadBytes, 0);
    assert.equal(field.stats.stampChecks, 0, "proved column increments must not rebuild the metadata prefix");
  }
  for (let i = 0; i < 192; i++) fixture.mutate(i);
  assert.deepEqual(tick(), expected);
  assert.equal(field.stats.benignCells, 384, "native default catch-up volume fits the proof budget");
  assert.equal(field.stats.scans + field.stats.visits + field.stats.uploadBytes, 0);
});

test("a missed unsafe sibling-section mutation prevents benign column acknowledgment", (t) => {
  const { fixture, field, tick, settle } = setup(t), world = fixture.world;
  world.set(14, 24, 3, BLOCK.OAK_LOG);
  settle();
  fixture.observe(undefined);
  world.set(13, 8, 2, BLOCK.AIR);
  fixture.observe((owner, event) => field.observeMutation(owner, event));
  assert.equal(world.applyCells([{ x: 14, y: 24, z: 3, before: world.getCell(14, 24, 3),
    after: { id: BLOCK.OAK_LOG, state: BLOCK_STATE.AXIS_X, fluid: 0 } }]), true);
  assert.ok(tick().every((rgb) => rgb[0] === 0));
  assert.equal(field.stats.benignCells, 1);
});

test("returning across cache boundaries uses the still-valid neighboring apron", (t) => {
  const { fixture, field, tick, settle } = setup(t);
  settle();
  const expected = tick();
  for (const x of [15.99, 16.01, 31.99, 32.01, 33, 31.99, 16.01, 15.99, 8])
    assert.deepEqual(tick(x), expected, `observer x=${x}`);
  assert.ok(field.revisions.semantic.size <= field.revisions.tokens.size);
  field.valid[field.index(0, 0, 0)] = 127;
  assert.deepEqual(field.sample(fixture.points[2]), [0, 0, 0], "verified dark must not borrow a lit neighbor");
});

for (const dimension of ["overworld", "nether", "end"])
  test(`${dimension}: negative-coordinate mutations and returning receiver stay invariant`, (t) => {
    const { fixture, field, tick, settle } = setup(t, dimension), world = fixture.world;
    world.set(-3, 8, 2, BLOCK.TORCH);
    world.set(-2, 8, 3, BLOCK.OAK_LOG);
    world.set(-1, 8, 1, BLOCK.WATER);
    settle();
    const point = { x: -0.02, y: 8.02, z: 2.5 }, expected = field.sample(point);
    assert.ok(expected[0] > 0);
    for (let i = 0; i < 20; i++) {
      assert.equal(world.applyCells([
        { x: -2, y: 8, z: 3, before: world.getCell(-2, 8, 3),
          after: { id: BLOCK.OAK_LOG, state: i % 2 ? BLOCK_STATE.AXIS_X : BLOCK_STATE.AXIS_Z, fluid: 0 } },
        { x: -1, y: 8, z: 1, before: world.getCell(-1, 8, 1),
          after: { id: BLOCK.WATER, state: 0, fluid: i % 2 ? FLUID.WATER_2 : FLUID.WATER_3 } },
      ]), true);
      tick(i % 2 ? 16.01 : 15.99);
      assert.deepEqual(field.sample(point), expected);
    }
  });

test("mixed harmful events, missed events and replays cannot certify stale torch light", (t) => {
  const { fixture, field, tick, settle } = setup(t);
  settle();
  fixture.mutate(0, "fluid");
  const old = fixture.lastEvent();
  assert.ok(tick().every((rgb) => rgb[0] > 0));
  fixture.observe(undefined);
  fixture.world.set(13, 8, 2, BLOCK.AIR);
  field.observeMutation(fixture.world, old);
  assert.ok(tick().every((rgb) => rgb[0] === 0));
  settle();
  fixture.world.set(13, 8, 2, BLOCK.TORCH);
  settle();
  fixture.observe((world, event) => field.observeMutation(world, event));
  assert.equal(fixture.world.applyCells([
    { x: 13, y: 8, z: 2, before: fixture.world.getCell(13, 8, 2), after: { id: BLOCK.AIR, state: 0, fluid: 0 } },
    { x: 15, y: 8, z: 1, before: fixture.world.getCell(15, 8, 1), after: { id: BLOCK.WATER, state: 0, fluid: FLUID.WATER_2 } },
  ]), true);
  assert.ok(tick().every((rgb) => rgb[0] === 0));
});

test("closure remains dark through subsequent benign mutations and ring movement", (t) => {
  const { fixture, tick, settle } = setup(t);
  settle();
  const changes = [];
  for (let y = 8; y <= 10; y++) for (let z = 1; z <= 3; z++)
    changes.push({ x: 15, y, z, before: fixture.world.getCell(15, y, z), after: { id: BLOCK.STONE, state: 0, fluid: 0 } });
  assert.equal(fixture.world.applyCells(changes), true);
  assert.equal(tick()[1][0], 0);
  settle();
  for (let i = 0; i < 30; i++) {
    fixture.mutate(i, "state");
    assert.equal(tick(i % 2 ? 33 : 8)[1][0], 0);
  }
});

test("per-update event budget fails closed, and disposal releases world references", (t) => {
  const { fixture, field, tick, settle } = setup(t);
  settle();
  for (let i = 0; i < BLOCK_LIGHT_MUTATION_CELLS / 2 + 12; i++) fixture.mutate(i);
  fixture.world.set(13, 8, 2, BLOCK.AIR);
  assert.ok(tick().every((rgb) => rgb[0] === 0));
  assert.equal(field.stats.mutationCells, BLOCK_LIGHT_MUTATION_CELLS);
  field.dispose();
  assert.equal(field.revisions.world, undefined);
  assert.equal(field.revisions.semantic.size, 0);
  fixture.mutate(0);
  assert.equal(field.revisions.semantic.size, 0);
});

test("semantic proof is narrow: water amounts/axes only, never sources, fluids or doors", () => {
  const cell = (id, state = 0, fluid = 0) => ({ id, state, fluid });
  assert.equal(benignBlockLightChange({ before: cell(BLOCK.WATER, 0, FLUID.WATER_2),
    after: cell(BLOCK.WATER, 0, FLUID.WATER_3) }), true);
  assert.equal(benignBlockLightChange({ before: cell(BLOCK.OAK_LOG),
    after: cell(BLOCK.OAK_LOG, BLOCK_STATE.AXIS_X) }), true);
  for (const [before, after] of [
    [cell(BLOCK.TORCH), cell(BLOCK.AIR)],
    [cell(BLOCK.AIR), cell(BLOCK.STONE)],
    [cell(BLOCK.WATER, 0, FLUID.WATER_2), cell(BLOCK.AIR)],
    [cell(BLOCK.OAK_DOOR), cell(BLOCK.OAK_DOOR, BLOCK_STATE.OPEN)],
  ]) assert.equal(benignBlockLightChange({ before, after }), false);
});
