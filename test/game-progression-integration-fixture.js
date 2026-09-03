import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { stageProgressionServices } from "../src/game-progression-integration.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { Gameplay } from "../src/gameplay.js";
import { Player } from "../src/player.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { STATION_BLOCK } from "./progression-live-fixture.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

/**
 * Authored resident columns; all item, XP, station, pearl-life and save owners
 * are production classes. UI callbacks are observations, never success/payment
 * sinks. This fixture makes no natural-acquisition or browser-layout claim.
 */
export function integratedProgressionFixture(t, {
  saved = null, seed = "integrated-progression", activate = true,
  root = null, document, headless = root === null, onChange,
} = {}) {
  const world = new World(saved?.world.seed ?? seed, {
    generatorVersion: saved?.world.generatorVersion ?? 4,
    dimension: saved?.world.dimension ?? "overworld",
    useWorker: false, generatorFactory: emptyFixtureGenerator,
  });
  if (saved) assert.equal(world.loadEdits(saved.world), true);
  world.generate(0);
  const context = createWorldContext(world), coordinator = world.coordinator;
  const gameplay = new Gameplay({ context, coordinator });
  if (saved) assert.equal(gameplay.load(saved.gameplay, { notify: false }), true);
  const overflow = new DropOverflow({ context, coordinator });
  if (saved) assert.equal(overflow.load(saved.overflow), true);
  const hostDocument = document ?? Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
  const player = new Player(camera, world, { ownerDocument: hostDocument, dataset: {} });
  player.setPosition(saved?.player ?? { x: 8.5, y: 65, z: 11.5 });
  const calls = { saves: 0, hud: 0, sounds: [], feedback: [], sessions: [], collected: [] };
  const game = {
    world, gameplay, player, coordinator, worldContext: context, overflow,
    graphics: { scene, camera }, paused: false, building: false, failed: false,
    overlayOpen: false, elapsed: 0, lastOverflowToast: 0,
    get simulating() { return !this.paused && !this.building && !this.failed && !this.gameplay.dead; },
    get active() { return this.simulating && !this.overlayOpen; },
    scheduleSave() { calls.saves++; },
    refreshHud() { calls.hud++; },
    overlayChanged(open) { this.overlayOpen = open; calls.sessions.push(open); },
    ui: {
      isHudVisible: true, toast() {},
      update(value) {
        if (value.experienceFeedback) calls.feedback.push(value.experienceFeedback);
      },
    },
    effects: { sound(...args) { calls.sounds.push(args); } },
  };
  const inventory = new GameInventoryActions(game);
  game.prepareDropItems = (...args) => inventory.prepareDropItems(...args);
  game.preparePlayerDrops = (...args) => inventory.preparePlayerDrops(...args);
  const building = new GameBuildingServices({ world, gameplay, context, saved });
  const projectileServices = new GameProjectileServices({ world, gameplay, context, saved });
  const integration = stageProgressionServices({ world, gameplay, context, projectileServices, saved });
  const orbs = new ExperienceOrbs(scene, world, {
    context, coordinator,
    prepareCollect: (amount) => integration.prepareExperience(amount),
    onCollect: (amount) => calls.collected.push(amount),
  });
  game.experienceOrbs = orbs;
  assert.equal(orbs.load(saved?.experienceOrbs), true);
  const f = {
    world, gameplay, player, game, context, coordinator, overflow,
    building, projectileServices, pearls: projectileServices.projectiles,
    integration, services: integration.services, orbs, calls,
    at: { dimension: world.dimension, x: 8, y: 65, z: 8 },
  };
  f.put = (x, y, z, id, state = 0, fluid) => {
    const before = world.getCell(x, y, z);
    const after = normalizeCell({ id, state, ...(fluid === undefined ? {} : { fluid }) });
    if (!cellsEqual(before, after))
      assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
  };
  f.editInventory = (edit) => {
    const participant = gameplay.prepareInventory(edit);
    assert.ok(participant);
    assert.equal(coordinator.commit([participant]).ok, true);
  };
  if (!saved) {
    const floor = [];
    for (let x = 4; x <= 12; x++)
      for (let z = 4; z <= 12; z++)
        floor.push({ x, y: 64, z, before: world.getCell(x, 64, z),
          after: normalizeCell({ id: BLOCK.STONE }) });
    assert.equal(world.applyCells(floor), true);
    f.editInventory((owned) => { owned.slots.fill(null); owned.experienceTotal = 0; return true; });
  }
  f.activate = (options = {}) => {
    if (!building.active) assert.equal(building.activate(game).ok, true);
    if (!projectileServices.active) assert.equal(projectileServices.activate(game).ok, true);
    return integration.activate(game, { root, headless, ...options });
  };
  if (activate) assert.equal(f.activate().ok, true);
  gameplay.onChange = (state) => { game.scheduleSave(); onChange?.(state); };
  gameplay.onDeath = () => {
    assert.equal(projectileServices.cancel("death", { advanceLife: true }), true);
    assert.equal(integration.onDeath(), true);
  };
  f.place = (kind) => f.put(f.at.x, f.at.y, f.at.z, STATION_BLOCK[kind]);
  f.open = () => integration.openStation({ ...f.at, ...world.getCell(f.at.x, f.at.y, f.at.z) });
  f.prepare = (action) => integration.prepareAction({ ...action, sessionToken: f.services.session?.token });
  f.action = (action) => integration.action({ ...action, sessionToken: f.services.session?.token });
  f.transfer = (inventoryIndex, stationIndex) => {
    assert.equal(f.action({ type: "click", area: "inventory", index: inventoryIndex, button: 0 }).ok, true);
    assert.equal(f.action({ type: "click", area: "container", index: stationIndex, button: 0 }).ok, true);
  };
  f.shelves = () => {
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++)
        if (Math.max(Math.abs(x), Math.abs(z)) === 2 && !(x === 0 && z === 2))
          f.put(f.at.x + x, f.at.y, f.at.z + z, BLOCK.BOOKSHELF);
  };
  f.collect = (amount) => {
    assert.equal(orbs.spawn(amount, {
      x: player.position.x, y: player.position.y + 0.8, z: player.position.z,
    }, { velocity: { x: 0, y: 0, z: 0 } }), true);
    orbs.update(0.01, game.elapsed += 0.01, player.position, gameplay);
  };
  f.snapshot = () => ({
    version: 3, world: world.serialize(), gameplay: gameplay.serialize(), overflow: overflow.serialize(),
    player: { x: player.position.x, y: player.position.y, z: player.position.z },
    experienceOrbs: orbs.serialize(), ...building.serialize(),
    ...projectileServices.serialize(), ...integration.serialize(),
  });
  t.after(() => {
    game.ecologyServices?.dispose();
    game.wildlife?.dispose();
    integration.dispose(); orbs.dispose(); projectileServices.dispose();
    building.dispose(); player.dispose(); overflow.dispose(); gameplay.dispose(); world.dispose();
  });
  return f;
}
