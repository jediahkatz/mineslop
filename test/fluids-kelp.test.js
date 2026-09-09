import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F } from "../src/block-state.js";
import {
  FLUID_LIMITS,
  KELP_GROW_TICKS,
  KELP_MAX_HEIGHT,
  MAX_FLUID_PLAN_READS,
} from "../src/fluid-constants.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { fluidFixture, fluidSteps } from "./fluid-fixture.js";
import { activateKelp, fluidTo, kelpColumn, kelpTimer } from "./fluid-kelp-fixture.js";

test("supported native-shaped kelp has a saved 487.5 active-second cooldown that repeat wakes cannot bypass", (t) => {
  const { world, fluids } = fluidFixture(t, {
    base: BLOCK.STONE, initial: kelpColumn(),
  });
  const before = world.serialize();
  const timer = activateKelp(fluids);
  assert.ok(timer[3] >= 0 && timer[3] <= 24);
  assert.equal(timer[4], 1 + KELP_GROW_TICKS);
  const prepare = t.mock.method(world, "prepareMutation");
  t.mock.method(world.generator, "generateChunk", () => assert.fail("growth cannot generate"));
  for (let i = 0; i < KELP_GROW_TICKS - 1; i++) {
    fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
    fluids.update(0.25);
    assert.equal(kelpTimer(fluids)[4], timer[4], "local edits cannot shorten or restart the cooldown");
  }
  assert.deepEqual(world.serialize(), before);
  assert.equal(prepare.mock.callCount(), 0, "waiting produces no World plans or no-op edits");
  fluids.update(0.25);
  assert.equal(world.get(8, 2, 8), BLOCK.KELP);
  assert.equal(world.get(8, 3, 8), BLOCK.WATER);
  assert.deepEqual(world.getCell(8, 2, 8), { id: BLOCK.KELP, state: 0, fluid: F.WATER_SOURCE });
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(fluids.diagnostics().last.kelpGrown, 1);
  const next = kelpTimer(fluids, 8, 2, 8);
  assert.deepEqual(next, [8, 2, 8, timer[3] + 1, timer[4] + KELP_GROW_TICKS]);
  assert.equal(kelpTimer(fluids), undefined, "one tip transfers one saved slot");
  fluidSteps(fluids, 8);
  assert.equal(fluids.diagnostics().kelpTimers, 1);
  assert.ok(encodedBytes(fluids.serialize()) <= fluids.reservedBytes);
});

test("growth stops at age 25; cutting the tip permits another full-cooldown extension", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE, initial: kelpColumn(32),
  });
  let timer = activateKelp(fluids);
  const initialAge = timer[3];
  for (let age = initialAge; age < 25; age++) {
    fluidTo(fluids, timer[4]);
    timer = kelpTimer(fluids, 8, timer[1] + 1, 8);
    assert.ok(timer);
    assert.equal(timer[3], age + 1);
  }
  assert.equal(timer[1], 26 - initialAge);
  const before = world.serialize();
  fluidTo(fluids, timer[4] + KELP_GROW_TICKS);
  assert.deepEqual(world.serialize(), before);
  assert.equal(kelpTimer(fluids, 8, timer[1], 8)[3], 25);
  put(8, timer[1], 8, BLOCK.WATER);
  fluidSteps(fluids, 2);
  const cut = kelpTimer(fluids, 8, timer[1] - 1, 8);
  assert.ok(cut && cut[3] < 25);
  fluidTo(fluids, cut[4] - 1);
  assert.equal(world.get(8, timer[1], 8), BLOCK.WATER);
  fluids.update(0.25);
  assert.equal(world.get(8, timer[1], 8), BLOCK.KELP);
});

