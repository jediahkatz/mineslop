import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { MAX_STEP_HEIGHT } from "../src/collision.js";
import { horseClear, horseEnvironment } from "../src/horse-collision.js";
import { horseMotion } from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseFixture, horseRecord } from "./horse-fixture.js";

/** Authored tamed archive for physics isolation. The taming workflow has its
 * own real-owner integration tests; this setup is not a claim of player play.
 */
function riding(t, { y = 1, motion = horseMotion(), saddled = true, hooks } = {}) {
  const f = horseFixture(t, { bind: false, hooks });
  const saved = { ...emptyHorseSnapshot(f.context), entries: [horseRecord("physics:horse", {
    tamed: true, temper: 100, tamingTicksLeft: 0, rider: "player", motion,
    saddle: saddled ? { id: ITEM.SADDLE, count: 1 } : null,
  })] };
  const mobs = mobSnapshot(f.context, "overworld", [mobRecord(f.context, "overworld", {
    id: "physics:horse", kind: "horse", health: 24, yaw: Math.PI,
    position: { x: 8.5, y, z: 8.5 },
  })]);
  assert.equal(f.horses.load(saved), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses: saved }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.horse = f.wildlife.byId.get("physics:horse");
  f.actor.position = { ...f.horses.riderPose().position };
  return f;
}

const wall = (z, heights, id = BLOCK.STONE) =>
  heights.flatMap((y) => Array.from({ length: 10 }, (_, index) => [index + 4, y, z, id]));

test("loaded bounded sweeps stop a fast horse AND its rider at a solid wall without requesting terrain", (t) => {
  const f = riding(t), initial = f.horse.position.clone(), generated = f.generated();
  f.put(wall(5, [1, 2, 3, 4, 5]));
  t.mock.method(f.world, "_generateSync", () => assert.fail("riding must not request terrain"));
  f.tick(50, { forward: 1, yaw: 0 });
  assert.ok(f.horse.position.z < initial.z);
  assert.ok(f.horse.position.z >= 6.88 - 1e-6);
  assert.equal(horseClear(f.world, f.horse.position, true), true);
  assert.equal(f.generated(), generated);
  assert.equal(MAX_STEP_HEIGHT, 0.6);
  assert.equal(f.horses.riderPose().hullYaw, 0, "horse +Z heading is converted to player -Z convention");
});

test("one-block stepping works, but a low rider ceiling, two-block wall and fence stop it", (t) => {
  const open = riding(t);
  open.put(wall(6, [1]));
  let maximum = open.horse.position.y;
  for (let index = 0; index < 25; index++) {
    open.tick(1, { forward: 1, yaw: 0 });
    maximum = Math.max(maximum, open.horse.position.y);
    assert.equal(horseClear(open.world, open.horse.position, true), true);
  }
  assert.ok(maximum >= 2 - 1e-6, "only the horse solver may step a full block");
  assert.equal(MAX_STEP_HEIGHT, 0.6);

  for (const obstacle of ["ceiling", "two-block", "fence"]) {
    const f = riding(t);
    f.put(wall(6, obstacle === "two-block" ? [1, 2] : [1],
      obstacle === "fence" ? BLOCK.OAK_FENCE : BLOCK.STONE));
    if (obstacle === "ceiling")
      f.put(Array.from({ length: 7 }, (_, x) => Array.from({ length: 7 }, (_, z) =>
        [x + 5, 4, z + 4, BLOCK.STONE])).flat());
    f.tick(25, { forward: 1, yaw: 0 });
    assert.ok(f.horse.position.y < 1.01, obstacle);
    assert.ok(f.horse.position.z > 7, obstacle);
    assert.equal(horseClear(f.world, f.horse.position, true), true, obstacle);
  }
});

test("charged jump rises, lands under gravity and has no hoof sounds while airborne", (t) => {
  const f = riding(t);
  f.tick();
  f.tick(20, { jump: true, yaw: 0 });
  assert.equal(f.horses.getHorse(f.horse.id).jumpCharge, 1);
  f.tick(1, { jump: false, yaw: 0 });
  assert.equal(f.horses.state(f.horse.id).motion.grounded, false);
  assert.ok(f.horses.state(f.horse.id).motion.vy > 0);
  let maximum = f.horse.position.y;
  for (let index = 0; index < 40; index++) {
    const airborne = !f.horses.state(f.horse.id).motion.grounded;
    const sounds = f.events.filter((event) => event.type === "horse-step").length;
    f.tick();
    maximum = Math.max(maximum, f.horse.position.y);
    assert.equal(horseClear(f.world, f.horse.position, true), true);
    if (airborne) assert.equal(f.events.filter((event) => event.type === "horse-step").length, sounds);
  }
  assert.ok(maximum > 2.5);
  assert.equal(f.horse.position.y, 1);
  assert.equal(f.horses.state(f.horse.id).motion.grounded, true);
  assert.equal(f.horses.state(f.horse.id).motion.fallDistance, 0);
});

