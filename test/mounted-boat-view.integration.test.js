import assert from "node:assert/strict";
import test from "node:test";
import { dispatch } from "./control-fixture.js";
import {
  assertPhysicalAim, boatView, boatViewFixture, near, shortestTurn,
} from "./mounted-boat-view-fixture.js";

// CPU owner regressions, not the browser/native Survival acceptance route.
const options = { timeout: 15_000, concurrency: false };
const transport = (row) => {
  assert.equal(row.result, true, "the real Player must accept the committed pose");
  const delta = shortestTurn(row.riderPose.hullYaw - row.before.heading);
  near(row.after.yaw, row.before.yaw + delta, "accepted hull delta carried to physical yaw");
  near(row.after.pitch, row.before.pitch, "hull yaw cannot alter pitch");
  return row.before.yaw + delta;
};

test("real Boats and host rider projections explicitly identify boats without adding archive fields", options, (t) => {
  const f = boatViewFixture(t);
  const mounted = f.mount();
  assert.equal(mounted.result, true);
  const archive = f.service.serialize();
  assert.equal(Object.hasOwn(archive.boats.boats[0], "vehicleType"), false);
  const leaf = f.service.boats.riderPose();
  assert.deepEqual(f.service.riderPose(), leaf);
  assert.deepEqual(f.service.poseForArchive(), leaf);
  assert.equal(leaf.vehicleType, "boat", "type is a runtime pose discriminator, not saved state");
  assert.equal(f.player.vehicleType, "boat");
  assert.deepEqual(f.service.serialize(), archive, "reading/consuming poses never rewrites the archive");
});

for (const [key, sign] of [["KeyA", 1], ["KeyD", -1]]) {
  test(`real ${key} steering carries shortest hull rotation through native consumption, coast and dt=0 exactly once`, options, async (t) => {
    const f = boatViewFixture(t, { hullYaw: sign * (Math.PI - 0.005) });
    f.player.inputMode = "native";
    assert.equal(await f.player.lock(), true);
    const mounted = f.mount();
    near(mounted.after.yaw, mounted.before.yaw, "mount cannot snap to hull heading");
    near(mounted.after.pitch, mounted.before.pitch, "mount pitch");
    dispatch(f.controls.document, "mousemove", { movementX: 125, movementY: -60 });
    const looked = boatView(f.player);
    const same = f.consume();
    near(same.after.yaw, looked.yaw, "relative mouse look survives identical pose delivery");
    near(same.after.pitch, looked.pitch, "relative mouse pitch survives pose delivery");
    const retained = f.retained();
    f.key(key);
    const turned = f.advance();
    const hull = f.service.boats.getBoat(1);
    const row = f.consume(0.05);
    assert.deepEqual(f.service.boats.getBoat(1), hull, "Player cannot run another hull step");
    f.key(key, false);
    f.game.overlayOpen = true;
    f.player.enabled = false;
    const coast = f.advance();
    const drifting = f.consume();
    const repeated = f.consume();
    assert.deepEqual(f.retained(), retained, "view transport changes no world, items, XP or reservations");
    assert.deepEqual(f.service._controls.player, { forward: 0, turn: 0, dismount: false });
    assert.ok(Math.abs(turned.rider.hullYaw - turned.before.hullYaw) > 6,
      "actual boat physics crosses the +/-pi representation boundary");
    assert.ok(sign * shortestTurn(turned.rider.hullYaw - turned.before.hullYaw) > 0);
    assert.ok(sign * shortestTurn(coast.rider.hullYaw - coast.before.hullYaw) > 0,
      "angular inertia persists after raw steering input is released");
    near(repeated.after.yaw, repeated.before.yaw, "a repeated zero-time pose cannot turn twice");
    near(repeated.after.pitch, repeated.before.pitch);
    transport(row);
    const expected = transport(drifting);
    assertPhysicalAim(f, expected, looked.pitch);
  });
}

test("native mouse/arrow free-look changes physical aim but not real hull steering or thrust", options, async (t) => {
  const a = boatViewFixture(t), b = boatViewFixture(t);
  for (const f of [a, b]) {
    f.player.inputMode = "native";
    assert.equal(await f.player.lock(), true);
    assert.equal(f.mount().result, true);
  }
  a.player.perspective = "back";
  b.player.perspective = "front";
  for (const [f, x, arrow] of [[a, 400, "ArrowLeft"], [b, -350, "ArrowRight"]]) {
    dispatch(f.controls.document, "mousemove", { movementX: x, movementY: -100 });
    f.key(arrow);
    f.key("KeyW");
  }
  const beforeA = boatView(a.player), beforeB = boatView(b.player);
  const movedA = a.advance(), movedB = b.advance();
  a.consume(0.05);
  b.consume(0.05);
  assert.deepEqual(a.service.boats.getBoat(1), b.service.boats.getBoat(1),
    "different mouse/keyboard look cannot feed back into keyboard-only hull physics");
  near(movedA.rider.hullYaw, movedA.before.hullYaw);
  near(movedB.rider.hullYaw, movedB.before.hullYaw);
  assertPhysicalAim(a, beforeA.yaw + 0.08, beforeA.pitch);
  assertPhysicalAim(b, beforeB.yaw - 0.08, beforeB.pitch);
});

