import assert from "node:assert/strict";
import test from "node:test";
import { horseSeat } from "../src/horse-definitions.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

test("Game empty-hand use mounts the existing bareback Wildlife horse without a walking or flight tick", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  const base = point(mob.position), count = f.wildlife.byId.size;
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.horses.mountFor().id, mob.id);
  assert.equal(f.wildlife.byId.get(mob.id), mob);
  assert.equal(f.wildlife.byId.size, count);
  assert.equal(f.player.vehicleType, "horse");
  assert.deepEqual(point(f.player.position), horseSeat(base));
  assert.equal(f.horses.state(mob.id).tamed, false);
  assert.equal(f.horses.state(mob.id).saddle, null);
  assert.equal(f.vehicles.openHorseInventory().ok, false);
  f.player.allowFlight = true;
  f.key("KeyW");
  f.key("Space");
  f.frame(2);
  assert.deepEqual(point(mob.position), base, "bareback ownership suppresses both steering and generic AI");
  assert.equal(f.player.vehicleKeys.has("Space"), true, "repeated horse poses preserve raw Space");
  assert.equal(f.horses.getHorse(mob.id).jumpCharge, 0);
  assert.equal(f.player.flying, false);
  assert.equal(f.player.moving, false);
  assert.equal(f.player.sprinting, false);
  assert.equal(f.player._jumpQueued, false);
  assert.equal(f.player._spaceTapAt, null);
  assert.equal(f.player._forwardTapAt, null);
  assert.equal(f.calls.sounds.some(([event]) => event === "step"), false);
});

test("real Game riding charges/release-jumps and publishes horse view, hull heading and grounded hoof sounds", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  await f.saddle(mob);
  f.player.perspective = "back";
  f.frame();
  const yaw = f.player.yaw, before = point(mob.position), events = [];
  let rendered;
  for (const [owner, method, name] of [
    [f.vehicles, "beginFrame", "begin"],
    [f.horses, "update", "horse"],
    [f.player, "update", "player"],
    [f.wildlife, "update", "wildlife"],
    [f.ecology, "beginFrame", "ecology"],
  ]) {
    const original = owner[method];
    t.mock.method(owner, method, function (...args) {
      events.push(name);
      return Reflect.apply(original, this, args);
    });
  }
  const visual = f.game.playerVisual.update;
  t.mock.method(f.game.playerVisual, "update", function (dt, view) {
    rendered = view;
    return Reflect.apply(visual, this, [dt, view]);
  });
  f.key("KeyW");
  f.frame(12);
  f.key("KeyW", false);
  assert.ok(Math.hypot(mob.position.x - before.x, mob.position.z - before.z) > 1);
  assert.equal(f.player.yaw, yaw, "hull turns never overwrite the physical steering aim");
  assert.equal(rendered.vehicleType, "horse");
  assert.equal(rendered.hullYaw, f.player.hullHeading);
  assert.equal(rendered.horseView, mob.horseView, "the presentation consumes the committed base view");
  assert.equal(rendered.horseView.saddled, true);
  assert.equal(rendered.horseView.ridden, true);
  assert.equal(Object.isFrozen(rendered.horseView), true);
  assert.ok(events.indexOf("begin") < events.indexOf("horse"));
  assert.ok(events.indexOf("horse") < events.indexOf("player"));
  assert.ok(events.indexOf("player") < events.indexOf("wildlife"));
  assert.ok(events.indexOf("wildlife") < events.indexOf("ecology"));
  assert.ok(f.calls.sounds.some(([event, , options]) =>
    event === "horse-step" && Object.values(options.position).every(Number.isFinite)));
  assert.equal(f.calls.sounds.some(([event]) => event === "step"), false);
  f.frame(10);
  f.key("Space");
  f.frame(10);
  assert.ok(f.horses.getHorse(mob.id).jumpCharge >= 0.45);
  assert.equal(f.player.vehicleKeys.has("Space"), true);
  const groundedY = mob.position.y;
  f.key("Space", false);
  const soundCount = f.calls.sounds.length;
  f.frame();
  assert.ok(mob.position.y > groundedY);
  assert.ok(f.player.velocity.y > 0);
  assert.equal(f.player.grounded, false);
  assert.equal(f.horses.state(mob.id).motion.grounded, false);
  assert.equal(f.horses.getHorse(mob.id).jumpCharge, 0);
  assert.equal(f.calls.sounds.slice(soundCount).some(([event]) =>
    event === "horse-step" || event === "step"), false);
  assert.equal(f.player.flying, false);
});

test("input resets, overlays and same-frame dismounts never leak horse charge into walking controls", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  await f.saddle(mob);
  f.frame();
  f.key("Space");
  f.frame(6);
  assert.ok(f.horses.getHorse(mob.id).jumpCharge > 0);
  f.withGlobals(() => f.document.dispatchEvent(new Event("pointercancel")));
  assert.equal(f.player.vehicleKeys.size, 0);
  assert.equal(f.horses.getHorse(mob.id).jumpCharge, 0);
  f.frame();
  f.key("Space");
  f.frame(4);
  assert.ok(f.horses.getHorse(mob.id).jumpCharge > 0);
  f.key("KeyE");
  assert.equal(f.vehicles.horseInventory.isOpen, true);
  assert.equal(f.game.active, false);
  assert.equal(f.game.simulating, true);
  assert.equal(f.player.enabled, false);
  assert.equal(f.player.vehicleKeys, null);
  assert.equal(f.player._keys.size, 0);
  assert.equal(f.horses.getHorse(mob.id).jumpCharge, 0);
  assert.equal(f.vehicles.dismount().ok, false);
  f.frame();
  await f.closeHorse();
  f.frame();
  f.key("KeyW");
  f.key("Space");
  f.key("ControlLeft");
  f.key("ShiftLeft");
  let claimed;
  const update = f.wildlife.update;
  t.mock.method(f.wildlife, "update", function (...args) {
    claimed = f.horses.ownsMotionThisFrame(mob);
    return Reflect.apply(update, this, args);
  });
  f.frame();
  assert.equal(claimed, true, "the late AI pass cannot claim a horse released earlier in this frame");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.vehicleType, null);
  assert.equal(f.player.hullHeading, null);
  assert.equal(f.player.vehicleKeys.has("Space"), false);
  assert.equal(f.player.vehicleKeys.has("KeyW"), false);
  assert.equal(f.player.vehicleKeys.has("ShiftLeft"), false);
  assert.equal(f.player.vehicleKeys.has("ControlLeft"), false);
  assert.equal(f.player._jumpQueued, false);
  assert.equal(f.player._sprintLatched, false);
  assert.equal(f.vehicles.takeExitPose(), null);
});

test("untagged historical and tagged boat poses still suppress Space and keep independent aim", async (t) => {
  const f = await gameMobFixture(t);
  for (const vehicleType of [undefined, "boat"]) {
    f.player.setPosition(f.world.getSpawn());
    const yaw = f.player.yaw;
    const pose = {
      ...(vehicleType ? { vehicleType } : {}),
      dimension: f.world.dimension, position: point(f.player.position),
      velocity: { x: 0, y: 0, z: 0 }, hullYaw: 0.8, seated: true, grounded: false,
    };
    assert.equal(f.player.update(0, { riderPose: pose }), true);
    f.key("Space");
    assert.equal(f.player.update(0, { riderPose: pose }), true);
    assert.equal(f.player.vehicleKeys.has("Space"), false);
    assert.equal(f.player.yaw, yaw);
    assert.equal(f.player.flying, false);
    assert.equal(f.player.vehicleType, vehicleType ?? null);
  }
});
