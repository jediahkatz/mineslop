import assert from "node:assert/strict";
import test from "node:test";
import { FISHING_LINE_SEGMENTS } from "../src/fishing-render.js";
import {
  pearlImpactPose,
  PEARL_STEP_SECONDS,
  stepPearlFlight,
} from "../src/pearl-physics.js";
import { PLAYER_WIDTH } from "../src/player.js";
import {
  aim,
  mountAndCast,
  point,
  throwMountedPearl,
  VEHICLE_PEARL_SETUP,
} from "./vehicle-pearl-fixture.js";
import { vehicleFrameFixture } from "./vehicle-frame-fixture.js";

// Node real-frame/CPU scene proof only; the existing 22 tests own transaction
// vetoes, save/reload and lifecycle coverage. No GUI, WebGL or natural supplies.
const options = { timeout: 30_000, concurrency: false };
const entries = (frame, name) =>
  frame.events.filter((entry) => entry.name === name);
const near = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-10,
    `${actual} must equal ${expected} within floating-point roundoff`
  );

function one(frame, name) {
  const found = entries(frame, name);
  assert.equal(found.length, 1, `${frame.now}ms: exactly one ${name}`);
  return found[0];
}

function precedes(frame, first, second) {
  assert.ok(first && second, `${frame.now}ms: both boundaries must exist`);
  assert.ok(
    first.leave < second.enter,
    `${frame.now}ms: ${first.name} must finish before ${second.name}`
  );
}

function assertCamera(state) {
  const { player, camera } = state;
  assert.equal(player.perspective, "back");
  assert.deepEqual(player.eye, {
    ...player.position,
    y: player.position.y + player.eyeHeight,
  });
  for (const axis of ["x", "y", "z"]) {
    near(camera.forward[axis], camera.physicalForward[axis]);
    // The authored clearance permits the actual swept four-block rear camera.
    near(
      camera.position[axis],
      player.eye[axis] - camera.physicalForward[axis] * 4
    );
  }
}

