import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { boatWoodForItem } from "../src/boat-definitions.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { fishingRodStats } from "../src/fishing-loot.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { GameVehicleServices } from "../src/game-vehicle-services.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import {
  PEARL_COLLISION_OFFSET,
  PEARL_STEP_SECONDS,
  stepPearlFlight,
} from "../src/pearl-physics.js";
import { Pickups } from "../src/pickups.js";
import { Player, PLAYER_WIDTH } from "../src/player.js";
import { Settlement } from "../src/settlement.js";
import { WorldStorage } from "../src/storage.js";
import { TransitionGate } from "../src/transition-gate.js";
import { Wildlife } from "../src/wildlife.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";

export const VEHICLE_PEARL_SETUP = Object.freeze({
  seed: "vehicle-pearl-ownership",
  generatorVersion: 3,
  spawn: Object.freeze({ x: 8.5, y: 73.08, z: 12.5 }),
  pearls: 6,
  rodDurability: 19,
  wallZ: 3,
  wallFace: 4,
  landingY: 73,
  maxApproachTicks: 12,
});

export const point = ({ x, y, z }) => ({ x, y, z });
const sameCell = (a, b) =>
  a.id === b.id && a.state === b.state && a.fluid === b.fluid;

function record(buffer, value) {
  assert.ok(buffer.length < 64, "fixture observation buffer is bounded");
  buffer.push(value);
}

/**
 * Native v3 generation/admission, followed by one explicitly authored pool,
 * wall and landing shelf. No generator/getCell/collision/teleport replacement.
 * The 11 x 15 x 14 setup volume and finite inventory are NOT natural acquisition.
 * Water remains static: this suite exercises owners, not the fluid scheduler.
 */
function authorPool(world) {
  const changes = [];
  for (let x = 3; x <= 13; x++) {
    for (let z = 0; z <= 14; z++) {
      for (let y = 67; y <= 80; y++) {
        let id = y === 67 ? BLOCK.STONE : y <= 72 ? BLOCK.WATER : BLOCK.AIR;
        if (z === VEHICLE_PEARL_SETUP.wallZ && x >= 6 && x <= 10 && y <= 78)
          id = BLOCK.STONE;
        if (x >= 7 && x <= 9 && z >= 4 && z <= 5 && y === 72) id = BLOCK.STONE;
        const before = world.getCell(x, y, z);
        const after = normalizeCell({ id });
        assert.ok(before, "authoring requires actual admitted cells");
        if (!sameCell(before, after)) changes.push({ x, y, z, before, after });
      }
    }
  }
  assert.ok(changes.length > 0 && changes.length <= 2310);
  assert.equal(world.applyCells(changes), true);
}

export function playerState(player) {
  return {
    position: point(player.position),
    eye: point(player.eyePosition),
    velocity: point(player.velocity),
    yaw: player.yaw,
    pitch: player.pitch,
    height: player.height,
    eyeHeight: player.eyeHeight,
    perspective: player.perspective,
    seated: player.seated,
    grounded: player.grounded,
    flying: player.flying,
    sneaking: player.sneaking,
    moving: player.moving,
    sprinting: player.sprinting,
    climbing: player.climbing,
    fallDistance: player.fallDistance,
    poseRevision: player.poseRevision,
    captureRevision: player._captureRevision,
    jumpQueued: player._jumpQueued,
    sprintLatched: player._sprintLatched,
    spaceTapAt: player._spaceTapAt,
    forwardTapAt: player._forwardTapAt,
    bob: player._bob,
    stepDistance: player._stepDistance,
    keys: [...player._keys].sort(),
  };
}

