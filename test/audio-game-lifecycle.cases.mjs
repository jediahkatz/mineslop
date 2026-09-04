import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as THREE from "three";
import * as textures from "../src/textures.js";
import * as renderer from "../src/renderer.js";
import { stageWorld } from "../src/game-world-stage.js";
import { World } from "../src/world.js";
import { BLOCK } from "../src/blocks.js";
import { getWorldSpec } from "../src/world-spec.js";
import { FakeAudioContext } from "./audio-fixture.js";

// Only DOM/GPU submission and terrain generation are replaced. Actual stageWorld,
// Game.initialize, Effects construction/disposal and resource owners still run.
class BrowserTarget extends EventTarget {
  constructor() {
    super();
    this.listeners = new Map();
  }
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  emit(type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields))
      Object.defineProperty(event, key, { value });
    this.dispatchEvent(event);
  }
}
const doc = new BrowserTarget();
const view = new BrowserTarget();
doc.defaultView = view;
doc.hidden = false;
doc.querySelector = () => null;
doc.documentElement = {};
doc.pointerLockElement = null;
doc.exitPointerLock = () => {};
const container = new BrowserTarget();
container.ownerDocument = doc;
container.dataset = {};
container.contains = (node) => node === container;
container.matches = () => false;
container.closest = () => null;
container.requestPointerLock = () => Promise.resolve();
const noop = () => {};
const settleAudio = () => new Promise((resolve) => setImmediate(resolve));
let callbacks;
mock.module("../src/ui.js", { namedExports: {
  createUI: (handlers) => {
    callbacks = handlers;
    return new Proxy({
      isMenuOpen: true, isOverlayOpen: false, isHudVisible: true,
      closeInventory: () => true,
    }, { get: (target, key) => target[key] ?? noop });
  },
} });
mock.module("../src/browser-capture.js", { namedExports: {
  BrowserCapture: class { dispose() {} },
} });
mock.module("../src/settlement-ui.js", { namedExports: {
  ContainerUI: class { close() { return true; } refresh() {} },
} });
mock.module("../src/textures.js", { namedExports: {
  ...textures,
  createAtlas: () => ({
    texture: new THREE.Texture(), emissiveTexture: new THREE.Texture(),
    uvFor: () => [0, 0, 1, 1],
  }),
} });
class HeadlessRenderer {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.renderer = { domElement: container };
    this.renderRadius = 0;
  }
  registerContextResourceOwner() { return noop; }
  setQuality() {}
  setFullbrightInspection() {}
  setTime() {}
  setBiome() {}
  update() {}
  render() {}
  rebuildDirty() {}
  dispose() {}
}
mock.module("../src/renderer.js", { namedExports: {
  ...renderer, GameRenderer: HeadlessRenderer,
} });
function flatGenerator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    spec, getSpawn: () => ({ x: 8.5, y: 65, z: 8.5 }),
    getBiome: () => ({ id: "plains", name: "Plains", color: "#80a050" }),
    generateChunk(cx, cz) {
      const blocks = new Uint8Array((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.STONE, 0, (65 - spec.minY) * 256);
      return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks, biomes: new Uint8Array(256) };
    },
  };
}
mock.module("../src/game-world-stage.js", { namedExports: {
  stageWorld: (options) => stageWorld(options, {
    worldFactory: (seed, settings) => {
      const world = new World(seed, {
        ...settings, generatorFactory: flatGenerator, useWorker: false,
      });
      const ensure = world.ensureArea.bind(world);
      world.ensureArea = (position) => ensure(position, 1);
      return world;
    },
  }),
} });
const { VoxelGame } = await import("../src/game.js");
const { Effects } = await import("../src/effects.js");
// Item sprite loading requires DOM images and is unrelated to audio ownership.
mock.method(Effects.prototype, "select", noop);