function assertFrame(frame, { active = true, simulating = true } = {}) {
  const fluid = one(frame, "fluids"),
    vehicles = one(frame, "vehicles");
  const player = one(frame, "player"),
    use = one(frame, "use");
  const projectiles = one(frame, "projectiles");
  const vehicleRender = one(frame, "vehicle-render");
  const pearlRender = entries(frame, "pearl-render").at(-1);
  const visual = one(frame, "player-render"),
    draw = one(frame, "draw");
  assert.ok(pearlRender);
  assert.equal(
    entries(frame, "pearl-render").length,
    1 + entries(frame, "hurt").length,
    "one final projection plus the native impact notification's projection"
  );
  const order = [fluid, vehicles, player, use, projectiles];
  for (let index = 1; index < order.length; index++)
    precedes(frame, order[index - 1], order[index]);
  for (const entry of frame.events) assert.equal(entry.now, frame.now);
  assert.deepEqual(one(frame, "observe-frame").args, [
    frame.rawMs,
    { paused: !simulating, hidden: false },
  ]);
  assert.equal(frame.elapsedAfter, frame.elapsedBefore + frame.dt);
  assert.equal(
    frame.autosaveAfter,
    frame.autosaveBefore + (simulating ? frame.dt : 0)
  );
  assert.deepEqual(fluid.args, [frame.dt, { simulating }]);
  assert.equal(fluid.result.ok, true);
  assert.equal(vehicles.args[0], frame.dt);
  assert.equal(vehicles.args[1].simulating, simulating);
  assert.equal(vehicles.result.ok, true);
  if (!active) assert.equal(vehicles.args[1].keys, null);
  assert.deepEqual(projectiles.args, [frame.dt, { simulating }]);
  assert.equal(projectiles.result, true);
  assert.deepEqual(use.args, [active ? frame.dt : 0]);

  const seat = vehicles.after.seat;
  assert.deepEqual(player.args, [
    frame.dt,
    {
      recoverFromVoid: false,
      ...(seat ? { riderPose: seat, exitPose: null } : {}),
    },
  ]);
  assert.deepEqual(player.before.player, vehicles.after.player);
  assert.equal(
    player.after.player.poseRevision,
    player.before.player.poseRevision + 1
  );
  if (seat) {
    assert.equal(player.result, true);
    assert.equal(player.after.player.seated, true);
    assert.deepEqual(player.after.player.position, point(seat.position));
    assert.deepEqual(player.after.player.velocity, seat.velocity);
  }
  assert.deepEqual(use.before.player, player.after.player);
  assert.deepEqual(projectiles.before.player, player.after.player);

  for (const name of ["fluid-tick", "boat-tick", "fishing-tick", "pearl-tick"]) {
    const present =
      name === "fishing-tick"
        ? frame.before.fishing.casts.length > 0
        : name === "pearl-tick"
          ? frame.before.pearls.projectiles.length > 0 ||
            frame.before.pearls.cooldown > 0
          : true;
    assert.equal(
      entries(frame, name).length,
      Number(simulating && present),
      name
    );
    if (simulating && present)
      assert.equal(one(frame, name).args[0], frame.dt);
  }
  if (simulating) {
    const environment = one(frame, "environment"),
      survival = one(frame, "survival");
    precedes(frame, projectiles, environment);
    precedes(frame, environment, survival);
    precedes(frame, survival, visual);
    assert.deepEqual(environment.before.player, projectiles.after.player);
    assert.deepEqual(survival.before.player, projectiles.after.player);
    assert.deepEqual(survival.args, [frame.dt, environment.result]);
    assert.equal(
      survival.args[1].moving,
      false,
      "paddling is not walking exhaustion"
    );
    assert.deepEqual(one(frame, "boat-tick").result.observerErrors, []);
    if (frame.before.fishing.casts.length)
      assert.deepEqual(one(frame, "fishing-tick").result, {
        ticks: 1,
        observerErrors: [],
      });
  } else {
    assert.equal(entries(frame, "environment").length, 0);
    assert.equal(entries(frame, "survival").length, 0);
    assert.equal(fluid.result.advanced, false);
    assert.equal(vehicles.result.advanced, false);
    precedes(frame, projectiles, visual);
  }
  if (active) {
    precedes(frame, player, entries(frame, "target")[0]);
    precedes(frame, entries(frame, "target")[0], use);
  } else assert.equal(entries(frame, "target").length, 0);
  precedes(frame, visual, vehicleRender);
  precedes(frame, vehicleRender, pearlRender);
  precedes(frame, pearlRender, draw);
  assert.deepEqual(vehicleRender.args, [simulating ? frame.dt : 0]);
  assert.equal(vehicleRender.result, true);
  assert.equal(pearlRender.result, true);
  assert.deepEqual(vehicleRender.before.player, projectiles.after.player);
  assert.deepEqual(draw.before.player, projectiles.after.player);
  assert.equal(visual.args[0], active ? frame.dt : 0);
  assert.equal(visual.args[1].seated, draw.before.player.seated);
  assert.deepEqual(visual.args[1].position, draw.before.player.position);
  assert.deepEqual(
    draw.before.projection.player.position,
    draw.before.player.position
  );
  assert.equal(
    draw.before.projection.player.yaw,
    draw.before.player.yaw + Math.PI
  );
  assertCamera(draw.before);
}

