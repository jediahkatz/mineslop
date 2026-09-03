import { stackIdentity } from "../item-stack-data.js";
import { createCombatIndicator } from "./combat-indicator.js";
import { element, setText } from "./dom.js";
import { createFpsIndicator } from "./fps-indicator.js";
import { createHotbar } from "./hotbar.js";
import { createHurtIndicator } from "./hurt-indicator.js";
import { clamp, dimensionName } from "./model.js";
import { pixelIcon } from "./pixel-icons.js";
import { hotbarSlotView, stackDisplayName } from "./slot-model.js";
import { createStackSlot } from "./slots.js";

export function createHUD(root, { listen, onSelect }) {
  const $ = (selector) => root.querySelector(selector);
  const combat = createCombatIndicator($(".game-hud"));
  const hurt = createHurtIndicator($(".game-hud"));
  const compactFps = createFpsIndicator($(".game-hud"));
  const debugFps = $(".fps-indicator");
  const hotbar = createHotbar($(".hotbar"), { listen, onSelect });
  const offhand = createStackSlot({
    tag: "div",
    className: "offhand-slot",
    label: "Offhand",
  });
  $(".hud-offhand").append(offhand.node);
  const vitalNodes = {};
  for (const [name, icon] of [
    ["health", "heart"],
    ["hunger", "hunger"],
    ["armor", "armor"],
    ["air", "air"],
  ]) {
    const container = $(`[data-vital="${name}"]`);
    vitalNodes[name] = Array.from({ length: 10 }, () => {
      const pip = element("span", "vital-pip");
      pip.innerHTML = `<span class="vital-empty">${pixelIcon(icon)}</span><span class="vital-fill">${pixelIcon(icon)}</span>`;
      container.append(pip);
      return pip;
    });
  }
  let selectedSignature = "";
  let selectedTimer;

  function updateGameplay(state, hasSnapshot) {
    hotbar.update(state);
    const selected = hotbarSlotView(state, state.selected).stack;
    const signature = `${state.selected}:${selected ? stackIdentity(selected) : ""}`;
    if (signature !== selectedSignature) {
      selectedSignature = signature;
      clearTimeout(selectedTimer);
      const name = $(".selected-block-name");
      setText(name, selected ? stackDisplayName(selected) : "");
      name.classList.toggle("is-visible", Boolean(selected));
      if (selected) {
        selectedTimer = setTimeout(
          () => name.classList.remove("is-visible"),
          1600
        );
        selectedTimer.unref?.();
      }
    }
    offhand.update(state.offhand);
    $(".hud-offhand").hidden = !state.offhand;
    const creative = state.mode === "creative";
    $(".survival-vitals").hidden = creative || !hasSnapshot;
    $(".experience-meter").hidden =
      creative || !hasSnapshot || !state.experience;
    if (state.experience) {
      const progress = clamp(state.experience.progress);
      const level = Math.max(
        0,
        Math.floor(Number(state.experience.level) || 0)
      );
      $(".experience-fill").style.transform = `scaleX(${progress})`;
      $(".experience-track").setAttribute(
        "aria-valuenow",
        String(Math.round(progress * 100))
      );
      $(".experience-track").setAttribute(
        "aria-label",
        `Experience level ${level}`
      );
      setText($(".experience-level"), level || "");
    }
    if (creative || !hasSnapshot) return;
    for (const name of ["health", "hunger", "armor", "air"]) {
      const value = clamp(
        name === "armor" ? state.armorPoints : state[name],
        0,
        20
      );
      vitalNodes[name].forEach((pip, index) => {
        pip.style.setProperty(
          "--vital-fill",
          `${clamp((value - index * 2) / 2) * 100}%`
        );
      });
      const meter = $(`[data-vital="${name}"]`).parentElement;
      meter.setAttribute(
        "aria-label",
        `${name[0].toUpperCase() + name.slice(1)}: ${Math.ceil(value)} of 20`
      );
      meter.classList.toggle("is-low", value <= 6);
      if (name === "air") meter.hidden = value >= 20 && !state.underwater;
      if (name === "armor") meter.hidden = value <= 0;
    }
  }

  return {
    updateGameplay,
    updateCombat: combat.update,
    updateHurt: hurt.update,
    setShowFps: compactFps.setEnabled,
    update({
      fps,
      position,
      biome,
      dimension,
      chunkCount,
      targetName,
      blockName,
      miningProgress,
      spawnGrace,
    } = {}) {
      if (spawnGrace !== undefined) {
        const seconds = Number.isFinite(spawnGrace)
          ? Math.max(0, Math.ceil(spawnGrace))
          : 0;
        $(".spawn-grace").hidden = seconds === 0;
        setText(
          $(".spawn-grace"),
          seconds ? `Mob grace: ${seconds}s (ends on attack)` : ""
        );
      }
      if (fps !== undefined) {
        setText(
          debugFps,
          Number.isFinite(fps) && fps >= 0 ? `${Math.round(fps)} fps` : "— fps"
        );
        compactFps.update(fps);
      }
      if (position)
        ["x", "y", "z"].forEach((axis, index) => {
          const value = Number(position[axis] ?? position[index] ?? 0);
          setText($(`[data-coordinate="${axis}"]`), Math.floor(value));
        });
      if (biome !== undefined)
        setText(
          $("[data-biome-name]"),
          typeof biome === "string" ? biome : biome?.name || "Unknown"
        );
      if (dimension !== undefined)
        setText($(".hud-dimension"), dimensionName(dimension));
      if (chunkCount !== undefined)
        setText(
          $(".chunk-count"),
          `${Math.max(0, Math.floor(chunkCount))} loaded chunks`
        );
      if (targetName !== undefined || blockName !== undefined) {
        const name = targetName || blockName || "";
        setText($(".target-label"), name ? `Targeted block: ${name}` : "");
        $(".target-label").hidden = !name;
      }
      if (miningProgress !== undefined) {
        const progress = clamp(miningProgress);
        // Visible feedback lives on the targeted block's crack texture.
        $(".mining-progress").hidden = progress <= 0 || progress >= 1;
        $(".mining-progress").setAttribute(
          "aria-valuenow",
          String(Math.round(progress * 100))
        );
      }
    },
    dispose() {
      clearTimeout(selectedTimer);
      combat.dispose();
      hurt.dispose();
      compactFps.dispose();
    },
  };
}
