import {
  BedSystem,
  BED_STATE_VERSION,
  normalizeBedSnapshot,
} from "./bed-system.js";
import { BLOCKS } from "./blocks.js";
import {
  BuildingActions,
  buildingSupportCandidates,
} from "./building-actions.js";
import { CHUNK_SIZE } from "./terrain.js";
import { JAVA_DAY_TICKS, MAX_WORLD_DAY } from "./trading-calendar.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import {
  DAY_SECONDS,
  normalizeWorldClock,
  WorldClock,
  WORLD_CLOCK_VERSION,
} from "./world-clock.js";
import {
  createWorldContext,
  inColumnBounds,
  inWorldBounds,
} from "./world-spec.js";

export { JAVA_DAY_TICKS } from "./trading-calendar.js";
export const RENDERER_DAWN_PHASE = 0.25;
export const DEFAULT_BUILDING_TIME = 0.36;
export const BUILDING_SUPPORT_LIMITS = Object.freeze({
  cells: 512,
  columns: 128,
  candidates: 32,
  scanCells: 4096,
  mutationChanges: 8,
});
const LIMIT_CAPS = Object.freeze({
  cells: 4096,
  columns: 512,
  candidates: 64,
  scanCells: 16384,
  mutationChanges: 64,
});
const SUPPORTED = new Set(["door", "bed", "ladder"]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const refusal = (reason) => ({ ok: false, reason });
const emptyBeds = () => ({ version: BED_STATE_VERSION, spawn: null });
const columnKey = (cx, cz) => `${cx},${cz}`;
const positionKey = ({ x, y, z }) => `${x},${y},${z}`;
const phase = (value) =>
  Number.isFinite(value)
    ? value >= 0 && value < 1
      ? value
      : ((value % 1) + 1) % 1
    : null;

/** Pure archive-sidecar preflight. Explicit malformed sidecars never fall back. */
export function normalizeBuildingServicesSnapshot(saved, context) {
  try {
    if (saved === undefined || saved === null) saved = {};
    if (!record(saved)) return null;
    const beds = normalizeBedSnapshot(
      saved.beds === undefined ? emptyBeds() : saved.beds,
      context
    );
    let clock = saved.worldClock;
    if (clock === undefined) {
      const time =
        saved.time === undefined ? DEFAULT_BUILDING_TIME : phase(saved.time);
      if (time === null) return null;
      clock = { version: WORLD_CLOCK_VERSION, day: 0, time };
    }
    const worldClock = normalizeWorldClock(clock);
    return beds && worldClock ? { beds, worldClock } : null;
  } catch {
    return null;
  }
}

/**
 * Atmosphere uses (phase - .25) * 2π: .25=sunrise, .5=noon, 0=midnight.
 * Trading days roll at Java tick zero (sunrise), NOT the clock's midnight.
 * Day zero covers the initial pre-dawn interval; the first sunrise starts
 * trading day one. This fixed epoch offset avoids negative initial days and
 * keeps {day,time} ordered across both midnight and sunrise.
 */
export function projectBuildingClock(snapshot) {
  const clock = normalizeWorldClock(snapshot);
  if (!clock) return null;
  const ticks = Math.min(
    JAVA_DAY_TICKS - 1,
    Math.floor(clock.time * JAVA_DAY_TICKS)
  );
  const shifted = ticks - RENDERER_DAWN_PHASE * JAVA_DAY_TICKS;
  const day = clock.day + Number(shifted >= 0);
  return {
    day: clock.day,
    time: clock.time,
    // Preserve valid large WorldClock saves; never wrap/clamp a trading ledger.
    tradingClock:
      Number.isSafeInteger(day) && day <= MAX_WORLD_DAY
        ? { day, time: shifted < 0 ? shifted + JAVA_DAY_TICKS : shifted }
        : null,
  };
}

function supportLimits(value) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(LIMIT_CAPS, key))
  )
    throw new RangeError("Invalid building support limits");
  const limits = { ...BUILDING_SUPPORT_LIMITS, ...value };
  if (
    Object.entries(limits).some(
      ([key, limit]) =>
        !Number.isInteger(limit) || limit < 1 || limit > LIMIT_CAPS[key]
    )
  )
    throw new RangeError("Building support limits exceed their bounds");
  return Object.freeze(limits);
}

