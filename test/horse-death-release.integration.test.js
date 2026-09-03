import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { bodyBox, boxCollides } from "../src/collision.js";
import {
  findHorseDismount, horseBounds, horseDeathExitValid, horseSupport,
} from "../src/horse-collision.js";
import {
  HORSE_HEIGHT, HORSE_RADIUS, HORSE_RIDER_HEIGHT, HORSE_RIDER_RADIUS,
  HORSE_SEAT_HEIGHT, horseMotion,
} from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { loadedAquaticArea } from "../src/vehicle-water.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseFixture, horseRecord } from "./horse-fixture.js";

// Authored save isolation using the real World and every resource owner.
// It does not simulate a player reaching this ledge in Survival.
function deathFixture(t, {
  x = 8.5, y = 8, motion = { ...horseMotion(), vx: 1, vy: -2, vz: 0.5, grounded: false, fallDistance: 2 },
  hooks,
} = {}) {
  const f = horseFixture(t, { bind: false, hooks });
  const horses = { ...emptyHorseSnapshot(f.context), entries: [horseRecord("death:horse", {
    tamed: true, temper: 100, tamingTicksLeft: 0, rider: "player", motion,
    saddle: { id: ITEM.SADDLE, count: 1, data: { version: 1, name: "Retained trail saddle" } },
  })] };
  const mobs = mobSnapshot(f.context, "overworld", [mobRecord(f.context, "overworld", {
    id: "death:horse", kind: "horse", health: 24, yaw: 0, position: { x, y, z: 8.5 },
  })]);
  assert.equal(f.horses.load(horses), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.horse = f.wildlife.byId.get("death:horse");
  f.actor.position = { ...f.horses.riderPose().position };
  f.lethalPlan = () => {
    const stack = f.gameplay.getHandStack();
    const wear = f.gameplay.prepareHandCost("main", {
      stack, handRevision: f.gameplay.getHandRevision(), wear: 1, notify: false,
    });
    assert.ok(wear);
    return f.horses.prepareHit(f.horse.id, 999, null, {
      playerKill: true, validate: () => true, participants: [wear],
    });
  };
  return f;
}

test("death releases the exact unsupported seat with velocity, one tombstone and one complete resource commit", (t) => {
  let observed = false, f;
  f = deathFixture(t, { hooks: { onEvent: (event) => {
    if (event.type !== "death") return;
    assert.equal(f.horses.mountFor(), null);
    assert.equal(f.wildlife.byId.has(event.id), false);
    assert.deepEqual(f.horses.poseForArchive(), event.exit);
    observed = true;
    throw new Error("Postcommit death observer cannot roll back the airborne release");
  } } });
  const sword = f.hold("IRON_SWORD"), saddle = f.horses.state(f.horse.id).saddle;
  const seat = f.horses.riderPose(), generated = f.generated();
  assert.equal(findHorseDismount(f.world, f.horse), null);
  const before = f.ownership();
  for (const reason of ["input", "buck", "water"])
    assert.equal(f.horses.dismount("player", { reason }).reason, "no-safe-exit");
  assert.deepEqual(f.ownership(), before, "death fallback never loosens an ordinary exit");
  const plan = f.lethalPlan();
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.length, 5);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.horses, f.wildlife, f.gameplay, f.overflow, f.experience]));
  assert.deepEqual(plan.exit.position, seat.position, "no sideways/upward search or snapping");
  assert.deepEqual(plan.exit.velocity, seat.velocity);
  assert.equal(plan.exit.grounded, false);
  assert.equal(plan.exit.seated, false);
  assert.equal(horseSupport(f.world, plan.exit.position, HORSE_RIDER_RADIUS), null);
  assert.equal(boxCollides(f.world, bodyBox(plan.exit.position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT)), false);
  assert.deepEqual(f.ownership(), before, "preparation does not release the rider or resources");
  const result = f.horses.commit(plan);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(observed, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(result.handCostCommitted && result.dropsCommitted && result.experienceCommitted, true);
  assert.equal(f.gameplay.getHandStack().durability, sword.durability - 1);
  assert.equal(f.horse.dead, true);
  assert.equal(f.horse.health, 0);
  assert.deepEqual(f.horses.state(f.horse.id), { id: f.horse.id, dimension: "overworld", alive: false });
  assert.equal(f.wildlife.killed.has(f.horse.id), false);
  assert.equal(f.wildlife._retainedHorseIds.has(f.horse.id), false);
  assert.equal(f.wildlife.entities.includes(f.horse), false);
  assert.equal(f.horses.ownsMotionThisFrame(f.horse), true);
  assert.equal(f.totals().xp, result.experience);
  const drops = f.totals().drops;
  assert.equal(drops.length, 2);
  assert.equal(drops.find((drop) => drop.id === ITEM.SADDLE).count, 1);
  assert.deepEqual(drops.find((drop) => drop.id === ITEM.SADDLE).data, saddle.data);
  assert.equal(drops.find((drop) => drop.id === ITEM.LEATHER).count,
    result.drops.find((drop) => drop.id === ITEM.LEATHER).count);
  assert.deepEqual(f.horses.takeExitPose(), result.exit);
  assert.equal(f.horses.takeExitPose(), null);
  const committed = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.equal(f.horses.hurt(f.horse, 999).ok, false);
  assert.deepEqual(f.ownership(), committed);
  assert.equal(f.generated(), generated, "the fallback never requests terrain");
});

