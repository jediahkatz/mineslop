import { TransactionInvariantError } from "../transactions.js";
import { createEventScope, element, isTextInput, setText, trapFocus } from "./dom.js";
import { createSlotInteractions } from "./slot-interactions.js";
import { createSlotGrid, createStackSlot } from "./slots.js";

const ACTIONS = new Set([
  "click", "quickMove", "swapHotbar", "swapOffhand", "drop", "collect", "distribute",
]);
let nextPanelId = 0;

function validView(view) {
  return view?.kind === "horse" && view.sessionToken !== undefined &&
    view.sessionToken !== null && typeof view.horseId === "string" && view.horseId.length > 0 &&
    typeof view.tamed === "boolean" && typeof view.ridden === "boolean" &&
    Array.isArray(view.slots) && view.slots.length === 1 &&
    Array.isArray(view.gameplay?.slots) && view.gameplay.slots.length === 36 &&
    Object.hasOwn(view.gameplay, "cursor") && Array.isArray(view.supportedActions);
}

/**
 * Callback-only saddle screen. Parent imports horse-panel.css with the existing
 * UI styles and owns session authority, HUD, pause, input and pointer lock.
 *
 * readView() -> null or an immutable committed projection:
 * { kind:"horse", sessionToken, horseId, dimension, tamed, ridden,
 *   slots:[exactSaddleStackOrNull], gameplay:Gameplay.getState(),
 *   supportedActions:["click", ...] }
 * Only advertise actions the backend actually implements, from ACTIONS above.
 * "container":0 is the sole horse slot. "inventory":0..35 are OWNED slots even
 * in Creative. Offhand is shown only when swapOffhand is supported and projected.
 * No armor/lead/Creative catalog/crafting slots or local inventory authority.
 *
 * readRevision() -> optional cheap key covering session + horse + Gameplay.
 * onAction({...sharedSlotCommand, sessionToken}) -> true/{ok:true} ONLY after
 * the backend's atomic commit; a Promise is allowed. Backend rechecks the token,
 * access/taming, saddle identity/count and capacity; it owns all refusals/drops.
 * Horses.slotAction(id, command, {validate}) takes the command WITHOUT its
 * sessionToken. Parent captures that exact token in validate for commit-time
 * session authority; never just strip it and dispatch to the current horse.
 * onClose({type:"close", reason, sessionToken}) -> synchronous commit receipt.
 * Close never silently returns/drops/deletes the actual Gameplay cursor.
 *
 * Parent calls open/hide from its session observer and frame(dt) while open.
 * All control listeners and the sole cursor projection exist only while open.
 */
export class HorseUI {
  constructor(root, { readView, readRevision, onAction, onClose } = {}) {
    if (![readView, onAction, onClose].every((value) => typeof value === "function") ||
        (readRevision !== undefined && typeof readRevision !== "function"))
      throw new TypeError("Horse UI requires live view/action/close callbacks");
    Object.assign(this, { readView, readRevision, onAction, onClose, document: root.ownerDocument });
    this._view = null;
    this._state = {};
    this._disposed = false;
    this._closing = false;
    this._events = null;
    this._interactions = null;
    this._refreshTime = 0;
    this._renderRevision = null;

    const titleId = `horse-title-${++nextPanelId}`;
    this.element = element("div", "horse-overlay");
    this.element.hidden = true;
    this.element.tabIndex = -1;
    const layout = element("div", "horse-layout");
    this.panel = element("section", "horse-panel pixel-panel");
    this.panel.tabIndex = -1;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", titleId);
    const header = element("header", "horse-header");
    const titles = element("div");
    const brand = element("p", "horse-brand", "Mineslop");
    this.title = element("h2", "", "Horse");
    this.title.id = titleId;
    titles.append(brand, this.title);
    this.closeButton = element("button", "horse-close icon-button", "×");
    this.closeButton.type = "button";
    this.closeButton.setAttribute("aria-label", "Close horse saddle screen");
    header.append(titles, this.closeButton);
    this.location = element("p", "horse-location");

    const work = element("div", "horse-work");
    const saddle = element("div", "horse-saddle-slot");
    saddle.setAttribute("role", "group");
    saddle.setAttribute("aria-label", "Horse saddle: one owned slot");
    this._saddle = createStackSlot({ area: "container", label: "Saddle", placeholder: "S" });
    saddle.append(this._saddle.node, element("span", "horse-slot-label", "Saddle"));
    const summary = element("div", "horse-summary");
    this.condition = element("p", "horse-condition");
    this.riding = element("p", "horse-riding");
    summary.append(this.condition, this.riding);
    work.append(saddle, summary);

    const inventoryLabel = element("h3", "horse-inventory-label", "Inventory");
    const backpack = element("div", "horse-backpack player-slot-grid");
    backpack.setAttribute("role", "group");
    backpack.setAttribute("aria-label", "Backpack: 27 owned slots");
    this._backpack = createSlotGrid(backpack, {
      area: "inventory", indices: Array.from({ length: 27 }, (_, i) => i + 9),
    });
    const hotbar = element("div", "horse-hotbar player-slot-grid");
    hotbar.setAttribute("role", "group");
    hotbar.setAttribute("aria-label", "Hotbar: 9 owned slots");
    this._hotbar = createSlotGrid(hotbar, {
      area: "inventory", indices: Array.from({ length: 9 }, (_, i) => i),
      labels: Array.from({ length: 9 }, (_, i) => `Hotbar ${i + 1}`),
    });
    this.offhandGroup = element("div", "horse-offhand");
    this.offhandGroup.hidden = true;
    this._offhand = createStackSlot({ area: "offhand", label: "Offhand", placeholder: "F" });
    this.offhandGroup.append(this._offhand.node, element("span", "horse-slot-label", "Offhand"));
    this.dropCursor = element("button", "horse-drop-cursor", "Drop carried stack");
    this.dropCursor.type = "button";
    this.dropCursor.hidden = true;
    this.note = element("p", "horse-note");
    this.status = element("p", "horse-status");
    this.status.hidden = true;
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.help = element("p", "horse-help");
    this.panel.append(header, this.location, work, inventoryLabel, backpack,
      hotbar, this.offhandGroup, this.dropCursor, this.note, this.status);
    layout.append(this.panel, this.help);
    this.element.append(layout);
    root.append(this.element);
  }

