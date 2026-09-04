import assert from "node:assert/strict";
import test from "node:test";
import { createAnimalBehavior } from "../src/animal-behavior.js";
import { stepMob } from "../src/mob-ai.js";
import { animalContext, animalMob, flatWorld } from "./animal-behavior-fixture.js";

const physicalState = (mob) => ({
  position: mob.position.toArray(),
  yaw: mob.root.rotation.y,
  groundY: mob.groundY,
  velocityY: mob.velocityY,
  knockback: { ...mob.knockback },
  moving: mob.moving,
  targetYaw: mob.targetYaw,
});

test("motion authority suppresses generic physics for bareback, untamed and just-dismounted horses", () => {
  for (const flags of [
    { tamed: false, saddled: false },
    { tamed: true, saddled: false },
    { tamed: true, saddled: true },
    { tamed: false, saddled: false, justDismounted: true },
  ]) {
    const mob = animalMob("horse");
    Object.assign(mob, flags, {
      velocityY: 3, knockback: { x: 2, z: -1 }, moving: true,
    });
    mob.root.rotation.y = 0.7;
    const before = physicalState(mob);
    const world = {
      dimension: "overworld",
      isLoaded() { throw new Error("generic rider footprint read"); },
      get() { throw new Error("generic rider geometry read"); },
    };
    let authorityChecks = 0;
    const ctx = animalContext(world, {
      ownsMotionThisFrame(candidate) {
        authorityChecks++;
        assert.equal(candidate, mob);
        return true;
      },
      relocate() { throw new Error("generic rider teleport"); },
      cull() { throw new Error("generic rider removal"); },
    });
    for (let substep = 0; substep < 4; substep++) stepMob(mob, 0.05, ctx);
    assert.equal(authorityChecks, 4);
    assert.deepEqual(physicalState(mob), before);
    assert.equal(mob.animalIntent, "controlled");
    assert.equal(mob.grazing, false);
  }
});

test("retention and tamed/saddled flags do not claim motion after the owner releases a frame", () => {
  const mob = animalMob("horse", { x: 0.5, y: 10, z: 0.5 });
  mob.tamed = mob.saddled = true;
  let ownedThisFrame = true;
  const ctx = animalContext(flatWorld(), {
    ownsMotionThisFrame: () => ownedThisFrame,
    retainsMob: () => true,
  });
  stepMob(mob, 0.1, ctx);
  assert.equal(mob.position.y, 10);
  ownedThisFrame = false;
  stepMob(mob, 0.1, ctx);
  assert.ok(mob.position.y < 10, "generic gravity resumes on the next unowned frame");
  assert.notEqual(mob.animalIntent, "controlled");
  assert.equal(mob.dead, false);
});

test("an explicitly retained creature with missing support is not relocated or culled", () => {
  const mob = animalMob("horse");
  const before = physicalState(mob);
  const ctx = animalContext(flatWorld({ height: -1 }), {
    retainsMob: (candidate) => candidate === mob,
    relocate() { throw new Error("retention is not wolf-style teleport permission"); },
    cull() { throw new Error("retained creature removal"); },
  });
  stepMob(mob, 0.1, ctx);
  assert.deepEqual(mob.position.toArray(), before.position);
  assert.equal(mob.health, mob.spec.health);
  assert.equal(mob.dead, false);
});

test("an unloaded footprint stops generic AI before reads, relocation or culling", () => {
  const world = flatWorld({ loaded: (x) => x < 16 });
  const mob = animalMob("horse", { x: 15.9, y: 9, z: 0.5 });
  const before = physicalState(mob);
  const ctx = animalContext(world, {
    retainsMob: () => true,
    relocate() { throw new Error("unloaded relocation"); },
    cull() { throw new Error("unloaded removal"); },
  });
  stepMob(mob, 0.1, ctx);
  assert.deepEqual(physicalState(mob), before);
  assert.equal(world.unloadedReads, 0);
});

test("Peaceful suppresses retained hostile simulation before burn, attacks or death side effects", () => {
  for (const kind of ["zombie", "creeper", "enderman"]) {
    const mob = animalMob(kind);
    Object.assign(mob, { angry: 20, fuse: 1.64, attacking: true, fusing: true });
    const before = physicalState(mob);
    const world = {
      dimension: "overworld",
      isLoaded() { throw new Error("suppressed hostile simulation"); },
    };
    const forbidden = () => { throw new Error("Peaceful combat or removal"); };
    const ctx = animalContext(world, {
      difficulty: "peaceful", timeOfDay: 0.5,
      retainsMob: () => true,
      hurt: forbidden, damagePlayer: forbidden, shoot: forbidden,
      explodeMob: forbidden, relocate: forbidden, cull: forbidden,
      isLookingAt: forbidden,
    });
    stepMob(mob, 0.1, ctx);
    assert.deepEqual(mob.position.toArray(), before.position);
    assert.equal(mob.health, mob.spec.health);
    assert.equal(mob.dead, false);
    assert.equal(mob.angry, 0);
    assert.equal(mob.fuse, 0);
    assert.equal(mob.attacking, false);
  }
});

