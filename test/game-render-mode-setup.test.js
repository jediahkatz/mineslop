import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { NEARBY_RENDER_RADII } from "../src/render-distance.js";
import { RENDER_DISTANCE_KEY } from "../src/render-distance-preferences.js";
import { DEFAULT_RENDER_MODE, RENDER_MODE_KEY } from "../src/render-mode-preferences.js";

if (!mock.module) {
  test("Game render-mode constructor and preparation contracts (isolated)", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--test", fileURLToPath(import.meta.url),
    ], { env, encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  // Exercise the real Game constructor, preferences and preparation with no
  // browser, WebGL context, rendered output or terrain generation.
  let resources = [], terrainError = null;
  class Renderer {
    constructor(container, world, options) {
      this.container = container;
      this.world = world;
      this.options = options;
      this.calls = [];
      this.quality = "medium";
      this.renderDistanceOverride = null;
      this.distantTerrain = options.distantTerrain;
      this.disposed = false;
      this.renderer = { domElement: { remove: () => this.calls.push(["remove"]) } };
      resources.push(this);
    }
    get renderRadius() {
      return this.renderDistanceOverride ?? NEARBY_RENDER_RADII[this.quality];
    }
    setQuality(quality) {
      this.calls.push(["quality", quality]);
      this.quality = quality;
    }
    configureTerrain(settings) {
      this.calls.push(["terrain", settings]);
      if (terrainError) throw terrainError;
      this.renderDistanceOverride = settings.radius;
      this.distantTerrain = settings.distantTerrain;
      return this.renderRadius;
    }
    setRenderDistanceOverride(radius) {
      this.renderDistanceOverride = radius;
      return this.renderRadius;
    }
    setFullbrightInspection(enabled) {
      this.calls.push(["fullbright", enabled]);
      this.fullbrightInspection = enabled;
    }
    dispose() { this.disposed = true; }
  }
  mock.module("../src/renderer.js", { namedExports: { GameRenderer: Renderer } });
  mock.module("../src/ui.js", { namedExports: {
    createUI: (callbacks) => ({
      callbacks, snapshots: [], messages: [],
      update(snapshot) { this.snapshots.push(snapshot); },
      toast(message) { this.messages.push(message); },
    }),
  } });
  mock.module("../src/settlement-ui.js", { namedExports: { ContainerUI: class {} } });
  mock.module("../src/game-controls.js", { namedExports: { bindGameControls: () => () => {} } });
  const { VoxelGame } = await import("../src/game.js");

  function fixture(t, { modeBytes, distanceBytes = " \n12 " } = {}) {
    resources = [];
    terrainError = null;
    const originals = new Map(["document", "localStorage"].map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const doc = new EventTarget();
    doc.documentElement = { ownerDocument: doc };
    doc.querySelector = () => ({});
    const bytes = new Map([
      [RENDER_DISTANCE_KEY, distanceBytes],
      ["voxelcraft-view-v1", '{ "fullbrightInspection": true, "showFps": true, "guiScale": 2 }'],
      ["voxelcraft-controls-v1", '{ "inputMode": "remote", "mouseSensitivity": 1.5 }'],
      ["voxelcraft-world-v1", '{ "world": { "seed": "preserved", "generatorVersion": 3 } }'],
      ...(modeBytes === undefined ? [] : [[RENDER_MODE_KEY, modeBytes]]),
    ]);
    const writes = [], streams = [], games = [];
    const storage = {
      getItem: (key) => bytes.get(key) ?? null,
      setItem: (key, value) => { writes.push([key, value]); bytes.set(key, value); },
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    t.mock.method(VoxelGame.prototype, "initializeAudio", () => {});
    const world = Object.freeze({
      seed: "preserved", generatorVersion: 3, dimension: "overworld",
      updateStreaming: (...args) => streams.push(args),
    });
    const container = {};
    const create = () => {
      const game = new VoxelGame(container);
      games.push(game);
      return game;
    };
    t.after(async () => {
      for (const game of games) {
        game.browserCapture.dispose();
        game.gameplay.dispose();
        await game.storage.close();
      }
      for (const resource of resources) resource.dispose();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    return { bytes, writes, storage, streams, world, container, create };
  }

  test("cold Game defaults to Nearby without rewriting distance, controls, view or world bytes", (t) => {
    const f = fixture(t), before = [...f.bytes], game = f.create();
    assert.equal(game.renderDistance, 12);
    assert.deepEqual(game.renderModePreferences, DEFAULT_RENDER_MODE);
    assert.equal(game.ui.snapshots[0].quality, "medium");
    assert.deepEqual(game.ui.snapshots[0].renderSettings, {
      mode: "nearby", distantTerrain: false, override: null, radius: 3, maxRadius: 4,
    });
    assert.equal(Object.hasOwn(game.ui.snapshots[0], "renderDistance"), false);
    assert.deepEqual(game.controlPreferences, { inputMode: "remote", mouseSensitivity: 1.5 });
    assert.deepEqual(game.viewPreferences, { fullbrightInspection: true, guiScale: 2, showFps: true });
    assert.deepEqual([...f.bytes], before);
    assert.deepEqual(f.writes, []);
  });

  test("pre-world quality assignment remains available before start without bypassing runtime admission", async (t) => {
    const f = fixture(t), before = [...f.bytes];
    const previousRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => {
      if (previousRAF === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = previousRAF;
    });
    for (const [quality, radius] of [["low", 2], ["medium", 3], ["high", 4]]) {
      const game = f.create();
      assert.equal(game.setQuality("high"), false, "the UI cannot accept a missing renderer");
      assert.equal(game.quality, "medium");
      game.quality = quality;
      t.mock.method(game.storage, "load", async () => null);
      let prepared;
      t.mock.method(game, "initialize", async () => {
        prepared = game.prepareGraphics(f.world, game.quality);
      });
      await game.start();
      assert.equal(prepared.quality, quality);
      assert.equal(prepared.renderRadius, radius);
      assert.equal(prepared.renderDistanceOverride, null);
    }
    assert.deepEqual([...f.bytes], before);
    assert.deepEqual(f.writes, []);
  });

  test("initial and replacement graphics use staged quality presets and explicitly disable far terrain", (t) => {
    const f = fixture(t), game = f.create(), before = [...f.bytes];
    const originalControls = game.controlPreferences, originalView = game.viewPreferences;
    for (const generatorVersion of [3, 7]) {
      const world = Object.freeze({ ...f.world, generatorVersion });
      for (const [quality, radius] of [["low", 2], ["medium", 3], ["high", 4]]) {
        const graphics = game.prepareGraphics(world, quality);
        assert.equal(graphics.world, world);
        assert.equal(graphics.container, f.container);
        assert.deepEqual(graphics.options, { distantTerrain: false });
        assert.deepEqual(graphics.meshLimits, { regionalPages: true });
        assert.deepEqual(graphics.calls, [
          ["quality", quality],
          ["terrain", { radius: null, distantTerrain: false }],
          ["fullbright", true],
          ["remove"],
        ]);
        assert.equal(graphics.renderRadius, radius);
        assert.equal(graphics.disposed, false);
        assert.equal(game.graphics, undefined, "a candidate is not published by preparation");
      }
    }
    assert.equal(game.renderDistance, 12);
    assert.equal(game.controlPreferences, originalControls);
    assert.equal(game.viewPreferences, originalView);
    assert.equal(game.ui.snapshots.length, 1);
    assert.deepEqual([...f.bytes], before);
    assert.deepEqual(f.writes, []);
  });

  test("cold explicit Nearby and Extended choices keep their own radius across every quality", (t) => {
    const f = fixture(t, { distanceBytes: " 6\n" });
    for (const [mode, nearbyRadius, expected] of [
      ["nearby", 2, 2], ["nearby", 4, 4], ["extended", null, 6], ["extended", 2, 6],
    ]) {
      f.bytes.set(RENDER_MODE_KEY, JSON.stringify({ version: 1, mode, nearbyRadius }));
      const before = [...f.bytes], game = f.create();
      assert.equal(game.renderDistance, 6);
      assert.equal(game.ui.snapshots[0].renderSettings.radius, expected);
      assert.equal(game.ui.snapshots[0].renderSettings.maxRadius, mode === "nearby" ? 4 : 12);
      for (const quality of ["low", "medium", "high"]) {
        const graphics = game.prepareGraphics(f.world, quality);
        assert.deepEqual(graphics.options, { distantTerrain: mode === "extended" });
        assert.equal(graphics.renderDistanceOverride, expected);
        assert.equal(graphics.renderRadius, expected);
        assert.equal(graphics.fullbrightInspection, true);
      }
      assert.deepEqual([...f.bytes], before);
    }
    assert.deepEqual(f.writes, []);
  });

  test("the real Game UI callbacks restore both persisted choices after a cold restart", (t) => {
    const f = fixture(t), game = f.create();
    game.graphics = game.prepareGraphics(f.world, "medium");
    game.world = f.world;
    game.player = { position: { x: 8, y: 8, z: 8 } };
    assert.equal(game.ui.callbacks.onRenderDistanceChange(2), true);
    assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), " \n12 ");
    assert.equal(game.ui.callbacks.onRenderModeChange("extended"), true);
    assert.equal(game.graphics.renderRadius, 12);
    assert.equal(game.ui.callbacks.onRenderDistanceChange(6), true);
    assert.equal(game.ui.callbacks.onQualityChange("high"), true);
    assert.equal(game.graphics.renderRadius, 6);
    const extended = f.create();
    assert.equal(extended.renderModePreferences.nearbyRadius, 2);
    assert.equal(extended.renderSettings.mode, "extended");
    assert.equal(extended.renderSettings.radius, 6);
    assert.equal(game.ui.callbacks.onRenderModeChange("nearby"), true);
    assert.equal(game.graphics.renderRadius, 2);
    const nearby = f.create();
    assert.equal(nearby.renderSettings.mode, "nearby");
    assert.equal(nearby.renderSettings.radius, 2);
    assert.equal(nearby.renderDistance, 6);
    assert.equal(nearby.prepareGraphics(f.world, "high").renderRadius, 2);
    assert.deepEqual(f.streams.at(-1), [game.player.position, 2]);
  });

  test("failed graphics preparation disposes only the candidate without publishing or persisting its policy", (t) => {
    const f = fixture(t), game = f.create(), before = [...f.bytes];
    const original = game.prepareGraphics(f.world, "medium");
    game.graphics = original;
    game.world = f.world;
    const settings = game.renderSettings;
    const preferences = game.renderModePreferences;
    terrainError = new Error("GPU admission refused");
    const candidateWorld = Object.freeze({ ...f.world, seed: "candidate", generatorVersion: 7 });
    assert.throws(() => game.prepareGraphics(candidateWorld, "high"), /GPU admission refused/);
    assert.equal(resources.at(-1).disposed, true);
    assert.equal(original.disposed, false);
    assert.equal(game.graphics, original);
    assert.equal(game.world, f.world);
    assert.equal(game.renderModePreferences, preferences);
    assert.deepEqual(game.renderSettings, settings);
    assert.equal(game.ui.snapshots.length, 1);
    assert.deepEqual([...f.bytes], before);
    assert.deepEqual(f.writes, []);
  });

  test("malformed, future or out-of-range mode records cold-load Nearby without migration writes", (t) => {
    const f = fixture(t);
    for (const modeBytes of [
      "not-json",
      '{"version":2,"mode":"extended","nearbyRadius":2}',
      '{"version":1,"mode":"nearby","nearbyRadius":12}',
      '{"version":1,"mode":"far","nearbyRadius":null}',
    ]) {
      f.bytes.set(RENDER_MODE_KEY, modeBytes);
      const before = [...f.bytes], game = f.create();
      assert.deepEqual(game.renderModePreferences, DEFAULT_RENDER_MODE);
      assert.equal(game.renderSettings.radius, 3);
      assert.equal(game.renderDistance, 12);
      assert.deepEqual([...f.bytes], before);
    }
    assert.deepEqual(f.writes, []);
  });

  test("blocked browser storage reads still prepare Nearby presets without attempting writes", (t) => {
    const f = fixture(t), before = [...f.bytes];
    f.storage.getItem = () => { throw new Error("blocked"); };
    f.storage.setItem = () => assert.fail("loading must not repair storage");
    const game = f.create();
    assert.equal(game.renderDistance, 12);
    assert.deepEqual(game.renderModePreferences, DEFAULT_RENDER_MODE);
    const graphics = game.prepareGraphics(f.world, "low");
    assert.equal(graphics.renderRadius, 2);
    assert.deepEqual(graphics.options, { distantTerrain: false });
    assert.deepEqual([...f.bytes], before);
    assert.deepEqual(f.writes, []);
  });
}
