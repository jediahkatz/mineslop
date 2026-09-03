import { entityContextFor, matchesEntityContext } from "./entity-context.js";
import { prepareHostedPearlImpact } from "./game-projectile-ownership.js";
import {
  LOCAL_PROJECTILE_OWNER,
  normalizeProjectileServicesSnapshot,
} from "./game-projectile-state.js";
import { ITEM } from "./items.js";
import { PearlRenderer } from "./pearl-render.js";
import { MAX_PEARL_ID } from "./pearl-save.js";
import { PLAYER_WIDTH } from "./player.js";
import { PlayerProjectiles } from "./player-projectiles.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export { normalizeProjectileServicesSnapshot } from "./game-projectile-state.js";

const refused = (reason) => ({ ok: false, reason });
const canBind = (game, key) => {
  const property = Object.getOwnPropertyDescriptor(game, key);
  return property
    ? Object.hasOwn(property, "value") &&
        property.writable &&
        property.value == null
    : Object.isExtensible(game);
};

/** Stages save ownership without a Player, scene, DOM, flight or chunk request. */
export class GameProjectileServices {
  constructor({
    world,
    gameplay,
    context = gameplay?.context ?? world,
    saved = null,
    allowOverBudget = false,
  } = {}) {
    context = entityContextFor(world, context);
    const normalized = normalizeProjectileServicesSnapshot(saved, context);
    const coordinator = world?.coordinator;
    if (
      !normalized ||
      !(coordinator instanceof TransactionCoordinator) ||
      gameplay?.coordinator !== coordinator ||
      !matchesEntityContext(world, context) ||
      world._disposed ||
      gameplay._disposed ||
      coordinator.usage(world) === undefined ||
      coordinator.usage(gameplay) === undefined ||
      typeof allowOverBudget !== "boolean"
    )
      throw new RangeError("Invalid staged projectile services");
    this.world = world;
    this.gameplay = gameplay;
    this.context = context;
    this.coordinator = coordinator;
    this._owners = { world, gameplay, context, coordinator };
    this._gameplayContext = gameplay.context;
    this._preparedEpoch = world.epoch;
    this._preparedDimension = world.dimension;
    this._game = null;
    this._scene = null;
    this._disposed = false;
    this._frameBusy = false;
    this._rendered = false;
    this.renderer = null;
    this.observerErrors = [];
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot reserve projectile lifecycle");
    try {
      const packet = normalized.playerProjectiles;
      this.projectiles = new PlayerProjectiles(world, {
        context,
        coordinator,
        ownerId: packet?.ownerId ?? LOCAL_PROJECTILE_OWNER,
        life: packet?.life ?? 0,
        allowOverBudget,
        staged: true,
        getOwner: (id) => this._readOwner(id),
        prepareHeldCost: (request) => this._prepareHand(request),
        prepareImpact: (request) => prepareHostedPearlImpact(this, request),
        onEvent: (event) => this._onEvent(event),
      });
      if (packet && !this.projectiles.load(packet, { allowOverBudget }))
        throw new RangeError("Cannot restore staged player projectiles");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get game() {
    return this._game;
  }

  _available() {
    return (
      !this._disposed &&
      this.world === this._owners.world &&
      this.gameplay === this._owners.gameplay &&
      this.context === this._owners.context &&
      this.coordinator === this._owners.coordinator &&
      !this.world._disposed &&
      !this.gameplay._disposed &&
      this.gameplay.context === this._gameplayContext &&
      this.world.coordinator === this.coordinator &&
      this.gameplay.coordinator === this.coordinator &&
      matchesEntityContext(this.world, this.context) &&
      this.coordinator.usage(this) === 0 &&
      this.coordinator.usage(this.world) !== undefined &&
      this.coordinator.usage(this.gameplay) !== undefined &&
      this.projectiles?.world === this.world &&
      this.projectiles.coordinator === this.coordinator &&
      !this.projectiles._disposed
    );
  }

  get active() {
    const game = this._game;
    return (
      this._available() &&
      !!game &&
      game.projectileServices === this &&
      game.projectiles === this.projectiles &&
      game.world === this.world &&
      game.gameplay === this.gameplay &&
      game.player?.world === this.world &&
      game.graphics?.scene === this._scene &&
      game.graphics?.camera === game.player.camera
    );
  }

  get running() {
    const game = this._game;
    return (
      this.active &&
      !game.paused &&
      !game.building &&
      !game.failed &&
      !this.gameplay.dead &&
      game.simulating === true
    );
  }

  _readOwner(id) {
    if (!this.active || id !== this.projectiles.ownerId) return null;
    const player = this._game.player;
    return {
      id,
      life: this.projectiles.life,
      ref: player,
      world: this.world,
      dimension: this.world.dimension,
      alive: !this.gameplay.dead,
      mode: this.gameplay.mode,
      position: player.position,
      eye: player.eyePosition,
      forward: player.forward,
      radius: PLAYER_WIDTH / 2,
      height: player.height,
    };
  }

  _prepareHand({ world, ownerRef, life, hand, stack, handRevision, count }) {
    if (
      !this.running ||
      !this._game.active ||
      world !== this.world ||
      ownerRef !== this._game.player ||
      life !== this.projectiles.life
    )
      return null;
    const game = this._game;
    const cost = this.gameplay.prepareHandCost(hand, {
      stack,
      handRevision,
      count,
    });
    return (
      cost && {
        ...cost,
        validate: () =>
          this.running &&
          game.active &&
          this._game === game &&
          game.player === ownerRef &&
          this.projectiles.life === life &&
          cost.validate(),
      }
    );
  }

  activate(game) {
    if (
      !game ||
      !this._available() ||
      game.world !== this.world ||
      game.gameplay !== this.gameplay ||
      game.player?.world !== this.world
    )
      return refused("stale-projectile-host");
    if (this._game)
      return this._game === game && this.active
        ? { ok: true }
        : refused("already-bound");
    if (
      this.world.epoch !== this._preparedEpoch ||
      this.world.dimension !== this._preparedDimension ||
      !canBind(game, "projectileServices") ||
      !canBind(game, "projectiles") ||
      !this.coordinator.register(this, 0, { allowOverBudget: true })
    )
      return refused("stale-projectile-stage");
    this._game = game;
    this._scene = game.graphics?.scene;
    game.projectileServices = this;
    game.projectiles = this.projectiles;
    if (!this.projectiles.activateOwner()) {
      game.projectileServices = game.projectiles = null;
      this._game = this._scene = null;
      return refused("invalid-projectile-owner");
    }
    this.render();
    return { ok: true };
  }

  _ensureRenderer() {
    if (
      !this.active ||
      this._game.graphics?.scene !== this._scene ||
      typeof this._scene?.add !== "function" ||
      typeof this._scene?.remove !== "function"
    )
      return false;
    this.renderer ??= new PearlRenderer(this._scene);
    return true;
  }

  throw(hand = "main") {
    if (
      !this.running ||
      !this._game.active ||
      this.projectiles.life >= MAX_PEARL_ID ||
      !["main", "offhand"].includes(hand)
    )
      return false;
    const stack = this.gameplay.getHandStack(hand);
    if (stack?.id !== ITEM.ENDER_PEARL || !this._ensureRenderer()) return false;
    const plan = this.projectiles.prepareThrow({
      hand,
      stack,
      handRevision: this.gameplay.getHandRevision(hand),
    });
    if (!plan) return false;
    const result = this.coordinator.commit(plan.participants);
    this._observeResult(result);
    return result.ok;
  }

  _observeResult(result) {
    this.observerErrors = (result.observerErrors ?? []).slice(0, 16);
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
  }

  _onEvent(event) {
    if (
      !this.active ||
      event.ownerId !== this.projectiles.ownerId ||
      (event.type !== "cancel" && event.dimension !== this.world.dimension)
    )
      return;
    const game = this._game;
    const errors = [];
    const observe = (callback) => {
      if (!this.active || this._game !== game) return;
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    };
    if (event.type === "throw") {
      const handView =
        event.hand === "offhand" ? game.effects?.offhand : game.effects;
      if (handView) handView.swing = 1;
      observe(() => game.effects?.sound?.("shoot", ITEM.ENDER_PEARL));
    }
    if (event.type === "impact") {
      game.miningKey = "";
      game.miningProgress = 0;
      observe(() => game.updateTarget?.());
    }
    observe(() => this.render());
    observe(() => game.scheduleSave?.());
    observe(() => game.refreshHud?.());
    if (errors.length) {
      this.observerErrors = errors.slice(0, 16);
      throw new AggregateError(
        errors,
        "Projectile observers failed after publication"
      );
    }
  }

  /** Pause retains flight; death/respawn renew its saved life; travel cancels it. */
  cancel(reason = "travel", { advanceLife = false } = {}) {
    if (!this.active) return false;
    const accepted = this.projectiles.cancelPending(reason, { advanceLife });
    if (accepted) {
      this.render();
      this._game.scheduleSave?.();
    }
    return accepted;
  }

  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (!this.active || this._frameBusy || !Number.isFinite(dt) || dt < 0)
      return false;
    if (!simulating || !this.running) return true;
    // The dormant system performs no transactions, owner reads or geometry scans.
    if (!this.projectiles.size && this.projectiles.cooldown === 0) return true;
    this._frameBusy = true;
    try {
      return this.projectiles.update(dt);
    } finally {
      this._frameBusy = false;
    }
  }

  render() {
    if (!this.active) return false;
    if (!this.projectiles.size && !this._rendered) return true;
    if (!this._ensureRenderer()) return false;
    this.renderer.update(this.projectiles.projectiles, {
      dimension: this.world.dimension,
      elapsed: this._game.elapsed,
    });
    this._rendered = this.projectiles.size > 0;
    return true;
  }

  serialize() {
    if (
      !this._available() ||
      (this._game && !this.active) ||
      (!this._game &&
        (this.world.epoch !== this._preparedEpoch ||
          this.world.dimension !== this._preparedDimension))
    )
      throw new Error("Cannot serialize stale projectile services");
    return { playerProjectiles: this.projectiles.serialize() };
  }

  dispose() {
    if (this._disposed) return true;
    if (
      this.projectiles?._preparing ||
      this.projectiles?._reading ||
      !this.coordinator.release(this)
    )
      return false;
    this.projectiles?.dispose();
    this.renderer?.dispose();
    const game = this._game;
    if (game?.projectileServices === this) game.projectileServices = null;
    if (game?.projectiles === this.projectiles) game.projectiles = null;
    this._disposed = true;
    this._game = this._scene = this.renderer = null;
    return true;
  }
}
