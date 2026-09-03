import { BLOCK } from "./blocks.js";
import { ExplorationState } from "./exploration-state.js";
import {
  explorationContextMatches as matching,
  explorationHostBindable,
  explorationServiceLimits,
  normalizeExplorationServicesSnapshot,
} from "./exploration-host-state.js";
import {
  explorationOrdinary,
  explorationRefused,
  prepareExplorationBreakBatch,
  prepareExplorationClear,
  prepareExplorationOpen,
} from "./exploration-materialization.js";
import { ExplorationResidentIndex } from "./exploration-resident-index.js";
import { hasExpandedTerrain } from "./generator-version.js";
import { cloneStack } from "./inventory-slots.js";
import {
  composeProgressionPlan,
  normalizeProgressContext,
  synchronousProgressCallback as synchronous,
} from "./progression-common.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import { createWorldContext } from "./world-spec.js";

export {
  EXPLORATION_SERVICE_LIMITS,
  normalizeExplorationServicesSnapshot,
} from "./exploration-host-state.js";

/**
 * Stage/load -> install the same Game owners -> activate -> replay admissions.
 * The host owns ONE world-wide permanent ledger and a bounded resident cache.
 * Travel changes World.epoch/dimension, clearing only the cache. No subscriptions,
 * loot rolls, chunk generation or encounter materialization occur in construction.
 *
 * All destruction of generated containers must prepareBreak/prepareBreakBatch
 * BEFORE World publication. onWorldMutation is observation, never a loot grant
 * or a post-publication substitute for that ownership transaction.
 */