test("real Game frames consume one committed seat, then publish mounted pearl impact before survival and draw", options, async (t) => {
  const f = await vehicleFrameFixture(t);
  const boatId = mountAndCast(f, { consume: false });
  f.player.perspective = "back";
  assert.equal(f.player.seated, false);
  assert.notDeepEqual(
    f.read().player.position,
    point(f.vehicles.riderPose().position)
  );
  for (const key of ["KeyW", "ArrowLeft", "ArrowUp"]) f.key(key);
  const mounted = f.frameAt(50);
  assertFrame(mounted);
  const vehicleTick = one(mounted, "vehicles");
  assert.deepEqual(
    vehicleTick.args[1].keys,
    new Set(["KeyW", "ArrowLeft", "ArrowUp"])
  );
  assert.deepEqual(one(mounted, "boat-tick").args[1].controls, {
    player: { forward: 1, turn: 0, dismount: false },
  });
  assert.deepEqual(vehicleTick.after.player, vehicleTick.before.player);
  const hullBefore = mounted.before.boats.boats[0],
    hullAfter = mounted.after.boats.boats[0];
  assert.equal(hullAfter.id, boatId);
  assert.equal(hullAfter.x, hullBefore.x);
  assert.ok(
    hullAfter.z < hullBefore.z,
    "the real boat paddles before Player consumes its seat"
  );
  assert.equal(
    hullAfter.yaw,
    hullBefore.yaw,
    "physical arrow look cannot steer the hull"
  );
  near(mounted.after.player.yaw, mounted.before.player.yaw + 1.6 * mounted.dt);
  near(
    mounted.after.player.pitch,
    mounted.before.player.pitch + 1.3 * mounted.dt
  );
  assert.equal(mounted.after.projection.player.gait, 0);
  assert.equal(mounted.after.projection.player.stride, 0);
  assert.equal(mounted.after.fishing.casts.length, 1);
  assert.equal(mounted.after.projection.lineVertices, 2 * FISHING_LINE_SEGMENTS);
  const boatParts = mounted.after.projection.boatParts;
  assert.ok(boatParts > 0);
  for (const key of ["KeyW", "ArrowLeft", "ArrowUp"]) f.key(key, false);
  aim(f, 0, 0.04); // Authored pre-throw aim only; no live-flight pose edits.
  throwMountedPearl(f);
  const paid = f.read();
  assert.equal(paid.pearls.projectiles.length, 1);
  assert.equal(paid.gameplay.slots[0].count, VEHICLE_PEARL_SETUP.pearls - 1);
  let impact = null;
  for (let tick = 0; tick < VEHICLE_PEARL_SETUP.maxApproachTicks; tick++) {
    const before = f.read();
    const projectile = before.pearls.projectiles[0];
    assert.equal(projectile.id, paid.pearls.projectiles[0].id);
    const next = stepPearlFlight(f.world, f.context, projectile);
    assert.ok(
      ["flight", "impact"].includes(next.kind),
      "no cancellation/frontier is an impact"
    );
    const landing =
      next.kind === "impact"
        ? pearlImpactPose(f.world, f.context, next.hit, {
            radius: PLAYER_WIDTH / 2,
            height: f.player.height,
          })
        : null;
    if (landing) {
      assert.equal(next.hit.cell.z, VEHICLE_PEARL_SETUP.wallZ);
      assert.equal(landing.kind, "ready");
    }
    const frame = f.frameAt(100 + tick * 50);
    assertFrame(frame);
    assert.equal(frame.dt, PEARL_STEP_SECONDS);
    assert.equal(
      frame.after.pearls.cooldown,
      Math.max(0, before.pearls.cooldown - frame.dt)
    );
    assert.equal(frame.after.pearls.accumulator, 0);
    assert.equal(frame.after.pearls.randomState, paid.pearls.randomState);
    assert.equal(frame.after.pearls.nextId, paid.pearls.nextId);
    if (!landing) {
      assert.equal(frame.after.pearls.projectiles.length, 1);
      assert.deepEqual(
        frame.after.pearls.projectiles[0].position,
        next.position
      );
      assert.deepEqual(
        frame.after.pearls.projectiles[0].velocity,
        next.velocity
      );
      assert.equal(frame.after.gameplay.health, 20);
      assert.equal(frame.after.player.seated, true);
      assert.equal(frame.after.projection.pearls, 1);
      continue;
    }
    impact = { frame, landing };
    const hurt = one(frame, "hurt"),
      projectiles = one(frame, "projectiles");
    assert.ok(
      projectiles.enter < hurt.enter && hurt.leave < projectiles.leave,
      "the real projectile frame owns the impact notification"
    );
    precedes(frame, hurt, one(frame, "survival"));
    // The actual health notification already sees ALL publications, not a
    // post-frame observer repairing a passenger/cast or re-applying a seat.
    for (const state of [hurt.before, projectiles.after, frame.after]) {
      assert.equal(state.gameplay.health, 15);
      assert.deepEqual(state.gameplay.slots, paid.gameplay.slots);
      assert.deepEqual(state.gameplay.offhand, paid.gameplay.offhand);
      assert.deepEqual(state.gameplay.equipment, paid.gameplay.equipment);
      assert.deepEqual(state.player.position, landing.position);
      assert.deepEqual(state.player.velocity, { x: 0, y: 0, z: 0 });
      assert.equal(state.player.fallDistance, 0);
      assert.equal(state.player.seated, false);
      assert.equal(
        state.player.poseRevision,
        projectiles.before.player.poseRevision + 1
      );
      assert.equal(state.player.yaw, projectiles.before.player.yaw);
      assert.equal(state.player.pitch, projectiles.before.player.pitch);
      assert.deepEqual(state.pearls.projectiles, []);
      assert.equal(state.boats.boats.length, 1);
      assert.deepEqual(state.boats.boats[0], {
        ...projectiles.before.boats.boats[0],
        passengers: [null, null],
      });
      assert.deepEqual(state.fishing, {
        ...projectiles.before.fishing,
        casts: [],
      });
      assert.equal(state.seat, null);
      assert.equal(state.exit, null);
      assert.deepEqual(state.overflow, paid.overflow);
      assert.deepEqual(state.experience, paid.experience);
    }
    assert.equal(
      frame.after.player.poseRevision,
      frame.before.player.poseRevision + 2
    );
    assert.equal(
      frame.after.gameplay.timers.regen,
      frame.dt,
      "survival starts from the published 15 HP"
    );
    for (const render of entries(frame, "pearl-render")) {
      precedes(frame, hurt, render);
      precedes(frame, render, one(frame, "draw"));
      assert.equal(render.before.player.seated, false);
      assert.equal(render.before.gameplay.health, 15);
      assert.equal(render.after.projection.pearls, 0);
      assert.equal(render.after.projection.trails, 0);
    }
    assert.equal(frame.after.projection.boatParts, boatParts);
    assert.equal(frame.after.projection.lineVertices, 0);
    assert.equal(frame.after.projection.bobberParts, 0);
    break;
  }
  assert.ok(
    impact,
    "the real frame must reach the authored wall within twelve 20 Hz steps"
  );
  for (let tick = 1; tick <= 8; tick++) {
    const frame = f.frameAt(impact.frame.now + tick * 50);
    assertFrame(frame);
    assert.equal(frame.before.seat, null);
    assert.equal(frame.after.seat, null);
    assert.equal(frame.after.exit, null);
    assert.equal(frame.after.player.seated, false);
    assert.equal(frame.after.player.position.x, impact.landing.position.x);
    assert.equal(frame.after.player.position.z, impact.landing.position.z);
    assert.ok(
      frame.after.player.position.y <= frame.before.player.position.y + 1e-10
    );
    assert.ok(
      frame.after.player.position.y >= VEHICLE_PEARL_SETUP.landingY - 0.01
    );
    assert.equal(frame.after.gameplay.health, 15);
    assert.deepEqual(frame.after.gameplay.slots, paid.gameplay.slots);
    assert.deepEqual(frame.after.boats.boats[0].passengers, [null, null]);
    assert.equal(frame.after.boats.boats[0].id, boatId);
    assert.equal(frame.after.fishing.casts.length, 0);
    assert.equal(frame.after.pearls.projectiles.length, 0);
  }
  assert.equal(f.observed.hurt.length, 1);
});

