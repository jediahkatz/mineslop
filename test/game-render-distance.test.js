import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";
import { RENDER_DISTANCE_KEY, loadRenderDistance } from "../src/render-distance-preferences.js";
import {
  RENDER_MODE_KEY, loadRenderModePreferences, resolveRenderMode,
} from "../src/render-mode-preferences.js";
import { TransitionGate } from "../src/transition-gate.js";
import { createEventScope } from "../src/ui/dom.js";
import { createQualitySettings } from "../src/ui/quality-settings.js";
import { daylightRenderer } from "./daylight-fixture.js";
import { lightWorld } from "./block-light-fixture.js";

function fixture(t, { mode = "extended", nearbyRadius = null, quality = "high", distanceBytes = "6" } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const bytes = new Map([
    ["voxelcraft-view-v1", '{ "showFps": true, "guiScale": "auto" }'],
    ["voxelcraft-controls-v1", '{ "inputMode": "remote" }'],
    ["voxelcraft-world-v1", '{ "world": { "seed": "untouched" } }'],
    [RENDER_DISTANCE_KEY, distanceBytes],
    ...(mode === null ? [] : [[RENDER_MODE_KEY, JSON.stringify({ version: 1, mode, nearbyRadius })]]),
  ]);
  const otherEntries = () => [...bytes].filter(([key]) =>
    key !== RENDER_DISTANCE_KEY && key !== RENDER_MODE_KEY);
  const otherBytes = otherEntries(), writes = [];
  const storage = {
    getItem: (key) => bytes.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); bytes.set(key, value); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
    assert.deepEqual(otherEntries(), otherBytes);
  });
  const position = { x: 8, y: 8, z: 8 };
  const world = lightWorld();
  const streams = [];
  world.updateStreaming = (...args) => streams.push(args);
  const graphics = daylightRenderer(t, world, position, quality);
  const gpu = {
    MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
    isContextLost: () => false,
    getParameter: (key) => ({ 1: 2048, 2: 256, 3: 16 })[key],
  };
  graphics.renderer.getContext = () => gpu;
  const renderDistance = loadRenderDistance(), renderModePreferences = loadRenderModePreferences();
  const policy = resolveRenderMode(renderModePreferences, renderDistance, quality);
  graphics.configureTerrain({ radius: policy.override, distantTerrain: policy.distantTerrain });
  const updates = [], messages = [];
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world, graphics, player: { position }, renderDistance, renderModePreferences, quality,
    transitionGate: new TransitionGate(), building: false, failed: false,
    controlPreferences: Object.freeze({ inputMode: "remote", mouseSensitivity: 1.5 }),
    viewPreferences: Object.freeze({ fullbrightInspection: false, guiScale: 2, showFps: true }),
    ui: { update: (value) => updates.push(value), toast: (message) => messages.push(message) },
    scheduleSave: () => assert.fail("render preferences must not write a world save"),
  });
  return { game, bytes, writes, storage, graphics, gpu, streams, updates, messages };
}

function qualityState(f) {
  return structuredClone({
    quality: f.game.quality,
    graphicsQuality: f.graphics.quality,
    radius: f.graphics.renderRadius,
    override: f.graphics.renderDistanceOverride,
    renderDistance: f.game.renderDistance,
    renderModePreferences: f.game.renderModePreferences,
    updates: f.updates,
    streams: f.streams,
    bytes: [...f.bytes],
    writes: f.writes,
  });
}

for (const state of ["building", "failed", "missing graphics", "disposed", "lost context", "unavailable context"]) {
  test(`quality requests retain accepted Nearby state when ${state}`, (t) => {
    const f = fixture(t, { mode: null, quality: "medium" });
    if (state === "building") f.game.building = true;
    if (state === "failed") f.game.failed = true;
    if (state === "missing graphics") f.game.graphics = null;
    if (state === "disposed") f.graphics.disposed = true;
    if (state === "lost context") f.gpu.isContextLost = () => true;
    if (state === "unavailable context") f.graphics.renderer.getContext = () => null;
    const before = qualityState(f);
    const setQuality = t.mock.method(f.graphics, "setQuality");
    const accepted = f.game.setQuality("high");
    assert.deepEqual(qualityState(f), before, "refusal must preserve quality, radius, UI, preferences and demand");
    assert.equal(accepted, false);
    assert.equal(setQuality.mock.callCount(), 0, "admission precedes effect/radius mutation");
  });
}

