// View settings belong to this browser, never to a portable world. Keep the
// existing key: older records gain missing display defaults without a rewrite.
export const VIEW_PREFERENCES_KEY = "voxelcraft-view-v1";
export const DEFAULT_VIEW_PREFERENCES = Object.freeze({
  fullbrightInspection: false,
  guiScale: "auto",
  showFps: false,
});

export function normalizeGuiScale(value) {
  if (value === "auto") return "auto";
  const scale = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(scale) && scale >= 1 && scale <= 4 ? scale : "auto";
}

// Like Java's GUI scale, a requested size is capped to keep a 320x240 logical
// viewport usable. The preference itself is retained when the window shrinks.
export function resolveGuiScale(value, width, height) {
  const available = Math.max(
    1,
    Math.min(
      4,
      Math.floor(Number(width) / 320),
      Math.floor(Number(height) / 240)
    )
  );
  const maximum = Number.isFinite(available) ? available : 1;
  const requested = normalizeGuiScale(value);
  return requested === "auto" ? maximum : Math.min(requested, maximum);
}

export function normalizeViewPreferences(value) {
  return {
    fullbrightInspection: value?.fullbrightInspection === true,
    guiScale: normalizeGuiScale(value?.guiScale),
    showFps: value?.showFps === true,
  };
}

export function loadViewPreferences(storage) {
  try {
    const source = storage ?? globalThis.localStorage;
    return normalizeViewPreferences(
      JSON.parse(source?.getItem(VIEW_PREFERENCES_KEY) ?? "null")
    );
  } catch {
    return { ...DEFAULT_VIEW_PREFERENCES };
  }
}

export function saveViewPreferences(value, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(
      VIEW_PREFERENCES_KEY,
      JSON.stringify(normalizeViewPreferences(value))
    );
    return true;
  } catch {
    return false;
  }
}
