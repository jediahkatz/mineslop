import { HorseUI } from "./ui/horse-panel.js";
import { TransactionInvariantError } from "./transactions.js";

const refuse = (reason) => ({ ok: false, handled: true, reason });
const ACTIONS = Object.freeze([
  "click", "quickMove", "swapHotbar", "swapOffhand", "collect", "distribute", "drop",
]);

/**
 * Session authority only. There is no inventory/cursor copy here: every command
 * goes to Horses + the one real Gameplay owner. This overlay has its own gate;
 * opening it never makes ordinary Game/vehicle input actions available.
 */
export class GameHorseInventory {
  constructor(service) {
    this.service = service;
    this.session = null;
    this.revision = 0;
    this.ui = null;
    this._gate = null;
    this._plans = new WeakMap();
    this._headless = false;
  }

  bind(game, { root = null, headless = false } = {}) {
    if (typeof headless !== "boolean" || (root &&
        (root.ownerDocument !== game.player.element?.ownerDocument ||
          typeof root.append !== "function"))) return false;
    this._headless = headless;
    if (!root) return true;
    this.ui = new HorseUI(root, {
      readView: () => this.view(),
      readRevision: () => this.viewRevision,
      onAction: (command) => this.action(command),
      onClose: (command) => this.close(command),
    });
    // Kept out of JS module imports so detached Node owner tests stay DOM-free.
    const document = root.ownerDocument;
    if (document.head && !document.querySelector('link[data-horse-styles]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL("./ui/horse-panel.css", import.meta.url).href;
      link.dataset.horseStyles = "";
      document.head.append(link);
    }
    return true;
  }

  get isOpen() { return this.session !== null; }

  current(session = this.session, { closing = false } = {}) {
    const service = this.service, game = service._game;
    if (!session || this.session !== session || !service.active ||
        game.player !== session.player || game.wildlife !== session.wildlife ||
        service.horses.wildlife !== session.wildlife ||
        service.world.epoch !== session.epoch ||
        service.world.dimension !== session.dimension)
      return false;
    if (closing) return true;
    const mob = session.wildlife.byId.get(session.id);
    const chunk = service.world.chunks.get(session.column);
    return game.overlayOpen === true && !game.paused && !game.building &&
      !game.failed && !game.closingScreens && !service.gameplay.dead &&
      !game.progressionIntegration?.isOpen && !game.containerUI?.isOpen &&
      !game.ui?.isOverlayOpen && !game.ui?.isInventoryOpen &&
      mob === session.mob && !mob.dead && !mob.dormant &&
      chunk === session.chunk && chunk?.incarnation === session.incarnation &&
      service.horses.state(session.id)?.tamed === true;
  }

  get overlayGate() {
    return this._gate !== null && this.current(this._gate);
  }

  withGate(session, work) {
    if (this._gate || !this.current(session)) return refuse("stale-horse-session");
    this._gate = session;
    try { return work(); }
    finally { this._gate = null; }
  }

  _observe(work, errors = []) {
    try { return work(); }
    catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      errors.push(error);
      if (this.service._observerErrors.length < 16) this.service._observerErrors.push(error);
      return undefined;
    }
  }

  open(id, { validate = () => true } = {}) {
    const service = this.service, game = service._game;
    if (this.session || (!this.ui && !this._headless) ||
        !service._actionAvailable() || service._frameBusy || service._actionBusy)
      return refuse("horse-inventory-unavailable");
    const plan = service.horses.prepareInteraction(id, { inventory: true, validate });
    if (!plan.ok) return plan;
    const wildlife = service.horses.wildlife, mob = wildlife.byId.get(id);
    if (game.wildlife !== wildlife || !mob || validate() !== true)
      return refuse("stale-horse-target");
    const column = `${Math.floor(mob.position.x / 16)},${Math.floor(mob.position.z / 16)}`;
    const chunk = service.world.chunks.get(column);
    if (!chunk || !Number.isSafeInteger(this.revision + 1))
      return refuse("horse-inventory-frontier");
    this.session = Object.freeze({
      token: ++this.revision, id, mob, wildlife, game, player: game.player,
      epoch: service.world.epoch, dimension: service.world.dimension,
      column, chunk, incarnation: chunk.incarnation,
    });
    const session = this.session;
    const observerErrors = [];
    // This input/overlay notification owns no resource. The UI opens only after
    // the session exists, and every later mutation checks its captured token.
    this._observe(() => game.overlayChanged?.(true), observerErrors);
    if (this.session !== session || !this.current(session) ||
        (this.ui && this._observe(() => this.ui.open(), observerErrors) !== true)) {
      const closed = this.close({ sessionToken: session.token, reason: "unavailable" });
      return { ...refuse("horse-inventory-unavailable"),
        observerErrors: [...observerErrors, ...(closed.observerErrors ?? [])] };
    }
    return { ok: true, handled: true, action: "inventory", id, opened: true, observerErrors };
  }

