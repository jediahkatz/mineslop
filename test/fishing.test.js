import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { MAX_EXPERIENCE_ORBS } from "../src/experience-orbs.js";
import { FISHING_TICK, MAX_FISHING_STEPS } from "../src/fishing-physics.js";
import { normalizeFishingSnapshot } from "../src/fishing-save.js";
import { ITEM } from "../src/items.js";
import {
  advanceFishingTo,
  aquaticOwners,
  savedHookFixture,
} from "./vehicle-fishing-fixture.js";

const owned = (fixture, fishing) => ({
  inventory: fixture.gameplay.serialize(),
  fishing: fishing.serialize(),
  drops: fixture.overflow.serialize(),
  experience: fixture.experience.serialize(),
  bytes: fixture.coordinator.budget.totalBytes,
});

/** Authored water-entry snapshot to pin RNG, using a genuinely registered rod. */
function waterEntryFixture(fixture, fishing, randomState = 7) {
  assert.equal(fishing.cast().ok, true);
  const snapshot = fishing.serialize();
  Object.assign(snapshot.casts[0], {
    x: 0.5,
    y: fixture.world.surface - 0.035,
    z: 0.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "flying",
    total: 0,
    remaining: 0,
    flightTicks: 0,
    randomState,
    openWater: false,
    accumulator: 0,
  });
  assert.equal(fishing.load(snapshot), true);
  assert.equal(fishing.bindLoadedOwner().ok, true);
}

test("physical cast-to-bite flow commits one wear, retained catch and physical XP together", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  let fishing;
  fishing = fixture.fishing({
    onEvent(event) {
      fixture.hooks.onEvent(event);
      if (event.type !== "catch") return;
      assert.equal(fishing.size, 0);
      assert.equal(fixture.gameplay.getHandStack().durability, 63);
      assert.equal(fixture.overflow.size, 1);
      assert.ok(fixture.experience.size > 0);
    },
  });
  assert.equal(fishing.use().action, "cast");
  assert.equal(fixture.gameplay.getHandStack().durability, 64);
  advanceFishingTo(fishing, "waiting");
  assert.equal(fixture.overflow.size, 0);
  assert.equal(fixture.experience.size, 0);
  advanceFishingTo(fishing, "approach");
  advanceFishingTo(fishing, "hook");
  const caught = fishing.reel();
  assert.equal(caught.ok, true);
  assert.equal(caught.action, "catch");
  assert.deepEqual(caught.observerErrors, []);
  assert.equal(fixture.gameplay.getHandStack().durability, 63);
  assert.equal(
    fixture.gameplay.getState().experience.total,
    0,
    "XP must remain physical until collected"
  );
  assert.equal(
    fixture.experience
      .serialize()
      .orbs.reduce((sum, orb) => sum + orb.amount, 0),
    caught.catch.experience
  );
  assert.equal(
    fixture.overflow.serialize().entries[0].id,
    caught.catch.stack.id
  );
  assert.equal(fishing.reel().ok, false);
  assert.equal(fixture.overflow.serialize().entries[0].count, 1);
});

test("empty reel is free and the final durability point still pays for a real catch", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", { durability: 1 });
  const fishing = fixture.fishing();
  assert.equal(fishing.cast().ok, true);
  assert.equal(fishing.reel().action, "empty-reel");
  assert.equal(fixture.gameplay.getHandStack().durability, 1);
  assert.equal(fixture.overflow.size, 0);
  savedHookFixture(fishing, fixture.world);
  assert.equal(fishing.reel().ok, true);
  assert.equal(fixture.gameplay.getHandStack(), null);
  assert.equal(fixture.overflow.size, 1);
  assert.ok(fixture.experience.size > 0);
});

test("draining a hooked bobber's water before reel cannot create a dry-land catch", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  fixture.world.setCell(0, 8, 0, { id: BLOCK.AIR });
  assert.equal(fishing.reel().action, "empty-reel");
  assert.equal(fishing.size, 0);
  assert.equal(fixture.gameplay.getHandStack().durability, 64);
  assert.equal(fixture.overflow.size, 0);
  assert.equal(fixture.experience.size, 0);
});

test("missing prepared callbacks fail before casting or changing a retained catch window", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const unavailable = fixture.fishing({ prepareDrops: undefined });
  const empty = owned(fixture, unavailable);
  assert.equal(unavailable.cast().reason, "missing-prepared-rewards");
  assert.deepEqual(owned(fixture, unavailable), empty);
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  fishing.prepareExperience = undefined;
  const before = owned(fixture, fishing);
  assert.equal(fishing.reel().reason, "missing-prepared-rewards");
  assert.deepEqual(owned(fixture, fishing), before);
});

