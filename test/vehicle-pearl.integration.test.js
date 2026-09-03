import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Boats } from "../src/boats.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fishing } from "../src/fishing.js";
import { GameTravel } from "../src/game-travel.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import {
  pearlImpactPose,
  PEARL_STEP_SECONDS,
  stepPearlFlight,
} from "../src/pearl-physics.js";
import {
  nextPearlRandom,
  PEARL_COOLDOWN_SECONDS,
  PEARL_RECORD_RESERVED_BYTES,
} from "../src/pearl-save.js";
import { Player, PLAYER_WIDTH, collidesWithWorld } from "../src/player.js";
import {
  MAX_PEARL_IMPACT_PEERS,
  PlayerProjectiles,
  PEARL_TELEPORT_DAMAGE,
} from "../src/player-projectiles.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { World } from "../src/world.js";
import {
  aim,
  assertNoVehicleSnapback,
  commitWithoutObserverErrors,
  mountAndCast,
  nextVehiclePearlImpact,
  playerState,
  point,
  throwMountedPearl,
  VEHICLE_PEARL_SETUP,
  vehiclePearlFixture,
} from "./vehicle-pearl-fixture.js";

// Node owner/host regression only. No browser input, GPU, natural acquisition,
// native module-worker, complete VoxelGame.frame ordering, or waited-catch claim.
const options = { timeout: 30_000 };

function assertRealOwners(f) {
  for (const [owner, Type] of [
    [f.world, World],
    [f.gameplay, Gameplay],
    [f.player, Player],
    [f.boats, Boats],
    [f.fishing, Fishing],
    [f.overflow, DropOverflow],
    [f.experience, ExperienceOrbs],
    [f.pearls, PlayerProjectiles],
    [f.coordinator, TransactionCoordinator],
  ])
    assert.ok(owner instanceof Type);
  for (const owner of Object.values(f.owners)) {
    assert.equal(owner.coordinator, f.coordinator);
    assert.notEqual(f.coordinator.usage(owner), undefined);
  }
  assert.equal(f.player.world, f.world);
  assert.equal(f.game.vehicleServices, f.vehicles);
  assert.equal(f.game.projectileServices, f.projectiles);
  assert.equal(f.game.boats, f.boats);
  assert.equal(f.game.fishing, f.fishing);
  assert.equal(f.game.projectiles, f.pearls);
  assert.equal(f.vehicles.experienceOrbs, f.experience);
  assert.equal(f.player.vehicleKeys, f.player._keys);
}

function assertJoinedPlan(f, plan, { mounted = true, cast = true } = {}) {
  const expected = [
    f.projectiles,
    f.gameplay,
    f.pearls,
    f.vehicles,
    ...(mounted ? [f.boats] : []),
    ...(cast ? [f.fishing] : []),
  ];
  assert.equal(plan.participants.length, expected.length);
  assert.deepEqual(
    new Set(plan.participants.map(({ owner }) => owner)),
    new Set(expected),
    "pose, health, retirement and every real departure participant must share one commit"
  );
  const guard = plan.participants.find(({ owner }) => owner === f.vehicles);
  assert.equal(guard.beforeBytes, 0);
  assert.equal(guard.afterBytes, 0);
  assert.equal(plan.request.ownerRef, f.player);
  assert.equal(plan.request.world, f.world);
  assert.equal(plan.request.damage.amount, PEARL_TELEPORT_DAMAGE);
  assert.equal(plan.request.damage.bypassArmor, true);
  assert.equal(plan.request.damage.bypassShield, true);
  assert.equal(plan.request.damage.creativeImmune, true);
}

