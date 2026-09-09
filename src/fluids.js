import { BLOCK } from "./blocks.js";
import { cellsEqual } from "./block-state.js";
import {
  FLUID_GAME_TICKS,
  FLUID_LIMITS,
  FLUID_STEP_SECONDS,
  fluidLimits,
  fluidReservedBytes,
  KELP_GROW_TICKS,
  MAX_FLUID_CLOCK,
  MAX_FLUID_DROP_PARTICIPANTS,
} from "./fluid-constants.js";
import { planFluidCell } from "./fluid-rules.js";
import { normalizeFluidSnapshot, restoreFluidWork } from "./fluid-save.js";
import { FluidWork } from "./fluid-work.js";
import { MAX_EDITS } from "./save-budget.js";
import { TransactionInvariantError } from "./transactions.js";
import { getWorldSpec, inWorldBounds, isDimension } from "./world-spec.js";

export {
  FLUID_GAME_TICKS,
  FLUID_LIMITS,
  FLUID_STEP_SECONDS,
  normalizeFluidSnapshot,
};

const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const counters = () => ({
  ticks: 0,
  evaluated: 0,
  reads: 0,
  shapes: 0,
  scanCells: 0,
  scanVisits: 0,
  recoveryVisits: 0,
  queueVisits: 0,
  scheduleRequests: 0,
  overflows: 0,
  deferred: 0,
  readLimitRetries: 0,
  prepares: 0,
  commits: 0,
  changedCells: 0,
  rejected: 0,
  blockedDrops: 0,
  kelpDeferred: 0,
  kelpGrown: 0,
  observerErrors: 0,
  discardedSeconds: 0,
});
const detachedChange = ({ x, y, z, before, after }) =>
  Object.freeze({
    x,
    y,
    z,
    before: Object.freeze({ ...before }),
    after: Object.freeze({ ...after }),
  });

/**
 * Bounded active-water and kelp simulation. No implicit subscriptions.
 *
 * Parent hooks:
 *   World.onMutation(event) -> fluids.onMutation(event), after publication;
 *   each admitted resident column -> fluids.onChunkLoaded(chunk);
 *   active game seconds only -> fluids.update(dt); paused frames pass 0;
 *   archive/preflight -> serialize()/normalizeFluidSnapshot()/load();
 *   prepareDrops(drops, {plants, changes, dimension, epoch}) returns one shared
 *     coordinator participant or <=16 participants, or null to defer removal. This hook
 *     must also include any affected station/plant ownership participant.
 *
 * Conservative replay is queued before publication, so synchronous autosaves
 * and throwing notifications cannot miss the next wave. Duplicate forwarded
 * events coalesce. A whole tick is planned before one World commit,
 * so new flow cannot race through multiple queued cells in the same tick.
 *
 * Defaults: <=4 ticks/update, <=96 proposals/tick, <=192 distinct reads/proposal,
 * <=256 scan cells/update (<=7 reads/cell), <=64 scan-job visits and <=16 resident
 * recovery visits/update. World prerequisite validation adds at most two reads
 * per captured read plus one per changed cell. Caller-provided drop work is not
 * included in these bounds. External mutation intake is O(25 * changes.length),
 * capped by the World's MAX_EDITS; it never scans terrain. A removed timed
 * kelp cell adds one non-generating read to confirm its published replacement.
 *
 * Each dimension has its own clock and bounded queues. Excess dt beyond one
 * second is discarded, not converted into an unbounded catch-up loop. Pending
 * work, unlike wall-clock backlog, is never discarded. A fixed scheduler
 * reservation makes notifications safe even when the shared save is full.
 * A validated over-budget staged import may opt into allowOverBudget at
 * construction; this does not waive any later World/drop transaction checks.
 */