test("full physical-loot and XP owners preserve rod, RNG and the entire bite window", (t) => {
  const fixture = aquaticOwners(t, { overflowEntries: 1 });
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  assert.equal(
    fixture.overflow.enqueue(
      [{ id: ITEM.LEATHER, count: 1 }],
      { x: 20, y: 10, z: 20 },
      "overworld"
    ),
    true
  );
  let before = owned(fixture, fishing);
  assert.equal(fishing.reel().reason, "drop-rejected");
  assert.deepEqual(owned(fixture, fishing), before);
  assert.equal(fixture.overflow.load({ version: 1, entries: [] }), true);
  assert.equal(
    fixture.experience.load({
      version: 1,
      orbs: Array.from({ length: MAX_EXPERIENCE_ORBS }, (_, index) => ({
        amount: 1,
        dimension: "overworld",
        x: 100 + index * 3,
        y: 10,
        z: 100,
        age: 0,
        pickupDelay: 0,
        velocity: { x: 0, y: 0, z: 0 },
      })),
    }),
    true
  );
  before = owned(fixture, fishing);
  assert.equal(fishing.reel().reason, "experience-rejected");
  assert.deepEqual(owned(fixture, fishing), before);
});

test("stale hand, world epoch, or reward participant cannot publish any catch owner", (t) => {
  for (const invalidate of [
    (fixture) => {
      fixture.gameplay.select(1);
      fixture.gameplay.select(0);
    },
    (fixture) => {
      fixture.world.epoch++;
    },
    (_fixture, plan) => {
      const experience = plan.participants[3];
      plan.participants[3] = { ...experience, validate: () => false };
    },
  ]) {
    const fixture = aquaticOwners(t);
    fixture.setHand("FISHING_ROD");
    const fishing = fixture.fishing();
    savedHookFixture(fishing, fixture.world);
    const plan = fishing.prepareReel();
    assert.equal(plan.ok, true);
    invalidate(fixture, plan);
    const before = owned(fixture, fishing);
    assert.equal(fishing.commit(plan).ok, false);
    assert.deepEqual(owned(fixture, fishing), before);
  }
});

test("repeated preparations and saved reopen cannot duplicate a delivered reward", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const first = fishing.prepareReel(),
    second = fishing.prepareReel();
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.catch,
    second.catch,
    "a rejected preparation never advances RNG"
  );
  assert.equal(fishing.commit(first).ok, true);
  const delivered = owned(fixture, fishing);
  assert.equal(fishing.commit(second).ok, false);
  assert.deepEqual(owned(fixture, fishing), delivered);
  assert.equal(fishing.load(fishing.serialize()), true);
  assert.equal(fishing.reel().reason, "no-cast");
  assert.equal(fixture.overflow.serialize().entries[0].count, 1);
  assert.equal(fixture.gameplay.getHandStack().durability, 63);
});

test("mutation events latch invalid open water even if the source is repaired between ticks", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const change = { x: 0, y: 7, z: 0 };
  const event = {
    dimension: "overworld",
    epoch: fixture.world.epoch,
    changes: [change],
  };
  fixture.world.setCell(0, 7, 0, { id: BLOCK.WATER, fluid: FLUID.WATER_1 });
  assert.equal(fishing.onMutation(event), true);
  fixture.world.setCell(0, 7, 0, { id: BLOCK.WATER });
  fishing.onMutation(event);
  assert.equal(fishing.getCast().openWater, false);
  const plan = fishing.prepareReel();
  assert.equal(plan.ok, true);
  assert.notEqual(plan.catch.category, "treasure");
});

test("inactive dimensions/frontiers freeze timers; rod replacement and 32-block movement cancel", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const before = fishing.serialize();
  fixture.world.dimension = "end";
  assert.equal(fishing.update(60).ticks, 0);
  assert.deepEqual(fishing.serialize(), before);
  fixture.world.dimension = "overworld";
  fixture.world.loaded = () => false;
  assert.equal(fishing.update(60).ticks, 0);
  assert.deepEqual(fishing.serialize(), before);
  fixture.world.loaded = () => true;
  fixture.setHand("FISHING_ROD");
  fishing.update(0.05);
  assert.equal(fishing.size, 0);
  assert.equal(fixture.gameplay.getHandStack().durability, 64);
  savedHookFixture(fishing, fixture.world);
  fixture.actors.get("player").position.x += 33;
  fishing.update(0.05);
  assert.equal(fishing.size, 0);
  assert.equal(fixture.overflow.size, 0);
});

test("offhand fishing debits only that rod", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", { hand: "offhand" });
  const main = fixture.gameplay.getHandStack();
  const fishing = fixture.fishing();
  assert.equal(fishing.cast({ hand: "offhand" }).ok, true);
  const snapshot = fishing.serialize();
  Object.assign(snapshot.casts[0], {
    x: 0.5,
    y: fixture.world.surface - 0.035,
    z: 0.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "hook",
    total: 30,
    remaining: 30,
    openWater: true,
  });
  assert.equal(fishing.load(snapshot), true);
  assert.equal(fishing.bindLoadedOwner().ok, true);
  assert.equal(fishing.reel().ok, true);
  assert.deepEqual(fixture.gameplay.getHandStack(), main);
  assert.equal(fixture.gameplay.getHandStack("offhand").durability, 63);
});