function assertImpact(f, before, plan, state = f.snapshot()) {
  assert.equal(state.gameplay.health, 15);
  assert.equal(
    state.gameplay.health,
    before.gameplay.health - PEARL_TELEPORT_DAMAGE
  );
  assert.deepEqual(state.gameplay.slots, before.gameplay.slots);
  assert.deepEqual(state.gameplay.offhand, before.gameplay.offhand);
  assert.deepEqual(state.gameplay.equipment, before.gameplay.equipment);
  assert.deepEqual(state.gameplay.experience, before.gameplay.experience);
  assert.equal(state.gameplay.slots[0].count, VEHICLE_PEARL_SETUP.pearls - 1);
  assert.deepEqual(state.player.position, plan.request.position);
  assert.deepEqual(state.player.velocity, { x: 0, y: 0, z: 0 });
  assert.deepEqual(state.player.eye, {
    ...plan.request.position,
    y: plan.request.position.y + before.player.eyeHeight,
  });
  assert.equal(state.player.poseRevision, before.player.poseRevision + 1);
  assert.equal(state.player.seated, false);
  assert.equal(state.player.grounded, false);
  assert.equal(state.player.moving, false);
  assert.equal(state.player.sprinting, false);
  assert.equal(state.player.climbing, false);
  assert.equal(state.player.fallDistance, 0);
  assert.equal(state.player.jumpQueued, false);
  assert.equal(state.player.sprintLatched, false);
  assert.equal(state.player.bob, 0);
  assert.deepEqual(
    [state.player.yaw, state.player.pitch],
    [before.player.yaw, before.player.pitch]
  );
  assert.deepEqual(state.vehicles.boats, {
    ...before.vehicles.boats,
    boats: before.vehicles.boats.boats.map((boat) => ({
      ...boat,
      passengers: [null, null],
    })),
  });
  assert.deepEqual(state.vehicles.fishing, {
    ...before.vehicles.fishing,
    casts: [],
  });
  assert.deepEqual(
    state.pearls,
    { ...before.pearls, projectiles: [] },
    "impact retains the paid attempt's RNG, next ID, life and cooldown"
  );
  assert.equal(state.archivePose, null, "departure must not fabricate an exit");
  assert.equal(state.pendingExit, null);
  assert.equal(state.fishingNeedsBinding, false);
  assert.deepEqual(state.handRevisions, before.handRevisions);
  for (const key of [
    "world",
    "chunks",
    "epoch",
    "overflow",
    "experience",
    "pickups",
    "fuses",
    "settlement",
    "mobs",
  ])
    assert.deepEqual(state[key], before[key], `impact must preserve ${key}`);
  assert.equal(
    state.bytes,
    before.bytes +
      plan.participants.reduce(
        (sum, p) => sum + p.afterBytes - p.beforeBytes,
        0
      )
  );
  for (const [name, owner] of Object.entries(f.owners)) {
    const participant = plan.participants.find((p) => p.owner === owner);
    assert.equal(
      state.reservations[name],
      participant?.afterBytes ?? before.reservations[name],
      `reservation for ${name}`
    );
  }
}

function snapshotNotifications(f, plan) {
  const snapshots = [];
  const participants = plan.participants.map((participant) => ({
    ...participant,
    notify() {
      assert.ok(snapshots.length < plan.participants.length);
      snapshots.push(f.snapshot());
      // Observe BEFORE the original notification, not after some observer has
      // "helpfully" detached a passenger or cancelled a cast in a second commit.
      return participant.notify?.();
    },
  }));
  return { participants, snapshots };
}

function assertRefusedUnchanged(f, participants, before = f.snapshot()) {
  const result = f.coordinator.commit(participants);
  assert.equal(result.ok, false);
  assert.deepEqual(
    f.snapshot(),
    before,
    "a rejected composite must preserve all owners, revisions, bytes, RNG and observers"
  );
  return result;
}

test(
  "a genuine mounted pearl atomically publishes pose, damage, retirement and offhand departure",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    assertRealOwners(f);
    const boatId = mountAndCast(f);
    const beforeThrow = throwMountedPearl(f);
    assert.equal(f.pearls.cooldown, PEARL_COOLDOWN_SECONDS);
    assert.equal(
      f.pearls.serialize().randomState,
      nextPearlRandom(beforeThrow.pearls.randomState)
    );
    assert.equal(f.pearls.serialize().nextId, beforeThrow.pearls.nextId + 1);
    assert.equal(
      f.projectiles.renderer.pearls.count,
      1,
      "real Three resource, not GPU proof"
    );
    const paid = f.snapshot();
    assert.equal(f.projectiles.throw("main"), false);
    assert.deepEqual(
      f.snapshot(),
      paid,
      "cooldown refusal must not reel the offhand or charge again"
    );
    const { plan, before } = nextVehiclePearlImpact(f);
    assert.ok(
      before.pearls.projectiles[0].age >= PEARL_STEP_SECONDS,
      "the projectile actually travelled from the seated physical eye"
    );
    assert.ok(f.fishing.getCast());
    assertJoinedPlan(f, plan);
    const observed = snapshotNotifications(f, plan);
    commitWithoutObserverErrors(f.coordinator, observed.participants);
    assert.equal(observed.snapshots.length, plan.participants.length);
    for (const snapshot of observed.snapshots)
      assertImpact(f, before, plan, snapshot);
    assertImpact(f, before, plan);
    assert.equal(
      collidesWithWorld(f.world, f.player.position, f.player.height),
      false
    );
    assert.equal(f.observed.hurt.length, 1);
    assert.equal(f.observed.hurt[0].damage, PEARL_TELEPORT_DAMAGE);
    assert.equal(f.vehicles.takeExitPose(), null);
    assert.equal(f.fishing.renderer.bobbers.count, 0);
    assert.equal(f.fishing.renderer.lineGeometry.drawRange.count, 0);
    assert.equal(f.projectiles.renderer.pearls.count, 0);
    assertRefusedUnchanged(f, plan.participants);
    assertNoVehicleSnapback(f, plan.request.position, boatId);
  }
);