test("blocked tips wait another whole interval, even if the obstruction is cleared or repeatedly woken", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE, initial: [[8, 1, 8, BLOCK.KELP]],
  });
  const timer = activateKelp(fluids);
  const prepare = t.mock.method(world, "prepareMutation");
  fluidTo(fluids, timer[4]);
  assert.equal(prepare.mock.callCount(), 0);
  const next = kelpTimer(fluids);
  assert.equal(next[4], timer[4] + KELP_GROW_TICKS);
  put(8, 2, 8, BLOCK.WATER);
  fluidSteps(fluids, 5);
  assert.equal(world.get(8, 2, 8), BLOCK.WATER);
  assert.equal(kelpTimer(fluids)[4], next[4]);
  fluidTo(fluids, next[4]);
  assert.equal(world.get(8, 2, 8), BLOCK.KELP);
});

for (const height of [KELP_MAX_HEIGHT, KELP_MAX_HEIGHT + 8]) {
  test(`an existing ${height}-cell column is preserved but never extended past the safety cap`, (t) => {
    const { world, fluids } = fluidFixture(t, {
      base: BLOCK.STONE,
      initial: [
        ...Array.from({ length: height }, (_, i) => [8, i + 1, 8, BLOCK.KELP]),
        [8, height + 1, 8, BLOCK.WATER],
      ],
    });
    const before = world.serialize();
    const timer = activateKelp(fluids, 8, height, 8);
    fluidTo(fluids, timer[4]);
    assert.deepEqual(world.serialize(), before);
    assert.ok(fluids.diagnostics().last.reads <=
      fluids.diagnostics().last.evaluated * MAX_FLUID_PLAN_READS);
  });
}

test("the signed top build boundary is a blocked tip, not an out-of-range growth or generation", (t) => {
  const { world, fluids } = fluidFixture(t, {
    base: BLOCK.STONE, initial: [[8, 319, 8, BLOCK.KELP]],
  });
  const before = world.serialize();
  const timer = activateKelp(fluids, 8, 319, 8);
  fluidTo(fluids, timer[4]);
  assert.deepEqual(world.serialize(), before);
  assert.equal(fluids.diagnostics().last.kelpGrown, 0);
});

test("an unsupported root cannot earn a new tip while its atomic removal is waiting for retention", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [[8, 1, 8, BLOCK.KELP], [8, 2, 8, BLOCK.KELP], [8, 3, 8, BLOCK.WATER]],
  });
  const timer = activateKelp(fluids, 8, 2, 8);
  put(8, 0, 8, BLOCK.AIR);
  fluidTo(fluids, timer[4]);
  assert.equal(world.get(8, 1, 8), BLOCK.KELP, "no invented successful drop owner");
  assert.equal(world.get(8, 3, 8), BLOCK.WATER, "immediate kelp support alone cannot hide an uprooted chain");
  assert.ok(fluids.diagnostics().total.blockedDrops > 0);
});

for (const fluid of [F.WATER_SOURCE, F.WATER_FALLING, F.BUBBLE_UP, F.BUBBLE_DOWN]) {
  test(`eligible water ${fluid} at a due tip converts to source kelp, including a competing same-tick water proposal`, (t) => {
    const { world, fluids, put } = fluidFixture(t, {
      base: BLOCK.STONE, initial: kelpColumn(),
    });
    const timer = activateKelp(fluids);
    fluidTo(fluids, timer[4] - 1);
    if (fluid !== F.WATER_SOURCE) put(8, 2, 8, { id: BLOCK.WATER, fluid });
    else fluids.onMutation([{ x: 8, y: 2, z: 8 }]);
    fluids.update(0.25);
    assert.deepEqual(world.getCell(8, 2, 8), { id: BLOCK.KELP, state: 0, fluid: F.WATER_SOURCE });
    assert.equal(fluids.diagnostics().last.kelpGrown, 1);
    assert.equal(fluids.diagnostics().last.rejected, 0);
    assert.equal(fluids.diagnostics().last.commits, 1);
  });
}

