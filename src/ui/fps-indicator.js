/** A single passive HUD node. Disabled samples never write to the DOM. */
export function createFpsIndicator(host) {
  const node = host.ownerDocument.createElement("div");
  node.className = "compact-fps";
  node.setAttribute("aria-live", "off");
  node.setAttribute("aria-label", "Frames per second");
  node.hidden = true;
  host.append(node);
  let enabled = false;
  let fps = null;
  let text = "";
  let disposed = false;

  function render() {
    if (disposed || !enabled) return;
    const next = fps === null ? "— FPS" : `${fps} FPS`;
    if (next !== text) {
      node.textContent = next;
      text = next;
    }
  }

  return {
    node,
    setEnabled(value) {
      if (disposed) return;
      const next = value === true;
      if (next !== enabled) {
        enabled = next;
        node.hidden = !enabled;
      }
      render();
    },
    update(value) {
      if (disposed) return;
      fps = Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      node.remove();
    },
  };
}