test("death clearance uses the player envelope after removal, never an enlarged horse body or a displaced seat", (t) => {
  const f = deathFixture(t);
  f.put([[9, 9, 8, BLOCK.STONE]]);
  assert.equal(boxCollides(f.world, bodyBox(f.horse.position, HORSE_RADIUS, HORSE_HEIGHT)), true);
  const seat = f.horses.riderPose();
  assert.equal(boxCollides(f.world, bodyBox(seat.position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT)), false);
  const plan = f.horses.prepareHit(f.horse.id, 999);
  assert.equal(plan.ok, true, "only the horse's own body is relinquished");
  for (const axis of ["x", "y", "z"]) {
    const displaced = { ...plan.exit, position: { ...plan.exit.position, [axis]: plan.exit.position[axis] + 0.1 } };
    assert.equal(horseDeathExitValid(f.world, f.horse, displaced), false);
  }
  assert.equal(f.horses.commit(plan).ok, true);
  assert.deepEqual(f.horses.takeExitPose().position, seat.position);
});

test("death still prefers a supported safe exit whenever one exists", (t) => {
  const f = deathFixture(t, { y: 1, motion: horseMotion() });
  const supported = findHorseDismount(f.world, f.horse);
  assert.ok(supported);
  const plan = f.horses.prepareHit(f.horse.id, 999);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.exit, supported);
  assert.equal(plan.exit.grounded, true);
  assert.equal(f.horses.commit(plan).ok, true);
});

test("a clear loaded rider seat can release beside a frontier outside its own envelope", (t) => {
  const f = deathFixture(t, { x: 14.15 }), seat = f.horses.riderPose();
  f.world._removeChunk("1,0", f.world.chunks.get("1,0"));
  const generated = f.generated();
  assert.equal(loadedAquaticArea(f.world, horseBounds(f.horse.position)), false);
  assert.equal(loadedAquaticArea(f.world, bodyBox(seat.position, HORSE_RIDER_RADIUS, HORSE_RIDER_HEIGHT)), true);
  const plan = f.horses.prepareHit(f.horse.id, 999);
  assert.equal(plan.ok, true, "a disappearing horse's wider envelope is not the player's envelope");
  assert.equal(f.horses.commit(plan).ok, true);
  assert.deepEqual(f.horses.takeExitPose().position, seat.position);
  assert.equal(f.generated(), generated);
});