export class GameExplorationServices {
  constructor({
    world,
    gameplay,
    settlement,
    overflow,
    context = gameplay?.context ?? (world && createWorldContext(world)),
    saved = null,
    allowOverBudget = false,
    limits = {},
  } = {}) {
    const normalized = normalizeExplorationServicesSnapshot(saved, context);
    const cleanContext = normalizeProgressContext(context);
    const coordinator = world?.coordinator;
    if (
      !normalized ||
      typeof allowOverBudget !== "boolean" ||
      !(coordinator instanceof TransactionCoordinator) ||
      !(world?.chunks instanceof Map) ||
      !(world.edits instanceof Map) ||
      !matching(cleanContext, world) ||
      [world, gameplay, settlement, overflow].some(
        (owner) =>
          !owner ||
          owner._disposed ||
          owner.coordinator !== coordinator ||
          coordinator.usage(owner) === undefined
      ) ||
      [gameplay, settlement, overflow].some(
        (owner) => !matching(owner.context, world)
      ) ||
      !synchronous(world.getCell) ||
      !synchronous(world.prepareMutation) ||
      !synchronous(settlement.prepareContainers) ||
      !synchronous(settlement.inspectContainer) ||
      !synchronous(settlement.bindContainerAccess) ||
      !synchronous(settlement.unbindContainerAccess) ||
      !synchronous(settlement.ownsContainerAccess) ||
      !synchronous(gameplay.getHandRevision) ||
      !synchronous(overflow.prepareAddBatch)
    )
      throw new RangeError("Invalid staged exploration services");
    this.world = world;
    this.gameplay = gameplay;
    this.settlement = settlement;
    this.overflow = overflow;
    this.context = cleanContext;
    this.coordinator = coordinator;
    this.limits = explorationServiceLimits(limits);
    this._owners = Object.freeze({
      world,
      gameplay,
      settlement,
      overflow,
      coordinator,
    });
    this._contexts = [gameplay.context, settlement.context, overflow.context];
    this._context = cleanContext;
    this._preparedEpoch = world.epoch;
    this._preparedDimension = world.dimension;
    this._game = null;
    this._disposed = false;
    this._busy = false;
    this._revision = 0;
    this._notificationsStarted = false;
    this._accessBound = false;
    this._mapSearches = 0;
    this.observerErrors = [];
    this.index = new ExplorationResidentIndex(world, cleanContext, this.limits);
    this._index = this.index;
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register exploration service lifecycle");
    try {
      this.exploration = new ExplorationState({
        context: cleanContext,
        coordinator,
        allowOverBudget,
      });
      this._ledger = this.exploration;
      if (!this.exploration.load(normalized.exploration, { allowOverBudget }))
        throw new RangeError("Cannot restore staged exploration claims");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _worldAvailable() {
    return (
      !this._disposed &&
      Object.entries(this._owners).every(
        ([key, owner]) => this[key] === owner
      ) &&
      this.context === this._context &&
      matching(this.context, this.world) &&
      [this.world, this.gameplay, this.settlement, this.overflow].every(
        (owner) =>
          !owner._disposed &&
          owner.coordinator === this.coordinator &&
          this.coordinator.usage(owner) !== undefined
      ) &&
      [this.gameplay, this.settlement, this.overflow].every(
        (owner, index) =>
          owner.context === this._contexts[index] &&
          matching(owner.context, this.world)
      ) &&
      this.exploration instanceof ExplorationState &&
      this.exploration === this._ledger &&
      !this.exploration._disposed &&
      this.exploration.coordinator === this.coordinator &&
      matching(this.exploration.context, this.world) &&
      this.coordinator.usage(this.exploration) ===
        this.exploration.reservedBytes &&
      this.coordinator.usage(this) === 0 &&
      this.index === this._index &&
      this.index.world === this.world
    );
  }

  get active() {
    const game = this._game;
    return (
      this._worldAvailable() &&
      !!game &&
      game.explorationServices === this &&
      game.exploration === this.exploration &&
      this.settlement.ownsContainerAccess(this) &&
      ["world", "gameplay", "settlement", "overflow"].every(
        (name) => game[name] === this[name]
      ) &&
      (!game.worldContext || matching(game.worldContext, this.world)) &&
      (game.coordinator === undefined || game.coordinator === this.coordinator)
    );
  }

  _staged() {
    return (
      this._worldAvailable() &&
      !this._game &&
      this.world.epoch === this._preparedEpoch &&
      this.world.dimension === this._preparedDimension
    );
  }

  _running() {
    return (
      this.active &&
      !this._game.paused &&
      !this._game.building &&
      !this._game.failed &&
      !this.gameplay.dead
    );
  }

  activate(game) {
    if (
      !game ||
      typeof game !== "object" ||
      this._busy ||
      !this._worldAvailable() ||
      ["world", "gameplay", "settlement", "overflow"].some(
        (name) => game[name] !== this[name]
      ) ||
      (game.coordinator !== undefined &&
        game.coordinator !== this.coordinator) ||
      (game.worldContext && !matching(game.worldContext, this.world))
    )
      return explorationRefused("stale-exploration-host");
    if (this._game)
      return this._game === game && this.active
        ? { ok: true }
        : explorationRefused("exploration-already-bound");
    if (!this._staged()) return explorationRefused("stale-exploration-stage");
    const bindings = {
      explorationServices: this,
      exploration: this.exploration,
    };
    if (
      !Object.entries(bindings).every(([key, value]) =>
        explorationHostBindable(game, key, value)
      ) ||
      !this.coordinator.register(this, 0, { allowOverBudget: true }) ||
      !this.settlement.bindContainerAccess(this, (world, hit) =>
        this._containerAccessible(world, hit)
      )
    )
      return explorationRefused("exploration-host-already-owned");
    this._accessBound = true;
    for (const [key, value] of Object.entries(bindings))
      Object.defineProperty(game, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    this._game = game;
    this._revision++;
    // Explicit parent observer multiplexing owns admission, HUD and save hooks.
    this.exploration.onChange = () => {
      if (this.active) game.scheduleSave?.();
    };
    return { ok: true };
  }

  load(saved, { allowOverBudget = false } = {}) {
    if (
      !this._staged() ||
      this._busy ||
      this._notificationsStarted ||
      typeof allowOverBudget !== "boolean"
    )
      return false;
    const normalized = normalizeExplorationServicesSnapshot(
      saved,
      this.context
    );
    if (
      !normalized ||
      !this.exploration.load(normalized.exploration, { allowOverBudget })
    )
      return false;
    this._revision++;
    return true;
  }

  serialize() {
    if (!(this._game ? this.active : this._staged()))
      throw new Error("Cannot serialize stale exploration services");
    return { exploration: this.exploration.serialize() };
  }

  snapshot() {
    return this.serialize();
  }

  _acceptNotification(world, event) {
    return (
      world === this.world &&
      (this._game ? this.active : this._staged()) &&
      event?.epoch === world.epoch &&
      event?.dimension === world.dimension
    );
  }

  onChunkAdmitted(world, event) {
    if (!this._acceptNotification(world, event)) return false;
    const accepted = this.index.admit(event);
    if (accepted) this._notificationsStarted = true;
    return accepted;
  }

  onChunkLoaded(world, event) {
    return this.onChunkAdmitted(world, event);
  }

  onWorldMutation(world, event) {
    if (
      !this._acceptNotification(world, event) ||
      !Object.isFrozen(event) ||
      !Array.isArray(event.changes)
    )
      return false;
    this.index.onMutation(event);
    this._notificationsStarted = true;
    return true;
  }

  onMutation(world, event) {
    return this.onWorldMutation(world, event);
  }

  /** Maintenance only; paused/travel frames do not roll or materialize anything. */
  frame(dt = 0) {
    if (!this.active || this._busy || !Number.isFinite(dt) || dt < 0)
      return explorationRefused("exploration-frame-unavailable");
    return { ok: true, ...this.index.frame() };
  }

  _containerAccessible(world, hit) {
    if (!this.active || world !== this.world) return false;
    const cell = world.getCell(hit.x, hit.y, hit.z);
    if (!hasExpandedTerrain(world.generatorVersion) || cell?.id !== BLOCK.CHEST) return true;
    const lookup = this.index.lookup(hit);
    if (lookup.status === "ordinary") return true;
    if (lookup.status !== "marker") return false;
    if (lookup.entry.marker.type !== "container") return true;
    const claim = this.exploration.container(lookup.entry.marker);
    return (
      !!claim &&
      this.settlement.inspectContainer(world, hit)?.initialized === true
    );
  }

  _captureGuard(entries, validate) {
    const {
      epoch,
      dimension,
      generator,
      _editRevision: worldRevision,
    } = this.world;
    const revision = this._revision;
    const ledgerRevision = this.exploration.revision;
    const settlementRevision = this.settlement.revision;
    const { mode, selected } = this.gameplay;
    const hands = ["main", "offhand"].map((hand) =>
      this.gameplay.getHandRevision(hand)
    );
    const invalidated = entries.map((entry) => entry.invalidated);
    return () =>
      this._running() &&
      this._revision === revision &&
      this.world.epoch === epoch &&
      this.world.dimension === dimension &&
      this.world.generator === generator &&
      this.world._editRevision === worldRevision &&
      this.exploration.revision === ledgerRevision &&
      this.settlement.revision === settlementRevision &&
      this.gameplay.mode === mode &&
      this.gameplay.selected === selected &&
      ["main", "offhand"].every(
        (hand, i) => this.gameplay.getHandRevision(hand) === hands[i]
      ) &&
      entries.every(
        (entry, i) =>
          this.index.live(entry) && entry.invalidated === invalidated[i]
      ) &&
      (validate === undefined ||
        (synchronous(validate) && validate() === true));
  }

  _guardPlan(plan, guard, result) {
    const [first, ...rest] = plan.participants;
    const guarded = composeProgressionPlan(
      this,
      Object.freeze({
        ...first,
        validate: () => guard() && first.validate(),
      }),
      rest,
      result
    );
    return guarded && Object.freeze({ ...guarded, handled: true, ok: true });
  }

  _prepare(work) {
    if (!this._running() || this._busy)
      return explorationRefused("exploration-unavailable");
    this._busy = true;
    try {
      return work();
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return explorationRefused("invalid-exploration-action");
    } finally {
      this._busy = false;
    }
  }

  prepareOpen(hit, options) {
    return this._prepare(() => prepareExplorationOpen(this, hit, options));
  }

  openContainer(hit, options) {
    return this.commit(this.prepareOpen(hit, options));
  }

  /** Matches GameHarvestActions' already-prepared drops/player-cost seam. */
  prepareBreak(hit, { drops, prepareDrops, ...options } = {}) {
    if (prepareDrops !== undefined && !synchronous(prepareDrops))
      return explorationRefused("invalid-drop-preparation");
    return this.prepareBreakBatch([{ hit, drops }], {
      ...options,
      ...(prepareDrops === undefined
        ? {}
        : {
            prepareDrops: (entries) =>
              prepareDrops(
                entries.map((entry) => cloneStack(entry, this.context))
              ),
          }),
    });
  }

  prepareBreakBatch(requests, options) {
    return this._prepare(() =>
      prepareExplorationBreakBatch(this, requests, options)
    );
  }

  prepareClear(hit, options) {
    return this._prepare(() => prepareExplorationClear(this, hit, options));
  }

  commit(plan) {
    if (plan?.handled === false) return explorationOrdinary();
    if (!plan?.participants)
      return plan?.ok === false
        ? plan
        : explorationRefused("invalid-exploration-plan");
    const committed = this.coordinator.commit(plan.participants);
    this.observerErrors = committed.observerErrors ?? [];
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    return committed.ok
      ? { ...plan.result, handled: true, observerErrors: this.observerErrors }
      : explorationRefused(committed.reason);
  }

  encounterMarkers({ includeCompleted = false } = {}) {
    if (!(this._game ? this.active : this._staged())) return [];
    return this.index
      .list("encounter")
      .filter(({ invalidated }) => !invalidated)
      .map((entry) => ({
        ...entry,
        completed: this.exploration.completed(entry.marker),
      }))
      .filter(({ completed }) => includeCompleted || !completed);
  }

  /** Ecology must supply its real death/reward participants and prerequisites. */
  prepareEncounterComplete(id, { participants = [], validate } = {}) {
    return this._prepare(() => {
      const entry = this.index.byId(id);
      if (
        entry?.marker.type !== "encounter" ||
        !this.index.eligible(entry) ||
        !Array.isArray(participants) ||
        !participants.length ||
        !synchronous(validate)
      )
        return explorationRefused("encounter-ownership-unavailable");
      const guard = this._captureGuard([entry], validate);
      const plan = this.exploration.prepareEncounterComplete(entry.marker, {
        validate: guard,
        participants,
      });
      return plan
        ? this._guardPlan(plan, guard, plan.result)
        : explorationRefused("encounter-already-claimed");
    });
  }

  diagnostics() {
    return {
      active: this.active,
      notificationsStarted: this._notificationsStarted,
      mapSearches: this._mapSearches,
      ledgerBytes: this.exploration?.reservedBytes ?? 0,
      resident: this.index.diagnostics(),
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (
      this._busy ||
      this._ledger?._busy ||
      (this._accessBound && !this.settlement.unbindContainerAccess(this)) ||
      !this.coordinator.release(this)
    )
      return false;
    this._ledger?.dispose();
    this._accessBound = false;
    this._disposed = true;
    this._revision++;
    this._index.reset();
    const bindings = { explorationServices: this, exploration: this._ledger };
    for (const [key, value] of Object.entries(bindings)) {
      const slot =
        this._game && Object.getOwnPropertyDescriptor(this._game, key);
      if (
        slot &&
        Object.hasOwn(slot, "value") &&
        slot.value === value &&
        slot.writable
      )
        Object.defineProperty(this._game, key, { value: null });
    }
    this._game = null;
    return true;
  }
}
