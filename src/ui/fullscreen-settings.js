import { setText } from "./dom.js";

export function createFullscreenSettings(root, { listen, onToggle }) {
  const buttons = [...root.querySelectorAll("[data-fullscreen-toggle]")];
  const statuses = [...root.querySelectorAll("[data-fullscreen-state]")];
  let fullscreen = false;
  let keyboardCaptured = false;
  let busy = false;
  let disposed = false;

  function render() {
    root.dataset.fullscreen = String(fullscreen);
    root.dataset.keyboardCaptured = String(keyboardCaptured);
    for (const button of buttons) {
      button.disabled = !onToggle || busy;
      button.setAttribute("aria-pressed", String(fullscreen));
      button.setAttribute("aria-busy", String(busy));
      setText(
        button,
        `Fullscreen: ${fullscreen ? "ON" : "OFF"}${busy ? "..." : ""}`
      );
    }
    const state = keyboardCaptured
      ? "captured"
      : fullscreen
        ? "uncaptured"
        : "windowed";
    const message = keyboardCaptured
      ? "Game fullscreen on · Game shortcut capture on"
      : fullscreen
        ? "Game fullscreen on · Shortcuts not captured — double-tap W to sprint"
        : "Game fullscreen off · Shortcuts not captured";
    for (const status of statuses) {
      status.dataset.state = state;
      setText(status, message);
    }
  }

  async function toggle() {
    if (disposed || busy || !onToggle) return;
    busy = true;
    render();
    try {
      // Invoke immediately inside the click gesture: fullscreen needs activation.
      // Neither a request nor its result can replace the parent's actual snapshot.
      await onToggle();
    } catch {
      // The parent reports failures through its toast. Keep confirmed state.
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  for (const button of buttons) listen(button, "click", () => void toggle());
  render();

  return {
    update(next = {}) {
      if (disposed) return;
      if (next.fullscreen !== undefined) {
        const previous = fullscreen;
        fullscreen = next.fullscreen === true;
        if (!fullscreen || !previous) keyboardCaptured = false;
      }
      if (next.keyboardCaptured !== undefined)
        keyboardCaptured = fullscreen && next.keyboardCaptured === true;
      render();
    },
    dispose() {
      disposed = true;
    },
  };
}
