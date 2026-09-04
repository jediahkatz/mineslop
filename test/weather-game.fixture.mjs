import assert from "node:assert/strict";
import { mock } from "node:test";
import * as THREE from "three";
import * as renderer from "../src/renderer.js";
import * as textures from "../src/textures.js";
import { stageWorld } from "../src/game-world-stage.js";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { BIOME_INDEX } from "../src/biomes.js";
import { normalizeCell } from "../src/block-state.js";
import { getWorldSpec } from "../src/world-spec.js";
import { InputElement } from "./control-fixture.js";
import { FakeAudioContext } from "./audio-fixture.js";

const noop = () => {};
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
mock.module("../src/textures.js", { namedExports: {
  ...textures, createAtlas: () => ({
    texture: new THREE.Texture(), emissiveTexture: new THREE.Texture(),
    uvFor: () => [0, 0, 1, 1],
  }),
} });
// GPU/DOM transport only. Real weather borrows a real instanced cloud mesh.
class HeadlessRenderer {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.renderer = { domElement: container };
    this.renderRadius = 0;
    this.events = [];
    this.atmosphere = {
      cameraMediumKnown: true, underwater: false, inLava: false,
      clouds: new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 108),
    };
    this.scene.add(this.atmosphere.clouds);
  }
  registerContextResourceOwner() { return noop; }
  setQuality() {} setFullbrightInspection() {} setTime() {} setBiome() {}
  setTarget() {} observeFrame() {}
  update() {
    this.events.push("atmosphere");
    // The borrowed transform must be corrected AFTER each atmosphere update.
    this.atmosphere.clouds.position.copy(this.camera.position);
  }
  render() { this.events.push("draw"); }
  rebuildDirty() { this.events.push("mesh"); }
  dispose() {
    const clouds = this.atmosphere.clouds;
    clouds.geometry.dispose(); clouds.material.dispose(); clouds.dispose();
    this.scene.remove(clouds);
  }
}
mock.module("../src/renderer.js", { namedExports: { ...renderer, GameRenderer: HeadlessRenderer } });
export function weatherGenerator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  const biome = dimension === "nether" ? "nether_wastes" : dimension === "end" ? "the_end" : "plains";
  return {
    spec, getSpawn: () => ({ x: 8.5, y: 65, z: 8.5 }),
    terrainHeight: () => 64, getTrees: () => [],
    getBiome: () => ({ id: biome, name: "Authored weather terrain", color: "#80a050" }),
    generateChunk(cx, cz) {
      const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.STONE, 0, (65 - spec.minY) * 256);
      return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
        biomes: new Uint8Array(256).fill(BIOME_INDEX[biome]) };
    },
  };
}
export const stagedWorlds = [];
mock.module("../src/game-world-stage.js", { namedExports: {
  stageWorld: (options) => stageWorld(options, {
    worldFactory: (seed, settings) => {
      const world = new World(seed, { ...settings, generatorFactory: weatherGenerator, useWorker: false });
      stagedWorlds.push(world);
      const ensure = world.ensureArea.bind(world);
      world.ensureArea = (position) => ensure(position, 1);
      return world;
    },
  }),
} });
export const { VoxelGame } = await import("../src/game.js");
const { Effects } = await import("../src/effects.js");
mock.method(Effects.prototype, "select", noop); // No DOM item-sprite downloads.

export async function weatherGame(t, { seed = "weather-game", saved = null, generatorVersion } = {}) {
  const keys = ["document", "window", "requestAnimationFrame", "AudioContext"];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const doc = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(), hidden: false,
    querySelector: () => null, documentElement: {}, exitPointerLock: noop,
  });
  container = new InputElement(doc);
  const contexts = [];
  globalThis.document = doc;
  globalThis.window = doc.defaultView;
  globalThis.AudioContext = class extends FakeAudioContext {
    constructor() { super(); contexts.push(this); }
  };
  let initializing = true;
  globalThis.requestAnimationFrame = (callback) => {
    if (initializing) queueMicrotask(() => callback(0));
    return 1;
  };
  const game = new VoxelGame(container), saves = [];
  game.archive.storage = {
    async save(snapshot) { saves.push(structuredClone(snapshot)); },
    async requestPersistence() {},
  };
  const staged = [];
  const prepare = game.prepareWorld.bind(game);
  game.prepareWorld = async (...args) => {
    const candidate = await prepare(...args);
    staged.push(candidate);
    const activate = candidate.progressionIntegration.activate.bind(candidate.progressionIntegration);
    candidate.progressionIntegration.activate = (host, options) =>
      activate(host, { ...options, headless: true });
    return candidate;
  };
  t.after(() => {
    game.paused = true;
    clearTimeout(game.saveTimer);
    game.disposeAudio();
    game.unbindControls?.(); game.unbindWorldEvents?.();
    for (const name of ["weatherServices", "gravityServices", "vehicleServices", "mobIntegration",
      "progressionIntegration", "explorationServices", "projectileServices", "fluidServices",
      "buildingServices", "effects", "player", "playerVisual", "pickups", "experienceOrbs",
      "wildlife", "graphics", "gameplay", "settlement", "overflow", "fuses", "world", "hurtFeedback"])
      game[name]?.dispose?.();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  const resume = () => {
    game.paused = game.building = game.failed = game.overlayOpen = false;
    game.started = true; game.player.enabled = true; game.wildlife.autoSpawn = false;
  };
  const initialize = async (nextSeed, nextSaved = null, options = {}) => {
    initializing = true;
    try { await game.initialize(nextSeed, nextSaved, { generatorVersion, ...options }); }
    finally { initializing = false; }
    resume();
  };
  await initialize(seed, saved);
  assert.equal(game.frame, VoxelGame.prototype.frame);
  assert.equal(game.weatherServices.active, true);
  return {
    game, doc, contexts, saves, staged, initialize, resume,
    frame(count = 1, milliseconds = 100) {
      for (let i = 0; i < count; i++) {
        if (contexts[0]) contexts[0].currentTime += milliseconds / 1000;
        game.streamTimer = 0;
        game.frame(game.lastFrame + milliseconds);
      }
    },
    put(x, y, z, value) {
      const before = game.world.getCell(x, y, z);
      const after = normalizeCell(typeof value === "number" ? { id: value } : value);
      assert.equal(game.world.applyCells([{ x, y, z, before, after }]), true);
    },
    async rainy() {
      const saved = game.snapshot();
      saved.weather = { version: 1, elapsed: 1000 };
      await initialize(saved.world.seed, saved);
      await game.audioEngine.unlock();
    },
  };
}