test("a seated stationary player can cast, wait and catch without dismounting", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(boats.mount(placed.id).ok, true);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  const before = boats.serialize();
  assert.equal(fishing.cast().ok, true);
  advanceFishingTo(fishing, "hook");
  assert.equal(fishing.reel().ok, true);
  assert.equal(boats.mountFor().id, placed.id);
  assert.deepEqual(boats.serialize(), before);
});

test("multiple Lure rerolls stay inside the four-tick update cap without wall-clock catch-up", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3 } },
  });
  const fishing = fixture.fishing();
  waterEntryFixture(fixture, fishing, 0);
  const before = owned(fixture, fishing),
    firstEvent = fixture.events.length;
  assert.equal(fishing.update(60).ticks, MAX_FISHING_STEPS);
  const cast = fishing.getCast();
  assert.equal(cast.phase, "waiting");
  assert.equal(cast.total, 210);
  assert.equal(cast.remaining, 209);
  assert.equal(
    cast.randomState,
    3_519_870_697,
    "only the initial roll and two rerolls consumed RNG"
  );
  assert.equal(fishing.serialize().randomState, before.fishing.randomState);
  assert.deepEqual(
    fixture.events.slice(firstEvent).map((event) => event.type),
    ["splash", "wait-retry", "wait-retry", "waiting"]
  );
  assert.deepEqual(fixture.gameplay.serialize(), before.inventory);
  assert.deepEqual(fixture.overflow.serialize(), before.drops);
  assert.deepEqual(fixture.experience.serialize(), before.experience);
  assert.equal(fixture.coordinator.budget.totalBytes, before.bytes);
  assert.equal(fishing.update(0).ticks, 0);
  assert.equal(fishing.getCast().remaining, 209);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  assert.equal(fishing.getCast().remaining, 208);
  assert.equal(fishing.getCast().randomState, cast.randomState);
});

test("retry RNG and a fractional tick survive pause, frontier freeze, and explicit reload binding", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3 } },
  });
  const fishing = fixture.fishing();
  waterEntryFixture(fixture, fishing);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  assert.equal(fishing.update(0.02).ticks, 0);
  const snapshot = fishing.serialize();
  assert.equal(snapshot.casts[0].phase, "wait-retry");
  assert.equal(snapshot.casts[0].accumulator, 0.02);
  assert.equal(snapshot.casts[0].randomState, 1_025_555_898);
  assert.deepEqual(
    normalizeFishingSnapshot(snapshot, fixture.world.context),
    snapshot
  );
  assert.equal(fishing.update(0).ticks, 0);
  assert.deepEqual(fishing.serialize(), snapshot);
  fixture.world.dimension = "end";
  assert.equal(fishing.update(600).ticks, 0);
  assert.deepEqual(fishing.serialize(), snapshot);
  fixture.world.dimension = "overworld";
  fixture.world.loaded = () => false;
  assert.equal(fishing.update(600).ticks, 0);
  assert.deepEqual(fishing.serialize(), snapshot);
  fixture.world.loaded = () => true;

  const resume = () => {
    assert.equal(fishing.update(0.03).ticks, 1);
    const cast = fishing.getCast();
    assert.equal(cast.phase, "waiting");
    assert.equal(cast.total, 257);
    assert.equal(cast.remaining, 257);
    assert.equal(cast.randomState, 3_923_423_697);
    return cast;
  };
  const expected = resume();
  assert.equal(fixture.gameplay.load(fixture.gameplay.serialize()), true);
  assert.equal(fishing.load(JSON.parse(JSON.stringify(snapshot))), true);
  const unbound = fishing.serialize();
  assert.equal(fishing.update(600).ticks, 0);
  assert.equal(fishing.reel().reason, "needs-owner-binding");
  assert.deepEqual(fishing.serialize(), unbound);
  assert.equal(fishing.bindLoadedOwner().ok, true);
  assert.equal(fishing.getCast().randomState, snapshot.casts[0].randomState);
  assert.deepEqual(resume(), {
    ...expected,
    handRevision: fixture.gameplay.getHandRevision(),
  });
  assert.equal(fixture.gameplay.getHandStack().durability, 64);
  assert.equal(fixture.overflow.size, 0);
  assert.equal(fixture.experience.size, 0);
});

