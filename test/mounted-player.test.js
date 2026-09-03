import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { hasBodySupport } from "../src/collision.js";
import { sampleFluidAtPoint } from "../src/fluid-sampling.js";
import {
  collidesWithWorld,
  EYE_HEIGHT,
  PLAYER_FLUID_PHYSICS,
  PLAYER_HEIGHT,
  SNEAK_HEIGHT,
} from "../src/player.js";
import { restorePlayerSave } from "../src/player-save.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  close,
  exitPose,
  freezePose,
  keyDown,
  mountedFloor,
  mountedPlayerFixture,
  playerSnapshot,
  seatPose,
} from "./mounted-player-fixture.js";

for (const enabled of [true, false]) {
  for (const dt of [0, 0.1]) {
    test(`a committed seat applies at dt=${dt}, enabled=${enabled}, without walking or duplicating fluid/camera work`, (t) => {
      const f = mountedPlayerFixture(t);
      const p = f.player;
      assert.equal(p.seated, false);
      p.yaw = -408.72136;
      p.pitch = 0.47;
      p.flying = true;
      p.enabled = enabled;
      p.velocity.set(8, -31, 7);
      p.grounded = p.moving = p.sprinting = p.climbing = p.sneaking = true;
      p.fallDistance = 19;
      p._jumpQueued = p._sprintLatched = true;
      p._spaceTapAt = p._forwardTapAt = 1000;
      p._stepDistance = 1.69;
      p._bobPhase = 1.3;
      p._bob = 0.02;
      p.onFall =
        p.onStep =
        p.onJump =
          () =>
            assert.fail("a committed seat cannot execute ordinary movement");
      const flightChanges = [];
      p.onFlightChange = (value) => flightChanges.push(value);
      const pose = freezePose(seatPose());
      const before = structuredClone(pose);
      const revision = p.poseRevision;
      const position = p.position,
        velocity = p.velocity,
        eye = p.eyePosition;
      const sample = t.mock.method(p, "sampleFluids");
      const camera = t.mock.method(p, "_syncCamera");
      assert.equal(
        p.update(dt, { riderPose: pose, recoverFromVoid: false }),
        true
      );
      assert.equal(p.position, position);
      assert.equal(p.velocity, velocity);
      assert.equal(p.eyePosition, eye);
      assert.deepEqual(p.position.toArray(), [0.5, 1.4, 0.5]);
      assert.deepEqual(p.velocity.toArray(), [1.25, -0.2, -0.75]);
      assert.equal(p.seated, true);
      for (const name of [
        "grounded",
        "moving",
        "sprinting",
        "climbing",
        "sneaking",
        "flying",
      ])
        assert.equal(p[name], false, name);
      assert.equal(p.height, PLAYER_HEIGHT);
      assert.equal(p.eyeHeight, EYE_HEIGHT);
      assert.equal(p.yaw, -408.72136);
      assert.equal(p.pitch, 0.47);
      close(p.eyePosition.y, 1.4 + EYE_HEIGHT);
      assert.ok(p.camera.position.equals(p.eyePosition));
      assert.equal(p._jumpQueued, false);
      assert.equal(p._sprintLatched, false);
      assert.equal(p._spaceTapAt, null);
      assert.equal(p._forwardTapAt, null);
      for (const name of ["fallDistance", "_stepDistance", "_bobPhase", "_bob"])
        assert.equal(p[name], 0, name);
      assert.deepEqual(flightChanges, [false]);
      assert.ok(p.poseRevision > revision);
      assert.equal(sample.mock.callCount(), 1);
      assert.equal(camera.mock.callCount(), 1);
      assert.equal(p.fluidDiagnostics().queries, 1);
      assert.ok(
        p.fluidDiagnostics().cells <= PLAYER_FLUID_PHYSICS.maxBodyCellsPerQuery
      );
      assert.deepEqual(
        pose,
        before,
        "copy scalar poses; never mutate the vehicle record"
      );
    });

    test(`a committed exit applies once at dt=${dt}, enabled=${enabled}, before ordinary movement resumes`, (t) => {
      const f = mountedPlayerFixture(t);
      const p = f.player;
      keyDown(f, "KeyW");
      p.update(0, { riderPose: seatPose() });
      p.enabled = enabled;
      p.velocity.set(7, -12, -9);
      p.fallDistance = 20;
      p._jumpQueued = p._sprintLatched = true;
      p._spaceTapAt = p._forwardTapAt = 1000;
      p._stepDistance = p._bobPhase = 1.7;
      p._bob = 0.03;
      p.onFall =
        p.onStep =
        p.onJump =
          () => assert.fail("consuming an exit is not a second physics step");
      const pose = freezePose(exitPose());
      const revision = p.poseRevision;
      const sample = t.mock.method(p, "sampleFluids");
      const camera = t.mock.method(p, "_syncCamera");
      assert.equal(p.update(dt, { exitPose: pose }), true);
      assert.equal(p.seated, false);
      assert.equal(p.grounded, true);
      assert.equal(p.moving, false);
      assert.equal(p.sprinting, false);
      assert.equal(p.flying, false);
      assert.deepEqual(p.position.toArray(), [2.5, 1.001, 0.5]);
      assert.deepEqual(p.velocity.toArray(), [0, 0, 0]);
      assert.equal(p.fallDistance, 0);
      assert.equal(p._jumpQueued, false);
      assert.equal(p._spaceTapAt, null);
      assert.equal(p._forwardTapAt, null);
      assert.equal(p._sprintLatched, false);
      assert.equal(p._bobPhase, 0);
      assert.equal(p._bob, 0);
      close(p.eyePosition.y, pose.position.y + EYE_HEIGHT);
      assert.ok(p.poseRevision > revision);
      assert.equal(sample.mock.callCount(), 1);
      assert.equal(camera.mock.callCount(), 1);
      if (enabled) {
        p.update(0.05, { recoverFromVoid: false });
        assert.ok(
          p.position.z < pose.position.z,
          "raw forward input resumes next frame"
        );
        assert.equal(
          p.fallDistance,
          0,
          "the old fall cannot be charged on landing"
        );
      }
    });
  }
}

