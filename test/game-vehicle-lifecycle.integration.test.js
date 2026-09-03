import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { boatSeat } from "../src/boat-definitions.js";
import { normalizeVehicleServicesSnapshot } from "../src/game-vehicle-services.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  consumeVehiclePose,
  placeAndMount,
  stageHostHook,
  vehicleHostFixture,
} from "./game-vehicle-services-fixture.js";

test("legacy absent sidecars, including World's empty-string seed, migrate without changing identity", (t) => {
  for (const generatorVersion of [1, 2, 3, 4]) {
    const context = createWorldContext({ seed: "", generatorVersion });
    const normalized = normalizeVehicleServicesSnapshot(
      { legacy: true },
      context
    );
    assert.equal(normalized.boats.seed, "");
    assert.equal(normalized.fishing.seed, "");
    assert.equal(normalized.boats.generatorVersion, generatorVersion);
    assert.deepEqual(normalized.boats.boats, []);
    assert.deepEqual(normalized.fishing.casts, []);
  }
  const f = vehicleHostFixture(t, { seed: "", generatorVersion: 3 });
  assert.equal(f.service.active, true);
  assert.equal(f.service.serialize().boats.seed, f.world.seed);
});

test("preflight is pure and rejects malformed-present fields instead of silently emptying them", (t) => {
  const f = vehicleHostFixture(t, { activate: false });
  const before = f.service.serialize(),
    bytes = f.coordinator.budget.totalBytes;
  const reads = t.mock.method(f.world, "getCell", () =>
    assert.fail("pure preflight must not read World")
  );
  for (const saved of [
    { boats: undefined },
    { boats: null },
    { boats: {} },
    { fishing: undefined },
    { fishing: null },
    { fishing: { ...before.fishing, version: 2 } },
    { boats: { ...before.boats, seed: "wrong" } },
    { fishing: { ...before.fishing, generatorVersion: 3 } },
  ])
    assert.equal(normalizeVehicleServicesSnapshot(saved, f.context), null);
  assert.equal(
    normalizeVehicleServicesSnapshot(
      {},
      {
        ...f.context,
        specForDimension: (dimension) =>
          dimension === "end"
            ? { ...f.context.specForDimension(dimension), minY: -64 }
            : f.context.specForDimension(dimension),
      }
    ),
    null,
    "inactive dimension context must be canonical too"
  );
  assert.deepEqual(f.service.serialize(), before);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  reads.mock.restore();
});

test("staging performs no rendering, admission, input, or callbacks; activation binds once", (t) => {
  const f = vehicleHostFixture(t, { stage: false });
  const children = f.game.graphics.scene.children.length;
  const mutationObserver = f.world.onMutation;
  t.mock.method(f.world, "ensureArea", () =>
    assert.fail("host cannot admit terrain")
  );
  t.mock.method(f.world, "getCell", () =>
    assert.fail("empty staged service has no geometry work")
  );
  f.service = f.create();
  assert.equal(f.service.boats.renderer, null);
  assert.equal(f.service.fishing.renderer, null);
  assert.equal(f.game.graphics.scene.children.length, children);
  assert.equal(f.game.vehicleServices, undefined);
  assert.equal(f.service.frame(0.05).ok, false);
  assert.equal(f.service.fishing.cast().ok, false);
  assert.deepEqual(f.notifications, []);
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.game.boats, f.service.boats);
  assert.equal(f.game.fishing, f.service.fishing);
  assert.equal(f.game.graphics.scene.children.length, children + 3);
  assert.equal(f.world.onMutation, mutationObserver);
  const bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.game.graphics.scene.children.length, children + 3);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(
    f.service.load(f.service.serialize()),
    false,
    "live loads require a new detached host"
  );
});

