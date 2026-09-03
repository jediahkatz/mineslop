import { BLOCK } from "../blocks.js";
import { ITEM, ITEMS } from "../items.js";
import { PlayerPortrait } from "../player-portrait.js";
import { appendItemIcon, element, setText } from "./dom.js";
import { catalogItems, craftingJobs, filterItems } from "./model.js";
import { pixelIcon } from "./pixel-icons.js";
import { createRecipeBook } from "./recipe-book.js";
import { createSlotInteractions } from "./slot-interactions.js";
import {
  displayStack,
  EQUIPMENT_LABELS,
  EQUIPMENT_SLOTS,
  ownedSlotStacks,
} from "./slot-model.js";
import { createSlotGrid, createStackSlot } from "./slots.js";

const BAG_INDICES = Array.from({ length: 27 }, (_, i) => i + 9);
const HOTBAR_INDICES = Array.from({ length: 9 }, (_, i) => i);
const TABS = [
  ["creative", "Search Items", BLOCK.GRASS],
  ["blocks", "Building Blocks", BLOCK.STONE],
  ["tools", "Tools & Equipment", ITEM.IRON_PICKAXE],
  ["food", "Food", ITEM.APPLE],
  ["materials", "Ingredients", ITEM.STICK],
  ["backpack", "Survival Inventory", BLOCK.CHEST],
];