function matchingContext(context, world) {
  return (
    context?.seed === world.seed &&
    context?.generatorVersion === world.generatorVersion &&
    normalizeBedSnapshot(emptyBeds(), context) !== null
  );
}

function bindable(game, name, value) {
  const slot = Object.getOwnPropertyDescriptor(game, name);
  return slot
    ? Object.hasOwn(slot, "value") &&
        slot.configurable &&
        (slot.value == null ||
          slot.value === value ||
          slot.value._disposed === true)
    : Object.isExtensible(game);
}

/**
 * Construction is detached staging, with no Game argument or live callbacks.
 * Owns beds + clock + controller, never the supplied World/Gameplay. Parent:
 * construct/load -> install candidate World/Gameplay -> activate(game).
 * Constructor failure releases every acquired reservation. Failed activation
 * leaves a detached candidate owned by the caller, which must dispose it.
 *
 * Notifications are explicit: onMutation(world,event) after publication, and
 * onChunkLoaded(world,{epoch,dimension,cx,cz,incarnation}) after admission.
 * Neither hook installs subscriptions, loads chunks, or repairs terrain.
 * Queues are not save sidecars: unrepaired blocks remain owned by World.
 * Initial resident scans and every subsequent admission reconstruct that work.
 */
export class GameBuildingServices {
  constructor({
    world,
    gameplay,
    context = gameplay?.context ?? (world && createWorldContext(world)),
    saved = null,
    allowOverBudget = false,
    support = {},
  } = {}) {
    const normalized = normalizeBuildingServicesSnapshot(saved, context);
    if (
      !world ||
      world._disposed ||
      gameplay?._disposed ||
      !(world.coordinator instanceof TransactionCoordinator) ||
      gameplay?.coordinator !== world.coordinator ||
      world.coordinator.usage(world) === undefined ||
      world.coordinator.usage(gameplay) === undefined ||
      !matchingContext(context, world) ||
      (gameplay.context && !matchingContext(gameplay.context, world)) ||
      !normalized ||
      typeof allowOverBudget !== "boolean"
    )
      throw new RangeError("Invalid staged building services");
    this.limits = supportLimits(support);
    this.world = world;
    this.gameplay = gameplay;
    this.context = context;
    this.coordinator = world.coordinator;
    this._gameplayContext = gameplay.context;
    this._specForDimension = context.specForDimension;
    this._seed = world.seed;
    this._generatorVersion = world.generatorVersion;
    this._preparedEpoch = world.epoch;
    this._preparedDimension = world.dimension;
    this._game = null;
    this._disposed = false;
    this._frameBusy = false;
    this._advancingFrame = false;
    this._projecting = false;
    this.observerErrors = [];
    this._resetSupport();
    // A zero-byte lifecycle registration also rejects disposal/activation from
    // another participant's validation, before any owned objects are changed.
    if (!this.coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register staged building services");
    try {
      this.beds = new BedSystem({
        coordinator: this.coordinator,
        context,
        allowOverBudget,
      });
      if (!this.beds.load(normalized.beds, { context, allowOverBudget }))
        throw new RangeError("Cannot restore staged bed state");
      this.worldClock = new WorldClock({
        coordinator: this.coordinator,
        snapshot: normalized.worldClock,
        allowOverBudget,
      });
      this.buildingActions = new BuildingActions({
        world,
        gameplay,
        worldContext: context,
        beds: this.beds,
        worldClock: this.worldClock,
        building: true,
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _worldAvailable() {
    return (
      !this._disposed &&
      !this.world._disposed &&
      !this.gameplay._disposed &&
      !this.beds?._disposed &&
      !this.worldClock?._disposed &&
      !this.buildingActions?._disposed &&
      this.world.coordinator === this.coordinator &&
      this.gameplay.coordinator === this.coordinator &&
      this.beds?.coordinator === this.coordinator &&
      this.worldClock?.coordinator === this.coordinator &&
      this.buildingActions?.coordinator === this.coordinator &&
      this.buildingActions.world === this.world &&
      this.buildingActions.gameplay === this.gameplay &&
      this.buildingActions.beds === this.beds &&
      this.gameplay.context === this._gameplayContext &&
      this.context.specForDimension === this._specForDimension &&
      this.context.seed === this._seed &&
      this.context.generatorVersion === this._generatorVersion &&
      this.world.seed === this._seed &&
      this.world.generatorVersion === this._generatorVersion &&
      this.coordinator.usage(this) === 0 &&
      this.coordinator.usage(this.beds) !== undefined &&
      this.coordinator.usage(this.worldClock) !== undefined
    );
  }

  get active() {
    const game = this._game;
    return (
      this._worldAvailable() &&
      !!game &&
      this.buildingActions.game === game &&
      game.world === this.world &&
      game.gameplay === this.gameplay &&
      game.buildingServices === this &&
      game.buildingActions === this.buildingActions &&
      game.beds === this.beds &&
      game.worldClock === this.worldClock
    );
  }

  activate(game) {
    if (
      !record(game) ||
      !this._worldAvailable() ||
      game.world !== this.world ||
      game.gameplay !== this.gameplay ||
      (game.worldContext && !matchingContext(game.worldContext, this.world))
    )
      return refusal("stale-building-host");
    if (this._game)
      return this._game === game && this.active
        ? { ok: true, observerErrors: [] }
        : refusal("building-services-already-bound");
    if (
      this.world.epoch !== this._preparedEpoch ||
      this.world.dimension !== this._preparedDimension
    )
      return refusal("stale-building-stage");
    const bindings = {
      buildingServices: this,
      buildingActions: this.buildingActions,
      beds: this.beds,
      worldClock: this.worldClock,
    };
    if (
      !Object.entries(bindings).every(([name, value]) =>
        bindable(game, name, value)
      ) ||
      !this.coordinator.register(this, 0, { allowOverBudget: true })
    )
      return refusal("building-host-already-owned");
    for (const [name, value] of Object.entries(bindings))
      Object.defineProperty(game, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    this._game = game;
    this.buildingActions.game = game;
    const changed = (persistent) => {
      const result = this._projectClock(persistent);
      if (result.observerErrors?.length)
        throw new AggregateError(
          result.observerErrors,
          "Building clock observers failed"
        );
    };
    // The bed participant notifies before the clock participant during sleep,
    // but both have published. Project dawn before any save/HUD observer runs.
    this.beds.onChange = () => changed(true);
    this.worldClock.onChange = () => changed(!this._advancingFrame);
    return this.projectClock();
  }

  clockProjection() {
    return this._disposed
      ? null
      : projectBuildingClock(this.worldClock.serialize());
  }

  _observe(callback, errors) {
    if (!this.active) return;
    try {
      callback();
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      errors.push(error);
    }
  }

  _projectClock(changed) {
    if (!this.active || this._projecting)
      return refusal("building-clock-not-live");
    const game = this._game,
      projection = this.clockProjection(),
      errors = [];
    this._projecting = true;
    try {
      this._observe(() => {
        game.currentTime = projection.time;
      }, errors);
      this._observe(() => game.graphics?.setTime?.(projection.time), errors);
      if (changed) {
        this._observe(() => game.refreshHud?.(), errors);
        this._observe(() => game.scheduleSave?.(), errors);
      }
    } finally {
      this._projecting = false;
    }
    this.observerErrors = errors;
    return { ok: true, projection, observerErrors: errors };
  }

  projectClock() {
    return this._projectClock(false);
  }

  serialize() {
    if (
      !this._worldAvailable() ||
      (this._game && !this.active) ||
      (!this._game &&
        (this.world.epoch !== this._preparedEpoch ||
          this.world.dimension !== this._preparedDimension))
    )
      throw new Error("Cannot serialize stale building services");
    return {
      beds: this.beds.serialize(),
      worldClock: this.worldClock.serialize(),
      time: this.worldClock.time,
    };
  }

  _commitClock(participant) {
    if (!participant) return refusal("invalid-building-clock");
    const epoch = this.world.epoch,
      dimension = this.world.dimension;
    const result = this.coordinator.commit([
      {
        ...participant,
        validate: () =>
          this.active &&
          this.world.epoch === epoch &&
          this.world.dimension === dimension &&
          participant.validate(),
      },
    ]);
    this.observerErrors = result.observerErrors ?? [];
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    return result;
  }

  /** Slider chooses the next occurrence of a phase, never rewinding traders. */
  setTime(value) {
    const next = phase(value);
    if (
      !this.active ||
      this._frameBusy ||
      this._projecting ||
      this._game.building ||
      next === null
    )
      return refusal("building-clock-unavailable");
    const current = this.worldClock.time;
    if (next === current) return this.projectClock();
    const participant =
      next >= current
        ? this.worldClock.prepareTime(next)
        : this.worldClock.prepareAdvance((1 - current + next) * DAY_SECONDS);
    const result = this._commitClock(participant);
    return { ...result, projection: this.clockProjection() };
  }

  _resetSupport() {
    this._epoch = this.world.epoch;
    this._dimension = this.world.dimension;
    this._cells = new Map();
    this._columns = new Map();
    this._deferred = new Set();
    this._deferredCoarsened = false;
    this._admissions = new WeakMap();
    this._scan = null;
    this._recovery = null;
    this._recoverRequested = true;
    this._coarsened = false;
  }

  _acceptNotification(world, event) {
    if (
      !this._worldAvailable() ||
      world !== this.world ||
      event?.epoch !== world.epoch ||
      event?.dimension !== world.dimension ||
      (this._game
        ? !this.active
        : world.epoch !== this._preparedEpoch ||
          world.dimension !== this._preparedDimension)
    )
      return false;
    if (this._epoch !== world.epoch || this._dimension !== world.dimension)
      this._resetSupport();
    return true;
  }

  _recover() {
    this._recoverRequested = true;
    this._coarsened = true;
    this._cells.clear();
    this._columns.clear();
    // Do not restart an in-flight scan: repeated notifications cannot starve it.
    // A second pass covers changes behind its cursor. Unloaded columns will be
    // covered by the unconditional new-column + neighbor admission scans.
  }

  _enqueueCell(at) {
    if (!inWorldBounds(at.x, at.y, at.z, this.world.spec)) return true;
    const key = positionKey(at);
    if (this._cells.has(key)) return true;
    if (this._cells.size >= this.limits.cells) {
      this._recover();
      return false;
    }
    this._cells.set(key, {
      x: at.x,
      y: at.y,
      z: at.z,
      epoch: this._epoch,
      dimension: this._dimension,
    });
    return true;
  }

  _enqueueColumn(chunk) {
    const key = columnKey(chunk.cx, chunk.cz);
    if (this._columns.has(key)) {
      this._columns.set(key, { chunk, incarnation: chunk.incarnation, key });
      return true;
    }
    if (this._columns.size >= this.limits.columns) {
      this._recover();
      return false;
    }
    this._columns.set(key, { chunk, incarnation: chunk.incarnation, key });
    return true;
  }

  onMutation(world, event) {
    if (
      !this._acceptNotification(world, event) ||
      !Array.isArray(event.changes)
    )
      return false;
    if (event.changes.length > this.limits.mutationChanges) {
      this._recover();
      return true;
    }
    for (const candidate of buildingSupportCandidates(event))
      if (!this._enqueueCell(candidate)) break;
    return true;
  }

  onChunkLoaded(world, event) {
    if (
      !this._acceptNotification(world, event) ||
      ![event.cx, event.cz, event.incarnation].every(Number.isSafeInteger)
    )
      return false;
    const chunk = world.chunks.get(columnKey(event.cx, event.cz));
    if (!chunk || chunk.incarnation !== event.incarnation) return false;
    if (this._admissions.get(chunk) === chunk.incarnation) return true;
    this._admissions.set(chunk, chunk.incarnation);
    if (this._deferredCoarsened) {
      this._deferredCoarsened = false;
      this._recover();
    }
    // A missing link/support/corner can belong to the resident neighbor, not
    // the newly admitted column. Recheck all eight neighboring columns too.
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const key = columnKey(event.cx + dx, event.cz + dz);
        const neighbor = world.chunks.get(key);
        if (!neighbor) continue;
        this._deferred.delete(key);
        if (!this._enqueueColumn(neighbor)) return true;
      }
    return true;
  }

  _defer(at) {
    const key = columnKey(
      Math.floor(at.x / CHUNK_SIZE),
      Math.floor(at.z / CHUNK_SIZE)
    );
    if (this._deferred.size < this.limits.columns || this._deferred.has(key))
      this._deferred.add(key);
    else this._deferredCoarsened = true;
  }

  _candidateReady(at) {
    const cell = this.world.getCell(at.x, at.y, at.z);
    if (!cell) {
      this._defer(at);
      return false;
    }
    if (!SUPPORTED.has(BLOCKS[cell.id]?.shape)) return false;
    // The attachment may depend on a neighboring stair's derived corner.
    // Null geometry outside a resident apron is not proof of lost support.
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const x = at.x + dx,
          z = at.z + dz;
        if (inColumnBounds(x, z) && !this.world.isLoaded(x, z)) {
          this._defer(at);
          return false;
        }
      }
    return true;
  }

  _takeCells(count, batch, seen) {
    for (
      let i = 0;
      i < count && this._cells.size && batch.length < this.limits.candidates;
      i++
    ) {
      const [key, at] = this._cells.entries().next().value;
      this._cells.delete(key);
      if (!seen.has(key) && this._candidateReady(at)) {
        seen.add(key);
        batch.push(at);
      }
    }
  }

  _resident(entry) {
    return (
      this.world.chunks.get(entry.key) === entry.chunk &&
      entry.chunk.incarnation === entry.incarnation
    );
  }

  _startScan() {
    if (!this._recovery && this._recoverRequested) {
      this._recoverRequested = false;
      this._recovery = this.world.chunks.values();
    }
    let entry;
    if (this._recovery) {
      const next = this._recovery.next();
      if (next.done) {
        this._recovery = null;
        if (!this._recoverRequested) this._coarsened = false;
        return;
      }
      const chunk = next.value;
      entry = {
        chunk,
        key: columnKey(chunk.cx, chunk.cz),
        incarnation: chunk.incarnation,
      };
    } else if (this._columns.size) {
      const [key, queued] = this._columns.entries().next().value;
      this._columns.delete(key);
      entry = queued;
    }
    if (entry && this._resident(entry)) this._scan = { ...entry, index: 0 };
  }

  _scanCells(batch, seen) {
    let scanned = 0;
    for (
      let work = 0;
      work < this.limits.scanCells && batch.length < this.limits.candidates;
      work++
    ) {
      if (this._scan && !this._resident(this._scan)) this._scan = null;
      if (!this._scan) this._startScan();
      if (!this._scan) {
        if (!this._recovery && !this._recoverRequested && !this._columns.size)
          break;
        continue;
      }
      const { chunk } = this._scan;
      const index = this._scan.index++;
      scanned++;
      const id = chunk.blocks[index];
      if (this._scan.index >= chunk.blocks.length) this._scan = null;
      if (!SUPPORTED.has(BLOCKS[id]?.shape)) continue;
      const at = {
        x: chunk.cx * CHUNK_SIZE + (index % CHUNK_SIZE),
        y: chunk.minY + Math.floor(index / (CHUNK_SIZE * CHUNK_SIZE)),
        z:
          chunk.cz * CHUNK_SIZE + (Math.floor(index / CHUNK_SIZE) % CHUNK_SIZE),
        epoch: this._epoch,
        dimension: this._dimension,
      };
      const key = positionKey(at);
      if (!seen.has(key) && this._candidateReady(at)) {
        seen.add(key);
        batch.push(at);
      }
    }
    return scanned;
  }

  _prepareSupportDrops(stacks, at) {
    if (
      !this.active ||
      at.epoch !== this.world.epoch ||
      at.dimension !== this.world.dimension
    )
      return null;
    const game = this._game,
      epoch = this.world.epoch,
      dimension = this.world.dimension;
    const arbitrary = synchronous(game.prepareDropItems);
    const prepare = arbitrary ? game.prepareDropItems : game.preparePlayerDrops;
    if (!synchronous(prepare)) return null;
    const participant = arbitrary
      ? prepare.call(game, stacks, {
          x: at.x + 0.5,
          y: at.y + 0.5,
          z: at.z + 0.5,
        })
      : prepare.call(game, stacks);
    if (!participant) return null;
    return {
      ...participant,
      validate: () =>
        this.active &&
        this.world.epoch === epoch &&
        this.world.dimension === dimension &&
        (arbitrary ? game.prepareDropItems : game.preparePlayerDrops) ===
          prepare &&
        participant.validate(),
    };
  }

  _repairSupport() {
    const batch = [],
      seen = new Set();
    const first = Math.floor(this.limits.candidates / 2);
    this._takeCells(first, batch, seen);
    const scanned = this._scanCells(batch, seen);
    this._takeCells(this.limits.candidates - first, batch, seen);
    if (!batch.length)
      return { ok: true, checked: 0, removed: 0, scanned, observerErrors: [] };
    const epoch = this._epoch,
      dimension = this._dimension;
    const result = this.buildingActions.reconcileSupport(batch, {
      limit: batch.length,
      prepareDrops: (stacks, at) => this._prepareSupportDrops(stacks, at),
    });
    if (
      this.active &&
      this.world.epoch === epoch &&
      this.world.dimension === dimension
    ) {
      for (const at of result.deferred ?? []) this._defer(at);
      if (!result.ok) for (const at of batch) if (!this._enqueueCell(at)) break;
    } else if (!this._disposed) this._recoverRequested = true;
    return {
      ok: result.ok,
      checked: result.checked,
      removed: result.removed,
      scanned,
      deferred: result.deferred?.length ?? 0,
      observerErrors: result.observerErrors ?? [],
    };
  }

  /**
   * Parent passes simulation dt, not wall time or skipped sleep duration.
   * Pause/death/loading retain queued repairs but do no calendar or terrain work.
   * A frame always reserves raw scan work for recovery, even with a hot fine queue.
   */
  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (
      !this.active ||
      this._frameBusy ||
      this._projecting ||
      !Number.isFinite(dt) ||
      dt < 0 ||
      typeof simulating !== "boolean"
    )
      return refusal("building-frame-unavailable");
    if (
      this._epoch !== this.world.epoch ||
      this._dimension !== this.world.dimension
    )
      this._resetSupport();
    const game = this._game;
    if (
      !simulating ||
      game.paused ||
      game.building ||
      game.failed ||
      this.gameplay.dead
    )
      return { ok: true, advanced: false, support: null, observerErrors: [] };
    const epoch = this.world.epoch,
      dimension = this.world.dimension;
    this._frameBusy = true;
    try {
      let clock = { ok: true, observerErrors: [] };
      if (dt > 0) {
        this._advancingFrame = true;
        try {
          clock = this._commitClock(this.worldClock.prepareAdvance(dt));
        } finally {
          this._advancingFrame = false;
        }
      }
      if (!clock.ok) return { ...clock, advanced: false, support: null };
      const support =
        this.active &&
        this.world.epoch === epoch &&
        this.world.dimension === dimension &&
        !game.building &&
        !game.paused &&
        !this.gameplay.dead
          ? this._repairSupport()
          : refusal("building-host-changed");
      this.observerErrors = [
        ...clock.observerErrors,
        ...(support.observerErrors ?? []),
      ];
      return {
        ok: true,
        advanced: dt > 0,
        support,
        observerErrors: this.observerErrors,
      };
    } finally {
      this._frameBusy = false;
    }
  }

  supportStatus() {
    return {
      epoch: this._epoch,
      dimension: this._dimension,
      queuedCells: this._cells.size,
      queuedColumns: this._columns.size,
      deferredColumns: this._deferred.size,
      deferredCoarsened: this._deferredCoarsened,
      scanning: this._scan !== null,
      recovering: this._recovery !== null,
      recoveryRequested: this._recoverRequested,
      coarsened: this._coarsened,
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (
      this.beds?._busy ||
      this.buildingActions?._busy ||
      !this.coordinator.release(this)
    )
      return false;
    this.buildingActions?.dispose();
    this.beds?.dispose();
    this.worldClock?.dispose();
    this._disposed = true;
    const game = this._game;
    for (const [name, value] of Object.entries({
      buildingServices: this,
      buildingActions: this.buildingActions,
      beds: this.beds,
      worldClock: this.worldClock,
    })) {
      const slot = game && Object.getOwnPropertyDescriptor(game, name);
      if (
        slot &&
        Object.hasOwn(slot, "value") &&
        slot.value === value &&
        slot.writable
      )
        Object.defineProperty(game, name, { value: null });
    }
    this._game = null;
    this._cells.clear();
    this._columns.clear();
    this._deferred.clear();
    this._scan = this._recovery = null;
    this._recoverRequested = false;
    return true;
  }
}
