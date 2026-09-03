import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { nextFishingRandom } from "../src/fishing-loot.js";
import {
  fishingLaunch,
  FISHING_TICK,
  stepFishingCast,
} from "../src/fishing-physics.js";
import { sharedAquaticSample } from "../src/vehicle-water.js";
import { aquaticWorld, physicsBobber } from "./vehicle-fishing-fixture.js";

test("a cast follows a swept ballistic flight before beginning a water wait", () => {
  const world = aquaticWorld();
  const launch = fishingLaunch(
    world,
    { x: 0.5, y: world.surface + 1.6, z: 0.5 },
    { x: 0, y: 0, z: -1 }
  );
  assert.ok(launch);
  let bobber = physicsBobber(world, {
    ...launch,
    phase: "flying",
    remaining: 0,
    total: 0,
    openWater: false,
  });
  const first = stepFishingCast(world, bobber);
  assert.ok(first.bobber.y > bobber.y);
  assert.ok(first.bobber.z < bobber.z);
  assert.equal(first.bobber.phase, "flying");
  const start = { ...bobber };
  const events = [];
  for (let tick = 0; tick < 80 && bobber.phase === "flying"; tick++) {
    const result = stepFishingCast(world, bobber);
    assert.ok(result);
    bobber = result.bobber;
    events.push(...result.events);
  }
  assert.equal(bobber.phase, "waiting");
  assert.ok(bobber.z < start.z - 2);
  assert.ok(
    bobber.remaining * FISHING_TICK >= 5 &&
      bobber.remaining * FISHING_TICK <= 30
  );
  assert.ok(events.some((event) => event.type === "splash"));
  assert.ok(events.some((event) => event.type === "waiting"));
});

test("waiting, approach, bite dip, expiration and a fresh wait are separate phases", () => {
  const world = aquaticWorld();
  let bobber = physicsBobber(world);
  const events = [];
  const advance = () => {
    const result = stepFishingCast(world, bobber);
    assert.ok(result);
    bobber = result.bobber;
    events.push(...result.events);
  };
  for (let tick = 0; tick < 99; tick++) advance();
  assert.equal(bobber.phase, "waiting");
  advance();
  assert.equal(bobber.phase, "approach");
  assert.ok(bobber.total >= 20 && bobber.total <= 80);
  const approaching = bobber.remaining;
  for (let tick = 0; tick < approaching; tick++) advance();
  assert.equal(bobber.phase, "hook");
  assert.ok(bobber.total >= 20 && bobber.total <= 40);
  const hookY = bobber.y,
    hookRandom = bobber.randomState;
  advance();
  assert.ok(bobber.y < hookY, "the bite moves the actual bobber down");
  const window = bobber.remaining;
  for (let tick = 0; tick < window; tick++) advance();
  assert.equal(bobber.phase, "waiting");
  assert.notEqual(bobber.randomState, hookRandom);
  assert.deepEqual(
    events
      .filter((event) => ["approach", "bite", "miss"].includes(event.type))
      .map((event) => event.type),
    ["approach", "bite", "miss"]
  );
});

test("a nonpositive initial wait rerolls next tick and then counts the entire accepted wait", () => {
  for (const [
    seed,
    lure,
    rejectedTicks,
    rejectedState,
    acceptedTicks,
    acceptedState,
  ] of [
    [7, 3, -81, 1_025_555_898, 257, 3_923_423_697],
    [1972, 1, 0, 1_380_227, 73, 628_748_038],
  ]) {
    const world = aquaticWorld();
    const original = physicsBobber(world, {
      phase: "flying",
      remaining: 0,
      total: 0,
      openWater: false,
      randomState: seed,
      lure,
    });
    const before = structuredClone(original);
    const initial = stepFishingCast(world, original);
    assert.deepEqual(
      original,
      before,
      "the initial draw stays in a detached next record"
    );
    assert.equal(initial.bobber.phase, "wait-retry");
    assert.equal(initial.bobber.remaining, 0);
    assert.equal(initial.bobber.total, 0);
    assert.equal(initial.bobber.randomState, rejectedState);
    assert.deepEqual(initial.events, [
      { type: "splash" },
      { type: "wait-retry", waitTicks: rejectedTicks, openWater: true },
    ]);

    const retried = stepFishingCast(world, initial.bobber);
    assert.equal(retried.bobber.phase, "waiting");
    assert.equal(retried.bobber.total, acceptedTicks);
    assert.equal(
      retried.bobber.remaining,
      acceptedTicks,
      "accepting a roll does not decrement it"
    );
    assert.equal(retried.bobber.randomState, acceptedState);
    assert.deepEqual(retried.events, [
      {
        type: "waiting",
        seconds: acceptedTicks * FISHING_TICK,
        openWater: true,
      },
    ]);
    let bobber = retried.bobber;
    for (let tick = 1; tick < acceptedTicks; tick++) {
      const result = stepFishingCast(world, bobber);
      bobber = result.bobber;
      assert.equal(bobber.phase, "waiting");
      assert.equal(bobber.remaining, acceptedTicks - tick);
      assert.equal(bobber.randomState, acceptedState);
      assert.deepEqual(result.events, []);
    }
    const approach = stepFishingCast(world, bobber);
    assert.equal(
      approach.bobber.phase,
      "approach",
      "only a completed positive wait can start approach"
    );
    assert.ok(approach.bobber.total >= 20 && approach.bobber.total <= 80);
    assert.equal(
      approach.bobber.randomState,
      nextFishingRandom(nextFishingRandom(acceptedState).state).state
    );
    assert.deepEqual(
      approach.events.map((event) => event.type),
      ["approach"]
    );
  }
});

