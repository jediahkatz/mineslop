import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_PREFERENCES_KEY } from "../src/control-preferences.js";
import {
  DEFAULT_VIEW_PREFERENCES,
  loadViewPreferences,
  normalizeGuiScale,
  normalizeViewPreferences,
  resolveGuiScale,
  saveViewPreferences,
  VIEW_PREFERENCES_KEY,
} from "../src/view-preferences.js";

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

test("a fresh browser keeps natural lighting without writing a preference", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: false,
    guiScale: "auto",
    showFps: false,
  });
  assert.equal(storage.entries.size, 0);
});

test("only an explicit boolean enables inspection; unrelated fields are discarded", () => {
  for (const value of [undefined, null, "true", "false", 1, 0, [], {}, NaN]) {
    assert.deepEqual(
      normalizeViewPreferences({ fullbrightInspection: value, time: 0.5 }),
      { fullbrightInspection: false, guiScale: "auto", showFps: false }
    );
  }
  assert.deepEqual(
    normalizeViewPreferences({ fullbrightInspection: true, world: {} }),
    { fullbrightInspection: true, guiScale: "auto", showFps: false }
  );
  for (const value of [undefined, null, true, false, "true", [], 5])
    assert.deepEqual(normalizeViewPreferences(value), DEFAULT_VIEW_PREFERENCES);
});

test("inspection roundtrips independently of world saves and mouse controls", () => {
  const storage = memoryStorage();
  storage.setItem("voxelcraft-world-v1", '{"seed":"keep-me"}');
  storage.setItem(CONTROL_PREFERENCES_KEY, '{"inputMode":"remote"}');
  assert.equal(
    saveViewPreferences(
      {
        fullbrightInspection: true,
        quality: "low",
        world: { seed: "ignored" },
      },
      storage
    ),
    true
  );
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.deepEqual(JSON.parse(storage.getItem(VIEW_PREFERENCES_KEY)), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.equal(storage.getItem("voxelcraft-world-v1"), '{"seed":"keep-me"}');
  assert.equal(
    storage.getItem(CONTROL_PREFERENCES_KEY),
    '{"inputMode":"remote"}'
  );
  assert.equal(
    saveViewPreferences({ fullbrightInspection: false }, storage),
    true
  );
  assert.deepEqual(loadViewPreferences(storage), DEFAULT_VIEW_PREFERENCES);
});

test("existing Fullbright-only records gain GUI Auto without rewriting the old key", () => {
  const storage = memoryStorage();
  storage.setItem(VIEW_PREFERENCES_KEY, '{"fullbrightInspection":true}');
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: "auto",
    showFps: false,
  });
  assert.equal(
    storage.getItem(VIEW_PREFERENCES_KEY),
    '{"fullbrightInspection":true}'
  );
  const preferences = { ...loadViewPreferences(storage), guiScale: 3 };
  assert.equal(saveViewPreferences(preferences, storage), true);
  assert.deepEqual(loadViewPreferences(storage), preferences);
});

test("GUI scale is normalized independently and clamps to the available logical viewport", () => {
  assert.equal(normalizeGuiScale("3"), 3);
  for (const value of [false, true, null, -1, 0, 5, 2.5, "large", {}, []])
    assert.equal(normalizeGuiScale(value), "auto");
  assert.equal(resolveGuiScale("auto", 1280, 720), 3);
  assert.equal(resolveGuiScale(4, 1280, 720), 3);
  assert.equal(resolveGuiScale(2, 1920, 1080), 2);
  assert.equal(resolveGuiScale(4, 640, 480), 2);
  assert.equal(resolveGuiScale("auto", 250, 180), 1);
  assert.equal(resolveGuiScale("auto", undefined, undefined), 1);
  const preference = { fullbrightInspection: true, guiScale: 4 };
  resolveGuiScale(preference.guiScale, 640, 480);
  assert.equal(
    preference.guiScale,
    4,
    "resizing does not change the saved request"
  );
});

test("GUI preferences cannot leak world fields or disable an existing inspection setting", () => {
  const storage = memoryStorage();
  saveViewPreferences({ fullbrightInspection: true, guiScale: 2 }, storage);
  saveViewPreferences(
    {
      ...loadViewPreferences(storage),
      guiScale: 1,
      time: 0.8,
      seed: "not-a-view-preference",
    },
    storage
  );
  assert.deepEqual(loadViewPreferences(storage), {
    fullbrightInspection: true,
    guiScale: 1,
    showFps: false,
  });
  assert.deepEqual(JSON.parse(storage.getItem(VIEW_PREFERENCES_KEY)), {
    fullbrightInspection: true,
    guiScale: 1,
    showFps: false,
  });
});

test("FPS display is opt-in, migrates old view records and persists without replacing other settings", () => {
  const storage = memoryStorage();
  const old = '{"fullbrightInspection":true,"guiScale":3}';
  storage.setItem(VIEW_PREFERENCES_KEY, old);
  const previous = loadViewPreferences(storage);
  assert.equal(previous.showFps, false);
  assert.equal(storage.getItem(VIEW_PREFERENCES_KEY), old);
  for (const showFps of [undefined, null, "true", "false", 1, 0, {}, []])
    assert.equal(normalizeViewPreferences({ showFps }).showFps, false);
  const enabled = { ...previous, showFps: true };
  assert.equal(saveViewPreferences(enabled, storage), true);
  assert.deepEqual(loadViewPreferences(storage), enabled);
  assert.equal(
    saveViewPreferences({ ...enabled, showFps: false }, storage),
    true
  );
  assert.deepEqual(loadViewPreferences(storage), previous);
});

test("malformed or inaccessible storage falls back without removing user data", (t) => {
  const storage = memoryStorage();
  for (const value of ["broken json", "null", "true", "[]", '"true"']) {
    storage.setItem(VIEW_PREFERENCES_KEY, value);
    assert.deepEqual(loadViewPreferences(storage), DEFAULT_VIEW_PREFERENCES);
    assert.equal(storage.getItem(VIEW_PREFERENCES_KEY), value);
  }
  const blocked = {
    getItem() {
      throw new Error("Storage is blocked");
    },
    setItem() {
      throw new Error("Storage is full");
    },
  };
  assert.deepEqual(loadViewPreferences(blocked), DEFAULT_VIEW_PREFERENCES);
  assert.equal(
    saveViewPreferences({ fullbrightInspection: true }, blocked),
    false
  );

  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  assert.deepEqual(loadViewPreferences(), DEFAULT_VIEW_PREFERENCES);
  assert.equal(saveViewPreferences({ fullbrightInspection: true }), false);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: undefined,
  });
  assert.deepEqual(loadViewPreferences(), DEFAULT_VIEW_PREFERENCES);
  assert.equal(saveViewPreferences({ fullbrightInspection: true }), false);
});
