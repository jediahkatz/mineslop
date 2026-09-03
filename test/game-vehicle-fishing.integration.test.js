import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { MAX_EXPERIENCE_ORBS } from "../src/experience-orbs.js";
import {
  compileFishingLootTables,
  rollFishingCatch,
} from "../src/fishing-loot.js";
import { MAX_FISHING_STEPS } from "../src/fishing-physics.js";
import { ITEM } from "../src/items.js";
import { Pickups } from "../src/pickups.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  consumeVehiclePose,
  placeAndMount,
  stageHostHook,
  vehicleHostFixture,
  waitForHostBite,
} from "./game-vehicle-services-fixture.js";

test("real waited flight/approach/bite commits four actual owners with one finite wear and physical XP", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD", {
    durability: 12,
    data: { version: 1, name: "Tidal line", repairCost: 2 },
  });
  t.mock.method(Math, "random", () =>
    assert.fail("fishing RNG must be persisted, not global")
  );
  t.mock.method(f.gameplay, "add", () =>
    assert.fail("caught loot is physical, not an inventory grant")
  );
  t.mock.method(f.experienceOrbs, "spawn", () =>
    assert.fail("XP must publish in the catch transaction")
  );
  assert.equal(f.service.useHand().action, "cast");
  const waited = waitForHostBite(f);
  assert.ok(
    waited.ticks >= 100,
    "an unenchanted attempt cannot bypass its minimum wait"
  );
  for (const phase of ["flying", "waiting", "approach", "hook"])
    assert.ok(waited.phases.has(phase));
  assert.equal(f.gameplay.getHandStack().durability, 12);
  assert.equal(f.overflow.size, 0);
  assert.equal(f.experienceOrbs.size, 0);
  const plan = f.service.prepareUseHand();
  assert.equal(plan.action, "catch");
  assert.deepEqual(
    plan.participants.map((part) => part.owner),
    [f.service.fishing, f.gameplay, f.overflow, f.experienceOrbs]
  );
  const before = f.snapshot();
  assert.deepEqual(f.service.prepareUseHand().catch, plan.catch);
  assert.deepEqual(
    f.snapshot(),
    before,
    "preparing repeated reels cannot reroll or publish rewards"
  );
  f.overflow.onChange = () => {
    assert.equal(f.service.fishing.size, 0);
    assert.equal(f.gameplay.getHandStack().durability, 11);
    assert.equal(
      f.experienceOrbs
        .serialize()
        .orbs.reduce((sum, orb) => sum + orb.amount, 0),
      plan.catch.experience
    );
  };
  const caught = f.service.commit(plan);
  assert.equal(caught.ok, true);
  assert.deepEqual(caught.observerErrors, []);
  assert.equal(f.gameplay.getHandStack().durability, 11);
  assert.deepEqual(
    f.gameplay.getHandStack().data,
    before.gameplay.slots[0].data
  );
  const [drop] = f.overflow.serialize().entries,
    [orb] = f.experienceOrbs.serialize().orbs;
  assert.equal(drop.id, caught.catch.stack.id);
  assert.deepEqual(drop.data, caught.catch.stack.data);
  assert.equal(drop.wear, caught.catch.stack.durability);
  assert.equal(drop.pickupDelay, 0.25);
  assert.equal(orb.pickupDelay, 0.25);
  assert.deepEqual(
    { x: drop.x, y: drop.y, z: drop.z },
    { x: orb.x, y: orb.y, z: orb.z }
  );
  assert.equal(
    f.gameplay.getState().experience.total,
    0,
    "catch XP has not been collected"
  );
  assert.equal(f.service.commit(plan).ok, false);
  f.service.render(0);
  assert.ok(
    f.service.fishing.renderer.bobbers.count > 0,
    "the committed catch has visible bounded feedback"
  );
  assert.ok(
    f.notifications.some(
      (text) => typeof text === "string" && text.startsWith("Caught ")
    )
  );
});

test("an enchanted worn treasure stack survives retained overflow and physical pickup handoff exactly", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  const tables = compileFishingLootTables(undefined, f.context);
  let state = 0,
    expected;
  for (; state < 4096; state++) {
    expected = rollFishingCatch(state, {
      tables,
      context: f.context,
      openWater: true,
    });
    if (expected.category === "treasure") break;
  }
  assert.equal(expected.category, "treasure");
  stageHostHook(f, { randomState: state });
  const caught = f.service.useHand();
  assert.equal(caught.ok, true);
  assert.deepEqual(caught.catch, expected);
  const drop = f.overflow.serialize().entries[0];
  assert.deepEqual(drop.data, expected.stack.data);
  assert.equal(drop.wear, expected.stack.durability);
  const pickups = new Pickups(f.game.graphics.scene, f.world, {
    coordinator: f.coordinator,
    context: f.context,
  });
  t.after(() => pickups.dispose());
  assert.equal(f.overflow.flush(f.world, pickups, 1), 1);
  assert.equal(f.overflow.size, 0);
  const physical = pickups.serialize().items[0];
  assert.equal(physical.id, expected.stack.id);
  assert.deepEqual(physical.data, expected.stack.data);
  assert.deepEqual(physical.durability, [expected.stack.durability]);
});

