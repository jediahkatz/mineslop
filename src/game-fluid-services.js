import { BLOCK } from "./blocks.js";
import { cellsEqual } from "./block-state.js";
import {
  planKelpPlacement,
  planSpongeAbsorption,
  planWaterlogging,
} from "./fluid-actions.js";
import { FluidSystem } from "./fluids.js";
import {
  FLUID_SERVICE_LIMITS,
  prepareFluidPlantDrops,
} from "./game-fluid-drops.js";
import {
  fluidHostBindable,
  fluidServiceRecord as record,
  fluidServiceSynchronous as synchronous,
  hostedFluidWorld,
  normalizeFluidServiceContext,
  normalizeFluidServicesSnapshot,
} from "./game-fluid-state.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import { createWorldContext, inWorldBounds } from "./world-spec.js";

export { FLUID_SERVICE_LIMITS, normalizeFluidServicesSnapshot };

const refused = (reason) => ({ ok: false, reason });
const contextMatches = (context, world) =>
  context?.seed === world.seed &&
  context?.generatorVersion === world.generatorVersion;

/**
 * Detached lifecycle owner. Construction/load restore the fluid sidecar BEFORE
 * any admission, but never bind a live Game, subscribe, tick or generate.
 *
 * Host order:
 *   new GameFluidServices({world, overflow, settlement, context, saved})
 *   -> install those same owners -> activate(game)
 *   -> forward/replay frozen World admission envelopes -> frame(activeDt).
 *
 * Parent multiplexes observers independently and owns archive/save/HUD/flush.
 * This service neither calls Gameplay.update/damage nor grants callback receipts.
 * Optional prepared actions do NOT consume a hand item: the caller must append
 * its prepared inventory debit/hand exchange to the returned participants and
 * commit once. They never call GameUseActions or a second World convenience edit.
 */
