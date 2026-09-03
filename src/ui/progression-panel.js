import { TransactionInvariantError } from "../transactions.js";
import { createEventScope, element, isTextInput, setText, trapFocus } from "./dom.js";
import { createSlotInteractions } from "./slot-interactions.js";
import { EQUIPMENT_LABELS, EQUIPMENT_SLOTS } from "./slot-model.js";
import { createSlotGrid, createStackSlot } from "./slots.js";
import { createProgressionStationPanels, progressionMessage } from "./progression-station-panels.js";
import { createProgressionTradingPanel } from "./progression-trading-panel.js";

let nextPanelId = 0;
const kinds = new Set(["enchanting", "anvil", "brewing", "smithing", "trading"]);

/**
 * Callback-only overlay:
 * readView(options) -> services.view(options)
 * readRevision() -> services.viewRevision (optional cheap frame invalidation)
 * onAction(action) -> services.action(action), AFTER its one atomic commit
 * onClose(reason) -> services.close(reason)
 *
 * Parent opens/hides this from onSessionChange and owns pause, input resets,
 * pointer lock, HUD and save scheduling. No World, inventory or seed lives here.
 * hide/dispose NEVER return, clear or drop cursor/escrow.
 */
export class ProgressionUI {
  constructor(root, { readView, readRevision, onAction, onClose } = {}) {
    if (![readView, onAction, onClose].every((callback) => typeof callback === "function") ||
        (readRevision !== undefined && typeof readRevision !== "function"))
      throw new TypeError("Progression UI requires live view/action/close callbacks");
    Object.assign(this, { readView, readRevision, onAction, onClose, document: root.ownerDocument });
    this._events = createEventScope();
    this._view = null;
    this._state = {};
    this._rename = undefined;
    this._leftSignature = "";
    this._disposed = false;
    this._closing = false;
    this._interactions = null;
    this._interactionEvents = null;
    this._refreshTime = 0;
    this._renderRevision = null;
    const { listen } = this._events;
    const titleId = `progression-title-${++nextPanelId}`;
    this.element = element("div", "progression-overlay");
    this.element.hidden = true;
    this.element.tabIndex = -1;
    const layout = element("div", "progression-layout");
    this.panel = element("section", "progression-panel pixel-panel");
    this.panel.tabIndex = -1;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", titleId);
    const header = element("header", "progression-header");
    this.title = element("h2");
    this.title.id = titleId;
    this.closeButton = element("button", "progression-close icon-button", "×");
    this.closeButton.type = "button";
    this.closeButton.setAttribute("aria-label", "Close progression station");
    header.append(this.title, this.closeButton);
    this.location = element("p", "progression-location");
    const work = element("div", "progression-work");
    this._stationPanels = createProgressionStationPanels(work, {
      listen, dispatch: (action) => this.dispatch(action),
      onRename: (name) => { this._rename = name; this.refresh(); },
    });
    this._tradingPanel = createProgressionTradingPanel(work, {
      listen, dispatch: (action) => this.dispatch(action),
    });
    const inventoryLabel = element("h3", "progression-inventory-label", "Inventory");
    const backpack = element("div", "progression-backpack player-slot-grid");
    backpack.setAttribute("role", "group");
    backpack.setAttribute("aria-label", "Backpack: 27 owned slots");
    this._backpack = createSlotGrid(backpack, {
      area: "inventory", indices: Array.from({ length: 27 }, (_, i) => i + 9),
    });
    const hotbar = element("div", "progression-hotbar player-slot-grid");
    hotbar.setAttribute("role", "group");
    hotbar.setAttribute("aria-label", "Hotbar: 9 owned slots");
    this._hotbar = createSlotGrid(hotbar, {
      area: "inventory", indices: Array.from({ length: 9 }, (_, i) => i),
      labels: Array.from({ length: 9 }, (_, i) => `Hotbar ${i + 1}`),
    });
    const equipment = element("div", "progression-equipment");
    equipment.setAttribute("role", "group");
    equipment.setAttribute("aria-label", "Equipment and offhand");
    this._equipment = EQUIPMENT_LABELS.map((label, index) => {
      const item = createStackSlot({ area: "equipment", index, label, placeholder: label[0] });
      equipment.append(item.node);
      return item;
    });
    this._offhand = createStackSlot({ area: "offhand", label: "Offhand", placeholder: "F" });
    equipment.append(this._offhand.node);
    this.level = element("span", "progression-player-level");
    equipment.append(this.level);
    this.dropCursor = element("button", "progression-drop-cursor", "Drop carried stack");
    this.dropCursor.type = "button";
    this.dropCursor.hidden = true;
    this.note = element("p", "progression-note");
    this.status = element("p", "progression-status");
    this.status.hidden = true;
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(header, this.location, work, inventoryLabel, backpack,
      hotbar, equipment, this.dropCursor, this.note, this.status);
    const help = element("p", "progression-help",
      "Left: move stack · Right: half / one · Shift: quick move · Drag: distribute\n1–9: hotbar · F: offhand · Q / Ctrl+Q: drop · E / Esc: close");
    layout.append(this.panel, help);
    this.element.append(layout);
    root.append(this.element);
    listen(this.dropCursor, "click", () => this.dispatch({
      type: "drop", area: "cursor", index: 0, wholeStack: true,
    }));
    listen(this.closeButton, "click", () => this.close());
    listen(this.document, "keydown", (event) => {
      if (!this.isOpen) return;
      trapFocus(event, this.element);
      if (event.code === "Escape" || event.key === "Escape" ||
          (event.code === "KeyE" && !isTextInput(event.target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) this.close();
      }
    }, { capture: true });
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup",
      "mousedown", "mouseup", "click", "dblclick", "wheel"])
      listen(this.element, type, (event) => event.stopPropagation());
  }

  get isOpen() { return !this._disposed && !this.element.hidden && this._view !== null; }
  get kind() { return this._view?.kind ?? null; }

  _bindInteractions() {
    // One controller per session. Disposing it invalidates pending callback
    // responses, so an old result cannot refresh or report errors in a reopened
    // menu. The shared inventory/crafting controller is left unchanged.
    this._interactionEvents = createEventScope();
    const { listen } = this._interactionEvents;
    this._interactions = createSlotInteractions(this.element, {
      listen, getState: () => this._state,
      onAction: (action) => this._action(action),
      onStatus: (message, error) => this._status(message, error),
      onRefresh: () => this.refresh(),
    });
    // Slot controller must consume pointer-captured clicks before backdrop
    // dismissal, including after a session has been hidden and reopened.
    listen(this.element, "click", (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.setAttribute("aria-busy", "false");
  }

  open() {
    if (this._disposed) return false;
    const view = this.readView();
    if (!view || !kinds.has(view.kind)) return false;
    if (this.isOpen) this.hide();
    this._previousFocus = this.document.activeElement;
    this._view = view;
    this._rename = undefined;
    this._leftSignature = "";
    this._refreshTime = 0;
    this._renderRevision = null;
    this._tradingPanel.reset();
    this.element.hidden = false;
    this._bindInteractions();
    this._status("", false);
    this.refresh();
    if (this.isOpen) this.closeButton.focus({ preventScroll: true });
    return this.isOpen;
  }

  /** Local presentation only; lifecycle invalidation is never an item transfer. */
  hide() {
    this.element.hidden = true;
    this._view = null;
    this._state = {};
    this._rename = undefined;
    this._refreshTime = 0;
    this._renderRevision = null;
    this._interactions?.dispose();
    this._interactionEvents?.dispose();
    this._interactions = this._interactionEvents = null;
    if (this.element.contains(this.document.activeElement) &&
        this._previousFocus?.isConnected && !this._previousFocus.closest("[hidden]"))
      this._previousFocus.focus({ preventScroll: true });
    this._previousFocus = null;
  }

  close(reason = "closed") {
    if (!this.isOpen || this._closing || this._interactions?.busy) return false;
    const view = this._view;
    this._closing = true;
    try {
      const result = this.onClose(reason);
      if (result !== true && result?.ok !== true) {
        this._status(result?.message ?? "The interaction could not close.", true);
        return false;
      }
      // A synchronous parent lifecycle observer may already have hidden this
      // session and opened another. Its new control ownership must survive.
      if (this._view === view) this.hide();
      return true;
    } finally { this._closing = false; }
  }

  _status(message, error) {
    this.status.hidden = !message;
    this.status.dataset.state = error ? "error" : "idle";
    setText(this.status, message);
  }

  dispatch(action) {
    return this._interactions?.dispatch(action) ?? Promise.resolve(false);
  }

  async _action(action) {
    const view = this._view;
    if (!this.isOpen) return { ok: false, message: "Interaction closed." };
    if (action.type === "enchant") {
      const offer = view.offers?.[action.index];
      if (!offer) return { ok: false, message: progressionMessage("stale_offer") };
      action = { ...action, offerKey: offer.key };
    } else if (action.type === "takeCraftResult" || action.type === "takeResult") {
      action = { type: "takeResult", shift: action.shift === true,
        previewKey: view.preview?.key, rename: this._rename };
    }
    try {
      const result = await this.onAction({ ...action, sessionToken: view.sessionToken });
      return result?.ok || result === true ? result :
        { ...result, ok: false, message: result?.message ?? progressionMessage(result?.reason) };
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return { ok: false, message: "That action could not be completed." };
    }
  }

  /**
   * Parent may call this from its render loop. Hidden/unchanged menus do no
   * projection work. Brewing animation refreshes at most ten times per second;
   * it never advances the station, invents progress or serializes an archive.
   */
  frame(dt) {
    if (!this.isOpen || this._interactions?.busy || !Number.isFinite(dt) || dt <= 0 ||
        (!this.readRevision && this.kind !== "brewing")) return false;
    this._refreshTime += Math.min(dt, 0.25);
    if (this._refreshTime < 0.1) return false;
    this._refreshTime %= 0.1;
    if (this.readRevision && this.readRevision() === this._renderRevision) return false;
    return this.refresh();
  }

  refresh() {
    if (!this.isOpen) return false;
    let view = this.readView({ rename: this._rename });
    if (!view) { this.close("unavailable"); return false; }
    if (view.sessionToken !== this._view.sessionToken || view.kind !== this._view.kind) {
      this.hide();
      return false;
    }
    if (view.kind === "anvil") {
      const signature = JSON.stringify(view.slots[0]);
      if (signature !== this._leftSignature) {
        this._leftSignature = signature;
        this._rename = undefined;
        this._stationPanels.resetName(view.slots[0]?.data?.name);
        view = this.readView();
        if (!view) { this.close("unavailable"); return false; }
      }
    }
    this._view = view;
    this._state = { ...view.gameplay, containerSlots: view.slots ?? [],
      craftingResult: view.preview?.ok ? view.preview.output : null };
    this.element.dataset.kind = view.kind;
    setText(this.title, view.title);
    setText(this.location, view.kind === "trading" ? view.npcId :
      `${view.position.dimension}: ${view.position.x}, ${view.position.y}, ${view.position.z}`);
    this._stationPanels.update(view);
    this._tradingPanel.update(view);
    this._backpack.update(this._state.slots);
    this._hotbar.update(this._state.slots);
    this._equipment.forEach((slot, index) =>
      slot.update(this._state.equipment[EQUIPMENT_SLOTS[index]]));
    this._offhand.update(this._state.offhand);
    setText(this.level, `Level ${this._state.experience.level}`);
    this.dropCursor.hidden = !this._state.cursor;
    setText(this.note, `${view.kind === "trading" ? "" : "Station items stay here when you close. "}${this._state.mode === "creative"
      ? "These are owned slots, separate from the Creative palette."
      : "Carried items remain saved until you move or explicitly drop them."}`);
    this._renderRevision = this.readRevision?.() ?? null;
    this._interactions.update();
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this.hide();
    this._disposed = true;
    this._events.dispose();
    this.element.remove();
  }
}
