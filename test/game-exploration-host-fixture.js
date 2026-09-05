import assert from "node:assert/strict";
import * as THREE from "three";
import { normalizeCell } from "../src/block-state.js";
import { CombatFeedback } from "../src/combat-feedback.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameExplorationServices } from "../src/game-exploration-services.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { GameTravel } from "../src/game-travel.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { Settlement } from "../src/settlement.js";
import { TransitionGate } from "../src/transition-gate.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { InputElement } from "./control-fixture.js";
import {
  admitNativeStructure,
  NATIVE_UNMAPPED_SEED,
  nativeExplorationSite,
  retainedStacks,
} from "./exploration-services-fixture.js";
import {
  lifecycleGenerator,
  lifecycleShell,
  LIFECYCLE_POSE,
} from "./game-fluid-lifecycle-fixture.js";

const noop = () => {};
export const HOST_SEED = "authored-exploration-host";
export const HOST_POSE = LIFECYCLE_POSE;
export const OBSERVED_SERVICES = Object.freeze([
  "buildingServices",
  "fluidServices",
  "explorationServices",
]);
export const OBSERVED_METHODS = Object.freeze(["onChunkLoaded", "onMutation"]);

export const emptyExploration = ({ seed, generatorVersion }) => ({
  version: 1,
  seed,
  generatorVersion,
  containers: [],
  encounters: [],
});

export function authoredArchive({
  seed = HOST_SEED,
  generatorVersion = 4,
  dimension = "overworld",
  withExploration = false,
} = {}) {
  const world = { version: 3, seed, generatorVersion, dimension, edits: [] };
  return {
    version: 3,
    world,
    player: { ...HOST_POSE, yaw: 0, pitch: 0, flying: false },
    ...(withExploration ? { exploration: emptyExploration(world) } : {}),
  };
}

/**
 * Only terrain provisioning is substituted: real Game.prepareWorld, stageWorld,
 * pose validation, constructors, loads and cleanup run. One floor/air column;
 * NEVER use this helper as evidence of native discovery or generated loot.
 */
export function authorStageTerrain(t) {
  const worlds = [];
  t.mock.method(World.prototype, "ensureArea", async function (position) {
    assert.equal(this.chunks.size, 0);
    assert.ok([1, 2, 3, 4].includes(this.generatorVersion));
    this._generatorFactory = lifecycleGenerator;
    this.generator = lifecycleGenerator(
      this.seed,
      this.dimension,
      this.generatorVersion
    );
    this._workerDisabled = true;
    worlds.push(this);
    this._generateSync(
      Math.floor(position.x / 16),
      Math.floor(position.z / 16)
    );
    return this;
  });
  t.after(() => {
    for (const world of worlds) world.dispose();
  });
  return worlds;
}

/** Includes the independent projectile host and releases dependents first. */
export function disposeExplorationStage(staged) {
  for (const key of [
    "progressionIntegration",
    "explorationServices",
    "vehicleServices",
    "projectileServices",
    "fluidServices",
    "buildingServices",
    "fuses",
    "overflow",
    "settlement",
    "gameplay",
    "world",
  ])
    staged?.[key]?.dispose();
}

function stageOwners(world, saved, { maxEntries, limits } = {}) {
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const staged = { world, context };
  try {
    staged.gameplay = new Gameplay({
      ...ownership,
      mode: saved?.gameplay?.mode ?? "survival",
      allowOverBudget: saved != null,
    });
    staged.settlement = new Settlement(ownership);
    staged.overflow = new DropOverflow({ ...ownership, maxEntries });
    staged.fuses = new Fuses(ownership);
    for (const key of ["gameplay", "settlement", "overflow", "fuses"])
      if (saved?.[key] !== undefined)
        assert.equal(
          staged[key].load(saved[key], { context, allowOverBudget: true }),
          true
        );
    assert.equal(staged.settlement.bindWorld(world), true);
    const shared = { ...staged, saved, allowOverBudget: saved != null };
    staged.buildingServices = new GameBuildingServices({
      ...shared,
      support: { scanCells: 32, candidates: 4 },
    });
    staged.fluidServices = new GameFluidServices({
      ...shared,
      coordinator,
      limits: { maxScanCellsPerUpdate: 32 },
    });
    staged.projectileServices = new GameProjectileServices(shared);
    staged.explorationServices =
      world.generatorVersion === 4 ||
      (saved && Object.hasOwn(saved, "exploration"))
        ? new GameExplorationServices({ ...shared, limits })
        : null;
    return staged;
  } catch (error) {
    disposeExplorationStage(staged);
    throw error;
  }
}