test("restoring with Space held resets charge/latches, and a rider ceiling clips ascent safely", (t) => {
  const f = riding(t);
  f.tick();
  f.tick(20, { jump: true });
  const restored = horseFixture(t, { saved: f.snapshot() });
  const horse = restored.wildlife.byId.get(f.horse.id);
  restored.tick(5, { jump: true });
  restored.tick(1, { jump: false });
  assert.equal(horse.position.y, 1, "saved charge cannot fire a reload jump");
  assert.equal(restored.horses.getHorse(horse.id).jumpCharge, 0);
  restored.put(Array.from({ length: 3 }, (_, x) => Array.from({ length: 3 }, (_, z) =>
    [x + 7, 4, z + 7, BLOCK.STONE])).flat());
  restored.tick(20, { jump: true });
  restored.tick(1, { jump: false });
  assert.ok(horse.position.y <= 1.25 + 1e-6, "rider envelope reaches 2.75 above horse feet");
  assert.equal(horseClear(restored.world, horse.position, true), true);
});

test("unknown frontiers freeze airborne pose, velocity, fall and attempts, then resume only after admission", (t) => {
  const f = riding(t, { y: 7, motion: { vx: 1, vy: -4, vz: -1, grounded: false, fallDistance: 2 } });
  const position = f.horse.position.clone(), motion = f.horses.state(f.horse.id).motion;
  const generated = f.generated();
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  f.tick(5, { forward: 1, jump: true, yaw: 0 });
  assert.deepEqual(f.horse.position, position);
  assert.deepEqual(f.horses.state(f.horse.id).motion, motion);
  assert.equal(f.horses.mountFor().id, f.horse.id);
  assert.equal(f.wildlife.entities.includes(f.horse), true, "frozen rider never loses motion ownership");
  assert.equal(f.generated(), generated);
  f.world._generateSync(0, 0);
  f.tick();
  assert.ok(f.horse.position.y < position.y);
});

test("shallow water slows grounded travel; deep water blocks mount/jump and keeps an unsafe exit owned", (t) => {
  const dry = riding(t), wet = riding(t);
  const lake = (y, id) => Array.from({ length: 10 }, (_, x) =>
    Array.from({ length: 15 }, (_, z) => [x + 4, y, z, id])).flat();
  wet.put(lake(1, BLOCK.WATER));
  assert.equal(horseEnvironment(wet.world, wet.horse.position).water, "shallow");
  const dryStart = dry.horse.position.z, wetStart = wet.horse.position.z;
  dry.tick(8, { forward: 1, yaw: 0 });
  wet.tick(8, { forward: 1, yaw: 0 });
  assert.ok(wetStart - wet.horse.position.z < (dryStart - dry.horse.position.z) * 0.75);
  wet.put(lake(2, BLOCK.WATER));
  assert.equal(horseEnvironment(wet.world, wet.horse.position).water, "deep");
  const before = wet.horse.position.clone();
  wet.tick(25, { forward: 1, yaw: 0, jump: true, dismount: true });
  wet.tick(1, { jump: false });
  assert.deepEqual(wet.horse.position, before);
  assert.equal(wet.horses.mountFor().id, wet.horse.id);
  assert.equal(wet.horses.dismount().reason, "no-safe-exit");
  assert.equal(wet.horses.releasePassenger("player", { travelling: true }).ok, true);
  wet.hold(null);
  assert.equal(wet.horses.mount(wet.horse.id).reason, "unsafe-mount");
});

test("ordinary exits require a loaded swept supported nonhazardous path, not just an empty endpoint", (t) => {
  for (const obstacle of ["stone", "lava"]) {
    const f = riding(t);
    f.ring(obstacle === "stone" ? BLOCK.STONE : BLOCK.LAVA);
    const before = f.ownership();
    assert.equal(f.horses.dismount().reason, "no-safe-exit", obstacle);
    assert.deepEqual(f.ownership(), before);
    f.ring(BLOCK.AIR);
    const plan = f.horses.prepareDismount();
    assert.equal(plan.ok, true);
    const { x, y, z } = plan.exit.position;
    f.put([[Math.floor(x), Math.floor(y) + 1, Math.floor(z), BLOCK.STONE]]);
    const blocked = f.ownership();
    assert.equal(f.horses.commit(plan).ok, false, "stale path cannot teleport through a new ceiling");
    assert.deepEqual(f.ownership(), blocked);
  }
});