test("quality requests reject before and after the first await of a world transition", async (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const before = qualityState(f);
  const setQuality = t.mock.method(f.graphics, "setQuality");
  await f.game.transitionGate.run(async () => {
    const first = f.game.setQuality("high");
    assert.deepEqual(qualityState(f), before);
    assert.equal(first, false);
    await Promise.resolve();
    assert.equal(f.game.setQuality("low"), false);
    assert.deepEqual(qualityState(f), before);
  });
  assert.equal(setQuality.mock.callCount(), 0);
  assert.equal(f.game.setQuality("high"), true, "a completed transition leaves quality usable");
  assert.equal(f.graphics.renderRadius, 4);
});

test("quality requests cannot mutate the source world while prepared-world publication is pending", async (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const previousRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queueMicrotask(callback);
  t.after(() => {
    if (previousRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRAF;
  });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const candidate = { dispose: t.mock.fn() };
  f.game.prepareGraphics = () => candidate;
  f.game.building = true;
  const before = qualityState(f), world = f.game.world;
  const pending = f.game.installPreparedWorld({ world: {}, quality: "high" },
    null, () => {}, async () => {
      entered.resolve();
      await finish.promise;
      throw new Error("publication refused");
    });
  const rejected = assert.rejects(pending, /publication refused/);
  await entered.promise;
  try {
    const accepted = f.game.setQuality("high");
    assert.deepEqual(qualityState(f), before);
    assert.equal(accepted, false);
    assert.equal(f.game.world, world);
    assert.equal(f.game.graphics, f.graphics);
  } finally {
    finish.resolve();
    await rejected;
  }
  assert.equal(candidate.dispose.mock.callCount(), 1);
});

test("quality admission failure does not invoke the renderer quality mutator", (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const before = qualityState(f);
  const setQuality = t.mock.method(f.graphics, "setQuality");
  t.mock.method(f.graphics, "configureTerrain", () => { throw new Error("GPU preflight refused"); });
  const accepted = f.game.setQuality("high");
  assert.deepEqual(qualityState(f), before);
  assert.equal(accepted, false);
  assert.equal(setQuality.mock.callCount(), 0);
  assert.match(f.messages.at(-1), /unchanged.*GPU preflight refused/);
});

test("the quality selector keeps Game-confirmed values through gate and context refusals, then accepts recovery", async (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const select = Object.assign(new EventTarget(), { value: "" });
  const events = createEventScope();
  t.after(() => events.dispose());
  const settings = createQualitySettings({ querySelector: () => select }, {
    listen: events.listen, onChange: (quality) => f.game.setQuality(quality),
  });
  f.game.ui.update = (value) => {
    f.updates.push(value);
    settings.update(value.quality);
  };
  settings.update(f.game.quality);
  const before = qualityState(f);
  const request = (quality) => {
    select.value = quality;
    select.dispatchEvent(new Event("change"));
  };
  await f.game.transitionGate.run(async () => {
    request("high");
    assert.equal(select.value, "medium");
    await Promise.resolve();
    request("low");
    assert.equal(select.value, "medium");
  });
  f.game.failed = true;
  request("high");
  assert.equal(select.value, "medium");
  f.game.failed = false;
  f.gpu.isContextLost = () => true;
  request("high");
  assert.equal(select.value, "medium");
  assert.deepEqual(qualityState(f), before);
  f.gpu.isContextLost = () => false;
  request("high");
  assert.equal(select.value, "high");
  assert.equal(f.game.quality, "high");
  assert.equal(f.graphics.renderRadius, 4);
  assert.equal(f.updates.at(-1).renderSettings.radius, 4);
  assert.deepEqual(f.streams.at(-1), [f.game.player.position, 4]);
  assert.deepEqual([...f.bytes], before.bytes);
});

test("Game publishes only GPU-accepted distance, independently of effects, and saves only its own key", (t) => {
  const f = fixture(t);
  const modeBytes = f.bytes.get(RENDER_MODE_KEY);
  for (const radius of [2, 12, 6]) {
    assert.equal(f.game.setRenderDistance(radius), true);
    assert.equal(f.graphics.renderRadius, radius);
    assert.equal(f.game.renderDistance, radius);
    assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), String(radius));
    assert.equal(loadRenderDistance(), radius);
    assert.deepEqual(f.updates.at(-1), { renderSettings: {
      mode: "extended", distantTerrain: true, override: radius, radius, maxRadius: 12,
    } });
    assert.equal(f.bytes.get(RENDER_MODE_KEY), modeBytes);
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

test("default Nearby follows quality presets and publishes active distance without writing old preferences", (t) => {
  const f = fixture(t, { mode: null, quality: "medium", distanceBytes: " \n12 " });
  const before = [...f.bytes];
  assert.deepEqual(f.game.renderSettings, {
    mode: "nearby", distantTerrain: false, override: null, radius: 3, maxRadius: 4,
  });
  assert.equal(f.graphics.distant, null);
  for (const [quality, radius] of [["low", 2], ["high", 4], ["medium", 3]]) {
    assert.equal(f.game.setQuality(quality), true);
    assert.equal(f.game.quality, quality);
    assert.equal(f.graphics.renderRadius, radius);
    assert.equal(f.game.renderDistance, 12);
    assert.equal(f.game.renderModePreferences.nearbyRadius, null);
    assert.deepEqual(f.updates.at(-1), { quality, renderSettings: {
      mode: "nearby", distantTerrain: false, override: null, radius, maxRadius: 4,
    } });
    assert.deepEqual(f.streams.at(-1), [f.game.player.position, radius]);
  }
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.writes, []);
});

test("Nearby accepts only 2–4 and retains the exact extended bytes independently of quality", (t) => {
  const f = fixture(t, { mode: null, distanceBytes: " \n12 " });
  for (const radius of [2, 3, 4]) {
    assert.equal(f.game.setRenderDistance(radius), true);
    assert.equal(f.graphics.renderRadius, radius);
    assert.equal(f.graphics.distant, null);
    assert.equal(f.game.renderDistance, 12);
    assert.deepEqual(loadRenderModePreferences(), { version: 1, mode: "nearby", nearbyRadius: radius });
    assert.deepEqual(f.updates.at(-1), { renderSettings: {
      mode: "nearby", distantTerrain: false, override: radius, radius, maxRadius: 4,
    } });
    assert.deepEqual(f.streams.at(-1), [f.game.player.position, radius]);
    for (const quality of ["low", "high"]) {
      assert.equal(f.game.setQuality(quality), true);
      assert.equal(f.graphics.renderRadius, radius);
      assert.equal(f.updates.at(-1).renderSettings.radius, radius);
    }
  }
  const before = [...f.bytes], updates = [...f.updates], streams = [...f.streams];
  const setter = t.mock.method(f.graphics, "setRenderDistanceOverride");
  for (const radius of [null, undefined, NaN, Infinity, "3", {}, [], 0, 1, 5, 6, 12, 13, 2.5])
    assert.equal(f.game.setRenderDistance(radius), false);
  assert.equal(setter.mock.callCount(), 0, "invalid Nearby distances never reach graphics");
  assert.match(f.messages.at(-1), /from 2 to 4/);
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.updates, updates);
  assert.deepEqual(f.streams, streams);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), " \n12 ");
  assert.ok(f.writes.every(([key]) => key === RENDER_MODE_KEY));
});

