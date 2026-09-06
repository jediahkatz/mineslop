import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";
import { RENDER_DISTANCE_KEY, loadRenderDistance } from "../src/render-distance-preferences.js";
import { TransitionGate } from "../src/transition-gate.js";
import { daylightRenderer } from "./daylight-fixture.js";
import { lightWorld } from "./block-light-fixture.js";

function fixture(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const bytes = new Map([
    ["voxelcraft-view-v1", '{ "showFps": true, "guiScale": "auto" }'],
    ["voxelcraft-controls-v1", '{ "inputMode": "remote" }'],
    [RENDER_DISTANCE_KEY, "6"],
  ]);
  const otherBytes = [...bytes].filter(([key]) => key !== RENDER_DISTANCE_KEY);
  const storage = {
    getItem: (key) => bytes.get(key) ?? null,
    setItem: (key, value) => bytes.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
    assert.deepEqual([...bytes].filter(([key]) => key !== RENDER_DISTANCE_KEY), otherBytes);
  });
  const position = { x: 8, y: 8, z: 8 };
  const world = lightWorld();
  const streams = [];
  world.updateStreaming = (...args) => streams.push(args);
  const graphics = daylightRenderer(t, world, position, "high");
  const gpu = {
    MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
    isContextLost: () => false,
    getParameter: (key) => ({ 1: 2048, 2: 256, 3: 16 })[key],
  };
  graphics.renderer.getContext = () => gpu;
  graphics.setRenderDistanceOverride(6);
  const updates = [], messages = [];
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world, graphics, player: { position }, renderDistance: loadRenderDistance(),
    transitionGate: new TransitionGate(), building: false, failed: false,
    ui: { update: (value) => updates.push(value), toast: (message) => messages.push(message) },
  });
  return { game, bytes, storage, graphics, gpu, streams, updates, messages };
}

test("Game publishes only GPU-accepted distance, independently of effects, and saves only its own key", (t) => {
  const f = fixture(t);
  for (const radius of [2, 12, 6]) {
    assert.equal(f.game.setRenderDistance(radius), true);
    assert.equal(f.graphics.renderRadius, radius);
    assert.equal(f.game.renderDistance, radius);
    assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), String(radius));
    assert.equal(loadRenderDistance(), radius);
    assert.deepEqual(f.updates.at(-1), { renderDistance: radius });
    assert.deepEqual(f.streams.at(-1), [f.game.player.position, radius]);
  }
  f.graphics.resize = () => {};
  for (const quality of ["low", "high"]) {
    f.graphics.setQuality(quality);
    assert.equal(f.graphics.renderRadius, 6);
    assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
  }
});

test("invalid, unavailable and rejected GPU requests retain renderer, UI, preference and demand", (t) => {
  const f = fixture(t);
  for (const radius of [null, undefined, NaN, Infinity, "12", 0, 1, 13, 2.5])
    assert.equal(f.game.setRenderDistance(radius), false);
  f.gpu.getParameter = () => 0;
  assert.equal(f.game.setRenderDistance(12), false);
  assert.match(f.messages.at(-1), /unchanged.*WebGL2 limits/);
  f.gpu.isContextLost = () => true;
  assert.equal(f.game.setRenderDistance(2), false);
  assert.match(f.messages.at(-1), /live WebGL2/);
  f.graphics.renderer.getContext = () => null;
  assert.equal(f.game.setRenderDistance(12), false);
  assert.equal(f.game.renderDistance, 6);
  assert.equal(f.graphics.renderRadius, 6);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
});

test("initialization, failure and the pre-await transition gate reject settings without deferred writes", async (t) => {
  const f = fixture(t);
  f.game.building = true;
  assert.equal(f.game.setRenderDistance(12), false);
  f.game.building = false;
  f.game.failed = true;
  assert.equal(f.game.setRenderDistance(12), false);
  f.game.failed = false;
  f.game.graphics = null;
  assert.equal(f.game.setRenderDistance(12), false);
  f.game.graphics = f.graphics;
  await f.game.transitionGate.run(async () => {
    assert.equal(f.game.setRenderDistance(12), false);
    await Promise.resolve();
    assert.equal(f.game.setRenderDistance(2), false);
  });
  assert.equal(f.game.renderDistance, 6);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
  assert.equal(f.game.setRenderDistance(12), true);
});

test("blocked preference storage reports session-only acceptance without losing other preferences", (t) => {
  const f = fixture(t);
  f.storage.setItem = () => { throw new Error("blocked"); };
  assert.equal(f.game.setRenderDistance(12), true);
  assert.equal(f.graphics.renderRadius, 12);
  assert.equal(f.game.renderDistance, 12);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
  assert.match(f.messages.at(-1), /this session.*could not save/);
});

test("replacement GPU rejection precedes publication and preserves the old live owners and preference", async (t) => {
  const f = fixture(t);
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (work) => queueMicrotask(work);
  t.after(() => {
    if (oldRAF) globalThis.requestAnimationFrame = oldRAF;
    else delete globalThis.requestAnimationFrame;
  });
  let disposed = 0, published = 0;
  const stage = { world: {}, quality: "high", dispose: () => disposed++ };
  const oldWorld = f.game.world, oldPlayer = f.game.player;
  f.game.prepareGraphics = () => { throw new Error("GPU unavailable"); };
  Object.assign(f.game.ui, { ready() {}, showMenu() {} });
  f.game.refreshHud = () => {};
  f.game.building = true;
  await assert.rejects(f.game.installPreparedWorld(stage, null, () => {}, () => published++),
    /GPU unavailable/);
  assert.equal(published, 0);
  assert.equal(disposed, 1);
  assert.equal(f.game.building, false);
  assert.equal(f.game.world, oldWorld);
  assert.equal(f.game.player, oldPlayer);
  assert.equal(f.game.graphics, f.graphics);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
});

test("a failed atomic publication releases only the candidate renderer", async (t) => {
  const f = fixture(t);
  const oldRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (work) => queueMicrotask(work);
  t.after(() => {
    if (oldRAF) globalThis.requestAnimationFrame = oldRAF;
    else delete globalThis.requestAnimationFrame;
  });
  let disposed = 0;
  f.game.prepareGraphics = () => ({ dispose: () => disposed++ });
  const world = f.game.world;
  await assert.rejects(f.game.installPreparedWorld({ world: {}, quality: "low" },
    null, () => {}, async () => { throw new Error("CAS refused"); }), /CAS refused/);
  assert.equal(disposed, 1);
  assert.equal(f.game.world, world);
  assert.equal(f.game.graphics, f.graphics);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
});
