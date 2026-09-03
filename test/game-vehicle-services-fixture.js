import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { GameVehicleServices } from "../src/game-vehicle-services.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";
import { controlFixture } from "./control-fixture.js";

/** Real World transport/edits/geometry with an explicitly authored flat ocean.
 * This is an owner integration fixture, not evidence of natural generation. */
export function vehicleHostFixture(
  t,
  {
    seed = "vehicle-host",
    generatorVersion = 4,
    dimension = "overworld",
    stage = true,
    activate = true,
    scene = new THREE.Scene(),
    saved = null,
    savedGameplay,
    maxEntries,
    allowOverBudget = false,
  } = {}
) {
  const generatorFactory = (_seed, dimension, version) => {
    const spec = getWorldSpec(version, dimension);
    return {
      getSpawn: () => ({ x: 8.5, y: 9.08, z: 12.5 }),
      generateChunk(cx, cz) {
        const ArrayType = version === 4 ? Uint16Array : Uint8Array;
        const blocks = new ArrayType((spec.maxY - spec.minY) * 256);
        blocks.fill(BLOCK.STONE, 0, (4 - spec.minY) * 256);
        blocks.fill(BLOCK.WATER, (4 - spec.minY) * 256, (9 - spec.minY) * 256);
        return {
          cx,
          cz,
          minY: spec.minY,
          maxY: spec.maxY,
          blocks,
          biomes: new Uint8Array(256),
        };
      },
    };
  };
  const world = new World(seed, {
    dimension,
    generatorVersion,
    generatorFactory,
    useWorker: false,
  }).generate(1);
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const gameplay = new Gameplay({ coordinator, context, mode: "survival" });
  if (savedGameplay)
    assert.equal(gameplay.load(savedGameplay, { context }), true);
  const overflow = new DropOverflow({ coordinator, context, maxEntries });
  // A real orb owner always has its own scene, even for render-free host tests.
  const experienceOrbs = new ExperienceOrbs(scene ?? new THREE.Scene(), world, {
    coordinator,
    context,
    prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  const controls = controlFixture(t);
  const player = controls.player;
  player.world = world;
  player.allowFlight = false;
  player.pitch = -0.55;
  player.setPosition(world.generator.getSpawn());
  const notifications = [],
    sounds = [],
    services = [];
  const game = {
    world,
    worldContext: context,
    coordinator,
    gameplay,
    overflow,
    experienceOrbs,
    player,
    graphics: { scene, camera: controls.camera },
    paused: false,
    building: false,
    failed: false,
    overlayOpen: false,
    closingScreens: false,
    simulating: true,
    active: true,
    scheduleSave() {
      notifications.push("save");
    },
    refreshHud() {
      notifications.push("hud");
    },
    ui: { toast: (text) => notifications.push(text) },
    effects: { sound: (...args) => sounds.push(args) },
  };
  const fixture = {
    world,
    context,
    coordinator,
    gameplay,
    overflow,
    experienceOrbs,
    player,
    game,
    notifications,
    sounds,
    controls,
    service: null,
    create(options = {}) {
      const service = new GameVehicleServices({
        world,
        gameplay,
        overflow,
        context,
        coordinator,
        saved,
        allowOverBudget,
        ...options,
      });
      services.push(service);
      return service;
    },
    setHand(
      name,
      { hand = "main", durability, data, index = gameplay.selected } = {}
    ) {
      const item = getItem(ITEM[name]);
      assert.ok(
        item,
        `Real catalog item ${name} must be in the parent's checkpoint`
      );
      const stack = {
        id: item.id,
        count: 1,
        ...(item.durability
          ? { durability: durability ?? item.durability }
          : {}),
        ...(data === undefined ? {} : { data }),
      };
      assert.equal(
        gameplay.inventoryTransaction((draft) => {
          if (hand === "offhand") draft.offhand = stack;
          else draft.slots[index] = stack;
          return true;
        }),
        true
      );
      if (hand === "main" && gameplay.mode === "creative")
        gameplay.assignSlot(index, item.id);
      return stack;
    },
    aimAt(point) {
      const eye = player.eyePosition;
      const dx = point.x - eye.x,
        dy = point.y - eye.y,
        dz = point.z - eye.z;
      player.yaw = Math.atan2(-dx, -dz);
      player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      player._syncCamera(0);
    },
    put(x, y, z, value) {
      const before = world.getCell(x, y, z),
        after = normalizeCell(
          typeof value === "number" ? { id: value } : value
        );
      assert.ok(before);
      if (
        before.id === after.id &&
        before.state === after.state &&
        before.fluid === after.fluid
      )
        return;
      assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
    },
    snapshot(service = fixture.service) {
      return {
        world: world.serialize(),
        gameplay: gameplay.serialize(),
        overflow: overflow.serialize(),
        experience: experienceOrbs.serialize(),
        vehicles: service.serialize(),
        bytes: coordinator.budget.totalBytes,
      };
    },
    replaceService(snapshot, options = {}) {
      assert.equal(fixture.service.dispose(), true);
      fixture.service = fixture.create({ saved: snapshot, ...options });
      assert.equal(fixture.service.activate(game).ok, true);
      return fixture.service;
    },
  };
  world.onMutation = (event) => fixture.service?.onMutation(world, event);
  t.after(() => {
    for (const service of services) service.dispose();
    experienceOrbs.dispose();
    overflow.dispose();
    gameplay.dispose();
    world.dispose();
  });
  if (stage) {
    fixture.service = fixture.create();
    if (activate) assert.equal(fixture.service.activate(game).ok, true);
  }
  return fixture;
}

/**
 * Exercise the host's publication boundary with the actual Player. This is the
 * documented pose consumption protocol; the parent owns Player.update's native
 * riderPose branch and its separate browser/input regression tests.
 */
export function consumeVehiclePose(fixture) {
  const rider = fixture.service.riderPose();
  const exit = fixture.service.takeExitPose();
  const pose = rider ?? exit;
  if (!pose) return null;
  const player = fixture.player;
  player.setPosition(pose.position);
  player.velocity.set(pose.velocity.x, pose.velocity.y, pose.velocity.z);
  player.grounded = pose.grounded;
  player.moving = player.sprinting = player.climbing = false;
  player.sneaking = false;
  player.fallDistance = 0;
  player._syncCamera(0);
  return pose;
}

export function placeAndMount(fixture, name = "OAK_BOAT") {
  fixture.setHand(name, { data: { version: 1, name: "Estuary" } });
  const placed = fixture.service.useHand();
  assert.equal(placed.ok, true);
  const boat = fixture.service.boats.getBoat(placed.id);
  fixture.aimAt({ x: boat.x, y: boat.y + 0.3, z: boat.z });
  const hit = fixture.service.raycast();
  assert.equal(hit?.type, "boat");
  assert.equal(fixture.service.interact(hit).ok, true);
  consumeVehiclePose(fixture);
  return placed.id;
}

/** A real waited progression: no timer/RNG rewrite, debug rod, or clock skip. */
export function waitForHostBite(fixture, limit = 1000) {
  const phases = new Set();
  for (let tick = 0; tick < limit; tick++) {
    const cast = fixture.service.fishing.getCast();
    assert.ok(
      cast,
      "the cast stays owned throughout flight and the waited attempt"
    );
    phases.add(cast.phase);
    if (cast.phase === "hook") return { cast, phases, ticks: tick };
    assert.equal(fixture.service.frame(0.05).ok, true);
    consumeVehiclePose(fixture);
  }
  assert.fail("cast failed to reach a bite within the bounded fishing phases");
}

/** Save-window fixture for atomicity tests only, not a claim of waited fishing. */
export function stageHostHook(fixture, { randomState = 7 } = {}) {
  if (!fixture.service.fishing.hasCast())
    assert.equal(fixture.service.useHand().action, "cast");
  const snapshot = fixture.service.serialize();
  Object.assign(snapshot.fishing.casts[0], {
    x: 8.5,
    y: 8.845,
    z: 8.5,
    vx: 0,
    vy: 0,
    vz: 0,
    phase: "hook",
    total: 30,
    remaining: 30,
    accumulator: 0,
    openWater: true,
    randomState,
  });
  return fixture.replaceService(snapshot);
}