test("invalid configured loot tables fail staging without leaking headers, renderers or host bindings", (t) => {
  const f = vehicleHostFixture(t, { stage: false });
  const bytes = f.coordinator.budget.totalBytes;
  const children = [...f.game.graphics.scene.children];
  assert.throws(
    () =>
      f.create({
        lootTables: {
          fish: [{ item: "RAW_COD", weight: 1 }],
          junk: [{ item: "STICK", weight: 1 }],
          treasure: [{ item: "UNREGISTERED_VEHICLE_REWARD", weight: 1 }],
        },
      }),
    /unregistered requested item/
  );
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.deepEqual(f.game.graphics.scene.children, children);
  assert.equal(f.game.vehicleServices, undefined);
  f.service = f.create();
  assert.equal(f.service.activate(f.game).ok, true);
});

test("stale epoch, occupied alias and wrong XP owner cannot attach a staged host", (t) => {
  const f = vehicleHostFixture(t, { activate: false });
  const children = f.game.graphics.scene.children.length;
  assert.equal(
    f.service.activate({ ...f.game, experienceOrbs: f.overflow }).ok,
    false
  );
  assert.equal(f.game.vehicleServices, undefined);
  const occupied = { ...f.game, boats: { _disposed: false } };
  assert.equal(
    f.service.activate(occupied).reason,
    "vehicle-host-already-owned"
  );
  assert.equal(occupied.vehicleServices, undefined);
  f.world.setDimension("end");
  assert.equal(f.service.activate(f.game).ok, false);
  assert.equal(f.game.graphics.scene.children.length, children);
  assert.equal(f.service.dispose(), true);
});

test("render-free activation uses the real XP owner without allocating vehicle meshes", (t) => {
  const f = vehicleHostFixture(t, { activate: false, scene: null });
  assert.equal(
    f.service.experienceOrbs,
    null,
    "the stage does not invent an XP receiver"
  );
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.service.experienceOrbs, f.experienceOrbs);
  assert.equal(f.service.boats.renderer, null);
  assert.equal(f.service.fishing.renderer, null);
  f.setHand("FISHING_ROD");
  assert.equal(f.service.useHand().action, "cast");
  assert.equal(f.service.render(0.05), true);
});

test("renderer construction failures release every scene resource and keep the stage retryable", (t) => {
  for (const rejectedName of [
    "boats-and-rafts",
    "fishing-bobbers-and-bite-bubbles",
  ]) {
    const f = vehicleHostFixture(t, { activate: false });
    const scene = f.game.graphics.scene,
      add = scene.add;
    const before = f.service.serialize(),
      bytes = f.coordinator.budget.totalBytes;
    const children = [...scene.children];
    const mocked = t.mock.method(scene, "add", function (...objects) {
      add.apply(this, objects);
      if (objects.some((object) => object.name === rejectedName))
        throw new Error("fixture scene rejection");
      return this;
    });
    assert.equal(f.service.activate(f.game).ok, false);
    assert.deepEqual(scene.children, children);
    assert.equal(f.game.vehicleServices, undefined);
    assert.equal(f.service.boats.renderer, null);
    assert.equal(f.service.fishing.renderer, null);
    assert.deepEqual(f.service.serialize(), before);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    mocked.mock.restore();
    assert.equal(f.service.activate(f.game).ok, true);
  }
});

test("scene observers cannot move the staged player and still publish saved cast binding", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  stageHostHook(f);
  const saved = f.service.serialize();
  assert.equal(f.service.dispose(), true);
  f.service = f.create({ saved });
  const scene = f.game.graphics.scene,
    add = scene.add,
    yaw = f.player.yaw;
  const children = [...scene.children],
    bytes = f.coordinator.budget.totalBytes;
  const mocked = t.mock.method(scene, "add", function (...objects) {
    add.apply(this, objects);
    if (objects.some((object) => object.name === "fishing-lines"))
      f.player.yaw = yaw + 0.4;
    return this;
  });
  assert.equal(f.service.activate(f.game).reason, "stale-vehicle-activation");
  assert.equal(f.service.fishing.needsBinding(), true);
  assert.equal(f.game.vehicleServices, null);
  assert.deepEqual(f.service.serialize(), saved);
  assert.deepEqual(scene.children, children);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  mocked.mock.restore();
  f.player.yaw = yaw;
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.service.fishing.needsBinding(), false);
});