test("paused calls do no work; overlays retain seating while committed drift refreshes water and the physical eye", (t) => {
  const entries = mountedFloor();
  for (let y = 1; y <= 4; y++)
    entries.push([0, y, 0, BLOCK.WATER, 0, FLUID.BUBBLE_UP]);
  const f = mountedPlayerFixture(t, { entries });
  const p = f.player;
  const pose = seatPose();
  p.update(0, { riderPose: pose });
  const previousVelocity = p.velocity.toArray();
  p.enabled = false;
  assert.equal(p.vehicleKeys, null);
  assert.deepEqual(
    p.velocity.toArray(),
    previousVelocity,
    "input reset does not own boat velocity"
  );
  const before = playerSnapshot(p);
  const sample = t.mock.method(p, "sampleFluids");
  const camera = t.mock.method(p, "_syncCamera");
  p.update(0);
  assert.deepEqual(playerSnapshot(p), before);
  assert.equal(sample.mock.callCount(), 0);
  assert.equal(camera.mock.callCount(), 0);
  assert.equal(p.fluidDiagnostics().queries, 0);
  for (let frame = 1; frame <= 4; frame++) {
    const next = seatPose({
      position: { x: 0.5 + frame * 0.02, y: 1.4, z: 0.5 },
      velocity: { x: 0.4, y: 0, z: 0 },
      hullYaw: frame * 0.1,
    });
    assert.equal(p.update(0.05, { riderPose: next }), true);
    close(p.position.x, next.position.x);
    close(p.eyePosition.x, next.position.x);
    close(p.eyePosition.y, next.position.y + EYE_HEIGHT);
    assert.equal(p.fluidDiagnostics().queries, 1);
    assert.equal(p.fluidState.eyeFluid, FLUID.BUBBLE_UP);
    assert.equal(p.fluidState.restoresAir, true);
    assert.equal(p.moving, false);
    assert.equal(p.seated, true);
  }
  assert.equal(sample.mock.callCount(), 4);
  assert.equal(camera.mock.callCount(), 4);
  const position = p.position.clone(),
    velocity = p.velocity.clone();
  p.update(0.1);
  assert.ok(
    p.position.equals(position),
    "a temporarily absent pose is not a dismount"
  );
  assert.ok(
    p.velocity.equals(velocity),
    "Player does not extrapolate the hull"
  );
  assert.equal(p.seated, true);
  for (let y = 1; y <= 4; y++) f.world.put(0, y, 0, BLOCK.AIR);
  p.update(0.1);
  assert.equal(p.fluidState.eyeFluid, FLUID.NONE);
  assert.equal(p.fluidState.waterImmersion, 0);
  assert.equal(p.fluidState.restoresAir, false);
});