/** Empty ecology projection only: no invented spawn, encounter or death success. */
function emptyWildlife(world, saved) {
  const snapshot = saved ?? {
    version: 1,
    seed: world.seed,
    dimension: world.dimension,
    randomState: 1,
    nextId: 0,
    killed: [],
    entities: [],
  };
  return {
    entities: [],
    update: noop,
    dispose: noop,
    serialize: () => structuredClone(snapshot),
  };
}

/**
 * Real VoxelGame methods and ownership graph; no WebGL, DOM UI, disk or timers.
 * The container projection invokes the real lazy Settlement reader; it neither
 * initializes loot itself nor returns a fabricated transaction receipt.
 * Successful initialize's renderer construction is outside this Node fixture.
 */
export function hostFromExplorationStage(
  t,
  staged,
  {
    saved = null,
    bind = true,
    activate = true,
    position = saved?.player ?? HOST_POSE,
  } = {}
) {
  const shell = lifecycleShell(t);
  const { world, context, gameplay, settlement, overflow, fuses } = staged;
  const coordinator = world.coordinator;
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
  const player = new Player(camera, world, new InputElement(shell.document), {
    inputMode: "remote",
  });
  const calls = {
    saves: 0,
    hud: 0,
    draws: 0,
    toasts: [],
    uiReads: [],
    archives: [],
  };
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world,
    worldContext: context,
    coordinator,
    gameplay,
    settlement,
    overflow,
    fuses,
    player,
    transitionGate: new TransitionGate(),
    combatFeedback: new CombatFeedback(),
    paused: false,
    building: false,
    failed: false,
    overlayOpen: false,
    closingScreens: false,
    started: false,
    elapsed: 0,
    lastFrame: 0,
    hudTimer: 0,
    streamTimer: 0,
    autosaveTimer: 0,
    portalCooldown: 3,
    quality: "low",
    soundEnabled: false,
    currentTime: saved?.time ?? 0.36,
    heldAction: null,
    miningProgress: 0,
    lastAction: -Infinity,
    lastOverflowToast: -Infinity,
    renderDirection: new THREE.Vector3(),
    playerEnvironment: {},
    mobStates: structuredClone(saved?.mobStates ?? {}),
    graphics: {
      scene,
      camera,
      renderRadius: 0,
      setTime: noop,
      rebuildDirty: noop,
      setTarget: noop,
      update: noop,
      dispose: noop,
      render() {
        calls.draws++;
      },
    },
    ui: {
      closeInventory: () => true,
      closeAtlas: noop,
      setLoading: noop,
      ready: noop,
      showMenu: noop,
      hideMenu: noop,
      toast(message) {
        calls.toasts.push(message);
      },
    },
    effects: { update: noop, sound: noop, burst: noop, dispose: noop },
    playerVisual: { visible: false, update: noop, dispose: noop },
    containerUI: {
      isOpen: false,
      open(atWorld, hit, atGameplay, atSettlement) {
        const state = atSettlement.getContainerState(atWorld, hit, atGameplay);
        calls.uiReads.push({ world: atWorld, hit: { ...hit }, state });
        this.isOpen = !!state;
        return this.isOpen;
      },
      close() {
        this.isOpen = false;
        return true;
      },
      refresh: noop,
    },
    createWildlife(data) {
      this.wildlife = emptyWildlife(this.world, data);
    },
    scheduleSave() {
      calls.saves++;
    },
    refreshHud() {
      calls.hud++;
    },
    updateTarget: noop,
  });
  game.bindGameplay(gameplay);
  game.inventoryActions = new GameInventoryActions(game);
  game.harvestActions = new GameHarvestActions(game);
  game.useActions = new GameUseActions(game);
  game.travel = new GameTravel(game);
  game.createWildlife(saved?.mobStates?.[world.dimension] ?? saved?.mobs);
  player.setPosition(position);
  player.yaw = saved?.player?.yaw ?? 0;
  player.pitch = saved?.player?.pitch ?? 0;
  player.allowFlight = gameplay.mode === "creative";
  player.enabled = true;
  player.onInputReset = () => game.resetActions();
  player.onFall = (distance) =>
    gameplay.damage(Math.ceil(distance - 3), "fall");
  game.pickups = new Pickups(scene, world, { coordinator });
  game.experienceOrbs = new ExperienceOrbs(scene, world, {
    coordinator,
    context,
    prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  for (const key of ["pickups", "experienceOrbs"])
    assert.equal(
      game[key].load(saved?.[key], { context, allowOverBudget: true }),
      true
    );
  game.archive = new GameArchive(game, {
    async save(data) {
      calls.archives.push(structuredClone(data));
    },
  });
  const pickups = game.pickups,
    orbs = game.experienceOrbs;
  const extraServices = [];
  let disposed = false;
  const host = {
    ...staged,
    game,
    shell,
    calls,
    player,
    coordinator,
    pickups,
    orbs,
    get service() {
      return game.explorationServices ?? staged.explorationServices;
    },
    snapshot: () => game.archive.snapshot(),
    ownership: () => ({
      world: world.serialize(),
      gameplay: gameplay.serialize(),
      settlement: settlement.serialize(),
      overflow: overflow.serialize(),
      pickups: pickups.serialize(),
      orbs: orbs.serialize(),
      exploration: host.service?.exploration.serialize(),
      bytes: coordinator.budget.totalBytes,
    }),
    hit(marker) {
      const { x, y, z } = marker.position ?? marker;
      return { x, y, z, dimension: world.dimension, ...world.getCell(x, y, z) };
    },
    approachContainer(marker) {
      const { x, y, z } = marker.position ?? marker;
      // Stage the physical player atop the native container, within use reach.
      // This is host setup, not a simulated Survival journey or a loot grant.
      player.setPosition({ x: x + 0.5, y: y + 1, z: z + 0.5 });
    },
    entries() {
      return host.service.index
        .list("container")
        .filter(
          ({ marker }) =>
            !host.descriptor || marker.structureId === host.descriptor.id
        );
    },
    mutate(cells) {
      assert.ok(cells.length > 0 && cells.length <= 64);
      const part = world.prepareMutation(
        cells.map(([x, y, z, value]) => ({
          x,
          y,
          z,
          before: world.getCell(x, y, z),
          after: normalizeCell(
            typeof value === "number" ? { id: value } : value
          ),
        }))
      );
      assert.ok(part);
      const result = coordinator.commit([part]);
      assert.equal(result.ok, true);
      return result;
    },
    createExploration(options = {}) {
      const service = new GameExplorationServices({
        world,
        context,
        gameplay,
        settlement,
        overflow,
        ...options,
      });
      extraServices.push(service);
      return service;
    },
    activate() {
      for (const key of [
        "buildingServices",
        "fluidServices",
        "projectileServices",
        "explorationServices",
      ])
        if (staged[key]) assert.equal(staged[key].activate(game).ok, true);
    },
    bind() {
      game.bindWorldServiceEvents();
      return game.unbindWorldEvents;
    },
    frame(milliseconds = 50) {
      assert.ok(milliseconds > 0 && milliseconds <= 1000);
      game.streamTimer = 0;
      game.frame(game.lastFrame + milliseconds);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      game.unbindWorldEvents?.();
      for (const service of extraServices) service.dispose();
      staged.explorationServices?.dispose();
      staged.projectileServices?.dispose();
      staged.fluidServices?.dispose();
      staged.buildingServices?.dispose();
      player.dispose();
      pickups.dispose();
      orbs.dispose();
      game.hurtFeedback.dispose();
      disposeExplorationStage(staged);
      assert.equal(
        coordinator.budget.totalBytes,
        0,
        "release every real staged and active owner"
      );
    },
  };
  t.after(() => host.dispose());
  if (activate) {
    host.activate();
    if (bind) host.bind();
  }
  return host;
}

/** Bounded authored terrain for orchestration only; historical columns have no markers. */
export function authoredExplorationHost(
  t,
  {
    saved = authoredArchive({ generatorVersion: 3, withExploration: true }),
    columns = [[0, 0]],
    ...options
  } = {}
) {
  const world = new World(saved.world.seed, {
    generatorVersion: saved.world.generatorVersion,
    dimension: saved.world.dimension,
    useWorker: false,
    generatorFactory: lifecycleGenerator,
  });
  assert.equal(world.loadEdits(saved.world), true);
  assert.ok(columns.length > 0 && columns.length <= 4);
  for (const [cx, cz] of columns) world._generateSync(cx, cz);
  return hostFromExplorationStage(t, stageOwners(world, saved, options), {
    saved,
    ...options,
  });
}

/** Real default native factory + bounded locator; no injected sampler or registry. */
export async function nativeExplorationHost(
  t,
  { seed, kind = "village", variant = "", saved = null, ...options } = {}
) {
  let world, descriptor;
  const dimension =
    saved?.world?.dimension ??
    (["nether_fortress", "bastion_remnant"].includes(kind)
      ? "nether"
      : "overworld");
  for (const candidate of saved
    ? [saved.world.seed]
    : seed === undefined
      ? variant === "unmapped"
        ? [NATIVE_UNMAPPED_SEED]
        : ["cedar-valley", "tidal-archive", "basalt-crossing"]
      : [seed]) {
    world = new World(candidate, {
      generatorVersion: 4,
      dimension,
      useWorker: false,
    });
    if (saved?.world) assert.equal(world.loadEdits(saved.world), true);
    descriptor = nativeExplorationSite(world, kind, variant, false);
    if (descriptor) break;
    world.dispose();
  }
  assert.ok(
    descriptor,
    `Required native ${kind}/${variant} missing from bounded searches`
  );
  const host = hostFromExplorationStage(t, stageOwners(world, saved, options), {
    saved,
    position: { ...descriptor.origin, y: descriptor.origin.y + 2 },
    ...options,
  });
  host.descriptor = descriptor;
  await admitNativeStructure(world, descriptor);
  return host;
}

export function looseStacks(host) {
  return [
    ...retainedStacks(host),
    ...Array.from({ length: host.pickups.size }, (_, index) =>
      host.pickups.getStack(index)
    ),
  ];
}

/** Record, then execute the real coordinator, including nested postcommit transfers. */
export function traceCommits(t, coordinator) {
  const commits = [],
    commit = coordinator.commit;
  t.mock.method(coordinator, "commit", function (participants) {
    const entry = {
      participants,
      owners: participants.map(({ owner }) => owner),
    };
    commits.push(entry);
    entry.result = commit.call(this, participants);
    return entry.result;
  });
  return commits;
}

export function assertOwners(participants, owners) {
  assert.equal(
    participants.length,
    owners.length,
    "exactly one participant for each owner"
  );
  assert.deepEqual(
    new Set(participants.map(({ owner }) => owner)),
    new Set(owners)
  );
}

export function observeExplorationServices(t, host) {
  const seen = {};
  for (const slot of OBSERVED_SERVICES) {
    seen[slot] = {};
    const service = host.game[slot];
    for (const method of OBSERVED_METHODS) {
      const calls = (seen[slot][method] = []),
        original = service[method];
      t.mock.method(service, method, function (world, event) {
        const call = { world, event };
        calls.push(call);
        call.result = original.call(this, world, event);
        return call.result;
      });
    }
  }
  return seen;
}
