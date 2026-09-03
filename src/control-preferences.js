// Input is a browser/device preference, never part of a portable world save.
export const CONTROL_PREFERENCES_KEY = "voxelcraft-controls-v1";
export const MIN_MOUSE_SENSITIVITY = 0.25;
export const MAX_MOUSE_SENSITIVITY = 3;
export const MOUSE_SENSITIVITY_STEP = 0.05;
export const DEFAULT_CONTROL_PREFERENCES = Object.freeze({
  inputMode: "native",
  mouseSensitivity: 1,
});

export function normalizeControlPreferences(value) {
  return {
    inputMode: value?.inputMode === "remote" ? "remote" : "native",
    mouseSensitivity: Number.isFinite(value?.mouseSensitivity)
      ? Math.max(
          MIN_MOUSE_SENSITIVITY,
          Math.min(MAX_MOUSE_SENSITIVITY, value.mouseSensitivity)
        )
      : DEFAULT_CONTROL_PREFERENCES.mouseSensitivity,
  };
}

export function loadControlPreferences(storage) {
  try {
    const source = storage ?? globalThis.localStorage;
    return normalizeControlPreferences(
      JSON.parse(source?.getItem(CONTROL_PREFERENCES_KEY) ?? "null")
    );
  } catch {
    // Private/blocked storage and malformed preferences must not prevent play.
    return { ...DEFAULT_CONTROL_PREFERENCES };
  }
}

export function saveControlPreferences(value, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(
      CONTROL_PREFERENCES_KEY,
      JSON.stringify(normalizeControlPreferences(value))
    );
    return true;
  } catch {
    return false;
  }
}
