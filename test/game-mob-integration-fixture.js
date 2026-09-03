import assert from "node:assert/strict";
import * as THREE from "three";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { CombatFeedback } from "../src/combat-feedback.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { Fuses } from "../src/fuses.js";
import { GameArchive } from "../src/game-archive.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { bindGameControls } from "../src/game-controls.js";
import { GameExplorationServices } from "../src/game-exploration-services.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameMobActions, GameMobHarvestActions } from "../src/game-mob-actions.js";
import { GameMobIntegration } from "../src/game-mob-integration.js";
import { stageProgressionServices } from "../src/game-progression-integration.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { GameTravel } from "../src/game-travel.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { stageVehicleServices } from "../src/game-vehicle-integration.js";
import { VoxelGame } from "../src/game.js";
import { Gameplay } from "../src/gameplay.js";
import { hasExpandedTerrain } from "../src/generator-version.js";
import { getItem, ITEM } from "../src/items.js";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { PlayerVisual } from "../src/player-visual.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { Settlement } from "../src/settlement.js";
import { TransitionGate } from "../src/transition-gate.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";
import { dispatch, InputElement } from "./control-fixture.js";

export const point = ({ x, y, z }) => ({ x, y, z });

/** Authored sand floor, not a natural-distribution or Survival-acquisition test. */
export function gameMobGenerator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  const biome = dimension === "nether" ? "nether_wastes" : dimension === "end" ? "the_end" : "plains";
  return {
    seed, dimension, generatorVersion, spec,
    getSpawn: () => ({ x: 8.5, y: 65, z: 11.5 }),
    getBiome: () => getBiomeById(biome),
    generateChunk(cx, cz) {
      const ArrayType = generatorVersion >= 4 ? Uint16Array : Uint8Array;
      const blocks = new ArrayType((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.SAND, 0, (65 - spec.minY) * 256);
      return {
        cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
        biomes: new Uint8Array(256).fill(BIOMES.findIndex((entry) => entry.id === biome)),
      };
    },
  };
}

/**
 * Actual Game methods + detached GameMobIntegration/vehicle/progression stages,
 * real World/Player/Wildlife and every resource owner. Only DOM, RAF, graphics
 * submission and audio delivery are transports. No payment or success mocks.
 * Tests run only after the parent checkpoints the ecology adoption API.
 */