/** No logical participant is mocked. UI/audio are bounded observer sinks only. */
export async function vehiclePearlFixture(t, { saved = null } = {}) {
  const owned = [];
  let game, storage;
  const retain = (owner) => {
    owned.push(owner);
    return owner;
  };
  t.after(() => {
    // GameTravel may replace Wildlife with another real owner.
    game?.wildlife?.dispose();
    for (let index = owned.length - 1; index >= 0; index--)
      owned[index].dispose();
    storage?.database?.close();
  });
  const world = retain(
    new World(saved?.world.seed ?? VEHICLE_PEARL_SETUP.seed, {
      generatorVersion: VEHICLE_PEARL_SETUP.generatorVersion,
      useWorker: false,
    })
  );
  if (saved) assert.notEqual(world.loadEdits(saved.world), false);
  await world.ensureArea(VEHICLE_PEARL_SETUP.spawn, 1);
  if (!saved) authorPool(world);
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const gameplay = retain(new Gameplay({ mode: "survival", ...ownership }));
  if (saved) assert.equal(gameplay.load(saved.gameplay), true);
  else {
    assert.equal(
      boatWoodForItem(ITEM.OAK_BOAT),
      "oak",
      "requires the real boat catalogue"
    );
    assert.equal(
      gameplay.inventoryTransaction((draft) => {
        draft.slots.fill(null);
        draft.slots[0] = {
          id: ITEM.ENDER_PEARL,
          count: VEHICLE_PEARL_SETUP.pearls,
        };
        draft.slots[1] = {
          id: ITEM.OAK_BOAT,
          count: 1,
          data: { version: 1, name: "Pearl crossing" },
        };
        draft.offhand = {
          id: ITEM.FISHING_ROD,
          count: 1,
          durability: VEHICLE_PEARL_SETUP.rodDurability,
        };
        for (const [slot, id] of [
          ["head", ITEM.IRON_HELMET],
          ["chest", ITEM.IRON_ARMOR],
          ["legs", ITEM.IRON_LEGGINGS],
          ["feet", ITEM.IRON_BOOTS],
        ])
          draft.equipment[slot] = {
            id,
            count: 1,
            durability: getItem(id).durability,
          };
        return true;
      }),
      true
    );
    assert.ok(
      fishingRodStats(gameplay.getHandStack("offhand"), context),
      "requires the real rod and fishing progression dependency closure"
    );
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1.5, 0.1, 512);
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  document.hidden = false;
  const player = retain(
    new Player(
      camera,
      world,
      {
        ownerDocument: document,
        dataset: {},
      },
      { inputMode: "remote", mouseSensitivity: 1 }
    )
  );
  player.allowFlight = false;
  player.setPosition(saved?.player ?? VEHICLE_PEARL_SETUP.spawn);
  player.yaw = saved?.player.yaw ?? 0;
  player.pitch = saved?.player.pitch ?? -0.55;
  player._syncCamera(0);
  player.enabled = true;

  const observed = {
    saves: 0,
    hud: 0,
    hurt: [],
    death: 0,
    sounds: [],
    toasts: [],
  };
  game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    world,
    worldContext: context,
    coordinator,
    player,
    graphics: { scene, camera, renderRadius: 1, rebuildDirty() {} },
    paused: false,
    building: false,
    failed: false,
    overlayOpen: false,
    closingScreens: false,
    started: true,
    elapsed: 10,
    currentTime: saved?.time ?? 0.36,
    quality: "low",
    soundEnabled: false,
    mobStates: saved?.mobStates ?? {},
    target: null,
    mobTarget: null,
    meleeTarget: null,
    vehicleTarget: null,
    miningKey: "",
    miningProgress: 0,
    ui: {
      updateHurt() {},
      updateCombat() {},
      setSelected() {},
      closeInventory() {},
      closeAtlas() {},
      setLoading() {},
      ready() {},
      showMenu() {},
      toast: (text) => record(observed.toasts, text),
    },
    effects: {
      swing: 0,
      offhand: { swing: 0 },
      select() {},
      selectOffhand() {},
      sound: (...args) => record(observed.sounds, args),
    },
    scheduleSave() {
      observed.saves++;
    },
    refreshHud() {
      observed.hud++;
    },
  });
  game.gameplay = game.bindGameplay(gameplay);
  const hurt = gameplay.onHurt,
    death = gameplay.onDeath;
  gameplay.onHurt = (event) => {
    record(observed.hurt, structuredClone(event));
    hurt(event);
  };
  gameplay.onDeath = (cause) => {
    observed.death++;
    death(cause);
  };
  game.useActions = new GameUseActions(game);
  player.onInputReset = () => game.resetActions();
  player.onFall = (distance) =>
    gameplay.damage(Math.ceil(distance - 3), "fall");
  game.overflow = retain(new DropOverflow(ownership));
  game.experienceOrbs = retain(
    new ExperienceOrbs(scene, world, {
      ...ownership,
      prepareCollect: (amount) => gameplay.prepareExperience(amount),
    })
  );
  game.pickups = retain(new Pickups(scene, world, ownership));
  game.fuses = retain(new Fuses(ownership));
  game.settlement = retain(new Settlement(ownership));
  assert.equal(game.settlement.bindWorld(world), true);
  game.wildlife = new Wildlife(scene, world, { context, autoSpawn: false });
  if (saved) {
    for (const [name, owner] of [
      ["overflow", game.overflow],
      ["experienceOrbs", game.experienceOrbs],
      ["pickups", game.pickups],
      ["fuses", game.fuses],
      ["settlement", game.settlement],
      ["mobs", game.wildlife],
    ])
      assert.equal(
        owner.load(saved[name], { context }),
        true,
        `restore real ${name}`
      );
  }
  game.inventoryActions = new GameInventoryActions(game);
  game.transitionGate = new TransitionGate();
  storage = new WorldStorage({
    indexedDB: new IDBFactory(),
    name: "vehicle-pearl-test",
  });
  game.storage = storage;
  game.archive = new GameArchive(game, storage);

  // Default Fishing tables are intentional: no replacement catalogue or fake
  // reward bridge can conceal a missing parent-owned progression dependency.
  const vehicles = retain(
    new GameVehicleServices({
      world,
      gameplay,
      overflow: game.overflow,
      experienceOrbs: game.experienceOrbs,
      context,
      coordinator,
      saved,
    })
  );
  assert.equal(vehicles.activate(game).ok, true);
  const projectiles = retain(
    new GameProjectileServices({
      world,
      gameplay,
      context,
      saved,
    })
  );
  assert.equal(projectiles.activate(game).ok, true);
  world.onMutation = (event) => vehicles.onMutation(world, event);

  const owners = {
    world,
    gameplay,
    overflow: game.overflow,
    experience: game.experienceOrbs,
    pickups: game.pickups,
    fuses: game.fuses,
    settlement: game.settlement,
    vehicles,
    boats: vehicles.boats,
    fishing: vehicles.fishing,
    projectiles,
    pearls: projectiles.projectiles,
  };
  const f = {
    game,
    world,
    context,
    coordinator,
    player,
    scene,
    observed,
    owners,
    vehicles,
    boats: vehicles.boats,
    fishing: vehicles.fishing,
    projectiles,
    pearls: projectiles.projectiles,
    overflow: game.overflow,
    experience: game.experienceOrbs,
    gameplay,
    ticks: 0,
    snapshot() {
      return structuredClone({
        world: world.serialize(),
        chunks: [...world.chunks].map(([key, chunk]) => [
          key,
          chunk.incarnation,
          chunk.revision,
        ]),
        epoch: world.epoch,
        gameplay: gameplay.serialize(),
        vehicles: vehicles.serialize(),
        pearls: projectiles.serialize().playerProjectiles,
        overflow: game.overflow.serialize(),
        experience: game.experienceOrbs.serialize(),
        pickups: game.pickups.serialize(),
        fuses: game.fuses.serialize(),
        settlement: game.settlement.serialize(),
        mobs: game.wildlife.serialize(),
        player: playerState(player),
        archivePose: vehicles.poseForArchive(),
        pendingExit: vehicles._exitPose,
        fishingNeedsBinding: vehicles.fishing.needsBinding(),
        handRevisions: {
          main: gameplay.getHandRevision("main"),
          offhand: gameplay.getHandRevision("offhand"),
        },
        revisions: Object.fromEntries(
          Object.entries(owners).map(([name, owner]) => [
            name,
            owner.revision ?? owner._revision,
          ])
        ),
        reservations: Object.fromEntries(
          Object.entries(owners).map(([name, owner]) => [
            name,
            coordinator.usage(owner),
          ])
        ),
        bytes: coordinator.budget.totalBytes,
        observed,
      });
    },
    applyPose() {
      assert.equal(
        typeof game.applyVehiclePose,
        "function",
        "parent must supply native VoxelGame.applyVehiclePose; no test-side pose publication"
      );
      return game.applyVehiclePose();
    },
    step() {
      assert.ok(f.ticks++ < 100, "owner simulation is bounded to five seconds");
      game.elapsed += PEARL_STEP_SECONDS;
      const simulating = game.simulating;
      const vehicleFrame = vehicles.frame(PEARL_STEP_SECONDS, {
        simulating,
        keys: player.vehicleKeys,
      });
      assert.equal(vehicleFrame.ok, true);
      if (simulating) {
        player.update(PEARL_STEP_SECONDS, {
          recoverFromVoid: false,
          riderPose: vehicles.riderPose(),
          exitPose: vehicles.takeExitPose(),
        });
        game.updateTarget();
        game.useActions.update(PEARL_STEP_SECONDS);
      }
      assert.equal(projectiles.frame(PEARL_STEP_SECONDS, { simulating }), true);
      if (game.simulating)
        gameplay.update(PEARL_STEP_SECONDS, player.gameplayEnvironment());
      assert.equal(vehicles.render(PEARL_STEP_SECONDS), true);
      assert.equal(projectiles.render(), true);
      return vehicleFrame;
    },
  };
  if (saved && vehicles.riderPose()) f.applyPose();
  return f;
}