  get viewRevision() {
    const { service, session } = this;
    return session && this.current(session)
      ? `${session.token}:${service.horses.revision}:${service.gameplay.revision}` : null;
  }

  view() {
    if (!this.current()) return null;
    const state = this.service.horses.state(this.session.id);
    return Object.freeze({
      kind: "horse", sessionToken: this.session.token, horseId: this.session.id,
      dimension: this.session.dimension, tamed: state.tamed, ridden: state.rider === "player",
      slots: Object.freeze([state.saddle]), gameplay: this.service.gameplay.getState(),
      supportedActions: ACTIONS,
    });
  }

  prepareAction(command) {
    const session = this.session;
    if (!session || command?.sessionToken !== session.token ||
        !ACTIONS.includes(command.type)) return refuse("stale-horse-session");
    const { sessionToken, ...action } = command;
    return this.withGate(session, () => {
      const plan = this.service.horses.prepareSlotAction(session.id, action, {
        validate: () => sessionToken === session.token && this.current(session),
      });
      if (plan.ok) this._plans.set(plan, session);
      return plan;
    });
  }

  commit(plan) {
    if (!plan?.ok) return plan ?? refuse("invalid-horse-plan");
    const session = this._plans.get(plan);
    if (!session) return refuse("foreign-horse-slot-plan");
    return this.withGate(session, () => this.service.horses.commit(plan));
  }

  action(command) {
    const result = this.commit(this.prepareAction(command));
    if (!result.ok) return result;
    const observerErrors = [...(result.observerErrors ?? [])];
    // The slot/Gameplay publishers have already committed. A rendering error
    // must never invite the UI to retry an already-paid transfer.
    this._observe(() => this.ui?.refresh(), observerErrors);
    return { ...result, observerErrors };
  }

  close(command = {}) {
    const session = this.session;
    if (!session)
      return command.sessionToken === undefined ? { ok: true, changed: false } : refuse("stale-horse-session");
    if (command.sessionToken !== session.token || this._gate)
      return refuse("stale-horse-session");
    const game = this.service._game;
    // Invalidating an epoch/base makes slot actions stale, not the overlay's
    // obligation to close. Never close a replacement Game or another modal.
    const ownsOverlay = () => this.session === null && game === session.game &&
      game === this.service._game && game?.vehicleServices === this.service &&
      game.player === session.player && game.overlayOpen === true &&
      !game.progressionIntegration?.isOpen && !game.containerUI?.isOpen &&
      !game.ui?.isOverlayOpen && !game.ui?.isInventoryOpen;
    // Closing invalidates the lease only. The exact Gameplay cursor remains
    // owned/saved, even with a full backpack or a refusing overflow sink.
    this.session = null;
    this.revision++;
    const observerErrors = [];
    this._observe(() => this.ui?.hide(), observerErrors);
    if (ownsOverlay()) this._observe(() => game.overlayChanged?.(false), observerErrors);
    return { ok: true, changed: true, escrowRetained: true, observerErrors };
  }

  closeCurrent(reason) {
    return this.close(this.session ? { sessionToken: this.session.token, reason } : { reason });
  }

  frame(dt) {
    if (this.session && !this.current()) this.closeCurrent("unavailable");
    this._observe(() => this.ui?.frame(dt));
  }

  dispose() {
    if (this._gate) return false;
    if (!this.closeCurrent("dispose").ok) return false;
    this._observe(() => this.ui?.dispose());
    this.ui = null;
    return true;
  }
}
