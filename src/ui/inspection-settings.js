export function createInspectionSettings(root, { listen, onChange }) {
  const toggle = root.querySelector("#fullbright-inspection-setting");
  const badge = root.querySelector("#fullbright-inspection-badge");
  let enabled = false;
  toggle.disabled = !onChange;

  function update(value) {
    enabled = value === true;
    toggle.checked = enabled;
    badge.hidden = !enabled;
  }

  listen(toggle, "change", () => {
    const requested = toggle.checked;
    // The game confirms the renderer's value with update(). Failed or rejected
    // requests must not leave an optimistic, misleading switch behind.
    toggle.checked = enabled;
    onChange?.(requested);
  });
  update(false);
  return { update };
}