test(
  "the native pearl frame performs the same departure and completed archives never remount or replay",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    const boatId = mountAndCast(f);
    throwMountedPearl(f);
    const { plan, before } = nextVehiclePearlImpact(f);
    assertJoinedPlan(f, plan);
    // Do not commit the inspected plan. Actual vehicle/Player motion comes first;
    // the native projectile frame must prepare its own current swept impact.
    f.step();
    assert.equal(f.pearls.size, 0);
    assert.equal(f.gameplay.health, 15);
    assert.equal(f.player.seated, false);
    assert.deepEqual(point(f.player.position), plan.request.position);
    assert.equal(f.boats.mountFor(), null);
    assert.equal(f.fishing.size, 0);
    assert.equal(f.vehicles.takeExitPose(), null);
    assert.deepEqual(
      f.gameplay.getHandStack("offhand"),
      before.gameplay.offhand
    );
    assert.equal(f.pearls.serialize().randomState, before.pearls.randomState);
    assert.equal(
      f.fishing.serialize().randomState,
      before.vehicles.fishing.randomState
    );
    assertRefusedUnchanged(f, plan.participants);
    assertNoVehicleSnapback(f, plan.request.position, boatId);
    assert.equal((await f.game.save()).ok, true);
    const saved = await f.game.storage.load();
    assert.deepEqual(saved.boats, f.boats.serialize());
    assert.deepEqual(saved.fishing, f.fishing.serialize());
    assert.deepEqual(saved.horses, f.vehicles.horses.serialize());
    assert.deepEqual(saved.playerProjectiles, f.pearls.serialize());
    assert.equal(saved.boats.boats.length, 1);
    assert.equal(saved.boats.boats[0].id, boatId);
    assert.equal(saved.boats.boats[0].stack.data.name, "Pearl crossing");
    assert.deepEqual(saved.boats.boats[0].passengers, [null, null]);
    assert.deepEqual(saved.fishing.casts, []);
    assert.equal(saved.gameplay.slots[0].count, VEHICLE_PEARL_SETUP.pearls - 1);

    const restored = await vehiclePearlFixture(t, { saved });
    assertRealOwners(restored);
    assert.deepEqual(restored.vehicles.serialize(), {
      boats: saved.boats,
      fishing: saved.fishing,
      horses: saved.horses,
    });
    assert.deepEqual(restored.pearls.serialize(), saved.playerProjectiles);
    assert.deepEqual(point(restored.player.position), point(saved.player));
    assert.equal(restored.player.seated, false);
    assert.equal(restored.vehicles.poseForArchive(), null);
    const physical = playerState(restored.player);
    restored.applyPose();
    assert.deepEqual(playerState(restored.player), physical);
    for (let tick = 0; tick < 8; tick++) restored.step();
    assert.equal(restored.observed.hurt.length, 0);
    assert.equal(restored.gameplay.health, 15);
    assert.equal(
      restored.gameplay.getHandStack().count,
      VEHICLE_PEARL_SETUP.pearls - 1
    );
    assert.equal(restored.pearls.size, 0);
    assert.equal(restored.fishing.size, 0);
    assert.deepEqual(restored.boats.getBoat(boatId).passengers, [null, null]);
    assert.equal(restored.player.position.x, saved.player.x);
    assert.equal(restored.player.position.z, saved.player.z);
  }
);