export class GameFluidServices {
  constructor({
    world,
    overflow,
    settlement,
    coordinator = world?.coordinator,
    context = world && createWorldContext(world),
    saved = null,
    allowOverBudget = false,
    limits = {},
  } = {}) {
    const cleanContext = normalizeFluidServiceContext(context);
    const snapshot = normalizeFluidServicesSnapshot(saved, context);
    if (
      !world ||
      world._disposed ||
      !(coordinator instanceof TransactionCoordinator) ||
      coordinator !== world.coordinator ||
      !(world.chunks instanceof Map) ||
      !synchronous(world.getCell) ||
      !synchronous(world.prepareMutation) ||
      !cleanContext ||
      !snapshot ||
      !contextMatches(cleanContext, world) ||
      typeof allowOverBudget !== "boolean" ||
      [world, overflow, settlement].some(
        (owner) =>
          !owner ||
          owner._disposed ||
          owner.coordinator !== coordinator ||
          coordinator.usage(owner) === undefined
      ) ||
      !synchronous(overflow.prepareAddBatch) ||
      !synchronous(settlement.hasCrop) ||
      !contextMatches(overflow.context, world) ||
      !contextMatches(settlement.context, world)
    )
      throw new RangeError("Invalid staged fluid services");
    this.world = world;
    this.overflow = overflow;
    this.settlement = settlement;
    this.coordinator = coordinator;
    this.context = context;
    this._owners = Object.freeze({
      world,
      overflow,
      settlement,
      coordinator,
      context,
    });
    this._specForDimension = context.specForDimension;
    this._overflowContext = overflow.context;
    this._settlementContext = settlement.context;
    this._seed = world.seed;
    this._generatorVersion = world.generatorVersion;
    this._preparedEpoch = world.epoch;
    this._preparedDimension = world.dimension;
    this._revision = 0;
    this._game = null;
    this._disposed = false;
    this._frameBusy = false;
    this._preparing = false;
    this._notificationsStarted = false;
    this._lastDropFailure = null;
    this._dropAttempts = 0;
    this._dropRefusals = 0;
    this._view = hostedFluidWorld(this);
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register fluid service lifecycle");
    try {
      this.fluids = new FluidSystem(this._view, {
        coordinator,
        allowOverBudget,
        limits,
        prepareDrops: (drops, scope) => this.prepareDrops(drops, scope),
      });
      if (!this.fluids.load(snapshot.fluids))
        throw new RangeError("Cannot restore staged fluids");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _worldAvailable() {
    return (
      !this._disposed &&
      Object.entries(this._owners).every(
        ([name, owner]) => this[name] === owner
      ) &&
      !this.world._disposed &&
      !this.overflow._disposed &&
      !this.settlement._disposed &&
      this.fluids instanceof FluidSystem &&
      !this.fluids._disposed &&
      this.fluids.world === this._view &&
      this.fluids.coordinator === this.coordinator &&
      this.world.seed === this._seed &&
      this.world.generatorVersion === this._generatorVersion &&
      contextMatches(this.context, this.world) &&
      this.context.specForDimension === this._specForDimension &&
      [this.world, this.overflow, this.settlement].every(
        (owner) =>
          owner.coordinator === this.coordinator &&
          this.coordinator.usage(owner) !== undefined
      ) &&
      this.overflow.context === this._overflowContext &&
      this.settlement.context === this._settlementContext &&
      contextMatches(this.overflow.context, this.world) &&
      contextMatches(this.settlement.context, this.world) &&
      this.coordinator.usage(this) === 0 &&
      this.coordinator.usage(this.fluids) === this.fluids?.reservedBytes
    );
  }

  get active() {
    const game = this._game;
    return (
      this._worldAvailable() &&
      !!game &&
      game.world === this.world &&
      game.overflow === this.overflow &&
      game.settlement === this.settlement &&
      game.fluidServices === this &&
      game.fluids === this.fluids &&
      (!game.worldContext || contextMatches(game.worldContext, this.world)) &&
      (game.coordinator === undefined || game.coordinator === this.coordinator)
    );
  }

  _running() {
    const game = this._game;
    return (
      this.active &&
      !game.paused &&
      !game.building &&
      !game.failed &&
      !game.gameplay?.dead &&
      !game.gameplay?._disposed
    );
  }

  _actionAvailable() {
    return this._running();
  }

  _staged() {
    return (
      this._worldAvailable() &&
      !this._game &&
      this.world.epoch === this._preparedEpoch &&
      this.world.dimension === this._preparedDimension
    );
  }

  _captureGuard() {
    const epoch = this.world.epoch,
      dimension = this.world.dimension;
    const revision = this._revision;
    return () =>
      this._actionAvailable() &&
      this._revision === revision &&
      this.world.epoch === epoch &&
      this.world.dimension === dimension;
  }

  _prepareWorld(changes, options) {
    if (!this._actionAvailable()) return null;
    const validHost = this._captureGuard();
    const participant = this.world.prepareMutation(changes, options);
    return (
      participant &&
      Object.freeze({
        ...participant,
        validate: () => validHost() && participant.validate(),
      })
    );
  }

  activate(game) {
    if (
      !record(game) ||
      this._preparing ||
      !this._worldAvailable() ||
      game.world !== this.world ||
      game.overflow !== this.overflow ||
      game.settlement !== this.settlement ||
      (game.coordinator !== undefined &&
        game.coordinator !== this.coordinator) ||
      (game.worldContext && !contextMatches(game.worldContext, this.world))
    )
      return refused("stale-fluid-host");
    if (this._game)
      return this._game === game && this.active
        ? { ok: true }
        : refused("fluid-services-already-bound");
    if (!this._staged()) return refused("stale-fluid-stage");
    const bindings = { fluidServices: this, fluids: this.fluids };
    if (
      !Object.entries(bindings).every(([name, value]) =>
        fluidHostBindable(game, name, value)
      ) ||
      !this.coordinator.register(this, 0, { allowOverBudget: true })
    )
      return refused("fluid-host-already-owned");
    for (const [name, value] of Object.entries(bindings))
      Object.defineProperty(game, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    this._game = game;
    this._revision++;
    return { ok: true };
  }

  /** Detached only, and strictly before the first mutation/admission intake. */
  load(saved, { allowOverBudget = false } = {}) {
    if (
      !this._staged() ||
      this._preparing ||
      this._notificationsStarted ||
      typeof allowOverBudget !== "boolean"
    )
      return false;
    const snapshot = normalizeFluidServicesSnapshot(saved, this.context);
    if (!snapshot || !this.coordinator.register(this, 0, { allowOverBudget }))
      return false;
    if (!this.fluids.load(snapshot.fluids)) return false;
    this._revision++;
    return true;
  }

  serialize() {
    if (!(this._game ? this.active : this._staged()))
      throw new Error("Cannot serialize stale fluid services");
    return { fluids: this.fluids.serialize() };
  }

  _acceptNotification(sourceWorld, event) {
    return (
      sourceWorld === this.world &&
      (this._game ? this.active : this._staged()) &&
      event?.epoch === sourceWorld.epoch &&
      event?.dimension === sourceWorld.dimension
    );
  }

  onMutation(sourceWorld, event) {
    if (!this._acceptNotification(sourceWorld, event)) return false;
    const accepted = this.fluids.onMutation(event);
    if (accepted) this._notificationsStarted = true;
    return accepted;
  }

  onChunkLoaded(sourceWorld, event) {
    if (
      !this._acceptNotification(sourceWorld, event) ||
      !Object.isFrozen(event) ||
      event.world !== sourceWorld ||
      event.seed !== this._seed ||
      event.generatorVersion !== this._generatorVersion ||
      ![event.cx, event.cz, event.incarnation, event.revision].every(
        Number.isSafeInteger
      ) ||
      event.incarnation < 1 ||
      event.revision < 0 ||
      event.key !== `${event.cx},${event.cz}`
    )
      return false;
    const chunk = sourceWorld.chunks.get(event.key);
    if (
      !chunk ||
      event.chunk !== chunk ||
      chunk.incarnation !== event.incarnation ||
      event.revision > chunk.revision
    )
      return false;
    const accepted = this.fluids.onChunkLoaded(chunk);
    if (accepted) this._notificationsStarted = true;
    return accepted;
  }

  /**
   * FluidSystem calls this once for the entire tick's plant batch. No eager
   * callback fallback, fabricated crop, per-position overflow participant or
   * postcommit second loot grant. Failure leaves the domain's replay pending.
   */
  prepareDrops(drops, scope) {
    if (this._preparing || !this._actionAvailable()) return null;
    this._dropAttempts++;
    this._preparing = true;
    this._lastDropFailure = null;
    let participants = null;
    try {
      participants = prepareFluidPlantDrops(this, drops, scope);
      if (!participants)
        this._lastDropFailure = "plant-ownership-or-retention-unavailable";
      return participants;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      this._lastDropFailure = "invalid-plant-retention-plan";
      return null;
    } finally {
      this._preparing = false;
      if (!participants) this._dropRefusals++;
    }
  }

  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (
      !this.active ||
      this._frameBusy ||
      this._preparing ||
      !Number.isFinite(dt) ||
      dt < 0 ||
      typeof simulating !== "boolean"
    )
      return refused("fluid-frame-unavailable");
    if (!simulating || !this._running() || dt === 0)
      return { ok: true, advanced: false };
    this._frameBusy = true;
    try {
      const advanced = this.fluids.update(dt);
      return {
        ok: true,
        advanced,
        diagnostics: this.fluids.diagnostics().last,
      };
    } finally {
      this._frameBusy = false;
    }
  }

  _prepareAction(plan) {
    if (
      !this._actionAvailable() ||
      this._preparing ||
      !plan?.ok ||
      !plan.changes.length
    )
      return null;
    const epoch = this.world.epoch,
      dimension = this.world.dimension;
    const world = this._prepareWorld(plan.changes, {
      epoch,
      reads: plan.reads,
    });
    if (!world) return null;
    const retained = this.prepareDrops(plan.drops, {
      plants: plan.plants,
      changes: plan.changes,
      epoch,
      dimension,
    });
    if (!retained) return null;
    // Result describes the planned change, not loot to spawn after commit.
    return Object.freeze({
      participants: Object.freeze([world, ...retained]),
      result: Object.freeze({
        changes: plan.changes.length,
        retentionPrepared: true,
        ...(plan.waterCells === undefined
          ? {}
          : { waterCells: plan.waterCells }),
        ...(plan.limited === undefined ? {} : { limited: plan.limited }),
        ...(plan.spongeCell
          ? { spongeCell: Object.freeze({ ...plan.spongeCell }) }
          : {}),
      }),
    });
  }

  prepareWaterlogging(position, filled = true) {
    if (!this._actionAvailable()) return null;
    return this._prepareAction(planWaterlogging(this.world, position, filled));
  }

  prepareKelpPlacement(position) {
    if (!this._actionAvailable()) return null;
    return this._prepareAction(planKelpPlacement(this.world, position));
  }

  /**
   * Existing dry sponge, or explicit placement into AIR/empty water only.
   * Center placement/wetting joins absorption in the same World participant.
   * The host must validate reach/collision and append the prepared hand debit.
   */
  prepareSpongeAbsorption(position, { place = false, ...limits } = {}) {
    if (
      !this._actionAvailable() ||
      typeof place !== "boolean" ||
      !position ||
      !inWorldBounds(position.x, position.y, position.z, this.world.spec)
    )
      return null;
    const before = this.world.getCell(position.x, position.y, position.z);
    if (
      !before ||
      (place
        ? ![BLOCK.AIR, BLOCK.WATER].includes(before.id)
        : before.id !== BLOCK.SPONGE)
    )
      return null;
    const plan = planSpongeAbsorption(this.world, position, limits);
    if (!plan.ok) return null;
    if (!cellsEqual(before, plan.spongeCell))
      plan.changes.push({
        x: position.x,
        y: position.y,
        z: position.z,
        before,
        after: plan.spongeCell,
      });
    return this._prepareAction(plan);
  }

  diagnostics() {
    return {
      active: this.active,
      disposed: this._disposed,
      notificationsStarted: this._notificationsStarted,
      dropAttempts: this._dropAttempts,
      dropRefusals: this._dropRefusals,
      lastDropFailure: this._lastDropFailure,
      cropBatchAvailable: synchronous(this.settlement.prepareRemoveCrops),
      retainedRecords: this.overflow.size,
      retainedBytes: this.overflow.reservedBytes,
      retentionLimits: FLUID_SERVICE_LIMITS,
      fluid: this.fluids?.diagnostics() ?? null,
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (this._preparing || !this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    this.fluids?.dispose();
    for (const [name, value] of Object.entries({
      fluidServices: this,
      fluids: this.fluids,
    })) {
      const slot =
        this._game && Object.getOwnPropertyDescriptor(this._game, name);
      if (
        slot &&
        Object.hasOwn(slot, "value") &&
        slot.value === value &&
        slot.writable
      )
        Object.defineProperty(this._game, name, { value: null });
    }
    this._game = null;
    return true;
  }
}