/** Authored aim before input, never a live-flight position/velocity edit. */
export function aim(f, yaw, pitch) {
  assert.equal(f.pearls.size, 0);
  f.player.yaw = yaw;
  f.player.pitch = pitch;
  f.player._syncCamera(0);
}

export function mountAndCast(f, { cast = true, consume = true } = {}) {
  f.game.select(1);
  aim(f, 0, -0.55);
  const placed = f.vehicles.useHand("main");
  assert.equal(placed.ok, true);
  assert.equal(placed.action, "place");
  assert.equal(
    f.gameplay.getHandStack(),
    null,
    "the finite boat item is spent"
  );
  const boat = f.boats.getBoat(placed.id);
  const eye = f.player.eyePosition;
  const dx = boat.x - eye.x,
    dy = boat.y + 0.3 - eye.y,
    dz = boat.z - eye.z;
  aim(f, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  const hit = f.vehicles.raycast();
  assert.equal(hit?.type, "boat");
  assert.equal(hit.id, placed.id);
  const mounted = f.vehicles.interact(hit);
  assert.equal(mounted.ok, true);
  assert.equal(mounted.action, "mount");
  if (consume) {
    f.applyPose();
    assert.equal(f.player.seated, true);
    assert.deepEqual(
      point(f.player.position),
      point(f.vehicles.riderPose().position)
    );
  }
  f.game.select(0);
  if (cast) {
    aim(f, -Math.PI / 2, -0.1);
    const rod = f.gameplay.getHandStack("offhand");
    const castResult = f.vehicles.useHand("offhand");
    assert.equal(castResult.ok, true);
    assert.equal(castResult.action, "cast");
    assert.equal(f.fishing.getCast().hand, "offhand");
    assert.equal(f.fishing.getCast().slotKey, "offhand:0");
    assert.deepEqual(f.gameplay.getHandStack("offhand"), rod);
  }
  aim(f, 0, 0.04);
  f.vehicles.render(0);
  return placed.id;
}

export function throwMountedPearl(f) {
  assert.ok(f.boats.mountFor());
  assert.equal(f.player.seated, true);
  assert.equal(f.gameplay.getHandStack().id, ITEM.ENDER_PEARL);
  const before = f.snapshot();
  const accepted = f.game.beginUse("mouse");
  f.game.endUse("mouse", true);
  assert.equal(
    accepted,
    true,
    "real GameUseActions must dispatch the held pearl"
  );
  assert.equal(f.pearls.size, 1);
  assert.equal(
    f.gameplay.getHandStack().count,
    before.gameplay.slots[0].count - 1
  );
  assert.equal(f.gameplay.health, before.gameplay.health);
  const physical = playerState(f.player);
  // The native use boundary may consume the already committed seat at dt=0.
  // That can advance poseRevision, but cannot move, turn or hurt this rider.
  assert.ok(physical.poseRevision >= before.player.poseRevision);
  assert.deepEqual(physical, {
    ...before.player,
    poseRevision: physical.poseRevision,
  });
  assert.deepEqual(f.vehicles.serialize(), before.vehicles);
  assert.deepEqual(f.pearls.projectiles[0].position, before.player.eye);
  return before;
}

/**
 * Advance only real owner APIs until the NEXT fixed tick meets the real wall.
 * prepareImpactTransaction must remain read-only. No saved flight, direct
 * _impactPlan call, supplied collision point or injected successful effects.
 */
export function nextVehiclePearlImpact(f) {
  assert.equal(f.pearls.size, 1);
  const id = f.pearls.projectiles[0].id;
  for (let tick = 0; tick < VEHICLE_PEARL_SETUP.maxApproachTicks; tick++) {
    const projectile = f.pearls.projectiles[0];
    assert.equal(projectile?.id, id, "the paid attempt remains owned");
    const flight = stepPearlFlight(f.world, f.context, projectile);
    if (flight.kind === "impact") {
      assert.equal(flight.hit.cell.id, BLOCK.STONE);
      assert.equal(flight.hit.cell.z, VEHICLE_PEARL_SETUP.wallZ);
      assert.deepEqual(flight.hit.normal, { x: 0, y: 0, z: 1 });
      const before = f.snapshot();
      const plan = f.pearls.prepareImpactTransaction(id);
      assert.ok(plan, "native host must compose a real next-tick pearl impact");
      assert.deepEqual(
        f.snapshot(),
        before,
        "preparation cannot detach, charge, hurt or move"
      );
      assert.deepEqual(plan.request.position, {
        x: flight.hit.point.x,
        y: flight.hit.point.y,
        z:
          VEHICLE_PEARL_SETUP.wallFace +
          PLAYER_WIDTH / 2 +
          PEARL_COLLISION_OFFSET,
      });
      assert.equal(plan.projectileId, id);
      return { plan, flight, before };
    }
    assert.equal(
      flight.kind,
      "flight",
      "no frontier/blocked fallback counts as an impact"
    );
    assert.equal(f.pearls.prepareImpactTransaction(id), null);
    f.step();
  }
  assert.fail("authored wall must be reached within twelve real 20 Hz ticks");
}

export function commitWithoutObserverErrors(coordinator, participants) {
  const result = coordinator.commit(participants);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.observerErrors, []);
  return result;
}

export function assertNoVehicleSnapback(f, destination, boatId) {
  for (let tick = 0; tick < 16; tick++) {
    const before = playerState(f.player);
    f.applyPose();
    assert.deepEqual(
      playerState(f.player),
      before,
      "no rider/exit means the dt0 hook must leave the pearl destination alone"
    );
    f.step();
    assert.equal(f.player.seated, false);
    assert.equal(f.vehicles.riderPose(), null);
    assert.equal(f.vehicles.poseForArchive(), null);
    assert.equal(f.player.position.x, destination.x);
    assert.equal(f.player.position.z, destination.z);
    assert.ok(f.player.position.y >= VEHICLE_PEARL_SETUP.landingY - 0.01);
    assert.ok(f.player.position.y <= destination.y + 0.01);
    assert.equal(f.pearls.size, 0);
    assert.equal(f.fishing.size, 0);
    assert.deepEqual(f.boats.getBoat(boatId).passengers, [null, null]);
  }
  assert.equal(
    f.gameplay.health,
    15,
    "later frames cannot replay impact damage"
  );
  assert.equal(f.gameplay.getHandStack().count, VEHICLE_PEARL_SETUP.pearls - 1);
  assert.equal(f.observed.hurt.length, 1);
}