test("water seats and swimming exits sample hazards without buoyancy, bubble acceleration or camera-derived breathing", (t) => {
  const entries = mountedFloor();
  for (const x of [0, 2])
    for (let y = 1; y <= 4; y++)
      entries.push([x, y, 0, BLOCK.WATER, 0, FLUID.BUBBLE_DOWN]);
  const f = mountedPlayerFixture(t, { entries });
  const p = f.player,
    pose = seatPose();
  p.perspective = "back";
  p.update(0.1, { riderPose: pose });
  assert.deepEqual(p.velocity.toArray(), [1.25, -0.2, -0.75]);
  assert.equal(p.fluidDiagnostics().queries, 1);
  assert.equal(p.fluidState.eyeFluid, FLUID.BUBBLE_DOWN);
  assert.equal(
    sampleFluidAtPoint(f.world, p.camera.position).fluid,
    FLUID.NONE
  );
  const environment = p.gameplayEnvironment();
  assert.equal(environment.underwater, true);
  assert.equal(environment.restoreAir, true);
  assert.equal(environment.moving, false);
  assert.equal(environment.sprinting, false);
  assert.equal(
    Object.hasOwn(p, "air"),
    false,
    "Gameplay still owns the hazard clocks"
  );
  const exit = freezePose(
    exitPose({
      position: { x: 2.5, y: 1.4, z: 0.5 },
      velocity: { x: 0.3, y: -0.4, z: -0.2 },
      grounded: false,
      swimming: true,
    })
  );
  p.enabled = false;
  assert.equal(p.update(0, { exitPose: exit }), true);
  assert.equal(p.seated, false);
  assert.equal(p.grounded, false);
  assert.deepEqual(p.velocity.toArray(), [0.3, -0.4, -0.2]);
  assert.equal(p.fluidState.eyeFluid, FLUID.BUBBLE_DOWN);
  assert.equal(p.fluidDiagnostics().queries, 1);
  assert.equal(p.fallDistance, 0);
});