test("full overflow, full XP, or a prepared owner veto preserves the exact catch RNG, rod and window", (t) => {
  const f = vehicleHostFixture(t, { maxEntries: 1 });
  f.setHand("FISHING_ROD", { durability: 1 });
  stageHostHook(f);
  assert.equal(
    f.overflow.enqueue(
      [{ id: ITEM.STICK, count: 1 }],
      { x: 20, y: 10, z: 20 },
      f.world.dimension
    ),
    true
  );
  let before = f.snapshot();
  assert.equal(f.service.useHand().reason, "drop-rejected");
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.overflow.load({ version: 1, entries: [] }), true);
  assert.equal(
    f.experienceOrbs.load({
      version: 1,
      orbs: Array.from({ length: MAX_EXPERIENCE_ORBS }, (_, i) => ({
        amount: 1,
        x: 100 + i * 3,
        y: 10,
        z: 100,
        dimension: "overworld",
        age: 0,
        pickupDelay: 0,
        velocity: { x: 0, y: 0, z: 0 },
      })),
    }),
    true
  );
  before = f.snapshot();
  assert.equal(f.service.useHand().reason, "experience-rejected");
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.experienceOrbs.load({ version: 1, orbs: [] }), true);
  const plan = f.service.prepareUseHand();
  assert.equal(plan.ok, true);
  before = f.snapshot();
  for (let index = 0; index < plan.participants.length; index++) {
    const parts = plan.participants.map((part, i) =>
      i === index ? { ...part, validate: () => false } : part
    );
    assert.equal(f.coordinator.commit(parts).ok, false);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.service.prepareUseHand().catch, plan.catch);
  }
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(
    f.gameplay.getHandStack(),
    null,
    "the last durability point pays for exactly this catch"
  );
  assert.equal(f.overflow.size, 1);
  assert.ok(f.experienceOrbs.size > 0);
});

test("releasing a retained cast funds its exact physical rewards even in an imported over-budget world", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD", {
    durability: 17,
    data: { version: 1, name: "Retained line" },
  });
  stageHostHook(f);
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes + 100_000,
      { allowOverBudget: true }
    ),
    true
  );
  t.after(() => f.coordinator.release(filler));
  const plan = f.service.prepareUseHand();
  assert.equal(plan.ok, true);
  const delta = plan.participants.reduce(
    (sum, part) => sum + part.afterBytes - part.beforeBytes,
    0
  );
  assert.ok(
    delta < 0,
    "the cast relinquishes more than the physical drop and XP require"
  );
  const bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(f.coordinator.budget.totalBytes, bytes + delta);
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.equal(f.service.fishing.size, 0);
  assert.equal(f.gameplay.getHandStack().durability, 16);
  assert.equal(f.overflow.size, 1);
  assert.equal(f.experienceOrbs.size, 1);
});

test("stale exact rod identity and replacement owner methods fail without publishing catch owners", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD", { data: { version: 1, name: "One" } });
  stageHostHook(f);
  const plan = f.service.prepareUseHand();
  f.setHand("FISHING_ROD", { data: { version: 1, name: "One" } });
  const before = f.snapshot();
  assert.equal(f.service.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(
    f.service.useHand().action,
    "cancel",
    "a new reference cannot inherit an old rod's cast"
  );
  stageHostHook(f);
  const next = f.service.prepareUseHand();
  const method = f.overflow.prepareEnqueue;
  f.overflow.prepareEnqueue = function (...args) {
    return method.apply(this, args);
  };
  const stable = f.snapshot();
  assert.equal(f.service.commit(next).ok, false);
  assert.deepEqual(f.snapshot(), stable);
  f.overflow.prepareEnqueue = method;
});

test("foreign-owner prepared receipts are not accepted as a retained fishing reward", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  stageHostHook(f);
  const before = f.snapshot();
  t.mock.method(f.overflow, "prepareEnqueue", () =>
    f.gameplay.prepareHandCost("main", { wear: 1 })
  );
  assert.equal(f.service.useHand().reason, "drop-rejected");
  assert.deepEqual(f.snapshot(), before);
});

test("offhand fishing is finite even in Creative and never wears the selected main hand", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD", {
    hand: "offhand",
    durability: 3,
    data: { version: 1, name: "Left" },
  });
  f.gameplay.setMode("creative");
  assert.equal(f.service.useHand("offhand").action, "cast");
  const saved = f.service.serialize();
  Object.assign(saved.fishing.casts[0], {
    x: 8.5,
    y: 8.845,
    z: 8.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "hook",
    total: 30,
    remaining: 30,
    accumulator: 0,
    openWater: true,
  });
  f.replaceService(saved);
  const main = f.gameplay.getHandStack();
  assert.equal(f.service.useHand("offhand").ok, true);
  assert.deepEqual(f.gameplay.getHandStack(), main);
  assert.equal(f.gameplay.getHandStack("offhand").durability, 2);
  assert.equal(f.gameplay.getHandStack("offhand").data.name, "Left");
});