test("restoring an actual occupied boat preserves saved view, seeds once, then carries the next owner delta", options, (t) => {
  const first = boatViewFixture(t);
  first.mount();
  first.key("KeyA");
  first.advance();
  first.consume();
  first.key("KeyA", false);
  const saved = first.service.serialize();
  const savedPlayer = {
    x: first.player.position.x, y: first.player.position.y, z: first.player.position.z,
    yaw: -408.72136, pitch: 0.47, flying: false,
  };
  const f = boatViewFixture(t, { saved, savedPlayer });
  assert.equal(f.player.seated, false);
  const mounted = f.consume();
  near(mounted.after.yaw, savedPlayer.yaw, "reload cannot snap an arbitrary saved free-look offset");
  near(mounted.after.pitch, savedPlayer.pitch);
  assert.equal(f.consume().after.yaw, savedPlayer.yaw);
  assert.deepEqual(f.service.serialize(), saved, "baseline tracking has no save-schema footprint");
  f.advance();
  const row = f.consume();
  assert.ok(Math.abs(shortestTurn(row.riderPose.hullYaw - row.before.heading)) > 1e-5);
  assertPhysicalAim(f, transport(row), savedPlayer.pitch);
});

test("rejected and absent poses retain the last accepted baseline across real owner turns", options, (t) => {
  const f = boatViewFixture(t);
  f.mount();
  const baseline = boatView(f.player);
  f.key("KeyA");
  const pending = f.advance().rider;
  const rejected = f.consume(0.05, {
    riderPose: { ...pending, hullYaw: pending.hullYaw + 1,
      position: { ...pending.position, x: 1000 } },
  });
  assert.equal(rejected.result, false, "a real unloaded footprint fails closed");
  assert.deepEqual(rejected.after, rejected.before);
  const absent = f.consume(0.05, { riderPose: null, exitPose: null });
  near(absent.after.yaw, baseline.yaw);
  near(absent.after.heading, baseline.heading);
  assert.equal(absent.after.seated, true);
  f.advance();
  const row = f.consume();
  near(row.before.heading, baseline.heading, "neither refusal nor absence may advance/reset tracking");
  assertPhysicalAim(f, transport(row), baseline.pitch);
});

test("an unchanged real World archive reload breaks view continuity by epoch, without changing terrain", options, (t) => {
  const f = boatViewFixture(t);
  f.mount();
  f.key("KeyA");
  f.advance(); // The old epoch's rotated pose has deliberately not been consumed.
  const before = boatView(f.player), world = f.world.serialize();
  assert.equal(f.world.loadEdits(world), true);
  assert.ok(f.world.epoch > before.epoch);
  assert.deepEqual(f.world.serialize(), world, "epoch replacement does not author a terrain edit");
  const reseeded = f.consume();
  near(reseeded.after.yaw, before.yaw, "same numeric boat ID in a new epoch cannot replay an old delta");
  near(reseeded.after.pitch, before.pitch);
  f.advance();
  const row = f.consume();
  assertPhysicalAim(f, transport(row), before.pitch);
});

for (const reason of ["travel", "death"]) {
  test(`real ${reason} departure and Player reposition cannot leak an earlier boat turn into remount`, options, (t) => {
    const f = boatViewFixture(t);
    f.mount();
    f.key("KeyA");
    f.advance();
    f.consume();
    f.key("KeyA", false);
    if (reason === "death") f.gameplay.damage(100, "isolated boat-view lifecycle case");
    const departed = reason === "death" ? f.service.onDeath() : f.service.detachForTravel();
    assert.equal(departed.ok, true);
    assert.equal(f.service.boats.mountFor(), null);
    assert.equal(f.service.takeExitPose(), null, "lifecycle departure cannot invent a safe exit");
    f.player.setPosition(f.world.generator.getSpawn());
    if (reason === "death") f.gameplay.respawn();
    assert.equal(f.player.seated, false);
    f.advance(); // The retained, unoccupied boat coasts using its own owner.
    const mounted = f.mount();
    near(mounted.after.yaw, mounted.before.yaw, "remount is a new baseline, not catch-up rotation");
    near(mounted.after.pitch, mounted.before.pitch);
    f.advance();
    const row = f.consume();
    assertPhysicalAim(f, transport(row), mounted.after.pitch);
  });
}