test("a damaging landing participates with health/death; a refused sink does not reset fall or move the horse", (t) => {
  const f = riding(t, {
    y: 1.1, motion: { vx: 0, vy: -8, vz: 0, grounded: false, fallDistance: 40 },
    hooks: { prepareDrops: () => null },
  });
  const before = f.ownership();
  const result = f.horses.update(0.05, { controls: { player: {} }, frameId: 900 });
  assert.equal(result.steps, 0);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horse.health, 24);
  assert.equal(f.horses.state(f.horse.id).motion.fallDistance, 40);
});

test("only actual grounded strides produce the horse-step event, never stationary charge or bareback input", (t) => {
  const f = riding(t);
  f.tick(20, { forward: 1, yaw: 0 });
  assert.ok(f.events.some((event) => event.type === "horse-step" && Number.isInteger(event.blockId)));
  const stopped = riding(t, { saddled: false });
  stopped.tick(20, { forward: 1, yaw: 0, jump: true });
  assert.equal(stopped.events.filter((event) => event.type === "horse-step").length, 0);
  assert.equal(stopped.horses.state(stopped.horse.id).rider, "player");
});

test("other horses' damage/death cannot erase the mounted horse's charge", (t) => {
  const f = riding(t);
  const other = f.spawn("other:horse", { x: 12.5, y: 1, z: 8.5 });
  assert.equal(f.horses.track(other.id).ok, true);
  f.tick();
  f.tick(10, { jump: true });
  const charge = f.horses.getHorse(f.horse.id).jumpCharge;
  assert.ok(charge > 0.4);
  assert.equal(f.horses.hurt(other, 1).ok, true);
  assert.equal(f.horses.getHorse(f.horse.id).jumpCharge, charge);
  assert.equal(f.horses.hurt(other, 999).ok, true);
  assert.equal(f.horses.getHorse(f.horse.id).jumpCharge, charge);
  f.tick(1, { jump: false });
  assert.ok(f.horses.state(f.horse.id).motion.vy > 0);
});

test("an unseated airborne handoff can advance after the rider without consuming rider input", (t) => {
  const f = horseFixture(t, { bind: false });
  const saved = { ...emptyHorseSnapshot(f.context), entries: [
    horseRecord("pilot", { tamed: true, tamingTicksLeft: 0, rider: "player",
      saddle: { id: ITEM.SADDLE, count: 1 }, motion: horseMotion() }),
    horseRecord("handoff", { motion: { ...horseMotion(), grounded: false, vy: -1 } }),
  ] };
  const mobs = mobSnapshot(f.context, "overworld", [
    mobRecord(f.context, "overworld", { id: "pilot", kind: "horse", health: 24,
      position: { x: 8.5, y: 1, z: 8.5 } }),
    mobRecord(f.context, "overworld", { id: "handoff", kind: "horse", health: 24,
      position: { x: 12.5, y: 10, z: 8.5 } }),
  ]);
  assert.equal(f.horses.load(saved), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses: saved }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.tick();
  f.tick(5, { jump: true });
  assert.ok(f.wildlife.byId.get("handoff").position.y < 10);
  assert.ok(f.horses.getHorse("pilot").jumpCharge > 0.2);
});

test("riding keeps fixed ownership bytes and never serializes a complete owner per frame", (t) => {
  const f = riding(t), bytes = f.coordinator.budget.totalBytes, reserved = f.horses.reservedBytes;
  for (const owner of [f.horses, f.wildlife, f.gameplay, f.overflow, f.experience, f.world])
    t.mock.method(owner, "serialize", () => assert.fail("frame must not serialize whole owner state"));
  f.tick(20, { forward: 1, yaw: 0 });
  assert.equal(f.horses.reservedBytes, reserved);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.ok(f.horse.position.z < 8.5);
});

test("the AI handoff is anchored where the horse was ridden and never reapplies a mounted hit impulse", (t) => {
  const f = riding(t);
  f.tick(20, { forward: 1, yaw: 0 });
  assert.deepEqual(f.horse.home, f.horse.position);
  assert.equal(f.horses.hurt(f.horse, 1, { x: 1, y: 0, z: 0 }).ok, true);
  assert.ok(f.horses.state(f.horse.id).motion.vx > 0);
  assert.deepEqual(f.horse.knockback, { x: 0, z: 0 });
  assert.equal(f.horses.dismount().ok, true);
  assert.deepEqual(f.horse.home, f.horse.position);
});
