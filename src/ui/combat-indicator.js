const phases = new Set(["ready", "cooldown", "using-item"]);
const refusals = new Set(["cooldown", "using-item"]);
const FILL_PIXELS = 14;
const labels = {
  ready: "Melee ready",
  cooldown: "Melee recharging",
  "using-item": "Cannot attack while using an item",
};

/**
 * Mount once in .game-hud, then update directly from CombatFeedback.view().
 * This path deliberately bypasses the inventory/hotbar/full HUD snapshot.
 * Import combat-indicator.css from the app's stylesheet, not this Node-testable
 * module. No listeners, timers, animation queues or per-frame DOM creation.
 */
export function createCombatIndicator(host) {
  const make = (className) => {
    const node = host.ownerDocument.createElement("span");
    node.className = className;
    return node;
  };
  const node = make("combat-indicator");
  const track = make("combat-indicator-track");
  const fill = make("combat-indicator-fill");
  const sword = make("combat-indicator-ready");
  node.setAttribute("role", "progressbar");
  node.setAttribute("aria-label", "Melee attack readiness");
  node.setAttribute("aria-valuemin", "0");
  node.setAttribute("aria-valuemax", "100");
  node.setAttribute("aria-live", "off");
  track.setAttribute("aria-hidden", "true");
  sword.setAttribute("aria-hidden", "true");
  track.append(fill);
  node.append(track, sword);
  host.append(node);
  let disposed = false;
  let lastPixels = -1;
  const attribute = (name, value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };

  function update({
    visible = false,
    progress = 0,
    phase = "cooldown",
    blockedReason = null,
  } = {}) {
    if (disposed) return;
    progress = Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0;
    if (!phases.has(phase) || (phase === "ready" && progress < 1))
      phase = "cooldown";
    if (!refusals.has(blockedReason)) blockedReason = null;
    if (node.hidden !== !visible) node.hidden = !visible;
    if (node.dataset.phase !== phase) node.dataset.phase = phase;
    if (node.dataset.blocked !== (blockedReason ?? ""))
      node.dataset.blocked = blockedReason ?? "";
    if (track.hidden !== (phase === "ready")) track.hidden = phase === "ready";
    if (sword.hidden !== (phase !== "ready")) sword.hidden = phase !== "ready";
    const pixels = Math.floor(progress * FILL_PIXELS);
    if (pixels !== lastPixels) {
      fill.style.transform = `scaleX(${pixels / FILL_PIXELS})`;
      lastPixels = pixels;
    }
    let label = labels[phase];
    if (blockedReason === "cooldown")
      label += ". Previous attack was too early";
    else if (blockedReason === "using-item")
      label += ". Previous attack was blocked by item use";
    attribute("aria-valuenow", String(Math.floor(progress * 100)));
    attribute("aria-valuetext", label);
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