function fixture(t) {
  const previous = {
    document: globalThis.document, window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    AudioContext: globalThis.AudioContext,
  };
  const contexts = [];
  globalThis.document = doc;
  globalThis.window = view;
  // Initialization's two awaited frame barriers; no continuous frame loop.
  globalThis.requestAnimationFrame = (callback) => { queueMicrotask(() => callback(0)); return 1; };
  globalThis.AudioContext = class extends FakeAudioContext {
    constructor() { super(); contexts.push(this); }
  };
  doc.hidden = false;
  const game = new VoxelGame(container);
  game.scheduleSave = noop;
  game.save = async () => ({ ok: true });
  const prepare = game.prepareWorld.bind(game);
  game.prepareWorld = async (...args) => {
    const staged = await prepare(...args);
    const activate = staged.progressionIntegration.activate.bind(staged.progressionIntegration);
    staged.progressionIntegration.activate = (host, options) =>
      activate(host, { ...options, headless: true });
    return staged;
  };
  t.after(() => {
    game.disposeAudio();
    game.unbindControls?.();
    game.unbindWorldEvents?.();
    for (const name of ["vehicleServices", "mobIntegration", "progressionIntegration",
      "explorationServices", "projectileServices", "fluidServices", "buildingServices",
      "effects", "player", "playerVisual", "pickups", "experienceOrbs", "wildlife",
      "gameplay", "settlement", "overflow", "fuses", "world", "hurtFeedback"])
      game[name]?.dispose?.();
    Object.assign(globalThis, previous);
  });
  const control = {
    closest: (selector) => selector === "#ui" ? {} :
      selector.startsWith("[hidden]") || selector === "select" ? null : control,
  };
  return { game, contexts, click: () => doc.emit("click", {
    target: control, isTrusted: true, detail: 0,
  }) };
}

test("pre-world trusted menu unlock, real world replacement and mute retain one mixer", async (t) => {
  const { game, contexts, click } = fixture(t);
  const mixer = game.audioEngine;
  const listeners = doc.listeners.get("click").size;
  assert.equal(game.effects, undefined);
  assert.equal(contexts.length, 0);
  click();
  await settleAudio();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].sources.length, 1);
  callbacks.onSoundChange(false);
  const gains = contexts[0].nodes[0].gain.events.length;
  await game.initialize("audio-first", null, { generatorVersion: 3 });
  assert.equal(game.effects.audioEngine, mixer);
  assert.equal(mixer.enabled, false);
  assert.equal(contexts[0].nodes[0].gain.events.length, gains, "no temporary unmute during injection");
  const firstEffects = game.effects;
  const firstPlayer = game.player;
  await game.initialize("audio-second", null, { generatorVersion: 3 });
  assert.equal(firstEffects._disposed, true);
  assert.equal(firstPlayer.onWaterSample, null);
  assert.equal(contexts[0].closeCount, 0);
  assert.equal(game.effects.audioEngine, mixer);
  assert.equal(game.effects.soundEnabled, false);
  const saved = game.archive.snapshot();
  game.setSoundEnabled(true);
  await game.initialize(saved.world.seed, saved, { generatorVersion: 3 });
  assert.equal(game.effects.audioEngine, mixer);
  assert.equal(mixer.enabled, false, "saved mute restores on the persistent transport");
  assert.equal(doc.listeners.get("click").size, listeners);
  game.initializeAudio();
  assert.equal(game.audioEngine, mixer);
  assert.equal(contexts.length, 1);
  callbacks.onSoundChange(true);
  contexts[0].advance(1);
  click();
  await settleAudio();
  assert.equal(contexts[0].sources.length, 2);
});

test("real archive reload in water seeds the tracker without replaying an entry", async (t) => {
  const { game, contexts, click } = fixture(t);
  click();
  await settleAudio();
  await game.initialize("audio-water-restore", null, { generatorVersion: 3 });
  await game.play();
  for (let x = 7; x <= 9; x++)
    for (let z = 7; z <= 9; z++) assert.equal(game.world.set(x, 65, z, BLOCK.WATER), true);
  game.player.setPosition({ x: 8.5, y: 65, z: 8.5 });
  assert.ok(game.player.fluidState.waterImmersion > 0);
  const saved = game.archive.snapshot();
  const mixer = game.audioEngine;
  const context = contexts[0];
  const sources = context.sources.length;
  const sound = Effects.prototype.sound;
  const water = [];
  t.mock.method(Effects.prototype, "sound", function (kind, ...args) {
    if (kind.startsWith("water-")) water.push(kind);
    return sound.call(this, kind, ...args);
  });
  await game.initialize(saved.world.seed, saved, { generatorVersion: 3 });
  await game.play();
  for (let i = 0; i < 240; i++) {
    context.advance(1 / 120);
    game.player.update(1 / 120);
  }
  assert.ok(game.player.fluidState.waterImmersion > 0);
  assert.equal(game.audioEngine, mixer);
  assert.deepEqual(water, []);
  assert.equal(context.sources.length, sources);
});