test("real Game frames suppress overlay input, freeze paused owners, and resume one tick without wall-time catch-up", options, async (t) => {
  const f = await vehicleFrameFixture(t);
  mountAndCast(f);
  f.player.perspective = "back";
  f.key("KeyW");
  assertFrame(f.frameAt(50));
  throwMountedPearl(f);
  // Invoke the real inventory/container open-state callback. The DOM panel is
  // not constructed; disabled input and all simulation gates remain native.
  f.game.overlayChanged(true);
  assert.equal(f.game.active, false);
  assert.equal(f.game.simulating, true);
  assert.equal(f.player.enabled, false);
  for (const key of ["KeyW", "KeyA", "ArrowLeft", "Space"])
    assert.equal(f.key(key).defaultPrevented, false);
  assert.equal(f.player.vehicleKeys, null);
  assert.equal(f.player._keys.size, 0);
  const refused = f.read();
  assert.equal(f.game.beginUse("mouse"), false);
  assert.deepEqual(f.read(), refused);
  const overlay = f.frameAt(100);
  assertFrame(overlay, { active: false });
  const before = overlay.before.boats.boats[0],
    coast = overlay.after.boats.boats[0];
  assert.deepEqual(one(overlay, "boat-tick").args[1].controls, {
    player: { forward: 0, turn: 0, dismount: false },
  });
  assert.equal(coast.x, before.x);
  assert.equal(coast.yaw, before.yaw);
  assert.ok(
    coast.z < before.z && coast.vz > before.vz && coast.vz < 0,
    "inertia continues without another paddle input"
  );
  assert.equal(overlay.after.player.yaw, overlay.before.player.yaw);
  assert.equal(overlay.after.player.pitch, overlay.before.player.pitch);
  assert.equal(overlay.after.player.seated, true);
  assert.equal(
    overlay.after.fishing.casts[0].flightTicks,
    overlay.before.fishing.casts[0].flightTicks + 1
  );
  assert.equal(
    overlay.after.pearls.cooldown,
    overlay.before.pearls.cooldown - PEARL_STEP_SECONDS
  );
  assert.equal(overlay.after.pearls.projectiles[0].age, PEARL_STEP_SECONDS);
  near(
    overlay.after.gameplay.exhaustion,
    overlay.before.gameplay.exhaustion + 0.002 * PEARL_STEP_SECONDS
  );

  // Isolate frame's pause gate with input already disabled by the real overlay;
  // do not introduce asynchronous menu/archive work into the measured frame.
  f.game.paused = true;
  const paused = f.frameAt(2100);
  assertFrame(paused, { active: false, simulating: false });
  assert.equal(paused.rawMs, 2000);
  assert.equal(paused.dt, 0.1);
  for (const owner of [
    "boats",
    "fishing",
    "horses",
    "pearls",
    "gameplay",
    "survivalClock",
    "fluids",
    "overflow",
    "experience",
  ])
    assert.deepEqual(paused.after[owner], paused.before[owner], owner);
  // A retained seat is refreshed for presentation even while paused. That
  // bookkeeping revision is not a physics tick or a turn of the physical aim.
  assert.deepEqual(paused.after.player, {
    ...paused.before.player,
    poseRevision: paused.before.player.poseRevision + 1,
  });
  assert.deepEqual(paused.after.camera, paused.before.camera);
  assert.equal(paused.after.projection.pearls, 1);
  assert.equal(paused.after.projection.lineVertices, 2 * FISHING_LINE_SEGMENTS);

  f.game.paused = false; // Inventory stays open: simulation resumes, input does not.
  const next = stepPearlFlight(
    f.world,
    f.context,
    f.read().pearls.projectiles[0]
  );
  assert.equal(next.kind, "flight");
  const resumed = f.frameAt(2150);
  assertFrame(resumed, { active: false });
  assert.equal(resumed.dt, PEARL_STEP_SECONDS);
  assert.deepEqual(resumed.after.pearls.projectiles[0].position, next.position);
  assert.equal(resumed.after.pearls.projectiles[0].age, 2 * PEARL_STEP_SECONDS);
  assert.equal(
    resumed.after.pearls.cooldown,
    resumed.before.pearls.cooldown - PEARL_STEP_SECONDS
  );
  assert.equal(
    resumed.after.fishing.casts[0].flightTicks,
    resumed.before.fishing.casts[0].flightTicks + 1
  );
  near(
    resumed.after.survivalClock,
    resumed.before.survivalClock + PEARL_STEP_SECONDS
  );
  assert.equal(resumed.after.gameplay.health, 20);
  assert.equal(
    resumed.after.gameplay.slots[0].count,
    VEHICLE_PEARL_SETUP.pearls - 1
  );
  assert.deepEqual(resumed.after.overflow, refused.overflow);
  assert.deepEqual(resumed.after.experience, refused.experience);
  assert.equal(f.observed.hurt.length, 0);
  assert.deepEqual(f.frames.map(({ now }) => now), [50, 100, 2100, 2150]);
});