test("multi-leaf staged capacity veto never installs only the first component", (t) => {
  const source = vehicleHostFixture(t);
  placeAndMount(source);
  source.setHand("FISHING_ROD");
  source.player.pitch = -0.2;
  stageHostHook(source);
  const saved = source.service.serialize();
  const f = vehicleHostFixture(t, { activate: false });
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes - 3000
    ),
    true
  );
  t.after(() => f.coordinator.release(filler));
  const before = f.service.serialize(),
    bytes = f.coordinator.budget.totalBytes;
  assert.equal(
    f.service.load(
      { ...saved, fishing: { ...saved.fishing, version: 99 } },
      { allowOverBudget: true }
    ),
    false
  );
  assert.deepEqual(f.service.serialize(), before);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.service.load(saved), false);
  assert.deepEqual(f.service.serialize(), before);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.service.load(saved, { allowOverBudget: true }), true);
  assert.equal(f.service.boats.size, 1);
  assert.equal(f.service.fishing.size, 1);
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.deepEqual(f.service.serialize(), saved);
});

test("import admission permits new empty headers over budget but does not authorize new boat ownership", (t) => {
  const f = vehicleHostFixture(t, { stage: false });
  f.setHand("OAK_BOAT");
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  t.after(() => f.coordinator.release(filler));
  const before = f.coordinator.budget.totalBytes;
  assert.throws(() => f.create(), /reserve boat archive header/);
  assert.equal(
    f.coordinator.budget.totalBytes,
    before,
    "failed construction releases lifecycle/children"
  );
  f.service = f.create({ allowOverBudget: true });
  assert.equal(f.service.activate(f.game).ok, true);
  const saved = f.snapshot();
  const plan = f.service.prepareUseHand();
  assert.equal(plan.ok, true);
  assert.equal(f.service.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), saved);
});

test("mounted boat and an exact enchanted rod slot rebind on reload without reroll or duplicate costs", (t) => {
  const f = vehicleHostFixture(t);
  const id = placeAndMount(f);
  f.setHand("FISHING_ROD", {
    hand: "offhand",
    durability: 19,
    data: {
      version: 1,
      name: "Estuary line",
      enchantments: { lure: 2, luck_of_the_sea: 3 },
    },
  });
  f.player.pitch = -0.2;
  assert.equal(f.service.useHand("offhand").ok, true);
  for (let i = 0; i < 3; i++) {
    f.service.frame(0.05);
    consumeVehiclePose(f);
  }
  const saved = f.service.serialize();
  const gameplay = f.gameplay.serialize();
  const position = f.player.position.clone();
  assert.equal(f.service.dispose(), true);
  assert.equal(f.gameplay.load(gameplay), true);
  f.player.setPosition(position);
  f.service = f.create({ saved });
  assert.equal(f.service.fishing.needsBinding(), true);
  assert.equal(f.service.stageRiderPose(f.player.position).ok, true);
  assert.equal(f.service.stagePlayerPose(f.player.position).ok, true);
  assert.equal(
    f.service.fishing.needsBinding(),
    true,
    "pre-teardown validation does not publish binding"
  );
  assert.deepEqual(f.service.serialize(), saved);
  assert.ok(f.service.requiredFootprints().length <= 2);
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.service.riderPose().id, id);
  assert.equal(f.service.fishing.needsBinding(), false);
  const rebound = f.service.fishing.getCast(),
    prior = saved.fishing.casts[0];
  assert.deepEqual(rebound, {
    ...prior,
    handRevision: f.gameplay.getHandRevision("offhand"),
  });
  assert.equal(rebound.slotKey, "offhand:0");
  assert.deepEqual(f.gameplay.serialize(), gameplay);
  assert.equal(f.overflow.size, 0);
  assert.equal(f.experienceOrbs.size, 0);
});

