import { setText } from "./dom.js";

/**
 * One short level notice, not a toast per orb. ExperienceFeedback owns time;
 * snapshots only update the ordinary bar and cannot start this presentation.
 */
export function createExperienceFeedback(host, meter) {
  const node = host.ownerDocument.createElement("div");
  node.className = "experience-feedback";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  host.append(node);
  let disposed = false;
  let lastPulse = null;

  function update({ visible = false, pulse = 0, levelUp = false, level = 0, opacity = 0 } = {}) {
    if (disposed) return;
    const strength = visible && Number.isFinite(pulse)
      ? Math.round(Math.max(0, Math.min(1, pulse)) * 100) / 100
      : 0;
    if (lastPulse !== strength) {
      meter.style.setProperty("--xp-pulse", String(strength));
      lastPulse = strength;
    }
    const show = visible && levelUp && Number.isSafeInteger(level) && level > 0;
    meter.classList.toggle("is-level-up", show);
    node.hidden = !show;
    node.style.opacity = String(show && Number.isFinite(opacity)
      ? Math.max(0, Math.min(1, opacity)) : 0);
    setText(node, show ? `Level ${level}` : "");
  }

  update();
  return {
    node,
    update,
    dispose() {
      if (disposed) return;
      update();
      disposed = true;
      node.remove();
    },
  };
}