  get isOpen() { return !this._disposed && !this.element.hidden && this._view !== null; }
  get kind() { return this._view?.kind ?? null; }

  _supports(type) {
    return ACTIONS.has(type) && this._view?.supportedActions.includes(type) === true;
  }

  _hasOffhand() {
    return this._supports("swapOffhand") && Object.hasOwn(this._state, "offhand");
  }

  _bindInteractions() {
    this._events = createEventScope();
    const { listen } = this._events;
    this._interactions = createSlotInteractions(this.element, {
      listen, getState: () => this._state,
      onAction: (action) => this._action(action),
      onStatus: (message, error) => this._status(message, error),
      onRefresh: () => this.refresh(),
    });
    listen(this.closeButton, "click", () => this.close());
    listen(this.dropCursor, "click", () => this.dispatch({
      type: "drop", area: "cursor", index: 0, wholeStack: true,
    }));
    // The shared controller consumes captured slot clicks before this handler.
    listen(this.element, "click", (event) => {
      if (event.target === this.element) this.close();
    });
    listen(this.document, "keydown", (event) => {
      if (!this.isOpen) return;
      trapFocus(event, this.element);
      const inventoryKey = event.code === "KeyE" && !isTextInput(event.target) &&
        !event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.code === "Escape" || event.key === "Escape" || inventoryKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) this.close();
      }
    }, { capture: true });
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup",
      "mousedown", "mouseup", "click", "dblclick", "wheel"])
      listen(this.element, type, (event) => event.stopPropagation());
    this.element.setAttribute("aria-busy", "false");
  }

  open() {
    if (this._disposed) return false;
    const view = this.readView();
    if (!validView(view)) return false;
    if (this.isOpen) this.hide();
    this._previousFocus = this.document.activeElement;
    this._view = view;
    this._refreshTime = 0;
    this._renderRevision = null;
    this.element.hidden = false;
    this._bindInteractions();
    this._status("", false);
    this.refresh();
    if (this.isOpen) this.closeButton.focus({ preventScroll: true });
    return this.isOpen;
  }

  /** Presentation teardown only. Parent remains the session/cursor authority. */
  hide() {
    this.element.hidden = true;
    this._view = null;
    this._state = {};
    this._refreshTime = 0;
    this._renderRevision = null;
    this._interactions?.dispose();
    this._events?.dispose();
    this._interactions = this._events = null;
    if (this.element.contains(this.document.activeElement) &&
        this._previousFocus?.isConnected && !this._previousFocus.closest("[hidden]"))
      this._previousFocus.focus({ preventScroll: true });
    this._previousFocus = null;
  }

  close(reason = "closed") {
    if (!this.isOpen || this._closing || this._interactions?.busy) return false;
    const controller = this._interactions;
    this._closing = true;
    try {
      const result = this.onClose({ type: "close", reason, sessionToken: this._view.sessionToken });
      if (result !== true && result?.ok !== true) {
        if (this._interactions === controller)
          this._status(result?.message ?? "The horse interaction could not close.", true);
        return false;
      }
      // A synchronous parent observer may already have opened another session.
      if (this._interactions === controller) this.hide();
      return true;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      if (this._interactions === controller)
        this._status("The horse interaction could not close.", true);
      return false;
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
    if (!this.isOpen) return { ok: false, message: "Horse interaction closed." };
    const address = (value) => Number.isInteger(value?.index) && (
      (value.area === "container" && value.index === 0) ||
      (value.area === "inventory" && value.index >= 0 && value.index < 36) ||
      (value.area === "offhand" && value.index === 0 && this._hasOffhand()) ||
      (value.area === "cursor" && value.index === 0 && action.type === "drop")
    );
    const targets = action?.type === "distribute"
      ? Array.isArray(action.targets) && action.targets.length > 0 &&
        action.targets.length <= 38 && action.targets.every(address)
      : address(action);
    if (!this._supports(action?.type) || !targets ||
        (action.type === "swapOffhand" && !this._hasOffhand()))
      return { ok: false, message: "That action is not available in this saddle screen." };
    const sessionToken = this._view.sessionToken;
    try {
      const result = await this.onAction({ ...action, sessionToken });
      return result === true || result?.ok === true ? result :
        { ok: false, message: result?.message ?? "That item could not be moved." };
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return { ok: false, message: "That item could not be moved." };
    }
  }

  frame(dt) {
    if (!this.isOpen || !this.readRevision || this._interactions?.busy ||
        !Number.isFinite(dt) || dt <= 0) return false;
    this._refreshTime += Math.min(dt, 0.25);
    if (this._refreshTime < 0.1) return false;
    this._refreshTime %= 0.1;
    if (this.readRevision() === this._renderRevision) return false;
    return this.refresh();
  }

  refresh() {
    if (!this.isOpen) return false;
    const view = this.readView();
    if (!validView(view)) { this.close("unavailable"); return false; }
    if (view.sessionToken !== this._view.sessionToken || view.horseId !== this._view.horseId) {
      this.hide();
      return false;
    }
    this._view = view;
    // Retain only the actual projection, never a second writable carried stack.
    this._state = { ...view.gameplay, containerSlots: view.slots };
    this._saddle.update(view.slots[0], { disabled: !this._supports("click") });
    this._backpack.update(this._state.slots);
    this._hotbar.update(this._state.slots);
    this.offhandGroup.hidden = !this._hasOffhand();
    this._offhand.update(this._state.offhand);
    this.dropCursor.hidden = !this._state.cursor || !this._supports("drop");
    setText(this.location, `${view.dimension ?? ""} · ${view.horseId}`);
    setText(this.condition, `${view.tamed === true ? "Tamed" : "Untamed"} horse`);
    setText(this.riding, view.slots[0]
      ? "Saddled" : view.ridden === true ? "Riding bareback" : "No saddle equipped");
    setText(this.note, view.ridden === true
      ? view.slots[0]
        ? "Removing the saddle leaves you mounted without steering or jumping."
        : "Bareback riding has no steering or charged jump. A tamed horse needs a saddle."
      : view.tamed !== true ? "Tame this horse before equipping a saddle."
        : "Equip a saddle to steer and jump while riding.");
    const help = [
      ...(this._supports("click") ? ["Left: move stack", "Right: half / one"] : []),
      ...(this._supports("quickMove") ? ["Shift: quick move"] : []),
      ...(this._supports("distribute") ? ["Drag: distribute"] : []),
      ...(this._supports("collect") ? ["Double-click: collect"] : []),
      ...(this._supports("swapHotbar") ? ["1–9: owned hotbar"] : []),
      ...(this._hasOffhand() ? ["F: offhand"] : []),
      ...(this._supports("drop") ? ["Q / Ctrl+Q: drop"] : []),
      "E / Esc: close", "Carried items stay in your inventory cursor when closed.",
    ];
    setText(this.help, help.join(" · "));
    this._renderRevision = this.readRevision?.() ?? null;
    this._interactions.update();
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this.hide();
    this._disposed = true;
    this.element.remove();
  }
}