test("real Game frames carry boat turns once through free look, overlay coasting and paused projection", options, async (t) => {
  const f = await vehicleFrameFixture(t);
  mountAndCast(f, { cast: false, consume: false });
  f.player.perspective = "back";
  const retained = {
    world: f.world.serialize(),
    columns: [...f.world.chunks.keys()],
    bytes: f.coordinator.budget.totalBytes,
    inventory: f.gameplay.serialize(),
  };
  for (const method of ["ensureArea", "_generateSync", "applyCells"])
    t.mock.method(f.world, method, () =>
      assert.fail(`mounted view cannot call World.${method}`)
    );
  const turn = (frame) => {
    const delta = frame.after.seat.hullYaw - frame.before.seat.hullYaw;
    return Math.atan2(Math.sin(delta), Math.cos(delta));
  };
  for (const key of ["KeyA", "ArrowLeft", "ArrowUp"]) f.key(key);
  const mounted = f.frameAt(50);
  assertFrame(mounted);
  assert.ok(turn(mounted) > 0, "the real owner turns before the first mount");
  assert.equal(f.player.vehicleType, "boat");
  near(mounted.after.player.yaw, mounted.before.player.yaw + 1.6 * mounted.dt);
  near(mounted.after.player.pitch, mounted.before.player.pitch + 1.3 * mounted.dt);

  const turning = f.frameAt(100);
  assertFrame(turning);
  assert.ok(turn(turning) > 0);
  const yaw = turning.before.player.yaw + turn(turning) + 1.6 * turning.dt;
  near(turning.after.player.yaw, yaw);
  near(turning.after.player.pitch, turning.before.player.pitch + 1.3 * turning.dt);
  const consumed = one(turning, "player");
  assert.deepEqual(consumed.after.boats, consumed.before.boats,
    "native Player consumption cannot advance hull physics");
  for (const name of ["target", "use", "projectiles", "environment", "player-render", "draw"])
    near(one(turning, name).before.player.yaw, yaw);
  const beforeRepeat = f.read();
  assert.equal(f.game.applyVehiclePose(), true);
  near(f.player.yaw, yaw);
  near(f.player.pitch, beforeRepeat.player.pitch);
  assert.deepEqual(f.boats.serialize(), beforeRepeat.boats);
  assert.equal(f.player.poseRevision, beforeRepeat.player.poseRevision + 1);

  f.game.overlayChanged(true);
  const coast = f.frameAt(150);
  assertFrame(coast, { active: false });
  assert.ok(turn(coast) > 0, "real angular inertia continues without input");
  assert.deepEqual(one(coast, "boat-tick").args[1].controls, {
    player: { forward: 0, turn: 0, dismount: false },
  });
  near(coast.after.player.yaw, coast.before.player.yaw + turn(coast));
  near(coast.after.player.pitch, coast.before.player.pitch);

  f.game.paused = true;
  const paused = f.frameAt(1150);
  assertFrame(paused, { active: false, simulating: false });
  assert.equal(turn(paused), 0);
  near(paused.after.player.yaw, paused.before.player.yaw);
  near(paused.after.player.pitch, paused.before.player.pitch);
  assert.deepEqual(paused.after.boats, paused.before.boats);
  assert.deepEqual(f.world.serialize(), retained.world);
  assert.deepEqual([...f.world.chunks.keys()], retained.columns);
  assert.equal(f.coordinator.budget.totalBytes, retained.bytes);
  for (const key of ["slots", "offhand", "equipment", "experience"])
    assert.deepEqual(f.gameplay.serialize()[key], retained.inventory[key]);
});