test("mode switches restore both choices without changing controls, quality, fullbright or world owners", (t) => {
  const f = fixture(t, { mode: null, quality: "medium", distanceBytes: " 6\n" });
  const { world, player, controlPreferences, viewPreferences } = f.game;
  const materials = f.graphics.materials, atmosphere = f.graphics.atmosphere;
  const resize = t.mock.method(f.graphics, "resize");
  const quality = t.mock.method(f.graphics, "setQuality");
  assert.equal(f.game.setRenderDistance(2), true);
  assert.equal(f.game.setRenderMode("extended"), true);
  assert.equal(f.graphics.renderRadius, 6);
  assert.ok(f.graphics.distant);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), " 6\n");
  const modeBytes = f.bytes.get(RENDER_MODE_KEY);
  assert.equal(f.game.setRenderDistance(12), true);
  assert.equal(f.bytes.get(RENDER_MODE_KEY), modeBytes);
  for (const [mode, radius, maxRadius] of [["nearby", 2, 4], ["extended", 12, 12], ["nearby", 2, 4]]) {
    assert.equal(f.game.setRenderMode(mode), true);
    assert.equal(Boolean(f.graphics.distant), mode === "extended");
    assert.equal(f.graphics.renderRadius, radius);
    assert.deepEqual(f.updates.at(-1).renderSettings, {
      mode, distantTerrain: mode === "extended", override: radius, radius, maxRadius,
    });
    assert.deepEqual(f.streams.at(-1), [player.position, radius]);
    assert.equal(f.game.renderDistance, 12);
    assert.equal(f.game.renderModePreferences.nearbyRadius, 2);
  }
  assert.equal(f.game.quality, "medium");
  assert.equal(f.graphics.quality, "medium");
  assert.equal(f.graphics.fullbrightInspection, false);
  assert.equal(resize.mock.callCount(), 0);
  assert.equal(quality.mock.callCount(), 0);
  assert.equal(f.graphics.materials, materials);
  assert.equal(f.graphics.atmosphere, atmosphere);
  assert.equal(f.game.world, world);
  assert.equal(f.game.player, player);
  assert.equal(f.game.controlPreferences, controlPreferences);
  assert.equal(f.game.viewPreferences, viewPreferences);
});

