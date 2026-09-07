import { experienceProgress } from "../experience-feedback.js";
import { isValidExperience } from "../experience.js";
import { parseStructureIdentity } from "../canonical-structure-identity.js";
import { normalizeStack } from "../inventory-slots.js";
import { stackIdentity } from "../item-stack-data.js";
import { ITEM } from "../items.js";
import { WORLD_MAX, WORLD_MIN } from "../terrain.js";
import { createCombatIndicator } from "./combat-indicator.js";
import { element, setText } from "./dom.js";
import { createExperienceFeedback } from "./experience-feedback.js";
import { createFpsIndicator } from "./fps-indicator.js";
import { createHotbar } from "./hotbar.js";
import { createHurtIndicator } from "./hurt-indicator.js";
import { clamp, dimensionName } from "./model.js";
import { pixelIcon } from "./pixel-icons.js";
import { hotbarSlotView, stackDisplayName } from "./slot-model.js";
import { createStackSlot } from "./slots.js";

function mapGuidanceDetails(stack, position) {
  let normalized;
  try {
    if (
      !stack ||
      typeof stack !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(stack)) ||
      !["id", "count", "data"].every((key) => {
        const field = Object.getOwnPropertyDescriptor(stack, key);
        return field && field.enumerable && Object.hasOwn(field, "value");
      }) ||
      Reflect.ownKeys(stack).some(
        (key) => typeof key !== "string" || !["id", "count", "data"].includes(key)
      ) ||
      stack.id !== ITEM.TREASURE_MAP
    )
      return null;
    normalized = normalizeStack(stack);
  } catch {
    return null;
  }
  const target = normalized.data?.mapTarget;
  if (
    !target ||
    !position ||
    !parseStructureIdentity(
      target.structureId,
      target.seed,
      target.generatorVersion,
      target.dimension
    ) ||
    ![position.x, position.z].every(Number.isFinite) ||
    position.x < WORLD_MIN ||
    position.x >= WORLD_MAX ||
    position.z < WORLD_MIN ||
    position.z >= WORLD_MAX ||
    ![Math.floor(position.x), Math.floor(position.z)].every(Number.isSafeInteger)
  )
    return null;
  const rawDx = target.x - position.x;
  const rawDz = target.z - position.z;
  const dx = Math.round(rawDx);
  const dz = Math.round(rawDz);
  if (
    ![rawDx, rawDz].every(Number.isFinite) ||
    ![dx, dz].every(Number.isSafeInteger)
  )
    return null;
  const directions = [
    ...(Math.abs(dx) < 1 ? [] : [`${Math.abs(dx)} ${dx < 0 ? "west" : "east"}`]),
    ...(Math.abs(dz) < 1 ? [] : [`${Math.abs(dz)} ${dz < 0 ? "north" : "south"}`]),
  ];
  const reached = directions.length === 0;
  return {
    text: `Treasure map · ${directions.join(" · ") || "target reached"} · target ${target.x}, ${target.y}, ${target.z}`,
    milestone: reached
      ? "reached"
      : `${Math.sign(dx)}:${Math.sign(dz)}`,
    signature: stackIdentity(normalized),
  };
}

export const selectedMapGuidance = (stack, position) =>
  mapGuidanceDetails(stack, position)?.text ?? "";

export function createHUD(root, { listen, onSelect }) {
  const $ = (selector) => root.querySelector(selector);
  const combat = createCombatIndicator($(".game-hud"));
  const hurt = createHurtIndicator($(".game-hud"));
  const compactFps = createFpsIndicator($(".game-hud"));
  const experienceFeedback = createExperienceFeedback(
    $(".game-hud"), $(".experience-meter")
  );
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
  let experienceVisible = false;
  let selectedStack = null;
  let playerPosition = null;
  let visibleGuidance = "";
  let announcedMap = "";
  let announcedMilestone = "";

  function updateMapGuidance() {
    const guidance = mapGuidanceDetails(selectedStack, playerPosition);
    const text = guidance?.text ?? "";
    if (text !== visibleGuidance) {
      visibleGuidance = text;
      setText($(".map-guidance"), text);
      $(".map-guidance").hidden = !text;
    }
    if (!guidance) {
      if (announcedMap || announcedMilestone)
        setText($(".map-guidance-announcement"), "");
      announcedMap = "";
      announcedMilestone = "";
      return;
    }
    if (
      guidance.signature !== announcedMap ||
      guidance.milestone !== announcedMilestone
    ) {
      announcedMap = guidance.signature;
      announcedMilestone = guidance.milestone;
      setText($(".map-guidance-announcement"), guidance.text);
    }
  }

  function updateGameplay(state, hasSnapshot) {
    hotbar.update(state);
    const selected = hotbarSlotView(state, state.selected).stack;
    selectedStack = selected;
    updateMapGuidance();
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
    experienceVisible = !creative && hasSnapshot && Boolean(state.experience) && !state.dead;
    $(".experience-meter").hidden = !experienceVisible;
    if (!experienceVisible) experienceFeedback.update();
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
      const label = isValidExperience(state.experience.total)
        ? experienceProgress(state.experience.total).label
        : `Level ${level} · ${Math.round(progress * 100)}% to level ${level + 1}`;
      $(".experience-track").setAttribute("aria-valuetext", label);
      $(".experience-meter").setAttribute(
        "title", `${label}. Spend levels at an enchanting table or anvil.`
      );
      setText($(".experience-level"), level);
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
      experienceFeedback: feedback,
    } = {}) {
      if (feedback !== undefined)
        experienceFeedback.update(experienceVisible ? feedback : {});
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
      if (position) {
        playerPosition = position;
        updateMapGuidance();
        ["x", "y", "z"].forEach((axis, index) => {
          const value = Number(position[axis] ?? position[index] ?? 0);
          setText($(`[data-coordinate="${axis}"]`), Math.floor(value));
        });
      }
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
      experienceFeedback.dispose();
    },
  };
}