export async function gameMobFixture(t, {
  saved = null, seed = "game-horse-ecology", generatorVersion = 3,
  root = null, document: suppliedDocument, activate = true,
  generatorFactory = gameMobGenerator, spawnPosition, world: suppliedWorld = null,
  autoSpawn = false, admissionRadius = 1,
} = {}) {
  assert.equal(typeof autoSpawn, "boolean");
  assert.ok(Number.isSafeInteger(admissionRadius) && admissionRadius >= 1 && admissionRadius <= 3);
  if (saved) {
    const { context: ignored, ...components } = normalizeWorldComponents(saved);
    saved = { ...structuredClone(saved), ...components };
  }
  const owners = [];
  let game;
  t.after(() => {
    if (game) {
      game.paused = true;
      game.unbindWorldEvents?.();
      game.unbindControls?.();
      game.player.onInputReset = null;
    }
    for (const owner of owners.reverse()) owner.dispose();
    game?.hurtFeedback.dispose();
  });
  const keep = (owner) => { owners.push(owner); return owner; };
  const world = keep(suppliedWorld ?? new World(saved?.world.seed ?? seed, {
    dimension: saved?.world.dimension ?? "overworld",
    generatorVersion: saved?.world.generatorVersion ?? generatorVersion,
    ...(generatorFactory ? { generatorFactory } : {}), useWorker: false,
  }));
  assert.ok(world instanceof World && !world._disposed);
  if (saved) assert.equal(world.loadEdits(saved.world), true);
  const admittedPosition = spawnPosition ?? saved?.player;
  if (admittedPosition) await world.ensureArea(admittedPosition, admissionRadius);
  else world.generate(admissionRadius);
  const context = createWorldContext(world), coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const gameplay = keep(new Gameplay({ ...ownership, mode: "survival" }));
  const settlement = keep(new Settlement(ownership));
  const overflow = keep(new DropOverflow(ownership));
  const fuses = keep(new Fuses(ownership));
  for (const [key, owner] of Object.entries({ gameplay, settlement, overflow, fuses }))
    if (saved?.[key]) assert.equal(owner.load(saved[key], { context }), true);
  assert.equal(settlement.bindWorld(world), true);
  if (!saved) assert.equal(gameplay.inventoryTransaction((draft) => {
    draft.slots.fill(null);
    draft.offhand = draft.cursor = null;
    return true;
  }), true);
  const document = suppliedDocument ?? Object.assign(new EventTarget(), {
    defaultView: new EventTarget(), hidden: false,
  });
  if (!document.addEventListener) {
    const events = new EventTarget();
    for (const method of ["addEventListener", "removeEventListener", "dispatchEvent"])
      document[method] = events[method].bind(events);
  }
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 1.5, 0.1, 512);
  const container = new InputElement(document);
  const player = keep(new Player(camera, world, container, {
    inputMode: "remote",
  }));
  player.allowFlight = false;
  player.setPosition(saved?.player ?? spawnPosition ?? world.getSpawn());
  player.yaw = saved?.player.yaw ?? 0;
  player.pitch = saved?.player.pitch ?? 0;
  player.enabled = true;
  const calls = { saves: 0, hud: 0, sounds: [], toasts: [] };
  game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    world, worldContext: context, coordinator, player, settlement, overflow, fuses, container,
    graphics: {
      scene, camera, renderRadius: admissionRadius - 1, observeFrame() {}, rebuildDirty() {},
      setTarget() {}, update() {}, render() {}, resize() {},
    },
    ui: {
      isHudVisible: true, isMenuOpen: false, isOverlayOpen: false, isInventoryOpen: false,
      update() {}, updateHurt() {}, updateCombat() {}, setSelected() {},
      async closeInventory() { return true; }, closeAtlas() {}, hideMenu() {},
      setLoading() {}, ready() {}, showMenu() {}, toast(text) { calls.toasts.push(text); },
    },
    effects: {
      swing: 0, offhand: { swing: 0 }, update() {}, select() {}, selectOffhand() {},
      shoot() {}, burst() {}, unlockAudio() {}, sound(...args) { calls.sounds.push(args); },
    },
    scheduleSave() { calls.saves++; }, refreshHud() { calls.hud++; },
    async save() { return { ok: true }; },
    paused: false, building: false, failed: false, overlayOpen: false, closingScreens: false,
    started: true, elapsed: 0, lastFrame: 0, lastAction: -Infinity, currentTime: 0.36,
    quality: "low", soundEnabled: false, portalCooldown: 3,
    streamTimer: 0, hudTimer: 0, autosaveTimer: 0, lastOverflowToast: -Infinity,
    heldAction: null, target: null, mobTarget: null, meleeTarget: null, vehicleTarget: null,
    miningKey: "", miningProgress: 0, renderDirection: new THREE.Vector3(),
    combatFeedback: new CombatFeedback(), transitionGate: new TransitionGate(),
  });
  game.gameplay = game.bindGameplay(gameplay);
  game.inventoryActions = new GameInventoryActions(game);
  game.mobActions = new GameMobActions(game);
  game.harvestActions = new GameMobHarvestActions(game);
  game.useActions = new GameUseActions(game);
  game.archive = new GameArchive(game);
  game.travel = new GameTravel(game);
  player.onInputReset = () => game.resetActions();
  player.onStep = (id) => game.effects.sound("step", id);
  player.onFall = (distance) => gameplay.damage(Math.ceil(distance - 3), "fall");
  game.pickups = keep(new Pickups(scene, world, ownership));
  if (saved) assert.equal(game.pickups.load(saved.pickups, { context }), true);
  const building = keep(new GameBuildingServices({ world, gameplay, context, saved }));
  const fluids = keep(new GameFluidServices({ world, overflow, settlement, context, saved }));
  const projectiles = keep(new GameProjectileServices({ world, gameplay, context, saved }));
  const progression = keep(stageProgressionServices({ world, gameplay, context, projectileServices: projectiles, saved }));
  const exploration = hasExpandedTerrain(world.generatorVersion) || saved?.exploration
    ? keep(new GameExplorationServices({ world, gameplay, settlement, overflow, context, saved })) : null;
  const mobs = keep(new GameMobIntegration({
    world, gameplay, overflow, context, progressionIntegration: progression,
    explorationServices: exploration, saved,
  }));
  const vehicles = keep(await stageVehicleServices({
    world, gameplay, overflow, context, saved, position: point(player.position),
    mobIntegration: mobs, experienceOrbs: mobs.experienceOrbs,
  }));
  let frames = 0;
  const withGlobals = (work) => {
    const values = { document, window: document.defaultView, requestAnimationFrame: () => {
      assert.ok(++frames <= 512, "bounded manually driven real Game frames");
      return frames;
    } };
    const previous = new Map(Object.keys(values).map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    try { return work(); }
    finally {
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
  };
  const f = {
    game, world, context, coordinator, gameplay, overflow, player, scene, document, calls,
    building, fluids, projectiles, progression, exploration, mobs, vehicles, horses: vehicles.horses,
    withGlobals,
    get wildlife() { return game.wildlife ?? mobs.wildlife; },
    get ecology() { return mobs.ecologyServices; },
    activate() {
      return withGlobals(() => {
        assert.equal(mobs.install(game, vehicles), true);
        assert.equal(vehicles.activate(game, { root, headless: !root }).ok, true);
        assert.equal(building.activate(game).ok, true);
        assert.equal(fluids.activate(game).ok, true);
        assert.equal(projectiles.activate(game).ok, true);
        assert.equal(progression.activate(game, { headless: true }).ok, true);
        if (exploration) assert.equal(exploration.activate(game).ok, true);
        assert.equal(mobs.activate(), true);
        game.playerVisual = keep(new PlayerVisual(scene));
        game.bindWorldServiceEvents();
        game.unbindControls = bindGameControls(game);
        // Authored transaction cases opt out; native cases use the unchanged
        // Wildlife -> Ecology population scheduler inside the actual Game frame.
        game.wildlife.autoSpawn = autoSpawn;
        game.applyVehiclePose();
      });
    },
    frame(count = 1) {
      for (let index = 0; index < count; index++)
        withGlobals(() => game.frame(game.lastFrame + 50));
    },
    key(code, down = true, extra = {}) {
      return withGlobals(() =>
        dispatch(document, down ? "keydown" : "keyup", { code, timeStamp: game.lastFrame, ...extra }));
    },
    hold(name, { count = 1, hand = "main", data } = {}) {
      const item = name === null ? null : getItem(ITEM[name] ?? BLOCK[name]);
      if (name !== null) assert.ok(item, `Committed catalog must contain ${name}`);
      const stack = item ? {
        id: item.id, count, ...(item.durability ? { durability: item.durability } : {}),
        ...(data ? { data } : {}),
      } : null;
      assert.equal(gameplay.inventoryTransaction((draft) => {
        if (hand === "offhand") draft.offhand = stack;
        else draft.slots[gameplay.selected] = stack;
        return true;
      }), true);
      return stack;
    },
    aim(mob, height = mob.kind === "horse" ? 1.4 : (mob.spec?.height ?? 0) / 2) {
      const eye = player.eyePosition, at = mob.position ?? mob;
      const dx = at.x - eye.x, dz = at.z - eye.z, dy = at.y + height - eye.y;
      player.yaw = Math.atan2(-dx, -dz);
      player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      player._syncCamera(0);
    },
    spawn(id = "horse:game", position = { x: 8.5, y: 65, z: 8.5 }) {
      const mob = game.wildlife.spawn("horse", position, { id });
      assert.ok(mob);
      f.aim(mob);
      return mob;
    },
    placeBoat() {
      const changes = [];
      for (let x = 11; x <= 14; x++)
        for (let z = 9; z <= 12; z++)
          changes.push({ x, y: 65, z, before: world.getCell(x, 65, z),
            after: normalizeCell({ id: BLOCK.WATER }) });
      assert.equal(world.applyCells(changes), true);
      f.hold("OAK_BOAT");
      const placed = vehicles.boats.place({ point: { x: 12.5, y: 65.5, z: 10.5 } });
      assert.equal(placed.ok, true, placed.reason);
      assert.equal(gameplay.getHandStack(), null);
      return placed.id;
    },
    tame(mob) {
      f.hold("WHEAT", { count: 34 });
      for (let i = 0; i < 34; i++)
        assert.equal(game.mobActions.interact(mob).ok, true);
      assert.equal(vehicles.horses.state(mob.id).temper, 100);
      assert.equal(vehicles.horses.state(mob.id).tamed, false);
      f.hold(null);
      assert.equal(game.useActions.tap(), true);
      assert.equal(player.vehicleType, "horse");
      f.frame(60);
      assert.equal(vehicles.horses.state(mob.id).tamed, true);
    },
    async closeHorse() {
      assert.equal(vehicles.horseInventory.closeCurrent("test").ok, true);
      if (game.screenClose) await game.screenClose;
      await Promise.resolve();
    },
    async saddle(mob, data = { version: 1, name: "Game trail saddle" }) {
      f.tame(mob);
      const stack = f.hold("SADDLE", { data });
      assert.equal(vehicles.openHorseInventory().ok, true);
      const sessionToken = vehicles.horseInventory.session.token;
      assert.equal(vehicles.horseInventory.action({
        type: "quickMove", area: "inventory", index: gameplay.selected, sessionToken,
      }).ok, true);
      assert.deepEqual(vehicles.horses.state(mob.id).saddle, stack);
      await f.closeHorse();
      assert.equal(game.active, true);
      return stack;
    },
    put(x, y, z, id) {
      const before = world.getCell(x, y, z), after = normalizeCell({ id });
      if (!cellsEqual(before, after))
        assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
    },
    snapshot: () => game.archive.snapshot(),
    ownership: () => ({
      archive: f.snapshot(), bytes: coordinator.budget.totalBytes,
      player: { position: point(player.position), velocity: point(player.velocity), seated: player.seated },
    }),
  };
  if (activate) f.activate();
  return f;
}