test("unselected Nearby distance resumes quality presets after an Extended round trip", (t) => {
  const f = fixture(t, { mode: null, quality: "low" });
  assert.equal(f.game.setRenderMode("extended"), true);
  assert.equal(f.game.setQuality("high"), true);
  assert.equal(f.graphics.renderRadius, 6);
  assert.equal(f.game.setRenderMode("nearby"), true);
  assert.equal(f.graphics.renderDistanceOverride, null);
  assert.equal(f.graphics.renderRadius, 4);
  assert.equal(f.game.setQuality("medium"), true);
  assert.equal(f.graphics.renderRadius, 3);
  assert.equal(f.game.renderModePreferences.nearbyRadius, null);
  assert.equal(f.bytes.get(RENDER_DISTANCE_KEY), "6");
});

test("invalid and GPU-failed mode requests retain the accepted mode, preferences, owners and demand", (t) => {
  const f = fixture(t);
  const before = [...f.bytes], preferences = f.game.renderModePreferences, distant = f.graphics.distant;
  for (const mode of [null, undefined, "far", "Nearby", "", true, 1, {}, ["nearby"]])
    assert.equal(f.game.setRenderMode(mode), false);
  f.gpu.getParameter = () => 0;
  assert.equal(f.game.setRenderMode("extended"), false, "explicit radius still requires GPU capacity");
  f.gpu.isContextLost = () => true;
  assert.equal(f.game.setRenderMode("nearby"), false);
  assert.match(f.messages.at(-1), /unchanged.*live WebGL2/);
  f.graphics.renderer.getContext = () => null;
  assert.equal(f.game.setRenderMode("nearby"), false);
  assert.equal(f.game.setRenderMode("extended"), false);
  assert.equal(f.game.renderModePreferences, preferences);
  assert.equal(f.game.renderSettings.mode, "extended");
  assert.equal(f.graphics.renderRadius, 6);
  assert.equal(f.graphics.distant, distant);
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
  assert.deepEqual(f.writes, []);
});

test("Nearby GPU refusals never pin the default radius or remember a failed Extended mode", (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const before = [...f.bytes], preferences = f.game.renderModePreferences;
  f.gpu.getParameter = () => 0;
  assert.equal(f.game.setRenderDistance(4), false);
  assert.equal(f.game.setRenderMode("extended"), false);
  f.gpu.isContextLost = () => true;
  assert.equal(f.game.setRenderDistance(2), false);
  assert.equal(f.game.setRenderMode("nearby"), false);
  f.graphics.renderer.getContext = () => null;
  assert.equal(f.game.setRenderMode("nearby"), false);
  assert.equal(f.game.renderModePreferences, preferences);
  assert.equal(f.game.renderSettings.radius, 3);
  assert.equal(f.graphics.renderDistanceOverride, null);
  assert.equal(f.graphics.distant, null);
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
  assert.deepEqual(f.writes, []);
});