test("an invalid or unknown current seat refuses death without wall/roof teleport or resource loss", (t) => {
  for (const obstacle of ["wall", "roof", "unknown"]) {
    const f = deathFixture(t);
    f.hold("IRON_SWORD");
    if (obstacle === "unknown") f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
    else f.put([[8, obstacle === "roof" ? 10 : 9, 8, BLOCK.STONE]]);
    const before = f.ownership(), generated = f.generated();
    assert.equal(f.horses.prepareHit(f.horse.id, 999).ok, false, "environment damage has no attack-ray shortcut");
    assert.equal(f.lethalPlan().ok, false, obstacle);
    assert.deepEqual(f.ownership(), before, obstacle);
    assert.equal(f.wildlife.byId.get(f.horse.id), f.horse);
    assert.equal(f.horses.mountFor().id, f.horse.id);
    assert.equal(f.horses._pendingExit, null);
    assert.equal(f.generated(), generated);
  }
});

test("airborne release exempts only the dying horse, never another active mob body", (t) => {
  const f = deathFixture(t);
  const other = f.wildlife.spawn("cow", f.horse.position, { id: "overlapping:cow", restoring: true });
  assert.ok(other);
  assert.equal(findHorseDismount(f.world, f.horse), null);
  const before = f.ownership();
  assert.equal(f.horses.prepareHit(f.horse.id, 999).reason, "no-safe-exit");
  assert.deepEqual(f.ownership(), before);
});

test("airborne death release rechecks loaded seat clearance at commit", (t) => {
  for (const obstacle of ["roof", "unknown"]) {
    const f = deathFixture(t);
    f.hold("IRON_SWORD");
    const plan = f.lethalPlan();
    assert.equal(plan.ok, true);
    if (obstacle === "unknown") f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
    else f.put([[8, 10, 8, BLOCK.STONE]]);
    const before = f.ownership();
    assert.equal(f.horses.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.horses._pendingExit, null);
  }
});

test("either real reward owner's veto leaves airborne horse, saddle, rider, XP and tool wholly unchanged", (t) => {
  for (const sink of ["drops", "experience"]) {
    const f = deathFixture(t);
    f.hold("IRON_SWORD");
    const owner = sink === "drops" ? f.overflow : f.experience;
    const method = sink === "drops" ? "prepareEnqueue" : "prepareSpawn";
    const prepare = owner[method].bind(owner);
    t.mock.method(owner, method, (...args) => {
      const participant = prepare(...args);
      assert.ok(participant);
      return Object.freeze({ ...participant, validate: () => false });
    });
    const before = f.ownership(), view = f.horse.horseView;
    const plan = f.lethalPlan();
    assert.equal(plan.ok, true);
    assert.equal(plan.exit.grounded, false);
    assert.equal(f.horses.commit(plan).ok, false, sink);
    assert.deepEqual(f.ownership(), before, sink);
    assert.equal(f.horse.horseView, view, "a veto cannot publish the dead presentation either");
    assert.equal(f.horses._pendingExit, null);
    assert.equal(f.wildlife.byId.get(f.horse.id), f.horse);
  }
});

test("a fatal bounded landing in an enclosed pen releases the validated landing seat without inventing support", (t) => {
  const f = deathFixture(t, {
    y: 1.1, motion: { vx: 0, vy: -8, vz: 0, grounded: false, fallDistance: 40 },
  });
  f.ring();
  assert.equal(findHorseDismount(f.world, f.horse), null);
  const result = f.horses.update(0.05, { controls: { player: {} }, frameId: "fatal-landing" });
  assert.equal(result.steps, 1);
  assert.equal(result.exits, 1);
  assert.equal(f.horses.state(f.horse.id).alive, false);
  const exit = f.horses.takeExitPose();
  assert.deepEqual(exit.position, { x: 8.5, y: 1 + HORSE_SEAT_HEIGHT, z: 8.5 });
  assert.equal(exit.grounded, false);
  assert.equal(horseSupport(f.world, exit.position, HORSE_RIDER_RADIUS), null);
  assert.equal(f.totals().xp, 0, "environmental death is not a player kill");
  assert.equal(f.totals().drops.length, 2);
});