test("legacy and explicit Normal preserve hostile pursuit, melee and Enderman provocation", () => {
  const results = [];
  for (const difficulty of [undefined, "normal"]) {
    const mob = animalMob("zombie");
    const hits = [];
    const ctx = animalContext(flatWorld(), {
      difficulty,
      player: { x: 1.5, y: 9, z: 0.5 },
      playerEye: { x: 1.5, y: 10.62, z: 0.5 },
      damagePlayer: (damage) => hits.push(damage),
    });
    for (let step = 0; step < 12; step++) stepMob(mob, 0.05, ctx);
    assert.ok(hits.length > 0);
    results.push({ state: physicalState(mob), hits });
  }
  assert.deepEqual(results[0], results[1]);
  const enderman = animalMob("enderman");
  const ctx = animalContext(flatWorld(), { isLookingAt: () => true });
  for (let step = 0; step < 15; step++) stepMob(enderman, 0.05, ctx);
  assert.ok(enderman.angry > 0);
  assert.equal(enderman.position.x, 0.5, "gaze freezes an angry Enderman");
  ctx.isLookingAt = () => false;
  stepMob(enderman, 0.05, ctx);
  assert.ok(enderman.position.x > 0.5);
});

test("wolf companionship still follows and bites but cannot attack in Peaceful", () => {
  for (const difficulty of ["normal", "peaceful"]) {
    const wolf = animalMob("wolf");
    wolf.tamed = true;
    const target = animalMob("zombie", { x: 1.5, y: 9, z: 0.5 });
    let bites = 0;
    const ctx = animalContext(flatWorld(), {
      difficulty,
      wolfTarget: () => target,
      hurt: () => { bites++; },
    });
    for (let step = 0; step < 12; step++) stepMob(wolf, 0.05, ctx);
    assert.equal(bites > 0, difficulty === "normal");
    if (difficulty === "peaceful") assert.ok(wolf.position.x > 0.5);
    assert.equal(wolf.tamed, true);
    assert.equal(wolf.dead, false);
  }
});

test("a refused audio call still advances the timer before observing the exact sound API", () => {
  const cow = animalMob("cow");
  cow.animalBehavior = { ...createAnimalBehavior(cow.id), callIn: 0.02 };
  const calls = [];
  const effects = {
    sound(...args) { calls.push(args); return false; },
  };
  const ctx = animalContext(flatWorld(), {
    random() { throw new Error("animal intent must not consume host RNG"); },
    onAnimalEvent: (mob) => effects.sound("animal", mob.kind, {
      position: { x: mob.position.x, y: mob.position.y, z: mob.position.z },
    }),
  });
  stepMob(cow, 0.05, ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "animal", "cow", { position: { x: 0.5, y: 9, z: 0.5 } },
  ]);
  assert.ok(cow.animalBehavior.callIn >= 12 && cow.animalBehavior.callIn <= 30);
  for (let step = 0; step < 10; step++) stepMob(cow, 0.05, ctx);
  assert.equal(calls.length, 1);
});

test("owned motion uses the same spent vocalization opportunities and full three-dimensional range", () => {
  const horse = animalMob("horse");
  horse.animalBehavior = { ...createAnimalBehavior(horse.id), callIn: 0 };
  let calls = 0;
  const ctx = animalContext(flatWorld(), {
    ownsMotionThisFrame: () => true,
    player: { x: 0.5, y: 80, z: 0.5 },
    onAnimalEvent: () => { calls++; return false; },
  });
  stepMob(horse, 0.05, ctx);
  assert.equal(calls, 0);
  assert.ok(horse.animalBehavior.callIn >= 12);
  ctx.player.y = 9;
  stepMob(horse, 0.05, ctx);
  assert.equal(calls, 0);
});

test("frame-owned horses spend due calls silently when their footprint unloads", () => {
  const world = flatWorld({ loaded: () => false });
  const horse = animalMob("horse");
  horse.animalBehavior = { ...createAnimalBehavior(horse.id), callIn: 0 };
  const before = physicalState(horse);
  const ctx = animalContext(world, {
    ownsMotionThisFrame: () => true,
    onAnimalEvent() { throw new Error("unloaded animal voice"); },
  });
  stepMob(horse, 0.05, ctx);
  assert.deepEqual(physicalState(horse), before);
  assert.ok(horse.animalBehavior.callIn >= 12);
  assert.equal(world.unloadedReads, 0);
});
