import {
  DEFAULT_RENDER_RADIUS,
  MAX_NEARBY_RENDER_RADIUS,
  MAX_RENDER_RADIUS,
  MIN_RENDER_RADIUS,
} from "../render-distance.js";
import { DEFAULT_RENDER_MODE, isRenderMode, resolveRenderMode } from "../render-mode-preferences.js";
import { CHUNK_SIZE } from "../terrain.js";

export function createRenderDistanceSettings(root, { listen, onChange, onModeChange }) {
  const slider = root.querySelector("#render-distance-setting");
  const output = root.querySelector("#render-distance-value");
  const modeControl = root.querySelector("#render-mode-setting");
  // Standalone distance-only hosts retain the original 2–12 contract.
  const initial = modeControl ? resolveRenderMode(DEFAULT_RENDER_MODE, DEFAULT_RENDER_RADIUS) : null;
  let mode = initial?.mode;
  let radius = initial?.radius ?? DEFAULT_RENDER_RADIUS;
  let maxRadius = initial?.maxRadius ?? MAX_RENDER_RADIUS;
  slider.min = String(MIN_RENDER_RADIUS);
  slider.step = "1";
  slider.disabled = !onChange;
  if (modeControl) modeControl.disabled = !onModeChange;

  const valid = (value, max = maxRadius) => Number.isInteger(value) &&
    value >= MIN_RENDER_RADIUS && value <= max;

  function render() {
    slider.max = String(maxRadius);
    slider.value = String(radius);
    output.textContent = `${radius} chunks (${radius * CHUNK_SIZE} blocks)`;
    if (modeControl) modeControl.value = mode;
  }

  function update(value) {
    if (value && typeof value === "object") {
      const max = value.mode === "nearby" ? MAX_NEARBY_RENDER_RADIUS : MAX_RENDER_RADIUS;
      // A complete host snapshot changes the mode, bounds and value together.
      if (isRenderMode(value.mode) && value.maxRadius === max && valid(value.radius, max)) {
        mode = value.mode;
        radius = value.radius;
        maxRadius = max;
      }
    } else if (valid(value)) radius = value;
    render();
  }

  listen(slider, "change", () => {
    const requested = Number(slider.value);
    // A renderer rejection must leave the last confirmed setting visible.
    // Only the host's subsequent update publishes an accepted preference.
    render();
    if (valid(requested)) onChange?.(requested);
  });
  if (modeControl) listen(modeControl, "change", () => {
    const requested = modeControl.value;
    render();
    if (isRenderMode(requested)) onModeChange?.(requested);
  });
  render();
  return { update };
}