test("malformed, ambiguous, wrong-dimension and out-of-bounds poses refuse without partial publication", (t) => {
  const { player: p } = mountedPlayerFixture(t);
  p.update(0, { riderPose: seatPose() });
  const invalid = [
    ...[false, 1, [], {}, "seat"].map((value) => ({ riderPose: value })),
    { riderPose: seatPose({ position: { x: 0.5, y: 1.4 } }) },
    { riderPose: seatPose({ velocity: { x: 0, y: 0 } }) },
    { riderPose: seatPose({ grounded: undefined }) },
    { riderPose: seatPose({ grounded: 0 }) },
    { riderPose: seatPose({ grounded: true }) },
    { riderPose: seatPose({ seated: undefined }) },
    { riderPose: seatPose({ seated: false }) },
    { riderPose: seatPose({ seated: "true" }) },
    { riderPose: seatPose({ hullYaw: Infinity }) },
    { riderPose: seatPose({ dimension: "nether" }) },
    {
      riderPose: seatPose({
        position: { x: 0.5, y: 1.4, z: 0.5, dimension: "end" },
      }),
    },
    { riderPose: seatPose({ swimming: true }) },
    { exitPose: exitPose({ seated: true }) },
    { exitPose: exitPose({ grounded: "true" }) },
    { exitPose: exitPose({ swimming: "false" }) },
    { exitPose: exitPose({ swimming: true }) },
    { riderPose: seatPose(), exitPose: exitPose() },
  ];
  for (const x of [NaN, Infinity, -Infinity, "0", null]) {
    invalid.push({ riderPose: seatPose({ position: { x, y: 1.4, z: 0.5 } }) });
    invalid.push({ exitPose: exitPose({ velocity: { x, y: 0, z: 0 } }) });
  }
  for (const position of [
    { x: WORLD_MIN, y: 1.4, z: 0.5 },
    { x: WORLD_MAX, y: 1.4, z: 0.5 },
    { x: 0.5, y: p.world.spec.minY - 1, z: 0.5 },
    { x: 0.5, y: Number.MAX_SAFE_INTEGER, z: 0.5 },
  ])
    invalid.push({ riderPose: seatPose({ position }) });
  const before = playerSnapshot(p);
  const sample = t.mock.method(p, "sampleFluids");
  const camera = t.mock.method(p, "_syncCamera");
  for (const options of invalid) {
    assert.equal(p.update(0.1, options), false);
    assert.deepEqual(playerSnapshot(p), before);
  }
  for (const dt of [-1, NaN, Infinity, -Infinity]) {
    assert.equal(p.update(dt, { riderPose: seatPose() }), false);
    assert.deepEqual(playerSnapshot(p), before);
  }
  assert.equal(
    p.update(0, { riderPose: seatPose(), recoverFromVoid: 1 }),
    false
  );
  assert.deepEqual(playerSnapshot(p), before);
  assert.equal(sample.mock.callCount(), 0);
  assert.equal(camera.mock.callCount(), 0);
});

test("seat/exit clearance is the full standing body even when the old player is crouched", (t) => {
  const f = mountedPlayerFixture(t, {
    entries: [...mountedFloor(), [0, 3, 0, BLOCK.STONE]],
  });
  const p = f.player;
  p.sneaking = true;
  p.setPosition({ x: 0.5, y: 1.4, z: 0.5 });
  assert.equal(p.height, SNEAK_HEIGHT);
  assert.equal(collidesWithWorld(f.world, p.position, SNEAK_HEIGHT), false);
  assert.equal(collidesWithWorld(f.world, p.position, PLAYER_HEIGHT), true);
  const before = playerSnapshot(p);
  assert.equal(p.update(0, { riderPose: seatPose() }), false);
  assert.deepEqual(playerSnapshot(p), before);
  const clearSeat = seatPose({ position: { x: 2.5, y: 1.4, z: 0.5 } });
  assert.equal(p.update(0, { riderPose: clearSeat }), true);
  assert.equal(p.sneaking, false);
  const mounted = playerSnapshot(p);
  assert.equal(
    p.update(0, {
      exitPose: exitPose({ position: { x: 0.5, y: 1.4, z: 0.5 } }),
    }),
    false
  );
  assert.deepEqual(playerSnapshot(p), mounted);
  f.world.put(0, 3, 0, BLOCK.AIR);
  assert.equal(p.update(0, { riderPose: seatPose() }), true);
});