test(
  "each participant can veto a paid impact without partial release, refunds or RNG rewind",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    mountAndCast(f);
    throwMountedPearl(f);
    const { plan, before } = nextVehiclePearlImpact(f);
    assertJoinedPlan(f, plan);
    for (let index = 0; index < plan.participants.length; index++) {
      // Failure injection only: every successful publisher remains the real
      // prepared owner, including Boats/Fishing and the zero-byte host guard.
      const rejected = plan.participants.map((participant, at) =>
        at === index ? { ...participant, validate: () => false } : participant
      );
      assert.equal(
        assertRefusedUnchanged(f, rejected, before).reason,
        "validation-failed"
      );
    }
    commitWithoutObserverErrors(f.coordinator, plan.participants);
    assertImpact(f, before, plan);
    assertRefusedUnchanged(f, plan.participants);
  }
);

test(
  "a genuinely blocked landing retires only the paid pearl and retains the mounted boat and cast",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    const boatId = mountAndCast(f);
    // A single authored head obstruction, clear of the pearl's own swept path.
    const x = 8,
      y = 76,
      z = 4;
    assert.equal(f.world.getCell(x, y, z).id, BLOCK.AIR);
    assert.equal(
      f.world.applyCells([
        {
          x,
          y,
          z,
          before: f.world.getCell(x, y, z),
          after: { id: BLOCK.STONE },
        },
      ]),
      true
    );
    throwMountedPearl(f);
    const departure = t.mock.method(f.vehicles, "prepareDeparture");
    let reachedWall = false;
    for (let tick = 0; tick < VEHICLE_PEARL_SETUP.maxApproachTicks; tick++) {
      const projectile = f.pearls.projectiles[0];
      assert.ok(projectile);
      const flight = stepPearlFlight(f.world, f.context, projectile);
      if (flight.kind !== "impact") {
        assert.equal(flight.kind, "flight");
        f.step();
        continue;
      }
      assert.equal(flight.hit.cell.z, VEHICLE_PEARL_SETUP.wallZ);
      assert.deepEqual(flight.hit.normal, { x: 0, y: 0, z: 1 });
      assert.equal(
        pearlImpactPose(f.world, f.context, flight.hit, {
          radius: PLAYER_WIDTH / 2,
          height: f.player.height,
        }).kind,
        "blocked"
      );
      const before = f.snapshot();
      assert.equal(f.pearls.prepareImpactTransaction(projectile.id), null);
      assert.deepEqual(f.snapshot(), before);
      // Isolate this actual projectile tick from unrelated boat/fishing clocks.
      assert.equal(f.projectiles.frame(PEARL_STEP_SECONDS), true);
      assert.equal(f.pearls.size, 0);
      assert.deepEqual(playerState(f.player), before.player);
      assert.deepEqual(f.gameplay.serialize(), before.gameplay);
      assert.deepEqual(f.vehicles.serialize(), before.vehicles);
      assert.equal(f.boats.mountFor().id, boatId);
      assert.ok(f.fishing.getCast());
      assert.equal(f.pearls.serialize().randomState, before.pearls.randomState);
      assert.equal(f.pearls.serialize().nextId, before.pearls.nextId);
      assert.equal(f.observed.hurt.length, 0);
      assert.equal(f.vehicles.takeExitPose(), null);
      reachedWall = true;
      break;
    }
    assert.equal(reachedWall, true);
    assert.equal(
      departure.mock.callCount(),
      0,
      "a blocked pose must not prepare vehicle departure"
    );
    departure.mock.restore();
  }
);

test(
  "same-byte leaf changes and actual pose/read-set revisions stale the entire impact",
  options,
  async (t) => {
    const changes = [
      [
        "boat reload",
        (f) => assert.equal(f.boats.load(f.boats.serialize()), true),
      ],
      [
        "fishing reload",
        (f) => assert.equal(f.fishing.load(f.fishing.serialize()), true),
      ],
      [
        "physical look away/back",
        (f) => {
          f.player._applyLook(1, 0);
          f.player._applyLook(-1, 0);
        },
      ],
      [
        "wall edit away/back",
        (f, plan) => {
          const x = Math.floor(plan.request.position.x),
            y = Math.floor(plan.request.position.y);
          const z = VEHICLE_PEARL_SETUP.wallZ;
          const stone = f.world.getCell(x, y, z);
          assert.equal(stone.id, BLOCK.STONE);
          assert.equal(
            f.world.applyCells([
              { x, y, z, before: stone, after: { id: BLOCK.DIRT } },
            ]),
            true
          );
          assert.equal(
            f.world.applyCells([
              { x, y, z, before: f.world.getCell(x, y, z), after: stone },
            ]),
            true
          );
        },
      ],
    ];
    for (const [name, change] of changes)
      await t.test(name, options, async (t) => {
        const f = await vehiclePearlFixture(t);
        mountAndCast(f);
        throwMountedPearl(f);
        const { plan } = nextVehiclePearlImpact(f);
        change(f, plan);
        const afterExternalChange = f.snapshot();
        assertRefusedUnchanged(f, plan.participants, afterExternalChange);
        const current = f.pearls.prepareImpactTransaction(plan.projectileId);
        assert.ok(current);
        assertJoinedPlan(f, current);
        commitWithoutObserverErrors(f.coordinator, current.participants);
        assertImpact(f, afterExternalChange, current);
      });
  }
);