test("lateral water, air and waterlogged structural hosts never grow kelp", (t) => {
  for (const target of [
    ...Array.from({ length: 7 }, (_, i) => ({ id: BLOCK.WATER, fluid: F.WATER_1 + i })),
    BLOCK.AIR,
    { id: BLOCK.OAK_SLAB, state: 0, fluid: F.WATER_SOURCE },
  ]) {
    const { world, fluids, put } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
    const timer = activateKelp(fluids);
    fluidTo(fluids, timer[4] - 1);
    put(8, 2, 8, target);
    fluids.update(0.25);
    assert.notEqual(world.get(8, 2, 8), BLOCK.KELP);
    assert.equal(fluids.diagnostics().last.kelpGrown, 0);
    assert.equal(kelpTimer(fluids)[4], timer[4] + KELP_GROW_TICKS);
  }
});

test("unloaded kelp retains exact age/deadline without generating, then resumes after real admission", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  const timer = activateKelp(fluids);
  const old = world.chunks.get("0,0");
  world._removeChunk("0,0", old);
  const noGenerate = t.mock.method(world.generator, "generateChunk", () => assert.fail("no growth read admission"));
  fluidTo(fluids, timer[4]);
  assert.equal(world.getCell(8, 1, 8), null);
  assert.deepEqual(kelpTimer(fluids), timer);
  assert.equal(fluids.load(fluids.serialize()), true);
  assert.deepEqual(kelpTimer(fluids), timer);
  assert.ok(fluids.diagnostics().deferredSections > 0);
  noGenerate.mock.restore();
  const current = world._generateSync(0, 0);
  assert.notEqual(current.incarnation, old.incarnation);
  fluids.onChunkLoaded(current);
  const generated = t.mock.method(world.generator, "generateChunk", () => assert.fail("no active generation"));
  fluidSteps(fluids, 64);
  assert.equal(world.get(8, 2, 8), BLOCK.KELP);
  assert.equal(world.get(8, 3, 8), BLOCK.WATER, "no offline catch-up burst");
  assert.equal(generated.mock.callCount(), 0);
});

for (const refusal of ["bytes", "validation", "incarnation", "support"]) {
  test(`a real ${refusal} refusal preserves the mature growth opportunity for one later retry`, (t) => {
    const { world, fluids, put } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
    const timer = activateKelp(fluids);
    fluidTo(fluids, timer[4] - 1);
    const filler = {};
    let hook;
    if (refusal === "bytes") {
      assert.equal(world.coordinator.register(filler,
        MAX_RESERVED_BYTES - world.coordinator.budget.totalBytes), true);
    } else {
      const prepare = world.prepareMutation.bind(world);
      hook = t.mock.method(world, "prepareMutation", (changes, options) => {
        const participant = prepare(changes, options);
        assert.ok(participant);
        if (refusal === "validation") return { ...participant, validate: () => false };
        hook.mock.restore();
        if (refusal === "incarnation") {
          const old = world.chunks.get("0,0");
          world._removeChunk("0,0", old);
          fluids.onChunkLoaded(world._generateSync(0, 0));
        } else put(8, 0, 8, BLOCK.MAGMA_BLOCK);
        return participant;
      });
    }
    fluids.update(0.25);
    assert.equal(world.get(8, 2, 8), BLOCK.WATER);
    assert.equal(fluids.diagnostics().last.rejected, 1);
    assert.deepEqual(kelpTimer(fluids), timer, "failure does not spend age or cooldown");
    if (refusal === "bytes") world.coordinator.release(filler);
    else hook.mock.restore();
    if (refusal === "support") put(8, 0, 8, BLOCK.STONE);
    fluidSteps(fluids, 1);
    assert.equal(world.get(8, 2, 8), BLOCK.KELP);
    assert.equal(kelpTimer(fluids, 8, 2, 8)[3], timer[3] + 1);
    fluidSteps(fluids, 8);
    assert.equal(world.get(8, 3, 8), BLOCK.WATER);
  });
}

