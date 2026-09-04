import { CHEST_SLOTS } from "./settlement.js";
import { CONTAINER_TITLES, isStorageKind, isFurnaceKind } from "./container-kinds.js";
import { TransactionInvariantError } from "./transactions.js";
import { createEventScope, isTextInput, setText, trapFocus } from "./ui/dom.js";
import { clamp } from "./ui/model.js";
import { pixelIcon } from "./ui/pixel-icons.js";
import { createSlotInteractions } from "./ui/slot-interactions.js";
import { ownedSlotStacks } from "./ui/slot-model.js";
import { createSlotGrid, createStackSlot } from "./ui/slots.js";

const noOp = () => {};

export class ContainerUI {
  /**
   * Prepared drop/XP callbacks participate in the same ownership transaction.
   * Drops are forwarded for every action, including cursor/grid return on close.
   * onChange receives { action, kind, ...result } after an accepted transaction.
   * experienceCommitted means the parent must NOT award that XP again.
   */
  constructor(
    root,
    {
      onOpenChange = noOp,
      onChange = noOp,
      onToast = noOp,
      prepareDrops,
      prepareExperience,
    } = {}
  ) {
    this.document = root.ownerDocument;
    this.onOpenChange = onOpenChange;
    this.onChange = onChange;
    this.onToast = onToast;
    this.prepareDrops = prepareDrops;
    this.prepareExperience = prepareExperience;
    this.observerErrors = [];
    this._session = null;
    this._state = {};
    this._signature = "";
    this._events = createEventScope();
    const { listen } = this._events;
    this.element = this.document.createElement("div");
    this.element.className = "settlement-overlay";
    this.element.tabIndex = -1;
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="settlement-layout">
        <section class="settlement-panel pixel-panel" role="dialog" aria-modal="true" aria-labelledby="container-title" tabindex="-1">
          <header class="settlement-header"><h2 id="container-title">Chest</h2><button type="button" class="settlement-close icon-button" data-action="close" aria-label="Close container">×</button></header>
          <p class="settlement-location"></p>
          <div class="settlement-chest player-slot-grid" data-grid="chest" role="group" aria-label="Chest: 27 slots"></div>
          <div class="furnace-workbench" hidden>
            <div class="furnace-input"></div>
            <div class="furnace-burn" role="progressbar" aria-label="Fuel remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="furnace-flame-empty">${pixelIcon("flame")}</span><span class="furnace-flame-fill">${pixelIcon("flame")}</span></div>
            <div class="furnace-fuel"></div>
            <div class="furnace-cook" role="progressbar" aria-label="Smelting progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span>➜</span><span class="furnace-cook-fill">➜</span></div>
            <div class="furnace-output"></div>
          </div>
          <h3 class="settlement-inventory-label">Inventory</h3>
          <div class="settlement-backpack player-slot-grid" data-grid="backpack" role="group" aria-label="Backpack: 27 slots"></div>
          <div class="settlement-hotbar player-slot-grid" role="group" aria-label="Hotbar: 9 owned slots"></div>
          <div class="settlement-offhand" hidden><span>Offhand</span></div>
          <p class="settlement-owned-note" hidden>Owned items only. The Creative palette is separate.</p>
          <p class="settlement-status" role="status" aria-live="polite" hidden></p>
        </section>
        <p class="settlement-help">Left-click: move stack · Right-click: half / one · Shift-click: quick move<br>1–9: hotbar · F: offhand · Q / Ctrl+Q: drop · E / Esc: close</p>
      </div>`;
    root.append(this.element);
    const $ = (selector) => this.element.querySelector(selector);
    this.panel = $(".settlement-panel");
    this.closeButton = $(".settlement-close");
    this.status = $(".settlement-status");
    this._chest = createSlotGrid($(".settlement-chest"), {
      area: "container",
      indices: Array.from({ length: CHEST_SLOTS }, (_, index) => index),
      labels: Array.from(
        { length: CHEST_SLOTS },
        (_, index) => `Chest ${index + 1}`
      ),
      className: "settlement-slot",
    });
    this._furnace = ["input", "fuel", "output"].map((name, index) => {
      const slot = createStackSlot({
        area: "container",
        index,
        label: `Furnace ${name}`,
        className:
          name === "output" ? "result-slot settlement-slot" : "settlement-slot",
      });
      $(`.furnace-${name}`).append(slot.node);
      return slot;
    });
    this._backpack = createSlotGrid($(".settlement-backpack"), {
      area: "inventory",
      indices: Array.from({ length: 27 }, (_, index) => index + 9),
      className: "settlement-slot",
    });
    this._hotbar = createSlotGrid($(".settlement-hotbar"), {
      area: "inventory",
      indices: Array.from({ length: 9 }, (_, index) => index),
      labels: Array.from({ length: 9 }, (_, index) => `Hotbar ${index + 1}`),
      className: "settlement-slot",
    });
    this._offhand = createStackSlot({ area: "offhand", label: "Offhand" });
    $(".settlement-offhand").append(this._offhand.node);
    this._interactions = createSlotInteractions(this.element, {
      listen,
      getState: () => this._state,
      onAction: (action) => this._action(action),
      onStatus: (message, error) => this._setStatus(message, error),
      onRefresh: () => this.refresh(),
    });

    listen(this.closeButton, "click", () => this.close());
    listen(this.element, "click", (event) => {
      if (event.target === this.element) this.close();
    });
    listen(
      this.document,
      "keydown",
      (event) => {
        if (!this.isOpen) return;
        trapFocus(event, this.element);
        if (
          event.code === "Escape" ||
          event.key === "Escape" ||
          (event.code === "KeyE" && !isTextInput(event.target))
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!event.repeat) this.close();
        }
      },
      { capture: true }
    );
    for (const type of [
      "keydown",
      "keyup",
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "wheel",
    ])
      listen(this.element, type, (event) => event.stopPropagation());
    listen(this.element, "contextmenu", (event) => event.preventDefault());
  }

  get isOpen() {
    return this._session !== null;
  }

  get kind() {
    return this._session?.kind || null;
  }

  open(world, hit, gameplay, settlement, { validate } = {}) {
    if (validate !== undefined && (typeof validate !== "function" || validate() !== true))
      return false;
    const snapshot = settlement.getContainerState?.(world, hit, gameplay);
    if (!snapshot || !Object.hasOwn(CONTAINER_TITLES, snapshot.kind)) {
      this.onToast("That container is no longer available");
      return false;
    }
    if (this.isOpen && !this.close()) return false;
    this._previousFocus = this.document.activeElement;
    this._session = {
      world,
      gameplay,
      settlement,
      validate,
      kind: snapshot.kind,
      hit: { ...hit, id: world.get(hit.x, hit.y, hit.z), dimension: world.dimension },
    };
    this._signature = "";
    this.element.hidden = false;
    this.element.dataset.kind = snapshot.kind;
    this._setStatus("", false);
    this.refresh();
    this._observe(() => this.onOpenChange(true));
    this.closeButton.focus({ preventScroll: true });
    return true;
  }

  /**
   * Normal close returns owned cursor/grid contents through the domain and can
   * fail without hiding the screen. force only detaches an invalid/dead screen:
   * it never clears Gameplay's cursor/grid, which remain owned and serializable.
   */
  close({ force = false } = {}) {
    if (!this.isOpen) return false;
    if (!force) {
      if (this._interactions.busy) return false;
      const result = this._action({ type: "close" });
      if (!result?.ok) {
        this._setStatus(
          result?.message || "Could not return carried items. Try again.",
          true
        );
        return false;
      }
    }
    this._session = null;
    this._signature = "";
    this.element.hidden = true;
    this._interactions.reset();
    if (
      this.element.contains(this.document.activeElement) &&
      this._previousFocus?.isConnected &&
      !this._previousFocus.closest("[hidden]")
    )
      this._previousFocus.focus({ preventScroll: true });
    this._previousFocus = null;
    this._observe(() => this.onOpenChange(false));
    return true;
  }

  _observe(callback, errors = (this.observerErrors ??= [])) {
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }

  _setStatus(message, error) {
    this.status.hidden = !message;
    this.status.dataset.state = error ? "error" : "idle";
    setText(this.status, message);
  }

  _action(action) {
    if (!this.isOpen) return { ok: false, message: "Container closed" };
    const session = this._session;
    const { world, hit, gameplay, settlement, kind, validate } = session;
    if (validate && validate() !== true) {
      this.close({ force: true });
      return { ok: false, message: "That container is no longer available" };
    }
    let result;
    try {
      result = settlement.containerAction(world, hit, gameplay, action, {
        prepareDrops: this.prepareDrops,
        prepareExperience: this.prepareExperience,
        validate: () => this._session === session && (!validate || validate() === true),
      });
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return {
        ok: false,
        message: error?.message || "That transfer could not be completed.",
      };
    }
    if (result?.ok) {
      const errors = [...(result.observerErrors ?? [])];
      this.observerErrors = errors;
      this._observe(() => this.onChange({ action, kind, ...result }), errors);
      this._observe(() => this.refresh(), errors);
      return { ...result, observerErrors: errors };
    }
    return result;
  }

  refresh() {
    if (!this.isOpen) return false;
    const { world, hit, gameplay, settlement, kind, validate } = this._session;
    if (validate && validate() !== true) {
      this.close({ force: true });
      return false;
    }
    const snapshot = settlement.getContainerState(world, hit, gameplay);
    if (!snapshot || snapshot.kind !== kind) {
      this.close({ force: true });
      this.onToast("Container closed — it is no longer available");
      return false;
    }
    const $ = (selector) => this.element.querySelector(selector);
    this._state = {
      ...(snapshot.gameplay || snapshot.player || gameplay.getState()),
      containerSlots: snapshot.slots,
    };
    const signature = JSON.stringify([
      snapshot.slots,
      this._state.slots,
      this._state.cursor,
      this._state.offhand,
      this._state.mode,
    ]);
    if (signature !== this._signature) {
      this._signature = signature;
      const disabled = !Array.isArray(this._state.slots);
      $(".settlement-chest").hidden = !isStorageKind(kind);
      $(".furnace-workbench").hidden = !isFurnaceKind(kind);
      $(".settlement-chest").setAttribute("aria-label", `${CONTAINER_TITLES[kind]}: 27 slots`);
      setText(
        $("#container-title"),
        snapshot.title || CONTAINER_TITLES[kind]
      );
      this.closeButton.setAttribute("aria-label", `Close ${kind}`);
      const position = snapshot.position || hit;
      setText(
        $(".settlement-location"),
        `${position.dimension || world.dimension}: ${position.x}, ${position.y}, ${position.z}`
      );
      this._chest.update(snapshot.slots || [], {
        disabled: disabled || !isStorageKind(kind),
      });
      for (const slot of this._chest.slots) {
        slot.node.setAttribute("aria-label",
          slot.node.getAttribute("aria-label").replace(/^Chest/, CONTAINER_TITLES[kind]));
      }
      this._furnace.forEach((slot, index) =>
        slot.update(snapshot.slots?.[index], {
          disabled: disabled || !isFurnaceKind(kind),
        })
      );
      for (const slot of this._furnace) {
        slot.node.setAttribute("aria-label",
          slot.node.getAttribute("aria-label").replace(/^Furnace/, CONTAINER_TITLES[kind]));
      }
      const slots = ownedSlotStacks(this._state);
      this._backpack.update(slots, { disabled });
      this._hotbar.update(slots, { disabled });
      this._offhand.update(this._state.offhand, { disabled });
      $(".settlement-offhand").hidden = !this._state.offhand;
      $(".settlement-owned-note").hidden = this._state.mode !== "creative";
    }
    if (isFurnaceKind(kind)) {
      const burn = clamp(snapshot.burnProgress);
      const cook = clamp(snapshot.cookProgress);
      $(".furnace-burn").setAttribute(
        "aria-valuenow",
        String(Math.round(burn * 100))
      );
      $(".furnace-cook").setAttribute(
        "aria-valuenow",
        String(Math.round(cook * 100))
      );
      $(".furnace-flame-fill").style.clipPath =
        `inset(${(1 - burn) * 100}% 0 0 0)`;
      $(".furnace-cook-fill").style.clipPath =
        `inset(0 ${(1 - cook) * 100}% 0 0)`;
    }
    this._interactions.update();
    return true;
  }

  dispose() {
    this.close({ force: true });
    this._interactions.dispose();
    this._events.dispose();
    this.element.remove();
  }
}
