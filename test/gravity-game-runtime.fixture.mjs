import assert from "node:assert/strict";
import { mock } from "node:test";
import * as THREE from "three";
import * as renderer from "../src/renderer.js";
import { stageWorld } from "../src/game-world-stage.js";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { getWorldSpec } from "../src/world-spec.js";
import { InputElement } from "./control-fixture.js";

// Captured before substituting the DOM/WebGL constructor below. Focused state
// tests use these actual renderer methods with real meshes and lighting owners.
export const RealGameRenderer = renderer.GameRenderer;
const noop = () => {};
export let doc;
let container;
mock.module("../src/ui.js", { namedExports: {
  createUI: () => new Proxy({
    isMenuOpen: false, isOverlayOpen: false, isHudVisible: true,
    closeInventory: () => true,
  }, { get: (target, key) => target[key] ?? noop }),
} });
mock.module("../src/browser-capture.js", { namedExports: {
  BrowserCapture: class { dispose() {} },
} });
mock.module("../src/settlement-ui.js", { namedExports: {
  ContainerUI: class { close() { return true; } refresh() {} },
} });
// Rendering/audio are transports only: no simulation or resource owner mocks.
mock.module("../src/effects.js", { namedExports: {
  Effects: class {
    constructor() { this.offhand = { swing: 0 }; }
    select() {} selectOffhand() {} update() {} sound() {} burst() {}
    dispose() {} unlockAudio() {}
  },
} });
class HeadlessRenderer {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.renderer = { domElement: container };
    this.renderRadius = 0;
    this.budgets = [];
  }
  setQuality() {} setFullbrightInspection() {} setTime() {} setBiome() {}
  update() {} render() {} setTarget() {} observeFrame() {} dispose() {}
  rebuildDirty(budget) { this.budgets.push(budget); }
}
mock.module("../src/renderer.js", { namedExports: {
  ...renderer, GameRenderer: HeadlessRenderer,
} });
export const stagedWorlds = [];
export function generator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    spec, getSpawn: () => ({ x: 8.5, y: 65, z: 11.5 }),
    terrainHeight: () => 64,
    getTrees: () => [],
    getBiome: () => ({ id: dimension === "nether" ? "nether_wastes" : "plains",
      name: "Authored gravity terrain", color: "#80a050" }),
    generateChunk(cx, cz) {
      const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.STONE, 0, (65 - spec.minY) * 256);
      if (seed.startsWith("generated-") && cx === 0 && cz === 0)
        for (let y = 70; y < 73; y++)
          blocks[(y - spec.minY) * 256 + 3 * 16 + 3] = BLOCK.SAND;
      return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
        biomes: new Uint8Array(256) };
    },
  };
}
mock.module("../src/game-world-stage.js", { namedExports: {
  stageWorld: (options) => stageWorld(options, {
    worldFactory: (seed, settings) => {
      const world = new World(seed, {
        ...settings,
        ...(seed.startsWith("native-") ? {} : { generatorFactory: generator }),
        useWorker: false,
      });
      stagedWorlds.push(world);
      const ensure = world.ensureArea.bind(world);
      world.ensureArea = (position) => ensure(position, 1);
      return world;
    },
  }),
} });
export const { VoxelGame } = await import("../src/game.js");

export async function gravityGame(t, { seed = "gravity-game", saved = null } = {}) {
  const keys = ["document", "window", "requestAnimationFrame"];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  doc = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(), hidden: false,
    querySelector: () => null, documentElement: {}, exitPointerLock: noop,
  });
  container = new InputElement(doc);
  globalThis.document = doc;
  globalThis.window = doc.defaultView;
  let initializing = true;
  globalThis.requestAnimationFrame = (callback) => {
    if (initializing) queueMicrotask(() => callback(0));
    return 1;
  };
  doc.hidden = false;
  const game = new VoxelGame(container);
  let saves = 0;
  const scheduleSave = game.scheduleSave;
  game.scheduleSave = function (...args) {
    saves++;
    return Reflect.apply(scheduleSave, this, args);
  };
  // Browser storage transport only: actual Game/Archive scheduling, snapshot
  // construction and save lifecycle remain authoritative.
  game.archive.storage = { async save() {}, async requestPersistence() {} };
  const prepare = game.prepareWorld.bind(game);
  game.prepareWorld = async (...args) => {
    const staged = await prepare(...args);
    const activate = staged.progressionIntegration.activate.bind(staged.progressionIntegration);
    staged.progressionIntegration.activate = (host, options) =>
      activate(host, { ...options, headless: true });
    return staged;
  };
  t.after(() => {
    game.paused = true;
    clearTimeout(game.saveTimer);
    game.disposeAudio();
    game.unbindControls?.();
    game.unbindWorldEvents?.();
    for (const name of ["gravityServices", "vehicleServices", "mobIntegration",
      "progressionIntegration", "explorationServices", "projectileServices",
      "fluidServices", "buildingServices", "effects", "player", "playerVisual",
      "pickups", "experienceOrbs", "wildlife", "graphics", "gameplay", "settlement",
      "overflow", "fuses", "world", "hurtFeedback"]) game[name]?.dispose?.();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  const resume = () => {
    game.paused = game.building = game.failed = game.overlayOpen = false;
    game.started = true;
    game.player.enabled = true;
    game.wildlife.autoSpawn = false;
  };
  const initialize = async (nextSeed, nextSaved = null) => {
    initializing = true;
    try { await game.initialize(nextSeed, nextSaved, { generatorVersion: 3 }); }
    finally { initializing = false; }
    resume();
  };
  await initialize(seed, saved);
  assert.equal(game.frame, VoxelGame.prototype.frame);
  assert.equal(game.gravityServices.active, true);
  return {
    game, doc, initialize, resume, get saves() { return saves; },
    frame(count = 1, milliseconds = 100) {
      for (let i = 0; i < count; i++) {
        game.streamTimer = 0; // Authored residency; actual streaming tested separately.
        game.frame(game.lastFrame + milliseconds);
      }
    },
    put(x, y, z, value) {
      const before = game.world.getCell(x, y, z);
      const after = normalizeCell(typeof value === "number" ? { id: value } : value);
      assert.equal(game.world.applyCells([{ x, y, z, before, after }]), true);
    },
  };
}