test("synchronous autosave and a throwing observer see new tip age/deadline already committed", (t) => {
  const { world, fluids } = fluidFixture(t, {
    connect: false, base: BLOCK.STONE, initial: kelpColumn(),
  });
  const timer = activateKelp(fluids);
  let saved;
  world.onMutation = () => {
    saved = { world: world.serialize(), fluids: fluids.serialize() };
    throw new Error("authored observer failure");
  };
  fluidTo(fluids, timer[4]);
  assert.ok(saved);
  assert.equal(saved.world.edits.length, 1);
  assert.deepEqual(saved.fluids.dimensions[0].marine.kelp,
    [[8, 2, 8, timer[3] + 1, timer[4] + KELP_GROW_TICKS]]);
  assert.equal(fluids.diagnostics().last.observerErrors, 1);
  const b = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  assert.equal(b.world.loadEdits(saved.world), true);
  assert.equal(b.fluids.load(saved.fluids), true);
  fluidTo(b.fluids, timer[4] + 1);
  assert.equal(b.world.get(8, 3, 8), BLOCK.WATER);
});

test("active timer pressure leaves water capacity and rotates persistent retries within the unchanged work budgets", (t) => {
  const initial = [
    ...Array.from({ length: 4 }, (_, i) => [3 + i * 3, 1, 3, BLOCK.KELP]),
    ...Array.from({ length: 4 }, (_, i) => [3 + i * 3, 2, 3, BLOCK.WATER]),
    ...Array.from({ length: 5 }, (_, i) => [6 + i, 1, 10, BLOCK.AIR]),
  ];
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE, initial,
    limits: { maxQueued: 8, maxUpdatesPerTick: 2 },
  });
  for (let x = 3; x <= 12; x += 3) {
    fluids.onMutation([{ x, y: 1, z: 3 }]);
    fluidSteps(fluids, 16);
  }
  assert.equal(fluids.diagnostics().kelpTimers, 2, "only one quarter can be long-lived");
  assert.ok(fluids.diagnostics().total.kelpDeferred > 0);
  put(8, 1, 10, BLOCK.WATER);
  for (let i = 0; i < 256; i++) {
    for (const entry of fluids.serialize().dimensions[0].marine?.kelp ?? [])
      fluids.onMutation([{ x: entry[0], y: entry[1], z: entry[2] }]);
    fluids.update(1);
    const { last, limits } = fluids.diagnostics();
    assert.ok(last.evaluated <= 4 * 2);
    assert.ok(last.scanCells <= 256);
    assert.ok(last.queueVisits <= 4 * 8);
    assert.ok(last.reads <= last.evaluated * MAX_FLUID_PLAN_READS + last.scanCells * 7);
    assert.ok(fluids.diagnostics().queued <= 8);
    assert.ok(encodedBytes(fluids.serialize()) <= fluids.reservedBytes);
    assert.equal(limits.maxTicksPerUpdate, FLUID_LIMITS.maxTicksPerUpdate);
  }
  assert.equal(world.getFluid(9, 1, 10), F.WATER_1);
  assert.equal(world.getFluid(10, 1, 10), F.WATER_2);
  t.diagnostic("With 8 total slots / 2 pinned timers and repeat wakes every update, downstream water still reaches levels 1 and 2.");
});

test("huge frame deltas never bypass the four-tick catch-up limit or the growth cooldown", (t) => {
  const { world, fluids } = fluidFixture(t, { base: BLOCK.STONE, initial: kelpColumn() });
  const timer = activateKelp(fluids);
  const before = fluids.serialize();
  for (const dt of [0, -1, NaN, Infinity]) assert.equal(fluids.update(dt), false);
  assert.deepEqual(fluids.serialize(), before);
  fluids.update(1000000);
  assert.equal(fluids.diagnostics().clock, 5);
  assert.equal(fluids.diagnostics().last.ticks, 4);
  assert.equal(fluids.diagnostics().last.discardedSeconds, 999999);
  assert.deepEqual(kelpTimer(fluids), timer);
  assert.equal(world.get(8, 2, 8), BLOCK.WATER);
});
