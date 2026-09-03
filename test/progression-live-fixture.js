import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { experienceForLevel } from "../src/experience.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameProgressionServices } from "../src/game-progression-services.js";
import { Gameplay } from "../src/gameplay.js";
import { normalizeStack } from "../src/inventory-slots.js";
import { getItem } from "../src/items.js";
import { Player, PLAYER_WIDTH } from "../src/player.js";
import { PlayerProjectiles } from "../src/player-projectiles.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

export const STATION_BLOCK = Object.freeze({
  enchanting: BLOCK.ENCHANTING_TABLE, anvil: BLOCK.ANVIL,
  brewing: BLOCK.BREWING_STAND, smithing: BLOCK.SMITHING_TABLE,
});

export function progressionStack(id, count = 1, data, durability = getItem(id)?.durability) {
  assert.ok(getItem(id), "Tests require the real catalog registration checkpoint");
  return normalizeStack({
    id, count, ...(durability === undefined ? {} : { durability }),
    ...(data === undefined ? {} : { data: { version: 1, ...data } }),
  });
}

/**
 * Authored empty columns, not natural generation or a Survival acquisition
 * claim. World, Player, Gameplay, overflow, clock, pearl life and progression
 * owners are production classes. Only DOM events and parent composition are
 * headless; no source overrides, registry substitutions or success sinks.
 */