test("a saved rider cannot activate at a different pose, across a frontier, or inside a new obstruction", (t) => {
  const f = vehicleHostFixture(t);
  const id = placeAndMount(f),
    at = f.player.position.clone();
  const saved = f.service.serialize(),
    boat = f.service.boats.getBoat(id);
  assert.equal(f.service.dispose(), true);
  f.service = f.create({ saved });
  assert.equal(
    f.service.stageRiderPose({ ...at, x: at.x + 1 }).reason,
    "saved-rider-pose-mismatch"
  );
  const unavailable = t.mock.method(f.world, "isLoaded", () => false);
  assert.equal(f.service.stageRiderPose(at).reason, "rider-frontier");
  unavailable.mock.restore();
  f.put(
    Math.floor(boat.x),
    Math.floor(boat.y + 2),
    Math.floor(boat.z),
    BLOCK.STONE
  );
  assert.equal(f.service.stageRiderPose(at).reason, "rider-obstructed");
  assert.equal(f.service.activate(f.game).reason, "rider-obstructed");
  assert.equal(f.game.vehicleServices, null);
  assert.deepEqual(f.service.serialize(), saved);
  assert.ok(f.player.position.equals(at));
});

test("an equal rod in a different durable slot is not a saved cast binding", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("FISHING_ROD");
  stageHostHook(f);
  const saved = f.service.serialize();
  assert.equal(f.service.dispose(), true);
  f.setHand("FISHING_ROD", { index: 1 });
  f.gameplay.select(1);
  f.service = f.create({ saved });
  const bytes = f.coordinator.budget.totalBytes;
  const children = f.game.graphics.scene.children.length;
  assert.equal(
    f.service.stagePlayerPose(f.player.position).reason,
    "saved-rod-mismatch"
  );
  assert.equal(f.service.activate(f.game).reason, "saved-rod-mismatch");
  assert.equal(f.service.active, false);
  assert.equal(f.game.vehicleServices, null);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.game.graphics.scene.children.length, children);
  assert.deepEqual(f.service.serialize(), saved);
});

test("inactive boat/cast records freeze and explicitly bind on return to that dimension", (t) => {
  const source = vehicleHostFixture(t);
  placeAndMount(source);
  source.setHand("FISHING_ROD");
  stageHostHook(source);
  const saved = source.service.serialize();
  saved.boats.boats[0].dimension = "end";
  saved.fishing.casts[0].dimension = "end";
  const f = vehicleHostFixture(t, {
    saved,
    savedGameplay: source.gameplay.serialize(),
  });
  const before = f.service.serialize();
  assert.equal(f.service.boats.activeSize, 0);
  assert.equal(f.service.fishing.activeSize, 0);
  const idleCalls = [
    t.mock.method(f.service.boats, "update", () =>
      assert.fail("inactive boat simulation")
    ),
    t.mock.method(f.service.fishing, "update", () =>
      assert.fail("inactive cast simulation")
    ),
    t.mock.method(f.service.boats._boats, "values", () =>
      assert.fail("inactive boat scan")
    ),
    t.mock.method(f.service.fishing._casts, "values", () =>
      assert.fail("inactive cast scan")
    ),
    t.mock.method(f.world, "getCell", () =>
      assert.fail("inactive geometry query")
    ),
    t.mock.method(f.service.boats.renderer, "render", () =>
      assert.fail("inactive boat draw")
    ),
    t.mock.method(f.service.fishing.renderer, "render", () =>
      assert.fail("inactive cast draw")
    ),
  ];
  const idle = f.service.frame(60);
  for (let i = 0; i < 5; i++) {
    assert.equal(f.service.frame(60), idle);
    assert.equal(f.service.raycast(), null);
    assert.equal(f.service.render(0.05), true);
  }
  for (const mocked of idleCalls) mocked.mock.restore();
  assert.equal(f.service.riderPose(), null);
  assert.deepEqual(f.service.serialize(), before);
  f.world.setDimension("end").generate(1);
  assert.equal(f.service.boats.activeSize, 1);
  assert.equal(f.service.fishing.activeSize, 1);
  f.player.setPosition(boatSeat(saved.boats.boats[0]));
  assert.equal(f.service.rebindPlayer().ok, true);
  assert.equal(f.service.riderPose().dimension, "end");
  assert.equal(f.service.fishing.needsBinding(), false);
  assert.equal(
    f.service.fishing.getCast().randomState,
    before.fishing.casts[0].randomState
  );
});