test("unloaded footprints fail closed, while finite high and signed world coordinates remain intact", (t) => {
  const f = mountedPlayerFixture(t, { geometry: { loaded: (x) => x < 1 } });
  const before = playerSnapshot(f.player);
  assert.equal(
    f.player.update(0, {
      riderPose: seatPose({ position: { x: 0.9, y: 1.4, z: 0.5 } }),
    }),
    false
  );
  assert.deepEqual(playerSnapshot(f.player), before);
  const high = mountedPlayerFixture(t);
  const pose = seatPose({
    position: { x: -29_000_000.375, y: 300_000.625, z: 29_000_000.125 },
  });
  assert.equal(high.player.update(0, { riderPose: pose }), true);
  assert.deepEqual(high.player.position.toArray(), [
    pose.position.x,
    pose.position.y,
    pose.position.z,
  ]);
  close(high.player.eyePosition.y, pose.position.y + EYE_HEIGHT);
  assert.equal(high.player.fluidMovementBlocked, false);
});

test("saved seats do not require solid support and ordinary setPosition releases the seat coherently", (t) => {
  const f = mountedPlayerFixture(t, { entries: [[0, 1, 0, BLOCK.WATER]] });
  const p = f.player,
    pose = seatPose();
  assert.equal(hasBodySupport(f.world, pose.position), false);
  assert.equal(
    restorePlayerSave(p, f.world, {
      ...pose.position,
      yaw: 0.3,
      pitch: -0.2,
      flying: false,
    }),
    true
  );
  assert.equal(p.seated, false);
  assert.equal(p.update(0, { riderPose: pose }), true);
  keyDown(f, "ShiftLeft");
  const revision = p.poseRevision;
  p.setPosition({ x: 2.5, y: 2, z: 0.5 });
  assert.equal(p.seated, false);
  assert.equal(
    p.sneaking,
    true,
    "ordinary stance resumes with real held Shift"
  );
  assert.equal(p.height, SNEAK_HEIGHT);
  assert.equal(p.flying, false);
  assert.equal(p.grounded, false);
  assert.equal(p.moving, false);
  assert.equal(p.climbing, false);
  assert.deepEqual(p.velocity.toArray(), [0, 0, 0]);
  assert.equal(p.fallDistance, 0);
  assert.equal(p._bobPhase, 0);
  assert.equal(p._bob, 0);
  assert.equal(p._jumpQueued, false);
  close(p.eyePosition.y, p.position.y + p.eyeHeight);
  assert.ok(p.camera.position.equals(p.eyePosition));
  assert.equal(p.fluidState.waterImmersion, 0);
  assert.ok(p.poseRevision > revision);
});

test("poseRevision makes prepared transactions stale across zero-time mount, drift, exit and travel", (t) => {
  const { player: p } = mountedPlayerFixture(t);
  const coordinator = new TransactionCoordinator(),
    owner = {};
  assert.equal(coordinator.register(owner), true);
  t.after(() => coordinator.release(owner));
  let publications = 0;
  const prepare = () => {
    const revision = p.poseRevision;
    let used = false;
    return {
      owner,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () => !used && p.poseRevision === revision,
      publish: () => {
        used = true;
        publications++;
      },
    };
  };
  for (const change of [
    () => p.update(0, { riderPose: seatPose() }),
    () => p.update(0, { riderPose: seatPose({ hullYaw: 1.2 }) }),
    () => p.update(0, { exitPose: exitPose() }),
    () => p.setPosition({ x: 0.5, y: 1, z: 0.5 }),
    () => p._applyLook(5, 3),
    () => p.update(1 / 60),
  ]) {
    const plan = prepare();
    assert.equal(plan.validate(), true);
    change();
    assert.deepEqual(coordinator.commit([plan]), {
      ok: false,
      reason: "validation-failed",
    });
    assert.equal(publications, 0);
  }
  const paused = prepare();
  p.update(0);
  assert.equal(p.update(0, { riderPose: seatPose({ seated: false }) }), false);
  assert.equal(
    coordinator.commit([paused]).ok,
    true,
    "no-op/refused poses do not invalidate a plan"
  );
  assert.equal(publications, 1);
});
