import { NEARBY_RENDER_RADII } from "../render-distance.js";

export function createQualitySettings(root, { listen, onChange }) {
  const select = root.querySelector("#quality-setting");
  let quality = "medium";
  const valid = (value) => typeof value === "string" && Object.hasOwn(NEARBY_RENDER_RADII, value);
  select.disabled = !onChange;

  function update(value) {
    if (valid(value)) quality = value;
    select.value = quality;
  }

  listen(select, "change", () => {
    const requested = select.value;
    // Like distance/mode, only the host's snapshot confirms acceptance.
    update(quality);
    if (valid(requested)) onChange?.(requested);
  });
  update(quality);
  return { update };
}