test("death and accepted travel atomically detach cast/passenger while retaining the actual boat", (t) => {
  for (const reason of ["death", "travel"]) {
    const f = vehicleHostFixture(t);
    const id = placeAndMount(f);
    f.setHand("FISHING_ROD");
    stageHostHook(f);
    f.service.render(0);
    assert.ok(f.service.fishing.renderer.bobbers.count > 0);
    assert.equal(f.service.fishing.renderer.lineGeometry.drawRange.count, 24);
    if (reason === "death") f.gameplay.damage(100, "fixture death");
    else {
      f.game.paused = true;
      f.game.building = true;
    }
    const plan = f.service.prepareDeparture(reason);
    assert.equal(plan.ok, true);
    const before = f.snapshot();
    const rejected = plan.participants.map((participant, index) =>
      index === 1 ? { ...participant, validate: () => false } : participant
    );
    assert.equal(f.coordinator.commit(rejected).ok, false);
    assert.deepEqual(f.snapshot(), before);
    // Parent may append departure participants directly to another accepted
    // movement transaction; rendering cleanup is still a postcommit observer.
    const result =
      reason === "death"
        ? f.service.onDeath()
        : f.coordinator.commit(plan.participants);
    assert.equal(result.ok, true);
    assert.equal(f.service.boats.mountFor(), null);
    assert.equal(f.service.boats.activeSize, 1);
    assert.equal(f.service.fishing.size, 0);
    assert.equal(f.service.fishing.activeSize, 0);
    assert.equal(f.service.boats.getBoat(id).stack.data.name, "Estuary");
    assert.equal(f.overflow.size, 0);
    assert.equal(f.experienceOrbs.size, 0);
    assert.equal(f.gameplay.getHandStack().durability, 64);
    assert.equal(
      f.service.takeExitPose(),
      null,
      "travel/respawn owns the destination, not a fake dismount"
    );
    assert.equal(f.service.fishing.renderer.hasFeedback, false);
    assert.equal(f.service.fishing.renderer.bobbers.count, 0);
    assert.equal(f.service.fishing.renderer.lineGeometry.drawRange.count, 0);
  }
});

test("a departure prepared while empty cannot overlook a subsequently admitted cast or passenger", (t) => {
  for (const acquire of [
    (f) => {
      f.setHand("FISHING_ROD");
      assert.equal(f.service.useHand().action, "cast");
    },
    (f) => {
      placeAndMount(f);
    },
  ]) {
    const f = vehicleHostFixture(t);
    const plan = f.service.prepareDeparture("travel");
    assert.equal(plan.ok, true);
    acquire(f);
    const before = f.snapshot();
    assert.equal(f.service.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.service.detachForTravel().ok, true);
    assert.equal(f.service.boats.mountFor(), null);
    assert.equal(f.service.fishing.hasCast(), false);
  }
});

test("disposing a host releases only its ownership and stales every outstanding plan", (t) => {
  const f = vehicleHostFixture(t);
  f.setHand("OAK_BOAT");
  const plan = f.service.prepareUseHand();
  assert.equal(plan.ok, true);
  const before = f.gameplay.serialize();
  const children = f.game.graphics.scene.children.length;
  assert.equal(f.service.dispose(), true);
  assert.equal(f.service.dispose(), true);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.game.vehicleServices, null);
  assert.equal(f.game.boats, null);
  assert.equal(f.game.fishing, null);
  assert.equal(f.game.graphics.scene.children.length, children - 3);
  assert.deepEqual(f.gameplay.serialize(), before);
  for (const owner of [f.world, f.gameplay, f.overflow, f.experienceOrbs])
    assert.notEqual(f.coordinator.usage(owner), undefined);
});