test("Nearby distance and mode changes obey initialization, failure and pre-await transition gates", async (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const before = [...f.bytes];
  const reject = () => {
    assert.equal(f.game.setRenderDistance(2), false);
    assert.equal(f.game.setRenderMode("extended"), false);
  };
  f.game.building = true;
  reject();
  f.game.building = false;
  f.game.failed = true;
  reject();
  f.game.failed = false;
  f.game.graphics = null;
  reject();
  f.game.graphics = f.graphics;
  await f.game.transitionGate.run(async () => {
    reject();
    await Promise.resolve();
    reject();
  });
  assert.equal(f.game.renderSettings.radius, 3);
  assert.equal(f.game.renderModePreferences.nearbyRadius, null);
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.game.setRenderMode("extended"), true);
});

test("blocked mode storage explicitly accepts session-only mode and Nearby distance choices", (t) => {
  const f = fixture(t);
  const before = [...f.bytes];
  f.storage.setItem = () => { throw new Error("blocked"); };
  assert.equal(f.game.setRenderMode("nearby"), true);
  assert.equal(f.graphics.renderRadius, 4);
  assert.match(f.messages.at(-1), /Render mode.*this session.*could not save/);
  assert.equal(f.updates.at(-1).renderSettings.mode, "nearby");
  assert.equal(f.game.setRenderDistance(2), true);
  assert.equal(f.graphics.renderRadius, 2);
  assert.match(f.messages.at(-1), /Render distance.*this session.*could not save/);
  assert.equal(f.game.setRenderMode("extended"), true);
  assert.equal(f.graphics.renderRadius, 6);
  assert.equal(f.game.setRenderMode("nearby"), true);
  assert.equal(f.graphics.renderRadius, 2);
  assert.equal(f.game.renderDistance, 6);
  assert.deepEqual(loadRenderModePreferences(), { version: 1, mode: "extended", nearbyRadius: null });
  assert.deepEqual([...f.bytes], before);
});

test("invalid or failed quality changes do not publish a requested Nearby radius", (t) => {
  const f = fixture(t, { mode: null, quality: "medium" });
  const before = [...f.bytes];
  for (const quality of [null, undefined, "", "ultra", "toString", {}, ["high"]])
    assert.equal(f.game.setQuality(quality), false);
  t.mock.method(f.graphics, "setQuality", () => { throw new Error("GPU unavailable"); });
  assert.equal(f.game.setQuality("high"), false);
  assert.equal(f.game.quality, "medium");
  assert.equal(f.graphics.renderRadius, 3);
  assert.match(f.messages.at(-1), /unchanged.*GPU unavailable/);
  assert.deepEqual([...f.bytes], before);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.streams, []);
});

test("HUD refresh publishes the active Nearby distance, not the remembered Extended value", (t) => {
  const f = fixture(t, { mode: null, quality: "medium", distanceBytes: "12" });
  const biome = { dimension: "overworld", category: "grassland" };
  f.game.world.getBiome = () => biome;
  f.game.world.streamingStatus = () => ({ loaded: 1, demand: 49 });
  Object.assign(f.game, {
    station: () => "hand",
    gameplay: {
      mode: "creative", hotbar: [],
      getState: () => ({ mode: "creative" }),
      getCraftableRecipes: () => [],
      getHandStack: () => null,
    },
    effects: { select() {}, selectOffhand() {} },
  });
  f.game.refreshHud();
  assert.equal(f.game.renderDistance, 12);
  assert.deepEqual(f.updates.at(-1).renderSettings, {
    mode: "nearby", distantTerrain: false, override: null, radius: 3, maxRadius: 4,
  });
  assert.equal(Object.hasOwn(f.updates.at(-1), "renderDistance"), false);
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
