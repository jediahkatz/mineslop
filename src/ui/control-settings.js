import {
  DEFAULT_CONTROL_PREFERENCES,
  MAX_MOUSE_SENSITIVITY,
  MIN_MOUSE_SENSITIVITY,
  MOUSE_SENSITIVITY_STEP,
  normalizeControlPreferences,
} from "../control-preferences.js";
import { setText } from "./dom.js";

export function createControlSettings(root, { listen, onChange }) {
  const $ = (selector) => root.querySelector(selector);
  const mode = $("#input-mode-setting");
  const sensitivity = $("#mouse-sensitivity-setting");
  let preferences = { ...DEFAULT_CONTROL_PREFERENCES };
  sensitivity.min = String(MIN_MOUSE_SENSITIVITY);
  sensitivity.max = String(MAX_MOUSE_SENSITIVITY);
  sensitivity.step = String(MOUSE_SENSITIVITY_STEP);
  mode.disabled = sensitivity.disabled = !onChange;

  function update(value) {
    preferences = normalizeControlPreferences({ ...preferences, ...value });
    const remote = preferences.inputMode === "remote";
    root.dataset.inputMode = preferences.inputMode;
    mode.value = preferences.inputMode;
    sensitivity.value = String(preferences.mouseSensitivity);
    setText(
      $("#mouse-sensitivity-value"),
      `${preferences.mouseSensitivity.toFixed(2)}×`
    );
    setText(
      $("#input-mode-help"),
      remote
        ? "Remote: RIGHT-DRAG to look; short RIGHT-CLICK to place/use. Hold V to eat, draw a bow or raise a shield. No mouse capture. Release and reposition at window edges. Aim with the center crosshair."
        : "Native: captured mouse look, preferred for local play. Right-click to place/use; hold it to eat, draw a bow or raise a shield. Esc pauses and releases the mouse."
    );
    setText($('[data-control="look"] kbd'), remote ? "RIGHT-DRAG" : "Mouse");
    setText($('[data-control="use"] kbd'), remote ? "RIGHT-CLICK" : "RMB");
    setText($(".hotbar-use-hint kbd"), remote ? "RIGHT-CLICK" : "RMB");
    $(".hotbar-look-hint").hidden = !remote;
    $(".hotbar-edge-hint").hidden = !remote;
    $(".remote-input-hints").hidden = !remote;
    $(".remote-held-use").hidden = !remote;
  }

  listen(mode, "change", () => {
    update({ inputMode: mode.value });
    onChange?.({ ...preferences });
  });
  listen(sensitivity, "input", () => {
    update({ mouseSensitivity: Number(sensitivity.value) });
    onChange?.({ ...preferences });
  });
  update(preferences);
  return { update };
}
