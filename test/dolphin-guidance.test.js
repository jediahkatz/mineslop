import assert from "node:assert/strict";
import test from "node:test";
import { currentDolphinGuide, findDolphinGuide } from "../src/aquatic-ai.js";
import { GameEcologyMarkers } from "../src/game-ecology-markers.js";
import {
  ecologyFixture, ecologyState, ecologyStore, ecologyWorld,
  feedHook, fixtureLootObservation,
} from "./ecology-fixtures.js";

const from = { x: 0, y: 2, z: 0 };
const wreck = (id, x) => ({
  id, kind: "shipwreck", dimension: "overworld", origin: { x, y: 1, z: 0 },
});

test("loot-aware selection skips empty, destroyed and unknown sites; untouched and actual contents are worthwhile", () => {
  const descriptors = ["empty", "destroyed", "unknown", "untouched", "nonempty"]
    .map((status, index) => wreck(status, 8 + index * 4));
  descriptors[4].kind = "ocean_ruin";
  const observed = fixtureLootObservation(descriptors);
  observed.structures.forEach((structure) => {
    structure.containers[0].status = structure.id;
  });
  assert.equal(findDolphinGuide(from, "overworld", descriptors, observed).id, "untouched");
  observed.structures[3].containers[0].status = "empty";
  assert.equal(findDolphinGuide(from, "overworld", descriptors, observed).id, "nonempty");
  observed.structures[4].containers[0].status = "empty";
  assert.equal(findDolphinGuide(from, "overworld", descriptors, observed), null);
  assert.equal(findDolphinGuide(from, "overworld", descriptors), null);
});

test("selection uses useful chest distance instead of structure centers, with stable container ties", () => {
  const descriptors = [wreck("near-center", 8), wreck("near-loot", 30)];
  const observed = fixtureLootObservation(descriptors);
  observed.structures[0].containers[0].position.x = 20;
  observed.structures[1].containers = [
    { id: "z", position: { x: 10, y: 1, z: 0 }, status: "untouched" },
    { id: "a", position: { x: 0, y: 1, z: 10 }, status: "nonempty" },
  ];
  const guide = findDolphinGuide(from, "overworld", descriptors, observed);
  assert.equal(guide.id, "near-loot");
  assert.deepEqual(guide.position, { x: 30.5, y: 2, z: 0.5 },
    "saved position stays the legacy structure identity");
  const goal = { x: 0.5, y: 2, z: 10.5 };
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptors[1], observed).goal, goal);
  observed.structures[1].containers.reverse();
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptors[1], observed).goal, goal);
});

test("the existing host still returns no more than four structures within 64 despite nominal AI 8/96 requests", () => {
  const structures = Array.from({ length: 6 }, (_, i) => wreck(`near-${i}`, 10 + i));
  structures.unshift(wreck("out-of-host-range", 65));
  const column = { key: "0,0", complete: true, chunk: { structures } };
  const index = {
    columns: new Map([["0,0", column]]),
    current: (candidate) => candidate === column,
    limits: { columns: 512, descriptorsPerColumn: 8 },
    world: { dimension: "overworld" },
  };
  const markers = new GameEcologyMarkers(index);
  const supplied = markers.nearbyStructures(from, {
    dimension: "overworld", kinds: ["shipwreck", "ocean_ruin"], radius: 96, limit: 8,
  });
  assert.equal(supplied.length, 4);
  assert.deepEqual(supplied.map((entry) => entry.id), ["near-0", "near-1", "near-2", "near-3"]);
});

test("current chest goals retarget within the saved structure, distinguish exhaustion from unknown, and keep descriptor guards", () => {
  const descriptor = wreck("wreck", 12);
  const observed = fixtureLootObservation([descriptor]);
  const first = observed.structures[0].containers[0];
  const second = { id: "wreck/container/second", position: { x: 18, y: 1, z: 0 }, status: "nonempty" };
  observed.structures[0].containers.push(second);
  const guide = findDolphinGuide(from, "overworld", [descriptor], observed);
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptor, observed), {
    goal: { x: 12.5, y: 2, z: 0.5 }, exhausted: false,
  });
  first.status = "empty";
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptor, observed).goal,
    { x: 18.5, y: 2, z: 0.5 });
  second.status = "unknown";
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptor, observed),
    { goal: null, exhausted: false });
  second.status = "destroyed";
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide, descriptor, observed),
    { goal: null, exhausted: true });
  assert.deepEqual(currentDolphinGuide(from, "nether", guide, descriptor, observed),
    { goal: null, exhausted: false });
  assert.deepEqual(currentDolphinGuide(from, "overworld", guide,
    { ...descriptor, origin: { ...descriptor.origin, x: 13 } }, observed),
  { goal: null, exhausted: false });
});

for (const failure of ["null", "async", "changed-revision", "replaced-reader"])
  test(`a ${failure} availability observation cannot publish a paid feed`, () => {
    const world = ecologyWorld();
    const state = ecologyState(world, "dolphin", "guarded-loot-dolphin", from);
    const f = ecologyFixture({ world, entries: [state] }), mob = f.mobs.get(state.id);
    const fish = ecologyStore(f.coordinator, { RAW_COD: 2 });
    const descriptor = wreck("wreck", 12);
    f.structures.set(descriptor.id, descriptor);
    let revision = 0;
    const reader = (descriptors) => {
      const observed = fixtureLootObservation(descriptors), captured = revision;
      return { ...observed, validate: () => revision === captured };
    };
    f.ctx.observeLootAvailability = failure === "null" ? () => null :
      failure === "async" ? async () => fixtureLootObservation([descriptor]) : reader;
    const plan = f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: feedHook(fish) });
    assert.ok(plan);
    if (failure === "changed-revision") revision++;
    if (failure === "replaced-reader") f.ctx.observeLootAvailability = (descriptors) => reader(descriptors);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.equal(fish.value.RAW_COD, 2);
    assert.deepEqual(f.owner.state(mob.id), state);
  });

test("absent loot observers preserve Assistance but never invent guidance; paused legacy guide saves remain lossless", () => {
  const world = ecologyWorld();
  const state = ecologyState(world, "dolphin", "legacy-guide-dolphin", from, {
    assistTime: 0,
    guide: { id: "wreck", kind: "shipwreck", position: { x: 12.5, y: 2, z: 0.5 }, remaining: 77 },
  });
  const f = ecologyFixture({ world, entries: [state] }), mob = f.mobs.get(state.id);
  f.structures.set("wreck", wreck("wreck", 12));
  const saved = f.owner.serialize();
  f.owner.update(mob, 0, f.ctx);
  assert.deepEqual(f.owner.serialize(), saved);
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(f.owner.state(mob.id).guide.remaining, 76.9);
  assert.equal(mob.lookTarget, null);
  const fish = ecologyStore(f.coordinator, { RAW_COD: 1 });
  const plan = f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: feedHook(fish) });
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.owner.state(mob.id).guide, null);
  assert.equal(fish.value.RAW_COD, 0);
  assert.ok(f.owner.state(mob.id).assistTime > 0);
});