test(
  "a cast admitted after preparation cannot escape the departure's empty-leaf guard",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    mountAndCast(f, { cast: false });
    throwMountedPearl(f);
    const { plan } = nextVehiclePearlImpact(f);
    assertJoinedPlan(f, plan, { cast: false });
    const cast = f.vehicles.useHand("offhand");
    assert.equal(cast.ok, true);
    assert.equal(cast.action, "cast");
    const before = f.snapshot();
    assertRefusedUnchanged(f, plan.participants, before);
    const current = f.pearls.prepareImpactTransaction(plan.projectileId);
    assert.ok(current);
    assertJoinedPlan(f, current);
    commitWithoutObserverErrors(f.coordinator, current.participants);
    assertImpact(f, before, current);
  }
);

test(
  "capacity refuses an unpaid mounted throw but permits an already-paid impact at the full budget",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    mountAndCast(f);
    const filler = {};
    assert.equal(
      f.coordinator.register(
        filler,
        MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
      ),
      true
    );
    t.after(() => f.coordinator.release(filler));
    const full = f.snapshot();
    const throwPlan = f.pearls.prepareThrow({
      hand: "main",
      stack: f.gameplay.getHandStack(),
      handRevision: f.gameplay.getHandRevision("main"),
    });
    assert.ok(
      throwPlan,
      "capacity refusal is real budget admission, not invalid geometry"
    );
    assert.equal(f.coordinator.budget.canCommit(throwPlan.participants), false);
    assert.equal(
      assertRefusedUnchanged(f, throwPlan.participants, full).reason,
      "budget-rejected"
    );
    assert.equal(f.projectiles.throw("main"), false);
    assert.deepEqual(f.snapshot(), full);
    assert.equal(f.coordinator.release(filler), true);
    const beforeThrow = throwMountedPearl(f);
    assert.equal(
      f.pearls.serialize().randomState,
      nextPearlRandom(beforeThrow.pearls.randomState)
    );
    assert.equal(f.pearls.serialize().nextId, full.pearls.nextId + 1);
    const { plan } = nextVehiclePearlImpact(f);
    assertJoinedPlan(f, plan);
    assert.equal(
      f.coordinator.register(
        filler,
        MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
      ),
      true
    );
    const before = f.snapshot();
    assert.equal(before.bytes, MAX_RESERVED_BYTES);
    assert.equal(
      f.coordinator.budget.canCommit(plan.participants),
      true,
      "retirement and cast cancellation release bytes; impact must not require spare capacity"
    );
    commitWithoutObserverErrors(f.coordinator, plan.participants);
    assertImpact(f, before, plan);
    assertRefusedUnchanged(f, plan.participants);
  }
);

test(
  "a pending real dismount exit is cleared by impact without ever being applied as its destination",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    const boatId = mountAndCast(f, { cast: false });
    throwMountedPearl(f);
    const { plan: mountedPlan } = nextVehiclePearlImpact(f);
    const seated = playerState(f.player);
    const dismount = f.vehicles.dismount();
    assert.equal(dismount.ok, true);
    assert.equal(dismount.action, "dismount");
    assert.deepEqual(
      playerState(f.player),
      seated,
      "vehicle ownership does not move Player"
    );
    assert.equal(f.boats.mountFor(), null);
    assert.deepEqual(f.vehicles.poseForArchive(), dismount.exit);
    assert.notDeepEqual(
      point(dismount.exit.position),
      mountedPlan.request.position
    );
    const before = f.snapshot();
    assertRefusedUnchanged(f, mountedPlan.participants, before);
    const plan = f.pearls.prepareImpactTransaction(mountedPlan.projectileId);
    assert.ok(plan);
    assertJoinedPlan(f, plan, { mounted: false, cast: false });
    const observed = snapshotNotifications(f, plan);
    commitWithoutObserverErrors(f.coordinator, observed.participants);
    assert.equal(observed.snapshots.length, plan.participants.length);
    for (const snapshot of observed.snapshots)
      assertImpact(f, before, plan, snapshot);
    assertImpact(f, before, plan);
    assert.equal(f.vehicles.takeExitPose(), null);
    assertNoVehicleSnapback(f, plan.request.position, boatId);
  }
);

