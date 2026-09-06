import {
  DEFAULT_RENDER_RADIUS,
  MAX_RENDER_RADIUS,
  MIN_RENDER_RADIUS,
} from "../render-distance.js";
import { CHUNK_SIZE } from "../terrain.js";

export function createRenderDistanceSettings(root, { listen, onChange }) {
  const slider = root.querySelector("#render-distance-setting");
  const output = root.querySelector("#render-distance-value");
  let radius = DEFAULT_RENDER_RADIUS;
  slider.min = String(MIN_RENDER_RADIUS);
  slider.max = String(MAX_RENDER_RADIUS);
  slider.step = "1";
  slider.disabled = !onChange;

  const valid = (value) => Number.isInteger(value) &&
    value >= MIN_RENDER_RADIUS && value <= MAX_RENDER_RADIUS;

  function update(value) {
    if (valid(value)) radius = value;
    slider.value = String(radius);
    output.textContent = `${radius} chunks (${radius * CHUNK_SIZE} blocks)`;
  }

  listen(slider, "change", () => {
    const requested = Number(slider.value);
    // A renderer rejection must leave the last confirmed setting visible.
    // Only the host's subsequent update publishes an accepted preference.
    update(radius);
    if (valid(requested)) onChange?.(requested);
  });
  update(radius);
  return { update };
}
