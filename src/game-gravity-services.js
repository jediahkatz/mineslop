import { FallingBlocks } from "./falling-blocks.js";
import { gameGravityOccupied } from "./gravity-occupancy.js";

/**
 * No persisted sidecar or renderer: all mass lives in ordinary World cells.
 * Construct detached, activate after owner installation, then use the existing
 * independent World service event multiplexer and active simulation frame.
 */
export class GameGravityServices {
  constructor({ world, isOccupied = gameGravityOccupied } = {}) {
    this.world = world;
    this._game = null;
    this._disposed = false;
    this._epoch = world?.epoch;
    this.gravity = new FallingBlocks(world, {
      isOccupied: (bounds) => isOccupied?.(this._game, bounds),
      canAdvance: () => this._running(),
      prepareDrops: (drops, scope) =>
        this._game?.fluidServices?.active
          ? this._game.fluidServices.prepareDrops(drops, scope)
          : null,
    });
  }

  get active() {
    return !this._disposed && this.gravity._current() &&
      this._game?.world === this.world &&
      this._game?.gravityServices === this;
  }

  _running() {
    const game = this._game;
    return this.active && game.simulating === true && !game.paused &&
      !game.building && !game.failed && !game.gameplay?.dead &&
      !game.gameplay?._disposed;
  }

  activate(game) {
    if (this._disposed || !game || game.world !== this.world ||
        !this.gravity._current() ||
        (this._game && this._game !== game) ||
        (!this._game && this.world.epoch !== this._epoch) ||
        (game.gravityServices && game.gravityServices !== this))
      return { ok: false, reason: "stale-gravity-host" };
    this._game = game;
    game.gravityServices = this;
    return { ok: true };
  }

  onMutation(world, event) {
    return this.active && world === this.world &&
      this.gravity.onMutation(event);
  }

  onChunkLoaded(world, event) {
    if (!this.active || world !== this.world ||
        event?.world !== world || event.epoch !== world.epoch ||
        event.dimension !== world.dimension ||
        event.seed !== world.seed ||
        event.generatorVersion !== world.generatorVersion ||
        event.key !== `${event.cx},${event.cz}` ||
        world.chunks.get(event.key) !== event.chunk ||
        event.chunk?.incarnation !== event.incarnation) return false;
    const player = this._game.player?.position;
    return this.gravity.onChunkLoaded(event.chunk, {
      priority: player && Math.floor(player.x / 16) === event.cx &&
        Math.floor(player.z / 16) === event.cz,
    });
  }

  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (!this.active || !Number.isFinite(dt) || dt < 0)
      return { ok: false, reason: "gravity-frame-unavailable" };
    return {
      ok: true,
      advanced: simulating === true && this._running() && this.gravity.update(dt),
    };
  }

  diagnostics() {
    return { active: this.active, ...this.gravity.diagnostics() };
  }

  dispose() {
    if (this._disposed) return true;
    if (!this.gravity.dispose()) return false;
    this._disposed = true;
    if (this._game?.gravityServices === this) this._game.gravityServices = null;
    this._game = null;
    return true;
  }
}
