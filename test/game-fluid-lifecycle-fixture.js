import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { Settlement } from "../src/settlement.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";
import { InputElement } from "./control-fixture.js";

const noop = () => {};
const shells = new WeakMap();
export const LIFECYCLE_SEED = "authored-fluid-lifecycle";
export const LIFECYCLE_POSE = Object.freeze({ x: 8.5, y: 1.01, z: 8.5 });

/** Authored floor and empty air; never a natural terrain/acquisition fixture. */
export function lifecycleGenerator(_seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    getSpawn: () => ({ ...LIFECYCLE_POSE }),
    generateChunk(cx, cz) {
      const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.STONE, -spec.minY * 256, (1 - spec.minY) * 256);
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
}

/**
 * No DOM renderer, disk, real animation loop, audio or ecology simulation.
 * RAF records requests without scheduling them; each test explicitly advances
 * the REAL VoxelGame.frame. One shell per test also supports two live Worlds.
 */
export function lifecycleShell(t) {
  if (shells.has(t)) return shells.get(t);
  const previous = new Map(
    ["document", "window", "requestAnimationFrame"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: new EventTarget(),
    pointerLockElement: null,
  });
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  const shell = { document, rafRequests: 0, confirms: 0 };
  document.defaultView.confirm = () => {
    shell.confirms++;
    return true;
  };
  for (const [key, value] of Object.entries({
    document,
    window: document.defaultView,
    requestAnimationFrame: () => ++shell.rafRequests,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  shells.set(t, shell);
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    shells.delete(t);
  });
  return shell;
}

/**
 * Real World, Player, Gameplay, Settlement, overflow, pickups, orbs, fuses,
 * building/fluid services and shared coordinator. Crops are deliberately empty:
 * this fixture neither implements nor exercises the incoming crop-batch API.
 */
export function fluidLifecycleHost(
  t,
  {
    saved = null,
    cells = [],
    columns = [[0, 0]],
    generatorVersion = saved?.world?.generatorVersion ?? 4,
    mode = saved?.gameplay?.mode ?? "survival",
    position = saved?.player ?? LIFECYCLE_POSE,
    activate = true,
    bind = true,
    fluidLimits = {},
  } = {}
) {
  const shell = lifecycleShell(t);
  const world = new World(saved?.world?.seed ?? LIFECYCLE_SEED, {
    dimension: saved?.world?.dimension ?? "overworld",
    generatorVersion,
    generatorFactory: lifecycleGenerator,
    useWorker: false,
  });
  if (saved?.world) assert.equal(world.loadEdits(saved.world), true);
  assert.ok(columns.length <= 4, "lifecycle residency is explicitly bounded");
  for (const [cx, cz] of columns) world._generateSync(cx, cz);
  const mutate = (entries) => {
    assert.ok(entries.length > 0 && entries.length <= 64);
    const changes = entries.map(([x, y, z, value]) => ({
      x,
      y,
      z,
      before: world.getCell(x, y, z),
      after: normalizeCell(typeof value === "number" ? { id: value } : value),
    }));
    assert.ok(
      changes.every(({ before, after }) => before && !cellsEqual(before, after))
    );
    const participant = world.prepareMutation(changes);
    assert.ok(participant, "authored mutations use a real prepared World edit");
    const result = world.coordinator.commit([participant]);
    assert.equal(result.ok, true);
    return result;
  };
  if (cells.length) mutate(cells);
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const gameplay = new Gameplay({ mode, ...ownership });
  const settlement = new Settlement(ownership);
  const overflow = new DropOverflow(ownership);
  const fuses = new Fuses(ownership);
  if (saved?.gameplay)
    assert.equal(
      gameplay.load(saved.gameplay, { context, allowOverBudget: true }),
      true
    );
  assert.equal(
    settlement.load(
      saved?.settlement ?? { version: 3, chests: [], furnaces: [], crops: [] },
      { context, world, allowOverBudget: true }
    ),
    true
  );
  assert.equal(
    settlement.crops.size,
    0,
    "no synthetic crop owner in this fixture"
  );
  if (saved?.overflow)
    assert.equal(
      overflow.load(saved.overflow, { context, allowOverBudget: true }),
      true
    );
  if (saved?.fuses)
    assert.equal(
      fuses.load(saved.fuses, { context, allowOverBudget: true }),
      true
    );

  const calls = {
    saves: 0,
    writes: 0,
    hud: 0,
    draws: 0,
    hurts: [],
    toasts: [],
  };
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 512);
  const scene = new THREE.Scene();
  const element = new InputElement(shell.document);
  const player = new Player(camera, world, element, { inputMode: "remote" });
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world,
    worldContext: context,
    coordinator,
    gameplay,
    settlement,
    overflow,
    fuses,
    player,
    mobStates: {},
    paused: false,
    building: false,
    failed: false,
    overlayOpen: false,
    closingScreens: false,
    started: false,
    elapsed: 0,
    lastFrame: 0,
    fps: 60,
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
    graphics: {
      scene,
      camera,
      renderRadius: 0,
      setTime: noop,
      rebuildDirty: noop,
      setTarget: noop,
      update: noop,
      render: () => {
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
      toast: (message) => calls.toasts.push(message),
    },
    containerUI: { close: () => true },
    playerVisual: { visible: false, update: noop },
    effects: { update: noop },
    // Explicitly empty ecology projection, not a successful mocked mob action.
    wildlife: {
      entities: [],
      update: noop,
      serialize: () => ({
        version: 1,
        seed: world.seed,
        dimension: world.dimension,
        randomState: 1,
        nextId: 0,
        killed: [],
        entities: [],
      }),
    },
    scheduleSave: () => {
      calls.saves++;
    },
    refreshHud: () => {
      calls.hud++;
    },
    updateTarget: noop,
  });
  game.bindGameplay(gameplay);
  const onHurt = gameplay.onHurt;
  gameplay.onHurt = (event) => {
    calls.hurts.push(event);
    onHurt(event);
  };
  game.useActions = new GameUseActions(game);
  player.allowFlight = mode === "creative";
  player.setPosition(position);
  player.enabled = true;
  player.onInputReset = () => game.resetActions();
  // Same single fall-damage callback installed by VoxelGame.initialize.
  player.onFall = (distance) =>
    game.gameplay.damage(Math.ceil(distance - 3), "fall");
  game.pickups = new Pickups(scene, world, ownership);
  game.experienceOrbs = new ExperienceOrbs(scene, world, {
    ...ownership,
    prepareCollect: (amount) => game.gameplay.prepareExperience(amount),
  });
  game.archive = new GameArchive(game, {
    async save() {
      calls.writes++;
      assert.fail("lifecycle fixture must not write an archive");
    },
  });
  const building = new GameBuildingServices({
    world,
    gameplay,
    context,
    saved,
    support: { scanCells: 32, candidates: 4 },
    allowOverBudget: saved !== null,
  });
  const fluids = [];
  const createFluids = (options = {}) => {
    const service = new GameFluidServices({
      world,
      overflow,
      settlement,
      coordinator,
      context,
      saved,
      limits: { maxScanCellsPerUpdate: 32, ...fluidLimits },
      allowOverBudget: saved !== null,
      ...options,
    });
    fluids.push(service);
    return service;
  };
  const fluid = createFluids();
  const host = {
    game,
    world,
    context,
    coordinator,
    gameplay,
    settlement,
    overflow,
    fuses,
    player,
    building,
    fluid,
    shell,
    calls,
    mutate,
    createFluids,
    snapshot: () => game.archive.snapshot(),
    activate() {
      assert.equal(building.activate(game).ok, true);
      assert.equal(fluid.activate(game).ok, true);
    },
    bind() {
      game.bindWorldServiceEvents();
      return game.unbindWorldEvents;
    },
    frame(milliseconds = 50) {
      assert.ok(
        Number.isFinite(milliseconds) &&
          milliseconds > 0 &&
          milliseconds <= 1000
      );
      // Residency is authored by the tests, not the renderer's periodic radius.
      game.streamTimer = 0;
      game.frame(game.lastFrame + milliseconds);
    },
  };
  t.after(() => {
    game.unbindWorldEvents?.();
    player.dispose();
    for (const service of fluids) service.dispose();
    building.dispose();
    game.pickups.dispose();
    game.experienceOrbs.dispose();
    game.hurtFeedback.dispose();
    fuses.dispose();
    overflow.dispose();
    settlement.dispose();
    gameplay.dispose();
    world.dispose();
    assert.equal(
      coordinator.budget.totalBytes,
      0,
      "fixture releases every real owner"
    );
  });
  if (activate) {
    host.activate();
    if (bind) host.bind();
  }
  return host;
}