test(
  "native snapshots use the committed seat/exit before the dt0 Player consumption boundary",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    const physicalBeforeMount = point(f.player.position);
    mountAndCast(f, { cast: false, consume: false });
    const seat = f.vehicles.riderPose();
    assert.notDeepEqual(point(seat.position), physicalBeforeMount);
    assert.deepEqual(point(f.player.position), physicalBeforeMount);
    assert.equal(f.player.seated, false);
    const beforeSeatRead = f.snapshot();
    for (let read = 0; read < 2; read++) {
      const saved = f.game.snapshot();
      assert.deepEqual(point(saved.player), point(seat.position));
      assert.deepEqual(saved.boats, f.boats.serialize());
    }
    assert.deepEqual(
      f.snapshot(),
      beforeSeatRead,
      "archive reads do not consume the seat"
    );
    const update = t.mock.method(f.player, "update");
    f.applyPose();
    assert.equal(update.mock.callCount(), 1);
    assert.equal(update.mock.calls[0].arguments[0], 0);
    assert.deepEqual(
      point(update.mock.calls[0].arguments[1].riderPose.position),
      point(seat.position)
    );
    assert.deepEqual(point(f.player.position), point(seat.position));
    assert.equal(f.player.seated, true);

    const dismount = f.vehicles.dismount();
    assert.equal(dismount.ok, true);
    const beforeExitRead = f.snapshot();
    for (let read = 0; read < 2; read++) {
      assert.deepEqual(
        point(f.game.snapshot().player),
        point(dismount.exit.position)
      );
      assert.deepEqual(f.vehicles.poseForArchive(), dismount.exit);
    }
    assert.deepEqual(
      f.snapshot(),
      beforeExitRead,
      "archive reads must retain the pending exit"
    );
    assert.deepEqual(point(f.player.position), point(seat.position));
    assert.equal(f.player.seated, true);
    f.applyPose();
    assert.equal(update.mock.callCount(), 2);
    assert.equal(update.mock.calls[1].arguments[0], 0);
    assert.deepEqual(update.mock.calls[1].arguments[1].exitPose, dismount.exit);
    assert.deepEqual(point(f.player.position), point(dismount.exit.position));
    assert.equal(f.player.seated, false);
    assert.equal(f.vehicles.poseForArchive(), null);
    const exited = playerState(f.player);
    f.applyPose();
    assert.equal(
      update.mock.callCount(),
      2,
      "no committed pose means NO Player.update call"
    );
    assert.deepEqual(playerState(f.player), exited);
    update.mock.restore();
  }
);