export function progressionLiveFixture(t, {
  seed = "progression-live", generatorVersion = 4, dimension = "overworld",
  saved, activate = true, allowOverBudget = false, maxDropEntries,
  onSessionChange, onChange, onProjectileEvent, document,
} = {}) {
  const world = new World(saved?.world.seed ?? seed, {
    generatorVersion, dimension, useWorker: false,
    generatorFactory: emptyFixtureGenerator,
  });
  if (saved) assert.equal(world.loadEdits(saved.world), true);
  world.generate(0);
  const context = createWorldContext(world), coordinator = world.coordinator;
  const gameplay = new Gameplay({ context, coordinator });
  if (saved) assert.equal(gameplay.load(saved.gameplay, { notify: false }), true);
  const overflow = new DropOverflow({
    context, coordinator, ...(maxDropEntries === undefined ? {} : { maxEntries: maxDropEntries }),
  });
  if (saved) assert.equal(overflow.load(saved.overflow), true);
  const hostDocument = document ?? Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  const element = { ownerDocument: hostDocument, dataset: {} };
  const player = new Player(new THREE.PerspectiveCamera(75, 1, 0.1, 500), world, element);
  player.setPosition({ x: 8.5, y: 65, z: 11.5 });
  const calls = { saves: 0, hud: 0, sessions: [], projectiles: [], toasts: [] };
  let services;
  const game = {
    world, gameplay, player, coordinator, worldContext: context, overflow,
    paused: false, building: false, failed: false, elapsed: 0, lastOverflowToast: 0,
    get simulating() { return !this.paused && !this.building && !this.failed && !gameplay.dead; },
    get active() { return this.simulating && !services?.isOpen; },
    scheduleSave() { calls.saves++; },
    refreshHud() { calls.hud++; },
    ui: { toast(message) { calls.toasts.push(message); } },
  };
  const inventoryActions = new GameInventoryActions(game);
  game.prepareDropItems = (...args) => inventoryActions.prepareDropItems(...args);
  game.preparePlayerDrops = (...args) => inventoryActions.preparePlayerDrops(...args);
  const building = new GameBuildingServices({ world, gameplay, context, saved: saved?.building });
  assert.equal(building.activate(game).ok, true);
  let pearls;
  const getOwner = (id) => id === "local-player" ? {
    id, life: pearls.life, ref: game.player, world: game.world,
    dimension: game.world.dimension, alive: !game.gameplay.dead,
    position: game.player.position, eye: game.player.eyePosition,
    forward: game.player.forward, radius: PLAYER_WIDTH / 2, height: game.player.height,
    poseRevision: game.player.poseRevision,
  } : null;
  pearls = new PlayerProjectiles(world, {
    context, ownerId: "local-player", life: saved?.pearls.life ?? 0,
    staged: true, getOwner,
  });
  assert.equal(pearls.activateOwner(), true);
  const f = {
    world, gameplay, player, game, coordinator, context, overflow,
    building, pearls, getOwner, calls, ecology: null, ecologyContext: null,
    at: { dimension: world.dimension, x: 8, y: 65, z: 8 },
  };
  services = new GameProgressionServices({
    world, gameplay, context, saved: saved?.progression, allowOverBudget,
  });
  f.services = services;
  f.activate = (bridges = {}) => services.activate(game, {
    getOwner,
    getEcology: () => f.ecology,
    getEcologyContext: () => f.ecologyContext,
    onSessionChange: (...args) => {
      calls.sessions.push(args);
      onSessionChange?.(...args);
    },
    onChange: () => { game.scheduleSave(); onChange?.(); },
    onProjectileEvent: (event) => { calls.projectiles.push(event); onProjectileEvent?.(event); },
    ...bridges,
  });
  if (activate) assert.equal(f.activate().ok, true);
  gameplay.onDeath = () => {
    pearls.cancelPending("death", { advanceLife: true });
    services.onDeath();
  };
  f.put = (x, y, z, id, state = 0, fluid) => {
    const before = world.getCell(x, y, z);
    const after = normalizeCell({ id, state, ...(fluid === undefined ? {} : { fluid }) });
    if (!cellsEqual(before, after))
      assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
  };
  if (!saved) {
    const floor = [];
    for (let x = 4; x <= 12; x++)
      for (let z = 4; z <= 12; z++)
        floor.push({ x, y: 64, z, before: world.getCell(x, 64, z),
          after: normalizeCell({ id: BLOCK.STONE }) });
    assert.equal(world.applyCells(floor), true);
  }
  f.editInventory = (edit) => {
    const participant = gameplay.prepareInventory(edit);
    assert.ok(participant);
    assert.equal(coordinator.commit([participant]).ok, true);
  };
  if (!saved) f.editInventory((owned) => {
    owned.slots.fill(null);
    owned.experienceTotal = experienceForLevel(40);
    return true;
  });
  f.place = (kind, at = f.at) => {
    assert.ok(STATION_BLOCK[kind], `Missing station registration: ${kind}`);
    f.put(at.x, at.y, at.z, STATION_BLOCK[kind]);
    return at;
  };
  f.open = (at = f.at) => {
    services.close();
    return services.openStation({ ...at, ...world.getCell(at.x, at.y, at.z) });
  };
  f.prepare = (action) => services.prepareAction({ ...action, sessionToken: services.session?.token });
  f.action = (action) => services.action({ ...action, sessionToken: services.session?.token });
  f.transfer = (inventoryIndex, stationIndex) => {
    assert.equal(f.action({ type: "click", area: "inventory", index: inventoryIndex, button: 0 }).ok, true);
    assert.equal(f.action({ type: "click", area: "container", index: stationIndex, button: 0 }).ok, true);
  };
  f.shelves = () => {
    const shelves = [];
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== 2 || (x === 0 && z === 2)) continue;
        const at = { x: f.at.x + x, y: f.at.y, z: f.at.z + z };
        f.put(at.x, at.y, at.z, BLOCK.BOOKSHELF);
        shelves.push(at);
      }
    assert.equal(shelves.length, 15);
    return shelves;
  };
  f.snapshot = () => ({
    world: world.serialize(), gameplay: gameplay.serialize(), overflow: overflow.serialize(),
    progression: services.serialize(), building: building.serialize(), pearls: pearls.serialize(),
  });
  t.after(() => {
    services.dispose(); f.ecology?.dispose(); pearls.dispose(); building.dispose();
    player.dispose(); gameplay.dispose(); overflow.dispose(); world.dispose();
  });
  return f;
}