test("a real seated rod can wait and catch while retaining the same boat and passenger", (t) => {
  const f = vehicleHostFixture(t);
  const id = placeAndMount(f);
  f.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3, luck_of_the_sea: 3 } },
  });
  f.player.pitch = -0.2;
  assert.equal(f.service.useHand().action, "cast");
  const waited = waitForHostBite(f);
  assert.ok(waited.ticks > 1);
  assert.equal(f.service.fishing.getCast().lure, 3);
  assert.equal(f.service.fishing.getCast().luck, 3);
  assert.equal(f.service.useHand().ok, true);
  assert.equal(f.service.boats.mountFor().id, id);
  assert.equal(f.service.riderPose().seated, true);
  assert.equal(f.gameplay.getHandStack().durability, 63);
});

test("paused time/frontiers do not age RNG; large dt cannot exceed four fishing steps", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  stageHostHook(f);
  let before = f.snapshot();
  f.game.paused = true;
  assert.equal(f.service.frame(500).advanced, false);
  assert.deepEqual(f.snapshot(), before);
  f.game.paused = false;
  const cell = t.mock.method(f.world, "isLoaded", () => false);
  assert.equal(f.service.frame(500).fishing.ticks, 0);
  assert.deepEqual(f.snapshot(), before);
  cell.mock.restore();
  const remaining = f.service.fishing.getCast().remaining;
  assert.equal(f.service.frame(500).fishing.ticks, MAX_FISHING_STEPS);
  assert.equal(
    f.service.fishing.getCast().remaining,
    remaining - MAX_FISHING_STEPS
  );
  before = f.service.fishing.getCast().randomState;
  assert.equal(f.service.frame(0).advanced, false);
  assert.equal(f.service.fishing.getCast().randomState, before);
});

test("postcommit waterlogging/bubbles invalidate treasure, including a source repaired by an earlier observer", (t) => {
  for (const fluid of [FLUID.WATER_1, FLUID.BUBBLE_UP, FLUID.BUBBLE_DOWN]) {
    const f = vehicleHostFixture(t);
    f.setHand("FISHING_ROD");
    stageHostHook(f);
    const eventWorld = f.world;
    let repairing = false;
    f.world.onMutation = (event) => {
      if (repairing) return;
      repairing = true;
      f.put(6, 7, 6, BLOCK.WATER);
      repairing = false;
      f.service.onMutation(eventWorld, event);
    };
    f.put(6, 7, 6, { id: BLOCK.WATER, fluid });
    assert.equal(f.world.getFluid(6, 7, 6), FLUID.WATER_SOURCE);
    assert.equal(f.service.fishing.getCast().openWater, false);
    assert.notEqual(f.service.prepareUseHand().catch.category, "treasure");
  }
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  stageHostHook(f);
  f.put(6, 7, 6, { id: BLOCK.OAK_SLAB, fluid: FLUID.WATER_SOURCE });
  assert.equal(f.service.fishing.getCast().openWater, false);
  f.put(8, 8, 8, BLOCK.AIR);
  assert.equal(f.service.useHand().action, "empty-reel");
  assert.equal(f.gameplay.getHandStack().durability, 64);
  assert.equal(f.overflow.size, 0);
  assert.equal(f.experienceOrbs.size, 0);
});

test("line, bobber, approach and catch feedback share bounded renderer buffers", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  assert.equal(f.service.useHand().ok, true);
  const renderer = f.service.fishing.renderer;
  const positions = renderer.linePositions,
    matrices = renderer.bobbers.instanceMatrix.array;
  f.service.render();
  assert.equal(renderer.lineGeometry.drawRange.count, 24);
  assert.ok(renderer.bobbers.count >= 3);
  for (let i = 0; i < 10; i++) {
    f.service.frame(0.05);
    consumeVehiclePose(f);
    f.service.render(0.05);
  }
  assert.equal(renderer.linePositions, positions);
  assert.equal(renderer.bobbers.instanceMatrix.array, matrices);
  const resources = f.service.diagnostics();
  assert.equal(
    resources.boats.renderer.draws + resources.fishing.renderer.draws,
    3
  );
  assert.equal(
    resources.boats.renderer.textures + resources.fishing.renderer.textures,
    0
  );
  assert.equal(f.service.detachForTravel().ok, true);
  assert.equal(renderer.lineGeometry.drawRange.count, 0);
  assert.equal(renderer.bobbers.count, 0);
  assert.equal(renderer.hasFeedback, false);
});