test(
  "actual core impact preparation rejects malformed, duplicate and foreign extra participants",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    mountAndCast(f);
    throwMountedPearl(f);
    const { plan } = nextVehiclePearlImpact(f);
    assertJoinedPlan(f, plan);
    const retirement = plan.participants.find(
      ({ owner }) => owner === f.pearls
    );
    const foreignGameplay = new Gameplay({
      context: f.context,
      coordinator: new TransactionCoordinator(),
      mode: "survival",
    });
    t.after(() => foreignGameplay.dispose());
    const foreign = foreignGameplay.prepareInventory(() => true, {
      notify: false,
    });
    assert.ok(foreign);
    let asyncCalls = 0;
    const cases = [
      ["null collection", () => null],
      ["object collection", () => ({})],
      ["invalid entry", (effects) => [...effects.extraParticipants, null]],
      [
        "duplicate departure",
        (effects) => [
          ...effects.extraParticipants,
          effects.extraParticipants[0],
        ],
      ],
      [
        "duplicate pose",
        (effects) => [...effects.extraParticipants, effects.pose],
      ],
      [
        "duplicate damage",
        (effects) => [...effects.extraParticipants, effects.damage],
      ],
      [
        "duplicate retirement",
        (effects) => [...effects.extraParticipants, retirement],
      ],
      [
        "foreign coordinator",
        (effects) => [...effects.extraParticipants, foreign],
      ],
      [
        "asynchronous validator",
        (effects) => [
          ...effects.extraParticipants.slice(1),
          {
            ...effects.extraParticipants[0],
            validate: async () => {
              asyncCalls++;
              return true;
            },
          },
        ],
      ],
    ];
    const nativePrepare = f.pearls.prepareImpact;
    for (const [name, invalidExtras] of cases) {
      let nativeEffects;
      const before = f.snapshot();
      const bridge = t.mock.method(f.pearls, "prepareImpact", (request) => {
        nativeEffects = nativePrepare(request);
        return (
          nativeEffects && {
            ...nativeEffects,
            extraParticipants: invalidExtras(nativeEffects),
          }
        );
      });
      try {
        assert.equal(
          f.pearls.prepareImpactTransaction(plan.projectileId),
          null,
          name
        );
        assert.ok(
          nativeEffects?.pose && nativeEffects.damage,
          "real host produced the base effects"
        );
        assert.equal(nativeEffects.extraParticipants.length, 3);
        assert.deepEqual(f.snapshot(), before, name);
      } finally {
        bridge.mock.restore();
      }
    }
    assert.equal(
      asyncCalls,
      0,
      "reject asynchronous callbacks without invoking them"
    );
    commitWithoutObserverErrors(f.coordinator, plan.participants);
    assert.equal(f.gameplay.health, 15);
    assert.equal(f.boats.mountFor(), null);
    assert.equal(f.fishing.size, 0);
  }
);

test(
  "the core bounds extra participant work even when every supplied owner is unique and valid",
  options,
  async (t) => {
    const f = await vehiclePearlFixture(t);
    mountAndCast(f);
    throwMountedPearl(f);
    const { plan } = nextVehiclePearlImpact(f);
    const extraOwners = [];
    t.after(() => {
      for (const owner of extraOwners) owner.dispose();
    });
    // The supported vehicle bridge needs at most three extras. This deliberately
    // excessive batch has no duplicates/foreign owners to mask a missing bound.
    assert.ok(Number.isSafeInteger(MAX_PEARL_IMPACT_PEERS));
    assert.ok(MAX_PEARL_IMPACT_PEERS >= 3 && MAX_PEARL_IMPACT_PEERS <= 64);
    const extras = Array.from({ length: MAX_PEARL_IMPACT_PEERS + 1 }, () => {
      const owner = new DropOverflow({
        context: f.context,
        coordinator: f.coordinator,
      });
      extraOwners.push(owner);
      const participant = owner.prepareEnqueue(
        [{ id: ITEM.STICK, count: 1 }],
        point(f.player.position),
        f.world.dimension
      );
      assert.ok(participant);
      return participant;
    });
    assert.equal(
      new Set(extras.map(({ owner }) => owner)).size,
      MAX_PEARL_IMPACT_PEERS + 1
    );
    assert.equal(f.coordinator.budget.canCommit(extras), true);
    const before = f.snapshot();
    const nativePrepare = f.pearls.prepareImpact;
    let nativeEffects;
    const bridge = t.mock.method(f.pearls, "prepareImpact", (request) => {
      nativeEffects = nativePrepare(request);
      return nativeEffects && { ...nativeEffects, extraParticipants: extras };
    });
    try {
      assert.equal(f.pearls.prepareImpactTransaction(plan.projectileId), null);
      assert.ok(nativeEffects?.pose && nativeEffects.damage);
      assert.deepEqual(f.snapshot(), before);
      for (const owner of extraOwners) assert.equal(owner.size, 0);
    } finally {
      bridge.mock.restore();
    }
  }
);

