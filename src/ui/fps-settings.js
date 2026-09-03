export function createFpsSettings(root, { listen, onChange }) {
  const toggle = root.querySelector("#show-fps-setting");
  let enabled = false;
  toggle.disabled = !onChange;

  function update(value) {
    enabled = value === true;
    if (toggle.checked !== enabled) toggle.checked = enabled;
  }

  listen(toggle, "change", () => {
    const requested = toggle.checked;
    toggle.checked = enabled;
    onChange?.(requested);
  });
  update(false);
  return { update };
}