test("real play/pause/death/hidden transitions silence immediately and music starts only in play", async (t) => {
  const { game, contexts, click } = fixture(t);
  click();
  await settleAudio();
  await game.initialize("audio-play", null, { generatorVersion: 3 });
  const context = contexts[0];
  context.advance(1);
  for (let i = 0; i < 150; i++) game.updateAudio(0.1);
  assert.equal(context.sources.length, 1, "no title-screen music");
  await game.play();
  for (let i = 0; i < 100; i++) {
    context.advance(0.1);
    game.updateAudio(0.1);
  }
  assert.ok(context.sources.length > 1);
  click(); // HUD pause activation is captured before its Game handler.
  const paused = game.pause();
  assert.equal(game.audioEngine.paused, true, "before pause's first await");
  assert.equal(game.audioEngine.voices.size, 0);
  await paused;
  await settleAudio();
  assert.equal(game.audioEngine.voices.size, 1, "the pause button itself clicks");
  context.advance(1);
  click();
  await settleAudio();
  assert.equal(game.audioEngine.voices.size, 1, "pause menu click remains audible");
  doc.hidden = true;
  doc.emit("visibilitychange");
  assert.equal(game.audioEngine.voices.size, 0, "no RAF required");
  assert.equal(game.effects.sound("water-entry"), false);
  doc.hidden = false;
  doc.emit("visibilitychange");
  context.advance(1);
  await game.play();
  assert.equal(game.effects.sound("water-entry"), true);
  game.gameplay.onDeath();
  assert.equal(game.audioEngine.paused, true);
  assert.equal(game.audioEngine.voices.size, 0);
});

test("standalone and shared Effects dispose only their own mixer; pagehide is terminal except BFCache", async (t) => {
  const { game, contexts, click } = fixture(t);
  click();
  await settleAudio();
  const shared = new Effects(new THREE.Scene(), new THREE.PerspectiveCamera(), { audioEngine: game.audioEngine });
  shared.dispose();
  assert.equal(contexts[0].closeCount, 0);
  const standalone = new Effects(new THREE.Scene(), new THREE.PerspectiveCamera());
  await standalone.unlockAudio();
  standalone.dispose();
  standalone.dispose();
  assert.equal(contexts[1].closeCount, 1);
  view.emit("pagehide", { persisted: true });
  assert.equal(contexts[0].closeCount, 0);
  assert.equal(game.audioEngine.hidden, true);
  view.emit("pagehide", { persisted: false });
  assert.equal(contexts[0].closeCount, 1);
  assert.equal(doc.listeners.get("click").size, 0);
  assert.equal(game.detachAudioUI, null);
  click();
  await settleAudio();
  assert.equal(contexts.length, 2);
});

test("pending UI unlock is invalidated across pause, mute and hidden round trips", async (t) => {
  const { game, contexts, click } = fixture(t);
  await game.initialize("audio-pending", null, { generatorVersion: 3 });
  await game.play();
  const context = contexts[0];
  const transitions = [
    async () => { await game.pause(); await game.play(); },
    async () => { callbacks.onSoundChange(false); callbacks.onSoundChange(true); },
    async () => {
      doc.hidden = true;
      doc.emit("visibilitychange");
      doc.hidden = false;
      doc.emit("visibilitychange");
      await game.play();
    },
  ];
  for (const transition of transitions) {
    context.state = "suspended";
    let finish;
    context.resumeTask = () => new Promise((resolve) => {
      finish = () => { context.state = "running"; resolve(); };
    });
    const before = context.sources.length;
    click();
    await transition();
    finish();
    await game.audioEngine.resuming;
    await settleAudio();
    assert.equal(context.sources.length, before, "never replay a stale pre-transition click");
    context.resumeTask = null;
  }
});

test("Game frame tolerates absent or throwing optional audio and fatal cleanup happens before rendering", (t) => {
  const { game, click } = fixture(t);
  const realAudio = game.audioEngine;
  game.audioEngine = undefined;
  // Block RAF scheduling here: frame still runs its real early-return path.
  globalThis.requestAnimationFrame = () => 1;
  assert.doesNotThrow(() => game.frame(100));
  game.audioEngine = { setHidden() { throw Error("lost device"); }, setPaused() { throw Error("lost device"); }, update() { throw Error("lost device"); } };
  assert.doesNotThrow(() => game.frame(200));
  game.audioEngine = realAudio;
  click();
  // Stop at the presentation boundary; terminal cleanup must already be complete.
  doc.createElement = () => { throw Error("presentation boundary"); };
  const originalError = console.error;
  console.error = noop;
  try {
    assert.throws(() => game.showError(Error("fatal world")), /presentation boundary/);
  } finally {
    console.error = originalError;
    delete doc.createElement;
  }
  assert.equal(realAudio.disposed, true);
  assert.equal(game.detachAudioUI, null);
});