test(
  "vehicle-hand geometry and capacity refusals never fall through to a usable offhand pearl",
  options,
  async (t) => {
    for (const scenario of ["boat-no-water", "boat-capacity", "rod-capacity"])
      await t.test(scenario, options, async (t) => {
        const f = await vehiclePearlFixture(t);
        assert.equal(
          f.gameplay.inventoryTransaction((draft) => {
            draft.offhand = { id: ITEM.ENDER_PEARL, count: 2 };
            if (scenario === "rod-capacity")
              draft.slots[1] = {
                id: ITEM.FISHING_ROD,
                count: 1,
                durability: getItem(ITEM.FISHING_ROD).durability,
              };
            return true;
          }),
          true
        );
        f.game.select(1);
        aim(f, 0, scenario === "boat-no-water" ? 0.9 : -0.55);
        if (scenario !== "boat-no-water") {
          const filler = {};
          assert.equal(
            f.coordinator.register(
              filler,
              MAX_RESERVED_BYTES -
                f.coordinator.budget.totalBytes -
                PEARL_RECORD_RESERVED_BYTES -
                128
            ),
            true
          );
          t.after(() => f.coordinator.release(filler));
        }
        const offhand = f.pearls.prepareThrow({
          hand: "offhand",
          stack: f.gameplay.getHandStack("offhand"),
          handRevision: f.gameplay.getHandRevision("offhand"),
        });
        assert.ok(offhand);
        assert.equal(
          f.coordinator.budget.canCommit(offhand.participants),
          true,
          "the offhand could succeed, so suppressing fallthrough is observable"
        );
        const vehicle = f.vehicles.prepareUseHand("main");
        if (scenario === "boat-no-water") {
          assert.equal(vehicle.ok, false);
          assert.equal(vehicle.reason, "water-or-clearance");
        } else {
          assert.equal(vehicle.ok, true);
          assert.equal(
            f.coordinator.budget.canCommit(vehicle.participants),
            false
          );
        }
        const before = f.snapshot();
        const accepted = f.game.beginUse("mouse");
        f.game.endUse("mouse", true);
        assert.equal(accepted, false);
        const after = f.snapshot();
        // Refusal feedback is allowed; no logical owner may publish or lose an
        // item merely because another hand could perform a different action.
        assert.deepEqual(
          { ...after, observed: null },
          { ...before, observed: null }
        );
        assert.equal(f.observed.hurt.length, before.observed.hurt.length);
        assert.equal(f.pearls.size, 0);
        assert.equal(f.gameplay.getHandStack("offhand").count, 2);
      });
  }
);

test(
  "real death and accepted host travel detach mounted pending flights without invented exits or refunds",
  options,
  async (t) => {
    for (const reason of ["death", "travel"])
      await t.test(reason, options, async (t) => {
        const f = await vehiclePearlFixture(t);
        const boatId = mountAndCast(f);
        throwMountedPearl(f);
        const { plan, before } = nextVehiclePearlImpact(f);
        if (reason === "death") {
          f.gameplay.damage(100, "fall");
          assert.equal(f.gameplay.dead, true);
          assert.equal(f.observed.death, 1);
          assert.equal(f.pearls.life, before.pearls.life + 1);
        } else {
          const result = await new GameTravel(f.game).teleport({
            x: 8.5,
            y: VEHICLE_PEARL_SETUP.landingY,
            z: 4.6,
            dimension: "overworld",
          });
          assert.equal(result.ok, true, result.message);
          assert.equal(
            f.gameplay.health,
            20,
            "accepted travel cancels, it does not complete a pearl hit"
          );
          assert.equal(f.observed.hurt.length, 0);
          assert.equal(f.pearls.life, before.pearls.life);
        }
        assert.equal(f.boats.mountFor(), null);
        assert.deepEqual(f.boats.getBoat(boatId), {
          ...before.vehicles.boats.boats[0],
          passengers: [null, null],
        });
        assert.equal(f.fishing.size, 0);
        assert.equal(f.pearls.size, 0);
        assert.equal(f.vehicles.takeExitPose(), null);
        assert.equal(
          f.gameplay.getHandStack().count,
          VEHICLE_PEARL_SETUP.pearls - 1
        );
        assert.equal(
          f.pearls.serialize().randomState,
          before.pearls.randomState
        );
        assert.equal(
          f.fishing.serialize().randomState,
          before.vehicles.fishing.randomState
        );
        assert.deepEqual(f.overflow.serialize(), before.overflow);
        assert.deepEqual(f.experience.serialize(), before.experience);
        assertRefusedUnchanged(f, plan.participants);
        assert.equal((await f.game.save()).ok, true);
        const saved = await f.game.storage.load();
        assert.deepEqual(saved.boats.boats[0].passengers, [null, null]);
        assert.deepEqual(saved.fishing.casts, []);
        assert.deepEqual(saved.playerProjectiles.projectiles, []);
        assert.equal(
          saved.gameplay.slots[0].count,
          VEHICLE_PEARL_SETUP.pearls - 1
        );
      });
  }
);