export class FluidSystem {
  constructor(
    world,
    {
      coordinator = world?.coordinator,
      prepareDrops,
      limits = {},
      allowOverBudget = false,
    } = {}
  ) {
    if (
      !world ||
      typeof world.getCell !== "function" ||
      typeof world.prepareMutation !== "function" ||
      !(world.chunks instanceof Map) ||
      !coordinator ||
      coordinator !== world.coordinator
    )
      throw new TypeError(
        "FluidSystem requires a World and its shared coordinator"
      );
    if (prepareDrops !== undefined && !synchronous(prepareDrops))
      throw new TypeError("Fluid drop preparation must be synchronous");
    if (typeof allowOverBudget !== "boolean")
      throw new TypeError("Invalid fluid reservation adoption option");
    this.world = world;
    this.coordinator = coordinator;
    this.prepareDrops = prepareDrops;
    this.limits = fluidLimits(limits);
    this.seed = world.seed;
    this.generatorVersion = world.generatorVersion;
    this.reservedBytes = fluidReservedBytes(this.limits);
    this._work = new Map();
    this._disposed = false;
    this._updating = false;
    this._last = counters();
    this._total = counters();
    if (!coordinator.register(this, this.reservedBytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve bounded fluid scheduler capacity");
  }

  _matchesWorld() {
    return (
      !this._disposed &&
      this.world.seed === this.seed &&
      this.world.generatorVersion === this.generatorVersion &&
      isDimension(this.world.dimension)
    );
  }

  _dimension(dimension = this.world.dimension) {
    if (!this._work.has(dimension))
      this._work.set(
        dimension,
        new FluidWork(dimension, this.generatorVersion, this.limits)
      );
    return this._work.get(dimension);
  }

  onMutation(event) {
    if (!this._matchesWorld()) return false;
    const changes = Array.isArray(event) ? event : event?.changes;
    const dimension = Array.isArray(event)
      ? this.world.dimension
      : (event?.dimension ?? this.world.dimension);
    if (
      !Array.isArray(changes) ||
      changes.length > MAX_EDITS ||
      !isDimension(dimension) ||
      (!Array.isArray(event) &&
        event.epoch !== undefined &&
        event.epoch !== this.world.epoch)
    )
      return false;
    const spec =
      this._work.get(dimension)?.spec ??
      getWorldSpec(this.generatorVersion, dimension);
    for (const change of changes)
      if (!change || !inWorldBounds(change.x, change.y, change.z, spec))
        return false;
    if (!changes.length) return true;
    const work = this._dimension(dimension);
    for (const change of changes) {
      const { x, y, z, before, after } = change;
      // A paid break/replant between ticks is a new plant, not the old tip's
      // nearly completed opportunity. Coordinate-only/repeated wakeups cannot
      // clear this state; require an actual published kelp replacement.
      if (
        dimension === this.world.dimension &&
        before?.id === BLOCK.KELP &&
        after &&
        after.id !== BLOCK.KELP &&
        work.queue.get(`${x},${y},${z}`)?.kelpAge != null &&
        cellsEqual(this.world.getCell(x, y, z), after)
      )
        work.clearKelp(change);
      work.wake(x, y, z, this._updating ? this._last : this._total);
    }
    return true;
  }

  onChunkLoaded(chunkOrX, cz) {
    if (!this._matchesWorld()) return false;
    const cx = typeof chunkOrX === "object" ? chunkOrX?.cx : chunkOrX;
    cz = typeof chunkOrX === "object" ? chunkOrX?.cz : cz;
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) return false;
    const chunk = this.world.chunks.get(`${cx},${cz}`);
    if (!chunk || (typeof chunkOrX === "object" && chunkOrX !== chunk))
      return false;
    this._dimension().onChunkLoaded(this.world, chunk);
    return true;
  }

  _retry(work, plans, stats) {
    for (const plan of plans)
      work.offer(
        plan.entry.x,
        plan.entry.y,
        plan.entry.z,
        {
          ...plan.entry,
          due: work.clock + 1,
        },
        true,
        stats
      );
  }

  _dropParticipants(plans, changes, epoch) {
    if (!plans.some((plan) => plan.plants.length)) return [];
    const drops = Object.freeze(
      plans
        .flatMap((plan) => plan.drops)
        .map((drop) =>
          Object.freeze({ ...drop, stack: Object.freeze({ ...drop.stack }) })
        )
    );
    const context = Object.freeze({
      dimension: this.world.dimension,
      epoch,
      changes: Object.freeze(changes.map(detachedChange)),
      plants: Object.freeze(
        plans
          .flatMap((plan) => plan.plants)
          .map((plant) =>
            Object.freeze({
              ...plant,
              before: Object.freeze({ ...plant.before }),
            })
          )
      ),
    });
    try {
      const prepared = this.prepareDrops(drops, context);
      if (!prepared || typeof prepared.then === "function") return null;
      const participants = Array.isArray(prepared) ? prepared : [prepared];
      if (
        (drops.length && !participants.length) ||
        participants.length > MAX_FLUID_DROP_PARTICIPANTS
      )
        return null;
      return participants;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    }
  }

  _marineParticipants(work, plans, epoch) {
    const timed = plans.filter((plan) => plan.entry.kelpAge !== null)
      .map(({ entry, kelpNext }) => ({
        entry,
        next: kelpNext ? {
          x: kelpNext.x, y: kelpNext.y, z: kelpNext.z,
          due: kelpNext.due, expand: false, coralId: null, coralDue: null,
          kelpAge: kelpNext.age, kelpDue: kelpNext.due,
        } : null,
      }));
    if (!timed.length) return [];
    return [{
      owner: this,
      beforeBytes: this.reservedBytes,
      afterBytes: this.reservedBytes,
      validate: () =>
        this._matchesWorld() &&
        this.world.epoch === epoch &&
        this.world.dimension === work.dimension &&
        this._work.get(work.dimension) === work &&
        timed.every(({ entry }) => {
          const queued = work.queue.get(`${entry.x},${entry.y},${entry.z}`);
          return queued?.kelpAge === entry.kelpAge &&
            queued?.kelpDue === entry.kelpDue;
        }),
      publish: () => {
        for (const { entry, next } of timed) {
          // A successful extension transfers one pinned slot to its new tip.
          // No fallible capacity increase, RNG draw or post-publication fixup.
          if (next) work.moveKelp(entry, next);
          else work.clearKelp(entry);
        }
      },
    }];
  }

  _tick(work, stats) {
    stats.ticks++;
    work.clock++;
    const epoch = this.world.epoch;
    const proposals = [];
    // No callbacks or publication while planning: all cells see this tick's
    // starting state, including source counts, falling feeds and support.
    for (const entry of work.take(stats)) {
      stats.evaluated++;
      proposals.push(planFluidCell(this.world, entry, work.clock, stats));
    }
    const accepted = [];
    for (const plan of proposals) {
      if (plan.waiting.length) {
        work.defer(plan.entry, plan.waiting);
        if (plan.entry.kelpAge !== null)
          work.keepKelp(plan.entry, {
            age: plan.entry.kelpAge,
            due: plan.entry.kelpDue,
            checkAt: work.clock + KELP_GROW_TICKS,
          }, stats);
        stats.deferred++;
      } else if (plan.retryAt !== null) {
        if (plan.coralId !== null) work.clearKelp(plan.entry);
        work.offer(
          plan.entry.x,
          plan.entry.y,
          plan.entry.z,
          {
            ...plan.entry,
            due: plan.retryAt,
            coralId: plan.coralId,
            coralDue: plan.coralDue,
          },
          true,
          stats
        );
        if (plan.reason === "read-limit") stats.readLimitRetries++;
      } else if (!plan.change) {
        if (plan.kelp) work.keepKelp(plan.entry, plan.kelp, stats);
        else work.clearKelp(plan.entry, { remove: true });
        if (plan.entry.expand) work.expand(plan.entry, stats);
      } else if (plan.plants.length && !synchronous(this.prepareDrops)) {
        stats.blockedDrops++;
        this._retry(work, [plan], stats);
      } else {
        accepted.push(plan);
      }
    }
    if (!accepted.length) return;
    // Growth targets the water ABOVE a tip; that cell can also have a water
    // proposal this tick. Prefer the valid aquatic replacement, never submit
    // duplicate coordinates (which would veto/retry both forever).
    const byCell = new Map();
    for (const plan of accepted) {
      const { x, y, z } = plan.change;
      const key = `${x},${y},${z}`;
      if (!byCell.has(key) || plan.kelpNext) byCell.set(key, plan);
    }
    const selected = [...byCell.values()];
    const changes = selected.map((plan) => plan.change);
    // Fixed reservation makes conservative replay infallible under capacity
    // pressure. If preparation/commit rejects, these extra checks recompute
    // against unchanged cells; they are not speculative World publications.
    for (const { entry, change } of selected) {
      work.offer(
        entry.x,
        entry.y,
        entry.z,
        { ...entry, due: work.clock + 1 },
        true,
        stats
      );
      work.wake(change.x, change.y, change.z, stats);
    }
    const prerequisites = new Map();
    for (const plan of selected)
      for (const read of plan.reads)
        prerequisites.set(`${read.x},${read.y},${read.z}`, read);
    stats.prepares++;
    const worldPlan = this.world.prepareMutation(changes, {
      epoch,
      reads: [...prerequisites.values()],
    });
    if (!worldPlan) {
      stats.rejected++;
      this._retry(work, selected, stats);
      return;
    }
    const drops = this._dropParticipants(selected, changes, epoch);
    if (!drops) {
      stats.blockedDrops++;
      this._retry(work, selected, stats);
      return;
    }
    stats.commits++;
    const marine = this._marineParticipants(work, selected, epoch);
    const result = this.coordinator.commit([worldPlan, ...drops, ...marine]);
    if (!result.ok) {
      stats.rejected++;
      this._retry(work, selected, stats);
      return;
    }
    stats.changedCells += changes.length;
    stats.kelpGrown += selected.filter((plan) => plan.kelpNext).length;
    stats.observerErrors += result.observerErrors.length;
  }

  update(dt) {
    if (this._updating) return false;
    this._last = counters();
    if (!this._matchesWorld() || !Number.isFinite(dt) || dt <= 0) return false;
    const stats = this._last;
    const work = this._dimension();
    if (work.clock >= MAX_FLUID_CLOCK) return false;
    const maxDebt = FLUID_STEP_SECONDS * this.limits.maxTicksPerUpdate;
    const admitted = Math.min(dt, maxDebt);
    stats.discardedSeconds =
      dt - admitted + Math.max(0, work.accumulator + admitted - maxDebt);
    work.accumulator = Math.min(maxDebt, work.accumulator + admitted);
    this._updating = true;
    try {
      while (
        stats.ticks < this.limits.maxTicksPerUpdate &&
        work.accumulator + 1e-10 >= FLUID_STEP_SECONDS &&
        work.clock < MAX_FLUID_CLOCK &&
        this._matchesWorld() &&
        this.world.dimension === work.dimension
      ) {
        work.accumulator = Math.max(0, work.accumulator - FLUID_STEP_SECONDS);
        this._tick(work, stats);
      }
      // Admit recovery AFTER consuming ready work. Otherwise an external wake
      // flood can refill a small queue before every scan and pin its cursor
      // forever, even though each update drains ordinary water work afterward.
      if (this._matchesWorld() && this.world.dimension === work.dimension)
        work.scan(this.world, stats);
    } finally {
      this._updating = false;
      for (const key of Object.keys(stats)) this._total[key] += stats[key];
    }
    return true;
  }

  serialize() {
    return {
      version: 1,
      seed: this.seed,
      generatorVersion: this.generatorVersion,
      dimensions: [...this._work.values()].map((work) => work.serialize()),
    };
  }

  load(data) {
    if (!this._matchesWorld() || this._updating) return false;
    const snapshot = normalizeFluidSnapshot(data, this);
    if (!snapshot) return false;
    const replacement = new Map();
    for (const entry of snapshot.dimensions) {
      const work = restoreFluidWork(entry, this.generatorVersion, this.limits);
      if (!work) return false;
      if (entry.dimension === this.world.dimension)
        for (const section of work.sections.values())
          section.waiting = section.waiting.filter(
            ([cx, cz]) => !this.world.chunks.has(`${cx},${cz}`)
          );
      replacement.set(entry.dimension, work);
    }
    this._work = replacement;
    return true;
  }

  diagnostics() {
    let queued = 0,
      kelpTimers = 0,
      dirtySections = 0,
      deferredSections = 0,
      scanJobs = 0,
      recoveryRegions = 0;
    for (const work of this._work.values()) {
      queued += work.queue.size;
      kelpTimers += work.kelpCount;
      dirtySections += work.sections.size;
      scanJobs += work.scans.size;
      recoveryRegions += work.regions.length;
      for (const section of work.sections.values())
        if (section.waiting.length) deferredSections++;
    }
    return {
      disposed: this._disposed,
      contextMatches: this._matchesWorld(),
      queued,
      kelpTimers,
      dirtySections,
      deferredSections,
      scanJobs,
      recoveryRegions,
      clock: this._work.get(this.world.dimension)?.clock ?? 0,
      reservedBytes: this._disposed ? 0 : this.reservedBytes,
      limits: this.limits,
      last: { ...this._last },
      total: { ...this._total },
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._work.clear();
    this.coordinator.release(this);
  }
}