test("retry normalization admits only zero timers with an eligible Lure level", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3 } },
  });
  const fishing = fixture.fishing();
  waterEntryFixture(fixture, fishing);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  const before = owned(fixture, fishing),
    cast = before.fishing.casts[0];
  const plainRod = { ...cast.rod };
  delete plainRod.data;
  for (const changes of [
    { total: 1 },
    { remaining: 1 },
    { total: -81, remaining: -81 },
    { phase: "waiting" },
    { phase: "approach" },
    { phase: "hook" },
    { lure: 0, rod: plainRod },
    { lure: 0, rod: plainRod, phase: "waiting", total: 1, remaining: 1 },
  ]) {
    const invalid = { ...before.fishing, casts: [{ ...cast, ...changes }] };
    assert.equal(
      normalizeFishingSnapshot(invalid, fixture.world.context),
      null
    );
    assert.equal(fishing.load(invalid), false);
    assert.deepEqual(owned(fixture, fishing), before);
  }
});

test("retry does not reset open-water eligibility after an invalid pool is repaired", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3 } },
  });
  const fishing = fixture.fishing();
  waterEntryFixture(fixture, fishing);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  assert.equal(fishing.getCast().phase, "wait-retry");
  const event = {
    dimension: "overworld",
    epoch: fixture.world.epoch,
    changes: [{ x: 0, y: 7, z: 0 }],
  };
  fixture.world.setCell(0, 7, 0, { id: BLOCK.WATER, fluid: FLUID.WATER_1 });
  assert.equal(fishing.onMutation(event), true);
  fixture.world.setCell(0, 7, 0, { id: BLOCK.WATER });
  assert.equal(fishing.onMutation(event), false);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  assert.equal(fishing.getCast().phase, "waiting");
  assert.equal(fishing.getCast().openWater, false);
});

test("rejected retry and catch preparations preserve RNG, rod, loot and XP ownership", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: { version: 1, enchantments: { lure: 3 } },
  });
  const fishing = fixture.fishing();
  waterEntryFixture(fixture, fishing);
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  const before = owned(fixture, fishing),
    eventCount = fixture.events.length;
  const emptyReel = fishing.prepareReel();
  assert.equal(emptyReel.action, "empty-reel");
  assert.equal(emptyReel.participants.length, 1);
  assert.deepEqual(owned(fixture, fishing), before);
  const prepare = fishing._prepare;
  for (const rejection of ["preparation", "validation"]) {
    let proposed;
    const mocked = t.mock.method(
      fishing,
      "_prepare",
      function (changes, options) {
        proposed = changes.get("player");
        const participant = prepare.call(this, changes, options);
        return rejection === "preparation"
          ? null
          : { ...participant, validate: () => false };
      }
    );
    try {
      assert.equal(fishing.update(FISHING_TICK).ticks, 0);
      assert.equal(proposed.phase, "waiting");
      assert.equal(proposed.remaining, 257);
      assert.equal(proposed.randomState, 3_923_423_697);
      assert.deepEqual(owned(fixture, fishing), before);
      assert.equal(fixture.events.length, eventCount);
    } finally {
      mocked.mock.restore();
    }
  }
  assert.equal(fishing.update(FISHING_TICK).ticks, 1);
  assert.equal(fishing.getCast().remaining, 257);
  assert.equal(fishing.getCast().randomState, 3_923_423_697);
  const resumed = owned(fixture, fishing);
  assert.equal(
    fishing.commit(emptyReel).ok,
    false,
    "the old retry-state plan is stale after progress"
  );
  assert.deepEqual(owned(fixture, fishing), resumed);
  advanceFishingTo(fishing, "hook");

  const catchBefore = owned(fixture, fishing);
  fishing.prepareExperience = () => null;
  assert.equal(fishing.prepareReel().reason, "experience-rejected");
  assert.deepEqual(owned(fixture, fishing), catchBefore);
  fishing.prepareExperience = fixture.hooks.prepareExperience;
  const plan = fishing.prepareReel();
  assert.equal(plan.ok, true);
  assert.deepEqual(fishing.prepareReel().catch, plan.catch);
  assert.deepEqual(owned(fixture, fishing), catchBefore);
  const rejected = { ...plan, participants: [...plan.participants] };
  rejected.participants[3] = { ...plan.participants[3], validate: () => false };
  assert.equal(fishing.commit(rejected).ok, false);
  assert.deepEqual(owned(fixture, fishing), catchBefore);
  assert.equal(fishing.commit(plan).ok, true);
  assert.equal(fishing.size, 0);
  assert.equal(fixture.gameplay.getHandStack().durability, 63);
  assert.equal(fixture.overflow.serialize().entries[0].id, plan.catch.stack.id);
  assert.equal(fixture.overflow.serialize().entries[0].count, 1);
  assert.equal(
    fixture.experience
      .serialize()
      .orbs.reduce((sum, orb) => sum + orb.amount, 0),
    plan.catch.experience
  );
});