test("consecutive rejected waits consume separate ticks without shortening the valid reroll", () => {
  const world = aquaticWorld();
  let bobber = physicsBobber(world, {
    phase: "flying",
    total: 0,
    remaining: 0,
    randomState: 0,
    lure: 3,
    openWater: false,
  });
  for (const [phase, total, remaining, randomState, events] of [
    ["wait-retry", 0, 0, 1_013_904_223, ["splash", "wait-retry"]],
    ["wait-retry", 0, 0, 1_196_435_762, ["wait-retry"]],
    ["waiting", 210, 210, 3_519_870_697, ["waiting"]],
    ["waiting", 210, 209, 3_519_870_697, []],
  ]) {
    const result = stepFishingCast(world, bobber);
    bobber = result.bobber;
    assert.deepEqual(
      {
        phase: bobber.phase,
        total: bobber.total,
        remaining: bobber.remaining,
        randomState: bobber.randomState,
      },
      { phase, total, remaining, randomState }
    );
    assert.deepEqual(
      result.events.map((event) => event.type),
      events
    );
  }
});

test("physical bobbers collide with a loaded wall and freeze before unavailable columns", () => {
  const world = aquaticWorld();
  for (let y = 9; y <= 12; y++)
    for (let x = -1; x <= 1; x++) world.setCell(x, y, -1, { id: BLOCK.STONE });
  const launch = fishingLaunch(
    world,
    { x: 0.5, y: world.surface + 1.6, z: 0.5 },
    { x: 0, y: 0, z: -1 }
  );
  assert.ok(launch);
  const bobber = physicsBobber(world, {
    ...launch,
    phase: "flying",
    remaining: 0,
    total: 0,
  });
  const result = stepFishingCast(world, bobber);
  assert.equal(result.bobber.phase, "stuck");
  assert.ok(result.bobber.z >= 0.099);
  const frontier = aquaticWorld();
  frontier.loaded = (x) => x < 2;
  const flying = physicsBobber(frontier, {
    y: 10,
    vx: 24,
    phase: "flying",
    remaining: 0,
    total: 0,
  });
  const before = structuredClone(flying);
  assert.equal(stepFishingCast(frontier, flying), null);
  assert.deepEqual(flying, before);
});

test("currents move a waiting bobber, but flow or bubbles cannot qualify for treasure", () => {
  const world = aquaticWorld();
  let bobber = physicsBobber(world);
  const sampleFluid = (world, point) => {
    const sample = sharedAquaticSample(world, point);
    return sample && { ...sample, current: { x: 1, y: 0, z: 0 } };
  };
  for (let tick = 0; tick < 20; tick++)
    bobber = stepFishingCast(world, bobber, sampleFluid).bobber;
  assert.ok(bobber.x > 0.9);
  world.setCell(1, 8, 0, { id: BLOCK.WATER, fluid: FLUID.BUBBLE_UP });
  bobber = stepFishingCast(world, bobber, sampleFluid).bobber;
  assert.equal(bobber.openWater, false);
  world.setCell(1, 8, 0, { id: BLOCK.WATER });
  bobber = stepFishingCast(world, bobber, sampleFluid).bobber;
  assert.equal(
    bobber.openWater,
    false,
    "repair does not restore treasure within the same attempt"
  );
});
