import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { ConduitIndex, CONDUIT_LIMITS } from "../src/conduit-index.js";
import { authoredEcologyWorld } from "./ecology-host-fixture.js";
import { buildConduit, putCell } from "./conduit-fixture.js";

function settle(index, limit = 1024) {
  let steps = 0;
  do {
    index.step();
    assert.ok(index.lastWork.cells <= CONDUIT_LIMITS.cellsPerStep);
    assert.ok(index.lastWork.columns <= CONDUIT_LIMITS.columnsPerStep);
    assert.ok(index.queue.size <= CONDUIT_LIMITS.queuedColumns);
    assert.ok(index.sources.size <= CONDUIT_LIMITS.sources);
    assert.ok(++steps <= limit, "finite scan completion");
  } while (index.fallback || index.needsFallback || index.queue.size);
  return steps;
}

test("resident discovery/cache uses no generator, get(), pin, or more than four frame columns", (t) => {
  const { world, generated } = authoredEcologyWorld({ radius: 1 });
  t.after(() => world.dispose());
  const at = { x: 15, y: 3, z: 15 };
  buildConduit(world, 42, at);
  const count = generated(), pins = new Map(world._pins);
  t.mock.method(world, "get", () => assert.fail("No World.get"));
  t.mock.method(world, "_generateSync", () => assert.fail("No generation"));
  const index = new ConduitIndex(world);
  settle(index);
  const source = index.observe(at);
  assert.equal(source.value.count, 42);
  assert.equal(source.columns, 4);
  assert.equal(index.observe(at), source, "unchanged scalar revision cache");
  assert.equal(generated(), count);
  assert.deepEqual(world._pins, pins);
  putCell(world, { x: 16, y: 3, z: 16 }, BLOCK.AIR);
  assert.equal(source.validate(), false, "revision invalidates before event delivery");
  assert.equal(index.observe(at), null, "dry inner cell refuses immediately");
  putCell(world, { x: 16, y: 3, z: 16 }, BLOCK.WATER);
  assert.ok(index.observe(at));
  const current = index.observe(at), chunk = world.chunks.get("1,1");
  world.chunks.delete("1,1");
  assert.equal(current.validate(), false);
  assert.equal(index.observe(at), null);
  world.chunks.set("1,1", chunk);
  assert.ok(index.observe(at));
  world.setDimension("nether");
  assert.equal(current.validate(), false);
  assert.equal(index.observe(at), null);
  assert.equal(index.sources.size, 0);
});

test("source mutation is directly discovered; serialized cells reconstruct without a buff archive", (t) => {
  const { world } = authoredEcologyWorld({ radius: 1 });
  t.after(() => world.dispose());
  const index = new ConduitIndex(world);
  world.onMutation = (event) => index.onMutation(world, event);
  const at = { x: 8, y: 3, z: 8 };
  buildConduit(world, 16, at);
  assert.equal(index.observe(at).value.radius, 32, "no background scan required after placement");
  const save = world.serialize(), next = authoredEcologyWorld({ radius: 1 }).world;
  t.after(() => next.dispose());
  assert.equal(next.loadEdits(save), true);
  const reloaded = new ConduitIndex(next);
  settle(reloaded);
  assert.equal(reloaded.observe(at).value.radius, 32);
  assert.equal(JSON.stringify(save).includes("conduitPower"), false);
  putCell(world, at, BLOCK.WATER);
  assert.equal(index.sources.size, 0);
  assert.equal(index.observe(at), null);
});

test("queue overflow falls back to a finite bounded resident sweep", () => {
  const chunks = new Map();
  for (let cx = 0; cx < 70; cx++) {
    const blocks = new Uint16Array(256);
    if (cx === 69) blocks[1] = BLOCK.CONDUIT;
    chunks.set(`${cx},0`, { cx, cz: 0, incarnation: cx + 1, revision: 0, blocks });
  }
  const world = { chunks, epoch: 0, dimension: "overworld", spec: { minY: 0 },
    getCell(x, y, z) {
      const chunk = chunks.get(`${Math.floor(x / 16)},0`);
      return chunk ? { id: chunk.blocks[z * 16 + x % 16], fluid: FLUID.WATER_SOURCE } : null;
    } };
  const index = new ConduitIndex(world);
  for (const [key, chunk] of chunks)
    index.onChunkLoaded(world, { key, chunk, incarnation: chunk.incarnation, epoch: 0, dimension: world.dimension });
  assert.equal(index.queue.size, 64);
  settle(index);
  assert.equal(index.sources.size, 1);
  assert.ok(index.sources.has("1105,0,0"), "dropped admission found by fallback");
  assert.equal(index.overflow, false);
});

