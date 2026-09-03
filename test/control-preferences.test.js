import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_PREFERENCES_KEY,
  DEFAULT_CONTROL_PREFERENCES,
  loadControlPreferences,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  normalizeControlPreferences,
  saveControlPreferences,
} from "../src/control-preferences.js";

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

test("fresh browser preferences choose native capture at the original sensitivity", () => {
  // Regression: existing headless/native clients must not silently switch input.
  const storage = memoryStorage();
  assert.deepEqual(loadControlPreferences(storage), {
    inputMode: "native",
    mouseSensitivity: 1,
  });
  assert.equal(storage.entries.size, 0, "reading does not create a preference");
});

test("preferences roundtrip in a separate browser key, without world data", () => {
  const storage = memoryStorage();
  storage.setItem("voxelcraft-world-v1", '{"seed":"keep-me"}');
  const preferences = { inputMode: "remote", mouseSensitivity: 1.75 };
  assert.equal(
    saveControlPreferences(
      { ...preferences, world: { seed: "ignore-me" } },
      storage
    ),
    true
  );
  assert.deepEqual(loadControlPreferences(storage), preferences);
  assert.deepEqual(
    JSON.parse(storage.getItem(CONTROL_PREFERENCES_KEY)),
    preferences
  );
  assert.equal(storage.getItem("voxelcraft-world-v1"), '{"seed":"keep-me"}');
  assert.deepEqual(
    loadControlPreferences(memoryStorage()),
    DEFAULT_CONTROL_PREFERENCES
  );
});

test("malformed and blocked local storage are recoverable without deleting it", (t) => {
  const storage = memoryStorage();
  for (const value of ["broken json", "null", "[]", "3", '"remote"']) {
    storage.setItem(CONTROL_PREFERENCES_KEY, value);
    assert.deepEqual(
      loadControlPreferences(storage),
      DEFAULT_CONTROL_PREFERENCES
    );
    assert.equal(storage.getItem(CONTROL_PREFERENCES_KEY), value);
  }
  const blocked = {
    getItem() {
      throw new Error("Blocked");
    },
    setItem() {
      throw new Error("Full");
    },
  };
  assert.deepEqual(
    loadControlPreferences(blocked),
    DEFAULT_CONTROL_PREFERENCES
  );
  assert.equal(saveControlPreferences({}, blocked), false);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  assert.deepEqual(loadControlPreferences(), DEFAULT_CONTROL_PREFERENCES);
  assert.equal(saveControlPreferences({ inputMode: "remote" }), false);
});

test("untrusted preference values are normalized and sensitivity is bounded", () => {
  assert.deepEqual(
    normalizeControlPreferences({
      inputMode: "automatic",
      mouseSensitivity: -2,
    }),
    { inputMode: "native", mouseSensitivity: MIN_MOUSE_SENSITIVITY }
  );
  assert.equal(
    normalizeControlPreferences({ mouseSensitivity: 999 }).mouseSensitivity,
    MAX_MOUSE_SENSITIVITY
  );
  for (const invalid of [NaN, Infinity, -Infinity, "2", null, true]) {
    assert.equal(
      normalizeControlPreferences({ mouseSensitivity: invalid })
        .mouseSensitivity,
      DEFAULT_CONTROL_PREFERENCES.mouseSensitivity
    );
  }
});
