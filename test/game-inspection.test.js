import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";
import {
  DEFAULT_VIEW_PREFERENCES,
  loadViewPreferences,
  VIEW_PREFERENCES_KEY,
} from "../src/view-preferences.js";

function fixture(t, { blocked = false, renderer = true } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (blocked) throw new Error("Blocked");
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const snapshots = [];
  const messages = [];
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    viewPreferences: { ...DEFAULT_VIEW_PREFERENCES },
    controlPreferences: Object.freeze({
      inputMode: "remote",
      mouseSensitivity: 1.5,
    }),
    world: Object.freeze({ seed: "untouched", dimension: "overworld" }),
    player: Object.freeze({
      position: Object.freeze({ x: 51.5, y: 22, z: 985.5 }),
    }),
    gameplay: Object.freeze({ mode: "creative", inventory: Object.freeze([]) }),
    currentTime: 0.21,
    elapsed: 42,
    quality: "low",
    paused: false,
    overlayOpen: false,
    graphics: renderer
      ? {
          fullbrightInspection: false,
          setFullbrightInspection(enabled) {
            this.fullbrightInspection = enabled;
          },
        }
      : undefined,
    ui: {
      update: (snapshot) => snapshots.push(snapshot),
      toast: (message) => messages.push(message),
    },
    scheduleSave: () => assert.fail("inspection must not write a world save"),
    pause: () => assert.fail("inspection must not pause the simulation"),
  });
  return { game, storage, values, snapshots, messages };
}

test("Fullbright and GUI scale persist only browser preferences and preserve each other", (t) => {
  const { game, storage, values, snapshots, messages } = fixture(t);
  const original = {
    world: game.world,
    player: game.player,
    gameplay: game.gameplay,
    controls: game.controlPreferences,
  };
  assert.deepEqual(game.setFullbrightInspection(true), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.equal(game.graphics.fullbrightInspection, true);
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: true });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual([...values.keys()], [VIEW_PREFERENCES_KEY]);
  game.setFullbrightInspection(false);
  assert.equal(game.graphics.fullbrightInspection, false);
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: false });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(game.setGuiScale(3), {
    fullbrightInspection: false,
    guiScale: 3,
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { guiScale: 3 });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: 3,
    showFps: false,
  });
  for (const enabled of [true, false]) {
    assert.deepEqual(game.setFullbrightInspection(enabled), {
      fullbrightInspection: enabled,
      guiScale: 3,
      showFps: false,
    });
    assert.equal(game.graphics.fullbrightInspection, enabled);
    assert.deepEqual(snapshots.at(-1), { fullbrightInspection: enabled });
    assert.deepEqual(loadViewPreferences(storage), {
      fullbrightInspection: enabled,
      guiScale: 3,
      showFps: false,
    });
  }
  assert.deepEqual(game.setGuiScale("auto"), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { guiScale: "auto" });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual([...values.keys()], [VIEW_PREFERENCES_KEY]);
  assert.equal(game.currentTime, 0.21);
  assert.equal(game.elapsed, 42);
  assert.equal(game.paused, false);
  assert.equal(game.quality, "low");
  assert.equal(game.world, original.world);
  assert.equal(game.player, original.player);
  assert.equal(game.gameplay, original.gameplay);
  assert.equal(game.controlPreferences, original.controls);
  assert.deepEqual(messages, []);
});

test("blocked storage leaves inspection usable and reports session-only persistence", (t) => {
  const { game, snapshots, messages, values } = fixture(t, { blocked: true });
  game.setFullbrightInspection(true);
  assert.equal(game.graphics.fullbrightInspection, true);
  assert.deepEqual(game.viewPreferences, {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: true });
  assert.equal(values.size, 0);
  assert.match(messages[0], /this session.*could not be saved/);
  assert.deepEqual(game.setGuiScale(2), {
    fullbrightInspection: true,
    guiScale: 2,
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { guiScale: 2 });
  assert.equal(game.graphics.fullbrightInspection, true);
  game.setFullbrightInspection(false);
  assert.equal(game.graphics.fullbrightInspection, false);
  assert.deepEqual(game.viewPreferences, {
    fullbrightInspection: false,
    guiScale: 2,
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: false });
  assert.equal(values.size, 0);
  assert.equal(messages.length, 3);
  for (const message of messages)
    assert.match(message, /this session.*could not be saved/);
});

test("preferences can be chosen before renderer creation and never coerce truthy inputs", (t) => {
  const { game, storage, snapshots } = fixture(t, { renderer: false });
  game.setFullbrightInspection(true);
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: true });
  assert.deepEqual(game.setGuiScale("3"), {
    fullbrightInspection: true,
    guiScale: 3,
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { guiScale: 3 });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: 3,
    showFps: false,
  });
  game.setFullbrightInspection("true");
  assert.deepEqual(game.viewPreferences, {
    fullbrightInspection: false,
    guiScale: 3,
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { fullbrightInspection: false });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: 3,
    showFps: false,
  });
  assert.deepEqual(game.setGuiScale("invalid"), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(snapshots.at(-1), { guiScale: "auto" });
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
});

test("FPS display uses the existing sample and only persists its browser preference", (t) => {
  const { game, storage, snapshots, messages } = fixture(t);
  game.fps = 47.25;
  const world = game.world,
    player = game.player,
    gameplay = game.gameplay;
  game.setFullbrightInspection(true);
  game.setGuiScale(2);
  assert.deepEqual(game.setShowFps(true), {
    fullbrightInspection: true,
    guiScale: 2,
    showFps: true,
  });
  assert.deepEqual(snapshots.at(-1), { showFps: true, fps: 47.25 });
  assert.equal(loadViewPreferences(storage).showFps, true);
  game.setGuiScale(3);
  game.setFullbrightInspection(false);
  assert.equal(game.viewPreferences.showFps, true);
  game.setShowFps("true");
  assert.equal(game.viewPreferences.showFps, false);
  assert.equal(loadViewPreferences(storage).showFps, false);
  assert.equal(game.world, world);
  assert.equal(game.player, player);
  assert.equal(game.gameplay, gameplay);
  assert.equal(game.currentTime, 0.21);
  assert.equal(game.elapsed, 42);
  assert.equal(game.paused, false);
  assert.equal(game.quality, "low");
  assert.deepEqual(messages, []);
});

test("blocked storage still permits session-only FPS display", (t) => {
  const { game, snapshots, messages, values } = fixture(t, { blocked: true });
  game.fps = null;
  game.setShowFps(true);
  assert.equal(game.viewPreferences.showFps, true);
  assert.deepEqual(snapshots.at(-1), { showFps: true, fps: null });
  assert.equal(values.size, 0);
  assert.match(messages[0], /FPS display.*this session.*could not be saved/);
});