export function createInventory(
  container,
  { listen, onClose, onInventoryAction }
) {
  const items = catalogItems(ITEMS);
  let state = { mode: "survival", hotbar: Array(9).fill(0), selected: 0 };
  let tab = "backpack";
  let screen = "inventory";
  let size = 2;
  let bookOpen = false;
  let catalogSignature = "";
  let disposed = false;
  container.innerHTML = `
    <div class="inventory-layout" role="dialog" aria-modal="true" aria-labelledby="inventory-title" aria-describedby="inventory-help" tabindex="-1">
      <aside class="recipe-book pixel-panel" aria-label="Recipe book" hidden></aside>
      <div class="inventory-panel pixel-panel">
        <header class="inventory-header"><h2 id="inventory-title">Inventory</h2><button class="inventory-close icon-button" aria-label="Close inventory">×</button></header>
        <div class="inventory-tabs" role="tablist" aria-label="Creative inventory categories" hidden></div>
        <section class="creative-catalog" aria-label="Creative catalog" hidden>
          <label class="search-field"><span class="sr-only">Search items</span><input class="inventory-search" type="search" placeholder="Search Items" aria-label="Search items" autocomplete="off"></label>
          <div class="creative-grid" role="group" aria-label="Copy Creative items"></div>
          <p class="inventory-empty" hidden>No matching items</p>
          <span class="inventory-result-count"></span>
        </section>
        <section class="inventory-owned" aria-label="Owned inventory">
          <div class="inventory-upper">
            <div class="equipment-grid" role="group" aria-label="Equipped armor"></div>
            <canvas class="inventory-avatar" role="img" aria-label="Your equipped player"></canvas>
            <div class="inventory-offhand" role="group" aria-label="Offhand"></div>
            <div class="crafting-workbench">
              <h3>Crafting</h3>
              <div class="crafting-row"><div class="crafting-grid" role="group" aria-label="2 by 2 crafting grid"></div><span class="crafting-arrow" aria-hidden="true">➜</span><div class="crafting-output" role="group" aria-label="Crafting result"></div></div>
              <button class="recipe-book-toggle icon-button" aria-label="Open recipe book" aria-expanded="false">${pixelIcon("book")}</button>
            </div>
          </div>
          <h3 class="bag-label">Inventory</h3>
          <div class="inventory-grid player-slot-grid" role="group" aria-label="Backpack: 27 slots"></div>
        </section>
        <h3 class="owned-hotbar-label" hidden>Owned Hotbar</h3>
        <div class="inventory-hotbar player-slot-grid" role="group" aria-label="Hotbar: 9 owned slots"></div>
        <section class="creative-palette" aria-label="Creative palette policy" hidden><p>The unlimited building hotbar is kept separately. Shift-click a catalog item or press 1–9 over it to equip a copy.</p></section>
        <p class="legacy-crafting" hidden></p>
        <p class="inventory-status" role="status" aria-live="polite" hidden></p>
      </div>
      <p class="inventory-help" id="inventory-help">Left-click: move stack · Right-click: half / one · Shift-click: quick move<br>1–9: hotbar · F: offhand · Q / Ctrl+Q: drop · E / Esc: close</p>
    </div>`;
  const $ = (selector) => container.querySelector(selector);
  const portrait = new PlayerPortrait($(".inventory-avatar"));
  const equipment = EQUIPMENT_SLOTS.map((name, index) => {
    const slot = createStackSlot({
      area: "equipment",
      index,
      label: EQUIPMENT_LABELS[index],
      placeholder: "",
    });
    slot.node.querySelector(".slot-placeholder").innerHTML = pixelIcon(
      ["helmet", "chest", "legs", "feet"][index]
    );
    $(".equipment-grid").append(slot.node);
    return slot;
  });
  const offhand = createStackSlot({ area: "offhand", label: "Offhand" });
  offhand.node.querySelector(".slot-placeholder").innerHTML =
    pixelIcon("shield");
  $(".inventory-offhand").append(offhand.node);
  const output = createStackSlot({
    area: "result",
    label: "Crafting result",
    className: "result-slot",
  });
  $(".crafting-output").append(output.node);
  const bag = createSlotGrid($(".inventory-grid"), {
    area: "inventory",
    indices: BAG_INDICES,
  });
  const hotbar = createSlotGrid($(".inventory-hotbar"), {
    area: "inventory",
    indices: HOTBAR_INDICES,
    labels: HOTBAR_INDICES.map((index) => `Hotbar ${index + 1}`),
  });
  let crafting;

  function status(message, error) {
    if (disposed) return;
    const node = $(".inventory-status");
    node.hidden = !message;
    node.dataset.state = error ? "error" : "idle";
    setText(node, message);
  }

  const interactions = createSlotInteractions(container, {
    listen,
    getState: () => state,
    onAction: onInventoryAction,
    onStatus: status,
    onRefresh: refresh,
  });
  const book = createRecipeBook($(".recipe-book"), {
    listen,
    onFill: onInventoryAction
      ? (recipeId) => interactions.dispatch({ type: "fillRecipe", recipeId })
      : undefined,
  });

  function buildCraftingGrid() {
    $(".crafting-grid").replaceChildren();
    $(".crafting-grid").style.setProperty("--crafting-size", size);
    $(".crafting-grid").setAttribute(
      "aria-label",
      `${size} by ${size} crafting grid`
    );
    crafting = createSlotGrid($(".crafting-grid"), {
      area: "crafting",
      indices: Array.from({ length: size * size }, (_, i) => i),
    });
  }

  for (const [key, label, id] of TABS) {
    const button = element("button", "creative-tab");
    button.type = "button";
    button.dataset.tab = key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-selected", String(key === tab));
    button.title = label;
    button.tabIndex = key === tab ? 0 : -1;
    appendItemIcon(button, id);
    $(".inventory-tabs").append(button);
  }

  function renderCatalog() {
    if (tab === "backpack" || state.mode !== "creative") return;
    const query = $(".inventory-search").value;
    const signature = `${tab}:${query}`;
    if (catalogSignature === signature) return;
    catalogSignature = signature;
    const available = filterItems(items, {
      creative: true,
      query,
      category: tab === "creative" ? "all" : tab,
    });
    const grid = $(".creative-grid");
    grid.replaceChildren();
    for (const item of available) {
      const slot = createStackSlot({
        area: "catalog",
        index: item.id,
        label: "Copy item",
        interactive: Boolean(onInventoryAction),
        className: "inventory-block",
      });
      slot.update({ id: item.id, count: 1 }, { unlimited: true });
      grid.append(slot.node);
    }
    $(".inventory-empty").hidden = available.length > 0;
    setText(
      $(".inventory-result-count"),
      `${available.length} items · Right-click: copy one · Shift-click: copy to selected hotbar slot`
    );
  }

  function selectTab(next, focus = false) {
    if (!TABS.some(([key]) => key === next)) return;
    if (state.mode !== "creative" && next !== "backpack") return;
    tab = next;
    catalogSignature = "";
    $(".inventory-tabs")
      .querySelectorAll("[data-tab]")
      .forEach((button) => {
        const selected = button.dataset.tab === tab;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus();
      });
    refresh();
  }

  function refresh() {
    if (disposed || container.hidden) return;
    const creative = state.mode === "creative" && screen !== "crafting";
    if (!creative) tab = "backpack";
    const catalogOpen = creative && tab !== "backpack";
    $(".inventory-tabs").hidden = !creative;
    $(".inventory-owned").hidden = catalogOpen;
    $(".creative-catalog").hidden = !catalogOpen;
    $(".creative-palette").hidden = !catalogOpen;
    $(".owned-hotbar-label").hidden = !catalogOpen;
    $(".recipe-book").hidden = !bookOpen || catalogOpen;
    $(".inventory-panel").dataset.screen = screen;
    $(".equipment-grid").hidden = screen === "crafting";
    $(".inventory-avatar").hidden = screen === "crafting";
    $(".inventory-offhand").hidden = screen === "crafting";
    $(".inventory-layout").classList.toggle(
      "has-recipe-book",
      bookOpen && !catalogOpen
    );
    setText(
      $("#inventory-title"),
      screen === "crafting"
        ? "Crafting Table"
        : catalogOpen
          ? TABS.find(([key]) => key === tab)?.[1] || "Creative Inventory"
          : "Inventory"
    );
    const slots = ownedSlotStacks(state);
    const mainHand =
      state.mode === "creative"
        ? state.hotbar?.[state.selected]
          ? { id: state.hotbar[state.selected], count: 1 }
          : null
        : (slots[state.selected] ?? null);
    portrait.update(
      {
        mainHand,
        offhand: state.offhand,
        equipment: state.equipment,
      },
      { visible: !catalogOpen && screen === "inventory" }
    );
    const disabled = !onInventoryAction || !Array.isArray(state.slots);
    bag.update(slots, { disabled });
    hotbar.update(slots, { disabled });
    equipment.forEach((slot, index) =>
      slot.update(state.equipment?.[EQUIPMENT_SLOTS[index]], { disabled })
    );
    offhand.update(state.offhand, { disabled });
    crafting.update(state.craftingGrid || [], { disabled });
    output.update(state.craftingResult, {
      disabled: disabled || !displayStack(state.craftingResult),
    });
    book.update(state, size);
    renderCatalog();
    interactions.update();
    const jobs = craftingJobs(state.crafting);
    $(".legacy-crafting").hidden = !jobs.length;
    setText(
      $(".legacy-crafting"),
      jobs.length
        ? `${jobs.length} prepaid smelting ${jobs.length === 1 ? "job" : "jobs"} still completing`
        : ""
    );
    if (disabled && !$(".inventory-status").textContent)
      status(
        "Slot actions are not available until the inventory is loaded.",
        false
      );
  }

  listen($(".inventory-close"), "click", onClose);
  listen($(".inventory-tabs"), "click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) selectTab(button.dataset.tab);
  });
  listen($(".inventory-tabs"), "keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = TABS.findIndex(([key]) => key === tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : (index + (event.key === "ArrowLeft" ? -1 : 1) + TABS.length) %
            TABS.length;
    selectTab(TABS[next][0], true);
  });
  listen($(".inventory-search"), "input", renderCatalog);
  listen($(".recipe-book-toggle"), "click", () => {
    bookOpen = !bookOpen;
    $(".recipe-book-toggle").setAttribute("aria-expanded", String(bookOpen));
    $(".recipe-book-toggle").setAttribute(
      "aria-label",
      `${bookOpen ? "Close" : "Open"} recipe book`
    );
    refresh();
    book.refresh();
  });
  buildCraftingGrid();

  return {
    refresh,
    open({ screen: nextScreen = "inventory", size: nextSize } = {}) {
      screen = nextScreen === "crafting" ? "crafting" : "inventory";
      // Proximity never turns E's personal grid into a workbench.
      size = screen === "crafting" ? (nextSize === 2 ? 2 : 3) : 2;
      tab =
        state.mode === "creative" && screen === "inventory"
          ? "creative"
          : "backpack";
      buildCraftingGrid();
      status("", false);
      selectTab(tab);
    },
    update(next) {
      state = next;
      refresh();
    },
    async requestClose() {
      if (interactions.busy) return false;
      if (!onInventoryAction) {
        if (state.cursor || state.craftingGrid?.some(Boolean)) {
          status(
            "Unable to return carried items. Keep this inventory open and try again.",
            true
          );
          return false;
        }
        return true;
      }
      return interactions.dispatch({ type: "close" });
    },
    closed() {
      interactions.reset();
      book.refresh();
    },
    selectTab,
    dispose() {
      disposed = true;
      interactions.dispose();
      book.dispose();
      portrait.dispose();
    },
  };
}
