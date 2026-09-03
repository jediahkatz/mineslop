import { HURT_MAX_FLASH } from "../hurt-feedback.js";

/**
 * One decorative, non-interactive screen-edge flash. Mount in .game-hud once.
 * HurtFeedback owns time; this has no CSS animation, timer or live-region spam.
 * Import hurt-indicator.css from the app stylesheet, not this testable module.
 */
export function createHurtIndicator(host) {
  const node = host.ownerDocument.createElement("div");
  node.className = "hurt-indicator";
  node.setAttribute("aria-hidden", "true");
  host.append(node);
  let disposed = false;
  let lastOpacity = null;

  function update({ visible = false, flash = 0 } = {}) {
    if (disposed) return;
    const opacity =
      visible && Number.isFinite(flash)
        ? Math.round(Math.max(0, Math.min(HURT_MAX_FLASH, flash)) * 1000) / 1000
        : 0;
    if (node.hidden !== (opacity === 0)) node.hidden = opacity === 0;
    if (opacity !== lastOpacity) {
      node.style.opacity = String(opacity);
      lastOpacity = opacity;
    }
  }

  update();
  return {
    node,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      node.remove();
    },
  };
}
