import { getItem } from "./items.js";
import { GENERATOR_VERSION } from "./terrain.js";
import { createAtlas } from "./ui/atlas.js";
import { createControlSettings } from "./ui/control-settings.js";
import {
  createEventScope,
  focusFirst,
  isTextInput,
  setText,
  trapFocus,
} from "./ui/dom.js";
import { createFullscreenSettings } from "./ui/fullscreen-settings.js";
import { createFpsSettings } from "./ui/fps-settings.js";
import { createGuiSettings } from "./ui/gui-settings.js";
import { createHUD } from "./ui/hud.js";
import { createInspectionSettings } from "./ui/inspection-settings.js";
import { createInventory } from "./ui/inventory.js";
import { createMenuNavigation } from "./ui/menu-navigation.js";
import {
  clamp,
  createOverlayNotifier,
  itemCount,
  normalizeHotbar,
  storageView,
} from "./ui/model.js";
import { shellMarkup } from "./ui/shell.js";
import { hotbarSlotView } from "./ui/slot-model.js";
import { generationChoiceFromInput } from "./generation-choice.js";

export function createUI({
  onPlay,
  onResume,
  onQuit,
  onNewWorld,
  onSave,
  onTimeChange,
  onQualityChange,
  onSoundChange,
  onControlPreferencesChange,
  onFullbrightInspectionChange,
  onGuiScaleChange,
  onShowFpsChange,
  onToggleFullscreen,
  onSelect,
  onTeleport,
  onInventoryChange,
  onInventoryAction,
  onPause,
  onModeChange,
  onRespawn,
  onTravel,
  onDimensionChange,
  onExport,
  onImport,
} = {}) {
  const root = document.querySelector("#ui");
  if (!root) throw new Error("MINESLOP requires a #ui container");
  const events = createEventScope();
  const { listen } = events;
  const state = {
    mode: "survival",
    health: 20,
    hunger: 20,
    air: 20,
    dead: false,
    hotbar: Array(9).fill(0),
    selected: 0,
    counts: {},
    inventory: [],
    durability: {},
  };
  let loaded = false;
  let menuVisible = true;
  let menuMode = "title";
  let activeOverlay = null;
  let hasSnapshot = false;
  let snapshotRevision = 0;
  let modeRevision = 0;
  let modeBusy = false;
  let dimension = "overworld";
  let dimensionRevision = 0;
  let dimensionBusy = false;
  let storageRevision = 0;
  let externalStorageStatus = "";
  let storageBusy = false;
  let worldBusy = false;
  let returnFocus;
  let toastTimer;
  let disposed = false;
  let flying = false;
  let hudVisible = true;
  let debugVisible = false;
  let closingInventory = null;
  root.innerHTML = shellMarkup();
  const $ = (selector) => root.querySelector(selector);
  const menu = $(".menu-screen");
  const inventory = $(".inventory-overlay");
  const atlas = $(".atlas-overlay");
  const death = $(".death-overlay");
  const loading = $(".loading-screen");
  const hud = $(".game-hud");
  const seedInput = $("#world-seed");
  const generationInput = $("#world-generation");
  const resume = onResume || onPlay;
  const menuNavigation = createMenuNavigation(menu, {
    listen,
    canNavigate: () => !storageBusy && !worldBusy,
  });
  const hudView = createHUD(root, {
    listen,
    onSelect: onSelect ? selectFromUI : undefined,
  });
  const controlSettings = createControlSettings(root, {
    listen,
    onChange: onControlPreferencesChange
      ? (preferences) => void runAction(onControlPreferencesChange, preferences)
      : undefined,
  });
  const inspectionSettings = createInspectionSettings(root, {
    listen,
    onChange: onFullbrightInspectionChange
      ? (enabled) => void runAction(onFullbrightInspectionChange, enabled)
      : undefined,
  });
  const fpsSettings = createFpsSettings(root, {
    listen,
    onChange: onShowFpsChange
      ? (enabled) => void runAction(onShowFpsChange, enabled)
      : undefined,
  });
  const guiSettings = createGuiSettings(root, {
    listen,
    onChange: onGuiScaleChange
      ? (scale) => void runAction(onGuiScaleChange, scale)
      : undefined,
  });
  const fullscreenSettings = createFullscreenSettings(root, {
    listen,
    onToggle: onToggleFullscreen
      ? () => runAction(onToggleFullscreen)
      : undefined,
  });
  const inventoryView = createInventory(inventory, {
    listen,
    onClose: closeInventory,
    onInventoryAction,
  });
  const atlasView = createAtlas(atlas, {
    listen,
    onClose: closeAtlas,
    onTravel,
  });
  const notifyOverlay = createOverlayNotifier(
    (open) => void runAction(onInventoryChange, open)
  );

  function toast(text) {
    if (disposed) return;
    if (
      /^(?:Could not (?:save|export|import)|(?:Save|Export|Import) failed|World file is too large)/i.test(
        String(text)
      )
    )
      setStorageStatus({ state: "error", message: String(text) });
    else if (/^World (?:saved|exported|imported)/i.test(String(text)))
      setStorageStatus({ state: "success", message: String(text) });
    clearTimeout(toastTimer);
    setText($(".toast > span"), text);
    $(".toast").hidden = false;
    toastTimer = setTimeout(() => {
      if (!disposed) $(".toast").hidden = true;
    }, 4200);
  }

  async function runAction(callback, ...args) {
    try {
      return await callback?.(...args);
    } catch (error) {
      toast(error.message || "That action could not be completed.");
      return false;
    }
  }

  function overlayOpen() {
    return activeOverlay !== null || Boolean(state.dead);
  }

  function syncOverlays() {
    inventory.hidden =
      !loaded || menuVisible || activeOverlay !== "inventory" || state.dead;
    atlas.hidden =
      !loaded || menuVisible || activeOverlay !== "atlas" || state.dead;
    death.hidden =
      !loaded || !state.dead || (menuVisible && menuMode === "title");
    root.dataset.overlay = state.dead ? "death" : activeOverlay || "";
    notifyOverlay(activeOverlay, state.dead);
    syncHudVisibility();
  }

  function syncHudVisibility() {
    hud.hidden =
      !loaded || !hudVisible || (menuVisible && menuMode !== "pause");
    $(".debug-overlay").hidden = !debugVisible;
    root.dataset.hud = hudVisible ? "visible" : "hidden";
    root.dataset.debug = String(debugVisible);
  }

  function toggleHud() {
    hudVisible = !hudVisible;
    syncHudVisibility();
    return hudVisible;
  }

  function toggleDebug() {
    debugVisible = !debugVisible;
    syncHudVisibility();
    return debugVisible;
  }

  function restoreFocus() {
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden]"))
      returnFocus.focus({ preventScroll: true });
    returnFocus = undefined;
  }

  function closeInventory() {
    if (activeOverlay !== "inventory") return Promise.resolve(true);
    if (closingInventory) return closingInventory;
    closingInventory = inventoryView
      .requestClose()
      .then((closed) => {
        if (!closed || disposed) return false;
        if (activeOverlay === "inventory") {
          activeOverlay = null;
          inventoryView.closed();
          syncOverlays();
          restoreFocus();
        }
        return true;
      })
      .finally(() => {
        closingInventory = null;
      });
    return closingInventory;
  }

  function closeAtlas() {
    if (activeOverlay !== "atlas") return;
    activeOverlay = null;
    syncOverlays();
    restoreFocus();
  }

  function toggleOverlay(name) {
    if (activeOverlay === name) {
      if (name === "inventory") void closeInventory();
      else closeAtlas();
      return false;
    }
    if (menuVisible || !loaded || state.dead) return false;
    if (activeOverlay === "inventory") {
      void closeInventory().then((closed) => {
        if (closed) toggleOverlay(name);
      });
      return false;
    }
    if (!overlayOpen()) returnFocus = document.activeElement;
    activeOverlay = name;
    syncOverlays();
    if (name === "inventory") inventoryView.open();
    else atlasView.refresh();
    focusFirst(name === "inventory" ? inventory : atlas);
    return true;
  }

  function openInventory(options = {}) {
    if (menuVisible || !loaded || state.dead || closingInventory) return false;
    if (!overlayOpen()) returnFocus = document.activeElement;
    activeOverlay = "inventory";
    syncOverlays();
    inventoryView.open(options);
    focusFirst(inventory);
    return true;
  }

  function renderState(recipes) {
    hudView.updateGameplay(state, hasSnapshot);
    inventoryView.update(state, recipes);
  }

  function setSelected(index) {
    if (!Number.isInteger(index) || index < 0 || index > 8) return;
    state.selected = index;
    renderState();
  }

  function setHotbar(ids) {
    state.hotbar = normalizeHotbar(ids);
    if (state.mode === "creative") state.creativeHotbar = [...state.hotbar];
    renderState();
  }

  function selectFromUI(index, id) {
    if (!onSelect || !Number.isInteger(index) || index < 0 || index > 8) return;
    if (
      id !== undefined &&
      (!Number.isInteger(id) || id < 0 || (id && !getItem(id)))
    )
      return;
    if (id && state.mode !== "creative" && itemCount(state, id) < 1) {
      toast("Gather this item before adding it to your hotbar.");
      return;
    }
    const revision = snapshotRevision;
    try {
      const result = onSelect(index, id);
      if (result === false) return;
      if (revision === snapshotRevision) {
        if (id !== undefined) state.hotbar[index] = id;
        setSelected(index);
      }
      if (result?.then)
        void result.catch((error) =>
          toast(error.message || "Could not equip this item.")
        );
    } catch (error) {
      toast(error.message || "Could not equip this item.");
    }
  }

  function updateModeControls() {
    const creative = state.mode === "creative";
    root.dataset.mode = state.mode;
    setText($(".creative-badge"), creative ? "Creative" : "Survival");
    setText($(".mode-label"), creative ? "Creative" : "Survival");
    $(".survival-travel-note").hidden = creative;
    root.querySelectorAll("[data-mode]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.mode === state.mode)
      );
      button.disabled = !onModeChange || modeBusy || storageBusy || worldBusy;
    });
    root.querySelectorAll("[data-creative-only]").forEach((node) => {
      node.hidden = !creative;
    });
    $(".flight-indicator").hidden = !creative || !flying;
    $("#dimension-setting").disabled =
      !onDimensionChange ||
      !creative ||
      dimensionBusy ||
      storageBusy ||
      worldBusy;
    $("#dimension-setting").title = creative
      ? "Travel to another dimension"
      : "Use a portal in Survival, or switch to Creative to travel";
    atlasView.update({ mode: state.mode });
  }

  function setMode(mode) {
    if (!["survival", "creative"].includes(mode)) return;
    modeRevision++;
    state.mode = mode;
    updateModeControls();
    renderState();
  }

  function showMenu(mode = "title") {
    if (activeOverlay === "inventory")
      return closeInventory().then((closed) => closed && showMenu(mode));
    menuMode = mode === "pause" ? "pause" : "title";
    menuVisible = true;
    activeOverlay = null;
    root.dataset.menu = "open";
    menu.hidden = !loaded;
    menuNavigation.show(menuMode, { focus: loaded });
    setText(
      $(".play-label"),
      menuMode === "pause" ? "Back to Game" : "Play World"
    );
    $(".save-and-quit-button").hidden = menuMode !== "pause" || !onQuit;
    updateStorageButtons();
    syncOverlays();
    return true;
  }

  function hideMenu() {
    menuVisible = false;
    root.dataset.menu = "";
    menu.hidden = true;
    syncOverlays();
    if (!overlayOpen() && root.contains(document.activeElement))
      document.activeElement?.blur?.();
  }

  function setStorageStatus(status) {
    storageRevision++;
    const view = storageView(status);
    setText($(".storage-status"), view.message);
    $(".storage-status").dataset.state = view.state;
  }

  function updateStorageButtons() {
    $(".save-button").disabled = !onSave || storageBusy || worldBusy;
    $(".export-button").disabled = !onExport || storageBusy || worldBusy;
    $(".import-button").disabled = !onImport || storageBusy || worldBusy;
    $(".generate-button").disabled = !onNewWorld || storageBusy || worldBusy;
    generationInput.disabled = !onNewWorld || storageBusy || worldBusy;
    seedInput.disabled = !onNewWorld || storageBusy || worldBusy;
    $(".new-world-button").disabled = !onNewWorld || storageBusy || worldBusy;
    $(".play-button").disabled =
      !(menuMode === "pause" ? resume : onPlay) || storageBusy || worldBusy;
    $(".save-and-quit-button").disabled = !onQuit || storageBusy || worldBusy;
    $(".menu-back-button").disabled = storageBusy || worldBusy;
    $(".spawn-button").disabled = !onTeleport || storageBusy || worldBusy;
    $("#time-setting").disabled = !onTimeChange || storageBusy || worldBusy;
    $("#dimension-setting").disabled =
      !onDimensionChange ||
      state.mode !== "creative" ||
      dimensionBusy ||
      storageBusy ||
      worldBusy;
    root.querySelectorAll(".mode-picker [data-mode]").forEach((button) => {
      button.disabled = !onModeChange || modeBusy || storageBusy || worldBusy;
    });
    menu.setAttribute("aria-busy", String(storageBusy || worldBusy));
  }

  async function storageAction(kind, callback, ...args) {
    if (!callback || storageBusy || worldBusy) return;
    storageBusy = true;
    updateStorageButtons();
    const messages = {
      save: ["Saving your world…", "World saved on this device."],
      export: [
        "Preparing your save file…",
        "Save exported. Keep a copy somewhere safe.",
      ],
      import: ["Checking your save file…", "Save imported. Welcome back."],
    }[kind];
    setStorageStatus({ state: "busy", message: messages[0] });
    const revision = storageRevision;
    try {
      const pending = callback(...args);
      const asynchronous = Boolean(pending?.then);
      const result = await pending;
      if (disposed) return;
      if (result === false || result?.ok === false)
        throw new Error(
          result?.error?.message ||
            result?.message ||
            result?.error ||
            `Could not ${kind} this world.`
        );
      if (storageRevision === revision)
        setStorageStatus(
          result === undefined && !asynchronous
            ? {
                state: "idle",
                message: `${kind[0].toUpperCase() + kind.slice(1)} requested. Check the world status for the result.`,
              }
            : { state: "success", message: messages[1] }
        );
    } catch (error) {
      if (disposed) return;
      const message = error.message || `Could not ${kind} this world.`;
      setStorageStatus({ state: "error", message });
      toast(message);
    } finally {
      storageBusy = false;
      if (!disposed) updateStorageButtons();
    }
  }

  function update({
    gameplay,
    recipes,
    station,
    biome,
    dimension: nextDimension,
    storageStatus,
    flying: nextFlying,
    time,
    seed,
    generatorVersion,
    quality,
    soundEnabled,
    controlPreferences,
    fullbrightInspection,
    guiScale,
    showFps,
    fullscreen,
    keyboardCaptured,
    ...hudState
  } = {}) {
    if (disposed) return;
    if (gameplay) {
      const wasDead = Boolean(state.dead);
      const previousMode = state.mode;
      hasSnapshot = true;
      snapshotRevision++;
      for (const field of [
        "slots",
        "cursor",
        "offhand",
        "equipment",
        "armorPoints",
        "experience",
        "craftingGrid",
        "craftingSize",
        "craftingResult",
        "creativeHotbar",
      ])
        if (!Object.hasOwn(gameplay, field)) delete state[field];
      Object.assign(state, gameplay);
      state.mode = ["survival", "creative"].includes(state.mode)
        ? state.mode
        : previousMode;
      state.hotbar = normalizeHotbar(state.hotbar);
      state.selected = Math.floor(clamp(state.selected, 0, 8));
      if (gameplay.inventory && gameplay.counts === undefined)
        state.counts = undefined;
      if (previousMode !== state.mode) modeRevision++;
      updateModeControls();
      if (state.dead) {
        activeOverlay = null;
        setText(
          $("#death-description"),
          state.deathCause || state.cause
            ? `Cause: ${state.deathCause || state.cause}`
            : "You died in this world."
        );
      }
      syncOverlays();
      if (state.dead && !wasDead && !death.hidden) focusFirst(death);
      if (wasDead && !state.dead) restoreFocus();
    }
    if (station !== undefined) state.station = station;
    if (gameplay || recipes !== undefined || station !== undefined)
      renderState(recipes);
    if (nextDimension !== undefined || biome?.dimension) {
      dimension = nextDimension ?? biome.dimension;
      dimensionRevision++;
      $("#dimension-setting").value = dimension;
    }
    if (nextFlying !== undefined) flying = Boolean(nextFlying);
    $(".flight-indicator").hidden = state.mode !== "creative" || !flying;
    hudView.update({ ...hudState, biome, dimension });
    atlasView.update({ biome, dimension });
    if (storageStatus !== undefined) {
      const view = storageView(storageStatus);
      const signature = `${view.state}:${view.message}`;
      if (signature !== externalStorageStatus) {
        externalStorageStatus = signature;
        setStorageStatus(storageStatus);
      }
    }
    if (time !== undefined) {
      const t = time - Math.floor(time);
      const label =
        t < 0.22 || t >= 0.8
          ? "Nightfall"
          : t < 0.31
            ? "Sunrise"
            : t < 0.68
              ? "Daylight"
              : "Golden hour";
      setText($("[data-time-label]"), label);
      setText($(".settings-time-label"), label);
      if (document.activeElement !== $("#time-setting"))
        $("#time-setting").value = String(t);
    }
    if (seed !== undefined) {
      setText($(".footer-world b"), seed);
      setText($(".world-seed-value"), seed);
      // HUD refreshes describe the active world, not the new-world draft.
      if (menuNavigation.page !== "new-world" && document.activeElement !== seedInput)
        seedInput.value = String(seed);
    }
    if (generatorVersion !== undefined)
      $(".terrain-generation-note").hidden =
        !Number.isInteger(generatorVersion) ||
        generatorVersion < 1 ||
        generatorVersion >= GENERATOR_VERSION;
    if (quality !== undefined) $("#quality-setting").value = quality;
    if (soundEnabled !== undefined)
      $("#sound-setting").checked = Boolean(soundEnabled);
    if (controlPreferences !== undefined)
      controlSettings.update(controlPreferences);
    if (fullbrightInspection !== undefined)
      inspectionSettings.update(fullbrightInspection);
    if (guiScale !== undefined) guiSettings.update(guiScale);
    if (showFps !== undefined) {
      fpsSettings.update(showFps);
      hudView.setShowFps(showFps);
    }
    if (fullscreen !== undefined || keyboardCaptured !== undefined)
      fullscreenSettings.update({ fullscreen, keyboardCaptured });
  }

  listen(
    $(".play-button"),
    "click",
    () => void runAction(menuMode === "pause" ? resume : onPlay)
  );
  listen($(".seed-form"), "submit", async (event) => {
    event.preventDefault();
    if (worldBusy || storageBusy || !onNewWorld) return;
    seedInput.value = seedInput.value.trim().slice(0, 80) || "cedar-valley";
    worldBusy = true;
    updateStorageButtons();
    try {
      const generatorVersion = generationChoiceFromInput(generationInput.value);
      const result = await onNewWorld(seedInput.value, generatorVersion);
      if (disposed) return;
      if (result === false || result?.ok === false)
        setStorageStatus({
          state: "error",
          message:
            result?.message ||
            "World generation cancelled. Your current world is unchanged.",
        });
    } catch (error) {
      if (!disposed)
        setStorageStatus({
          state: "error",
          message: error.message || "Could not generate this world.",
        });
      toast(error.message || "Could not generate this world.");
    } finally {
      worldBusy = false;
      if (!disposed) updateStorageButtons();
    }
  });
  listen($(".save-button"), "click", () => void storageAction("save", onSave));
  listen(
    $(".export-button"),
    "click",
    () => void storageAction("export", onExport)
  );
  listen($(".import-button"), "click", () => $(".import-file").click());
  listen($(".import-file"), "change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void storageAction("import", onImport, file);
  });
  listen($(".spawn-button"), "click", () => {
    if (state.mode === "creative") void runAction(onTeleport);
  });
  listen(
    $("#sound-setting"),
    "change",
    (event) => void runAction(onSoundChange, event.target.checked)
  );
  listen(
    $("#quality-setting"),
    "change",
    (event) => void runAction(onQualityChange, event.target.value)
  );
  listen($("#time-setting"), "input", (event) => {
    const time = Number(event.target.value);
    update({ time });
    void runAction(onTimeChange, time);
  });
  listen($("#dimension-setting"), "change", async (event) => {
    const next = event.target.value;
    const previous = dimension;
    const revision = dimensionRevision;
    dimensionBusy = true;
    event.target.disabled = true;
    const result = await runAction(onDimensionChange, next);
    if (disposed) return;
    if (revision === dimensionRevision)
      update({
        dimension: result === false || result?.ok === false ? previous : next,
      });
    dimensionBusy = false;
    $("#dimension-setting").disabled =
      !onDimensionChange || state.mode !== "creative";
  });
  listen($(".mode-picker"), "click", async (event) => {
    const button = event.target.closest("button[data-mode]");
    if (
      !button ||
      button.disabled ||
      modeBusy ||
      button.dataset.mode === state.mode
    )
      return;
    const mode = button.dataset.mode;
    const revision = modeRevision;
    modeBusy = true;
    updateModeControls();
    const result = await runAction(onModeChange, mode);
    if (disposed) return;
    if (result !== false && result?.ok !== false && modeRevision === revision)
      setMode(mode);
    modeBusy = false;
    updateModeControls();
  });
  listen($(".respawn-button"), "click", async () => {
    $(".respawn-button").disabled = true;
    const result = await runAction(onRespawn);
    if (!disposed) {
      $(".respawn-button").disabled = !onRespawn;
      if (result === false) toast("Could not respawn. Please try again.");
    }
  });
  async function quitToTitle() {
    if (!onQuit || worldBusy || storageBusy) return;
    worldBusy = true;
    updateStorageButtons();
    $(".death-quit-button").disabled = true;
    const result = await runAction(onQuit);
    worldBusy = false;
    if (disposed) return;
    updateStorageButtons();
    $(".death-quit-button").disabled = !onQuit;
    if (result === false || result?.ok === false) {
      toast(
        result?.message || "Could not save and return to the title screen."
      );
      return;
    }
    showMenu("title");
  }
  listen($(".save-and-quit-button"), "click", () => void quitToTitle());
  listen($(".death-quit-button"), "click", () => void quitToTitle());
  listen($(".hud-pause"), "click", () => {
    showMenu("pause");
    void runAction(onPause);
  });
  listen($(".hud-biome"), "click", () => toggleOverlay("atlas"));
  for (const [overlay, close] of [
    [inventory, closeInventory],
    [atlas, closeAtlas],
  ]) {
    listen(overlay, "click", (event) => {
      if (event.target === overlay) close();
    });
  }
  for (const event of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "wheel",
  ])
    listen(root, event, (e) => e.stopPropagation());
  listen(root, "contextmenu", (event) => event.preventDefault());
  listen(root, "keyup", (event) => {
    if (isTextInput(event.target) || overlayOpen() || menuVisible)
      event.stopPropagation();
  });
  // Capture only modal navigation keys. This also handles a menu opened while
  // focus is still on the canvas/body; Escape must not depend on a prior click.
  listen(
    root.ownerDocument,
    "keydown",
    (event) => {
      const panel =
        state.dead && !death.hidden
          ? death
          : activeOverlay === "inventory"
            ? inventory
            : activeOverlay === "atlas"
              ? atlas
              : menuVisible
                ? menu
                : null;
      if (!panel || !loaded) return;
      if (panel) trapFocus(event, panel);
      if (event.key === "Escape" || event.code === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || storageBusy || worldBusy) return;
        if (activeOverlay === "inventory") void closeInventory();
        else if (activeOverlay === "atlas") closeAtlas();
        else if (menuVisible && menuNavigation.back()) return;
        else if (!state.dead && menuMode === "pause") void runAction(resume);
        return;
      }
      if (isTextInput(event.target)) return;
      if (
        activeOverlay &&
        !event.repeat &&
        ["KeyE", "KeyB"].includes(event.code)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.code === "KeyE") {
          if (activeOverlay === "inventory") void closeInventory();
          else closeAtlas();
        } else toggleOverlay("atlas");
        return;
      }
      if (["F1", "F3"].includes(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) {
          if (event.code === "F1") toggleHud();
          else toggleDebug();
        }
        return;
      }
      if (!root.contains(event.target)) event.stopImmediatePropagation();
    },
    { capture: true }
  );
  listen(root, "keydown", (event) => {
    if (isTextInput(event.target) || overlayOpen() || menuVisible)
      event.stopPropagation();
  });

  $(".generate-button").disabled = !onNewWorld;
  $(".spawn-button").disabled = !onTeleport;
  $(".respawn-button").disabled = !onRespawn;
  $(".death-quit-button").hidden = !onQuit;
  $(".hud-pause").disabled = !onPause;
  $("#sound-setting").disabled = !onSoundChange;
  $("#quality-setting").disabled = !onQualityChange;
  $("#time-setting").disabled = !onTimeChange;
  $("#dimension-setting").disabled = !onDimensionChange;
  updateStorageButtons();
  updateModeControls();
  renderState();
  showMenu();

  return {
    showMenu,
    hideMenu,
    closeInventory,
    openInventory,
    closeAtlas,
    setSelected,
    setHotbar,
    setMode,
    update,
    updateCombat: hudView.updateCombat,
    updateHurt: hudView.updateHurt,
    toast,
    setStorageStatus,
    toggleInventory: () => toggleOverlay("inventory"),
    toggleAtlas: () => toggleOverlay("atlas"),
    toggleHud,
    toggleDebug,
    openMenuPage: (page) => menuNavigation.navigate(page),
    get isHudVisible() {
      return hudVisible;
    },
    get isDebugVisible() {
      return debugVisible;
    },
    get isDebugOpen() {
      return debugVisible;
    },
    get isInventoryOpen() {
      return activeOverlay === "inventory";
    },
    get isAtlasOpen() {
      return activeOverlay === "atlas";
    },
    get isOverlayOpen() {
      return overlayOpen();
    },
    get isMenuOpen() {
      return menuVisible;
    },
    get isDead() {
      return Boolean(state.dead);
    },
    get selectedBlockId() {
      return hotbarSlotView(state, state.selected).stack?.id || 0;
    },
    get selectedItemId() {
      return hotbarSlotView(state, state.selected).stack?.id || 0;
    },
    get selectedIndex() {
      return state.selected;
    },
    setLoading(progress, label = "Preparing terrain...") {
      loaded = false;
      activeOverlay = null;
      loading.hidden = false;
      menu.hidden = true;
      hud.hidden = true;
      const percent = Math.round(clamp(progress) * 100);
      setText($(".loading-label"), label);
      $(".loading-track > div").style.width = `${percent}%`;
      $(".loading-track").setAttribute("aria-valuenow", String(percent));
      setText($(".loading-percent"), `${percent}%`);
      syncOverlays();
    },
    ready() {
      loaded = true;
      loading.hidden = true;
      if (menuVisible) showMenu(menuMode);
      else hideMenu();
      if (state.dead && !death.hidden) focusFirst(death);
    },
    dispose() {
      disposed = true;
      clearTimeout(toastTimer);
      inventoryView.dispose();
      atlasView.dispose();
      hudView.dispose();
      fullscreenSettings.dispose();
      events.dispose();
      root.replaceChildren();
      delete root.dataset.menu;
      delete root.dataset.mode;
      delete root.dataset.overlay;
      delete root.dataset.inputMode;
      delete root.dataset.hud;
      delete root.dataset.debug;
      delete root.dataset.guiScale;
      delete root.dataset.fullscreen;
      delete root.dataset.keyboardCaptured;
    },
  };
}