/** Observe entry points while executing their actual implementations once. */
export function traceFluidFrame(t, host) {
  const trace = {
    order: [],
    fluidFrames: [],
    fluidUpdates: [],
    playerUpdates: [],
    projections: [],
    gameplayUpdates: [],
    damage: [],
  };
  const { game, fluid, player, gameplay } = host;
  const wrap = (owner, key, observe) => {
    const original = owner[key];
    t.mock.method(owner, key, function (...args) {
      return observe(() => Reflect.apply(original, this, args), args);
    });
  };
  wrap(fluid, "frame", (run, [dt, options]) => {
    trace.order.push("fluids");
    const entry = { dt, options: { ...options } };
    trace.fluidFrames.push(entry);
    entry.result = run();
    return entry.result;
  });
  wrap(fluid.fluids, "update", (run, [dt]) => {
    trace.order.push("fluid-domain");
    trace.fluidUpdates.push(dt);
    return run();
  });
  wrap(player, "update", (run, [dt, options]) => {
    trace.order.push("player");
    trace.playerUpdates.push({ dt, options: { ...options } });
    return run();
  });
  wrap(player, "gameplayEnvironment", (run, [out]) => {
    trace.order.push("environment");
    const result = run();
    trace.projections.push({ out, result, snapshot: { ...result } });
    return result;
  });
  wrap(gameplay, "update", (run, [dt, environment]) => {
    trace.order.push("gameplay");
    trace.gameplayUpdates.push({
      dt,
      environment,
      snapshot: { ...environment },
    });
    return run();
  });
  wrap(gameplay, "damage", (run, [amount, cause]) => {
    trace.damage.push({ amount, cause });
    return run();
  });
  assert.equal(game.fluidServices, fluid);
  return trace;
}

/**
 * Only Game.prepareWorld's terrain provisioning is substituted. Its real
 * stageWorld, pose validation, owner construction/load and failure cleanup run.
 * Historical v3 avoids depending on removal of World's production-v4 guard.
 * No real terrain sampler is invoked; at most one authored column is admitted.
 */
export function authoredPrepareWorld(t) {
  const worlds = [];
  t.mock.method(World.prototype, "ensureArea", async function (position) {
    assert.equal(this.generatorVersion, 3);
    assert.equal(this.chunks.size, 0);
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

export function disposeFluidStage(staged) {
  for (const name of [
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
    staged[name].dispose();
}