test("source cap refuses effects and recovers after excess resident cells are removed", () => {
  const blocks = new Uint16Array(256).fill(BLOCK.CONDUIT);
  const chunk = { cx: 0, cz: 0, incarnation: 1, revision: 0, blocks };
  const world = { chunks: new Map([["0,0", chunk]]), epoch: 0, dimension: "overworld",
    spec: { minY: 0 }, getCell: (x, y, z) => ({ id: blocks[z * 16 + x], fluid: 1 }) };
  const index = new ConduitIndex(world);
  // A saturated sweep requests another recovery scan; one step is enough to
  // see overflow, but arbitrary repeated work never grows storage.
  for (let i = 0; i < 5; i++) index.step();
  assert.equal(index.overflow, true);
  assert.equal(index.sources.size, 128);
  assert.equal(index.lastWork.cells, 0, "a saturated finite sweep does not run forever");
  assert.equal(index.observe({ x: 0, y: 0, z: 0 }), null);
  blocks.fill(BLOCK.AIR, 1);
  chunk.revision++;
  settle(index);
  assert.equal(index.overflow, false);
  assert.equal(index.sources.size, 1);
});

test("evicting an untracked overflow column requests a finite recovery sweep", () => {
  const first = { cx: 0, cz: 0, incarnation: 1, revision: 0,
    blocks: new Uint16Array(256).fill(BLOCK.AIR) };
  first.blocks.fill(BLOCK.CONDUIT, 0, 128);
  const extra = { cx: 1, cz: 0, incarnation: 2, revision: 0,
    blocks: new Uint16Array(256).fill(BLOCK.AIR) };
  extra.blocks[0] = BLOCK.CONDUIT;
  const chunks = new Map([["0,0", first], ["1,0", extra]]);
  const world = { chunks, epoch: 0, dimension: "overworld", spec: { minY: 0 },
    getCell(x, y, z) {
      const chunk = chunks.get(`${Math.floor(x / 16)},0`);
      return chunk ? { id: chunk.blocks[z * 16 + x % 16], fluid: 1 } : null;
    } };
  const index = new ConduitIndex(world);
  for (let i = 0; i < 3; i++) index.step();
  assert.equal(index.overflow, true);
  chunks.delete("1,0");
  settle(index);
  assert.equal(index.overflow, false);
  assert.equal(index.sources.size, 128);
});

test("a missed real World mutation recovers after a later unrelated event, with bounded idle work", (t) => {
  const { world, generated } = authoredEcologyWorld({ radius: 1 });
  t.after(() => world.dispose());
  const index = new ConduitIndex(world), at = { x: 8, y: 3, z: 8 };
  settle(index);
  const generatedBefore = generated(), pins = new Map(world._pins);
  let missed, latest;
  world.onMutation = (event) => { missed = event; };
  buildConduit(world, 42, at);
  assert.equal(index.sources.size, 0);
  world.onMutation = (event) => {
    latest = event;
    assert.equal(index.onMutation(world, event), true);
  };
  putCell(world, { x: 20, y: 6, z: 20 }, BLOCK.STONE);
  assert.equal(index.needsFallback, true, "the revision gap must not be silently acknowledged");
  const recoverySteps = settle(index, 128);
  assert.equal(index.observe(at).value.count, 42);
  assert.equal(index.onMutation(world, missed), false, "late old event");
  assert.equal(index.onMutation(world, latest), false, "replayed latest event");
  assert.equal(index.onMutation({}, latest), false, "wrong owner");
  assert.equal(index.onMutation(world, { ...latest, epoch: world.epoch + 1 }), false);
  for (let i = 0; i < 128; i++) {
    index.step();
    assert.equal(index.lastWork.cells, 0, "no repeated full scan while world revision is unchanged");
  }
  assert.equal(generated(), generatedBefore);
  assert.deepEqual(world._pins, pins);
  t.diagnostic(JSON.stringify({ missingEventRecoverySteps: recoverySteps, idleSteps: 128 }));
});

test("native revision reconciliation catches a missing last event and preserves overflow/replay guards", (t) => {
  const { world, generated } = authoredEcologyWorld({ radius: 1 });
  t.after(() => world.dispose());
  const index = new ConduitIndex(world), at = { x: 8, y: 3, z: 8 };
  settle(index);
  const before = generated();
  let missing;
  world.onMutation = (event) => { missing = event; };
  buildConduit(world, 16, at);
  settle(index, 128);
  assert.equal(index.observe(at)?.value.radius, 32, "no later event is required for reconciliation");
  assert.equal(index.onMutation(world, missing), false, "already reconciled revision");
  let oversized;
  world.onMutation = (event) => {
    oversized = event;
    assert.equal(index.onMutation(world, event), true);
  };
  const changes = Array.from({ length: 257 }, (_, i) => ({
    x: i % 16, y: 6, z: Math.floor(i / 16),
    before: world.getCell(i % 16, 6, Math.floor(i / 16)),
    after: { id: BLOCK.STONE, state: 0, fluid: FLUID.NONE },
  }));
  assert.equal(world.applyCells(changes), true);
  assert.equal(index.needsFallback, true);
  settle(index, 128);
  assert.equal(index.observe(at).value.radius, 32);
  assert.equal(index.onMutation(world, oversized), false);
  world.setDimension("nether");
  assert.equal(index.onMutation(world, oversized), false);
  assert.equal(index.sources.size, 0);
  assert.equal(generated(), before);
});
