import { normalizeGuiScale, resolveGuiScale } from "../view-preferences.js";

export function createGuiSettings(root, { listen, onChange }) {
  const select = root.querySelector("#gui-scale-setting");
  const view = root.ownerDocument.defaultView;
  let preference = "auto";
  select.disabled = !onChange;

  function resize() {
    const scale = resolveGuiScale(
      preference,
      view?.innerWidth,
      view?.innerHeight
    );
    root.style.setProperty("--gui-scale", String(scale));
    root.dataset.guiScale = String(scale);
  }

  function update(value) {
    preference = normalizeGuiScale(value);
    select.value = String(preference);
    resize();
  }

  listen(select, "change", () => {
    const requested = normalizeGuiScale(select.value);
    select.value = String(preference);
    onChange?.(requested);
  });
  if (view) listen(view, "resize", resize);
  update("auto");
  return { update };
}
