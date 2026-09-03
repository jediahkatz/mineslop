import { intersectRayBox } from "./aabb.js";
import { validPassengerId } from "./boat-definitions.js";
import {
  captureEntityContext,
  entityContextFor,
  matchesEntityContext,
} from "./entity-context.js";
import {
  compileFishingLootTables,
  DEFAULT_FISHING_TABLES,
  fishingRodStats,
  nextFishingRandom,
  rollFishingCatch,
} from "./fishing-loot.js";
import {
  bobberBox,
  FISHING_TICK,
  fishingLaunch,
  MAX_FISHING_CASTS,
  MAX_FISHING_RANGE,
  MAX_FISHING_STEPS,
  stepFishingCast,
} from "./fishing-physics.js";
import { FishingRenderer } from "./fishing-render.js";
import {
  cloneFishingRecord,
  FISHING_HEADER_RESERVED_BYTES,
  FISHING_RECORD_RESERVED_BYTES,
  normalizeFishingRecord,
  normalizeFishingSnapshot,
  validFishingSlotKey,
} from "./fishing-save.js";
import {
  fishingOpenWaterBounds,
  inspectFishingMutationWater,
  inspectFishingOpenWater,
  mutationTouchesFishingWater,
} from "./fishing-water.js";
import { cloneStack } from "./inventory-slots.js";
import { stackIdentity } from "./item-stack-data.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  commitVehicleSnapshots,
  prepareVehicleSnapshot,
  vehicleDimensionCounts,
  vehicleDimensionsAfter,
} from "./vehicle-load.js";
import {
  aquaticSample,
  captureAquaticArea,
  finitePoint,
  loadedAquaticArea,
  synchronousAquaticCallback,
} from "./vehicle-water.js";
import { isDimension } from "./world-spec.js";

export {
  FISHING_ITEM_REQUIREMENTS,
  FISHING_ENCHANTMENT_REQUIREMENTS,
  DEFAULT_FISHING_TABLES,
} from "./fishing-loot.js";
export { normalizeFishingSnapshot } from "./fishing-save.js";
export { inspectFishingOpenWater } from "./fishing-water.js";

const failed = (reason) => ({ ok: false, reason });
const distanceSquared = (a, b) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const positionOf = ({ x, y, z }) => ({ x, y, z });
const IDLE_UPDATE = Object.freeze({
  ticks: 0,
  observerErrors: Object.freeze([]),
});

/**
 * One retained cast per owner, at most eight casts across all dimensions.
 *
 * Synchronous integration hooks (every participant on world.coordinator):
 * readOwner(ownerId,hand) -> {
 *   position, dimension, dead?, eye, direction, lineOrigin?,
 *   stack, handRevision, slotKey // e.g. "inventory:0" or "offhand:0"
 * }
 * prepareHandCost({ownerId,hand,stack,handRevision,wear:1}) -> participant|null
 * prepareDrops({stacks,position,dimension,velocity,pickupDelay,reason}) -> participant|null
 * prepareExperience({amount,position,dimension,velocity,pickupDelay}) -> participant|null
 *
 * Bridge these to Gameplay.prepareHandCost, DropOverflow.prepareEnqueue, and
 * ExperienceOrbs.prepareSpawn. No spawn/add/wear/credit callback is accepted.
 * The successful reel submits ALL FOUR owners once: cast/RNG removal, exact
 * hand wear, retained physical loot, and retained physical XP. Any unavailable,
 * stale, invalid, or full owner rejects before publication. Empty reel costs 0.
 *
 * Game: use({ownerId,hand}) on rod use; update(activeDt); render(viewer).
 * On World's postcommit mutation events forward onMutation(event), so an
 * invalid pool repaired between ticks still forfeits treasure for that attempt.
 * On events show splash/approach/bite/miss/catch feedback; the real renderer also
 * shows approach bubbles and a physical bite dip. No debug-only grants.
 * Lure's nonpositive rolls persist as `wait-retry` with zero timers. A retry
 * consumes one draw on the next 20Hz tick, within the same four-step update cap;
 * `wait-retry` events are not bites. `waiting` begins only after a positive roll.
 *
 * Archive: normalize/serialize/load. After Gameplay is loaded, explicitly call
 * bindLoadedOwner("player") once, before update/input. It compares the saved
 * rod AND durable slot key and only rebinds the runtime hand revision. Other
 * dimensions/unloaded frontiers freeze clocks and RNG; bind on return. Wrong
 * rods fail binding without mutation; parent may explicitly cancel that cast.
 * This system neither moves Player nor prevents fishing while seated in Boats.
 */
export class Fishing {
  constructor(
    scene,
    world,
    {
      coordinator = world?.coordinator,
      context = world,
      readOwner,
      prepareHandCost,
      prepareDrops,
      prepareExperience,
      sampleFluid,
      available,
      allowOverBudget = false,
      lootTables = DEFAULT_FISHING_TABLES,
      onEvent,
      onChange,
    } = {}
  ) {
    if (!world || !coordinator || coordinator !== world.coordinator)
      throw new TypeError("Fishing requires the World's shared coordinator");
    for (const callback of [
      readOwner,
      prepareHandCost,
      prepareDrops,
      prepareExperience,
      sampleFluid,
      available,
      onEvent,
      onChange,
    ])
      if (callback !== undefined && !synchronousAquaticCallback(callback))
        throw new TypeError("Fishing hooks must be synchronous");
    if (typeof allowOverBudget !== "boolean")
      throw new TypeError("Invalid fishing admission policy");
    this.world = world;
    this.context = entityContextFor(world, context);
    if (!matchesEntityContext(world, this.context))
      throw new RangeError("Fishing context belongs to another world");
    this._tables = compileFishingLootTables(lootTables, this.context);
    this.coordinator = coordinator;
    this.readOwner = readOwner;
    this.prepareHandCost = prepareHandCost;
    this.prepareDrops = prepareDrops;
    this.prepareExperience = prepareExperience;
    this.sampleFluid = sampleFluid;
    this.available = available;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this._casts = new Map();
    this._dimensionCounts = vehicleDimensionCounts();
    this._unbound = new Set();
    this._renderOwners = new Map();
    this._renderCasts = [];
    this._nextId = 1;
    this._randomState = normalizeFishingSnapshot(
      undefined,
      this.context
    ).randomState;
    this._revision = 0;
    this._bytes = FISHING_HEADER_RESERVED_BYTES;
    this._disposed = this._preparing = this._updating = false;
    if (!coordinator.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve fishing archive header");
    this.renderer = null;
    try {
      if (scene && !this.bindRenderer(scene))
        throw new TypeError("Invalid fishing scene");
    } catch (error) {
      coordinator.release(this);
      throw error;
    }
  }

  get size() {
    return this._casts.size;
  }
  get activeSize() {
    return this._dimensionCounts[this.world.dimension] ?? 0;
  }
  get revision() {
    return this._revision;
  }
  get reservedBytes() {
    return this._bytes;
  }

  _ready(loading = false) {
    return (
      !this._disposed &&
      !this._preparing &&
      this.world.coordinator === this.coordinator &&
      this.coordinator.usage(this) === this._bytes &&
      matchesEntityContext(this.world, this.context) &&
      (loading || this.available === undefined || this.available() === true)
    );
  }

  bindRenderer(scene) {
    if (!this._ready(true) || this._updating) return false;
    if (this.renderer)
      return this.renderer.scene === scene && !this.renderer._disposed;
    if (scene === null) return true;
    if (scene?.isScene !== true) return false;
    this.renderer = new FishingRenderer(scene);
    return true;
  }

  _owner(ownerId, hand) {
    if (
      !validPassengerId(ownerId) ||
      !synchronousAquaticCallback(this.readOwner)
    )
      return null;
    const owner = this.readOwner(ownerId, hand);
    if (!owner || !finitePoint(owner.position) || !isDimension(owner.dimension))
      return null;
    return {
      ...owner,
      position: positionOf(owner.position),
      eye: finitePoint(owner.eye)
        ? positionOf(owner.eye)
        : { ...positionOf(owner.position), y: owner.position.y + 1.62 },
      direction: finitePoint(owner.direction)
        ? positionOf(owner.direction)
        : null,
      lineOrigin: finitePoint(owner.lineOrigin)
        ? positionOf(owner.lineOrigin)
        : undefined,
    };
  }

  _rodMatches(cast, owner, { binding = false } = {}) {
    return (
      !!owner &&
      !owner.dead &&
      owner.dimension === cast.dimension &&
      owner.slotKey === cast.slotKey &&
      Number.isSafeInteger(owner.handRevision) &&
      owner.handRevision >= 0 &&
      (binding || owner.handRevision === cast.handRevision) &&
      fishingRodStats(owner.stack, this.context) !== null &&
      stackIdentity(owner.stack, this.context) ===
        stackIdentity(cast.rod, this.context) &&
      owner.stack.durability === cast.rod.durability
    );
  }

  _inRange(cast, owner) {
    return (
      distanceSquared(owner.position, cast) <= MAX_FISHING_RANGE ** 2 &&
      distanceSquared(owner.position, cast.origin) <= MAX_FISHING_RANGE ** 2
    );
  }

  _ownerGuard(cast, owner, options) {
    return () => {
      const current = this._owner(cast.ownerId, cast.hand);
      return (
        this._rodMatches(cast, current, options) &&
        this._inRange(cast, current) &&
        samePoint(current.position, owner.position) &&
        current.poseRevision === owner.poseRevision &&
        current.handRevision === owner.handRevision
      );
    };
  }

  _prepare(
    changes,
    {
      randomState = this._randomState,
      nextId = this._nextId,
      prerequisite = () => true,
      events = [],
      bind = [],
    } = {}
  ) {
    if (!this._ready()) return null;
    const casts = this._casts,
      unbound = this._unbound;
    const counts = this._dimensionCounts;
    const revision = this._revision,
      beforeBytes = this._bytes;
    const beforeRandom = this._randomState,
      beforeNextId = this._nextId;
    const coordinator = this.coordinator,
      world = this.world,
      context = this.context;
    const dimension = world.dimension;
    const current = captureEntityContext(world, context);
    const entries = [];
    let size = casts.size,
      nextCounts = counts;
    for (const [ownerId, next] of changes) {
      const before = casts.get(ownerId);
      size += Number(next !== null) - Number(before !== undefined);
      nextCounts = vehicleDimensionsAfter(nextCounts, before, next);
      entries.push({ ownerId, before, next });
    }
    if (size < 0 || size > MAX_FISHING_CASTS) return null;
    const afterBytes =
      FISHING_HEADER_RESERVED_BYTES + size * FISHING_RECORD_RESERVED_BYTES;
    let used = false,
      notified = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        this._ready() &&
        this._casts === casts &&
        this._unbound === unbound &&
        this._dimensionCounts === counts &&
        this.coordinator === coordinator &&
        this.world === world &&
        this.context === context &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this._randomState === beforeRandom &&
        this._nextId === beforeNextId &&
        coordinator.usage(this) === beforeBytes &&
        current() &&
        entries.every(({ ownerId, before }) => casts.get(ownerId) === before) &&
        prerequisite(),
      publish: () => {
        used = true;
        for (const { ownerId, before, next } of entries) {
          if (next === null) {
            casts.delete(ownerId);
            if (before) unbound.delete(before.id);
          } else casts.set(ownerId, next);
        }
        for (const id of bind) unbound.delete(id);
        this._dimensionCounts = nextCounts;
        this._randomState = randomState;
        this._nextId = nextId;
        this._bytes = afterBytes;
        this._revision++;
      },
      notify: () => {
        if (!used || notified) return;
        notified = true;
        const errors = [];
        for (const event of events) {
          const detail = { dimension, ...event };
          try {
            this.renderer?.event(detail);
          } catch (error) {
            errors.push(error);
          }
          try {
            this.onEvent?.(detail);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          this.onChange?.();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(errors, "Fishing observers failed");
      },
    };
  }

  _callback(name, request) {
    const callback = this[name];
    if (!synchronousAquaticCallback(callback)) return null;
    this._preparing = true;
    try {
      const participant = callback(request);
      return participant &&
        typeof participant.then !== "function" &&
        this.coordinator.usage(participant.owner) !== undefined &&
        (participant.owner?.coordinator === undefined ||
          participant.owner.coordinator === this.coordinator)
        ? participant
        : null;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this._preparing = false;
    }
  }

  commit(plan) {
    if (!plan?.ok || !Array.isArray(plan.participants))
      return plan ?? failed("invalid-plan");
    const result = this.coordinator.commit(plan.participants);
    if (!result.ok) return result;
    const { participants, ...details } = plan;
    return { ...details, ...result };
  }

  getCast(ownerId = "player") {
    const cast = this._casts.get(ownerId);
    return cast ? cloneFishingRecord(cast, this.context) : null;
  }

  hasCast(ownerId = "player") {
    return this._casts.has(ownerId);
  }

  needsBinding(ownerId = "player") {
    const cast = this._casts.get(ownerId);
    return !!cast && this._unbound.has(cast.id);
  }

  prepareCast({ ownerId = "player", hand = "main", direction } = {}) {
    if (!this._ready() || !["main", "offhand"].includes(hand))
      return failed("unavailable");
    if (
      [this.prepareHandCost, this.prepareDrops, this.prepareExperience].some(
        (callback) => !synchronousAquaticCallback(callback)
      )
    )
      return failed("missing-prepared-rewards");
    if (this._casts.has(ownerId)) return failed("already-cast");
    if (
      this.size >= MAX_FISHING_CASTS ||
      this._nextId >= Number.MAX_SAFE_INTEGER
    )
      return failed("cast-capacity");
    const owner = this._owner(ownerId, hand);
    const stats = fishingRodStats(owner?.stack, this.context);
    if (
      !owner ||
      owner.dead ||
      owner.dimension !== this.world.dimension ||
      !stats ||
      !Number.isSafeInteger(owner.handRevision) ||
      owner.handRevision < 0 ||
      !validFishingSlotKey(owner.slotKey)
    )
      return failed("invalid-rod");
    const launch = fishingLaunch(
      this.world,
      owner.eye,
      direction ?? owner.direction
    );
    if (!launch) return failed("no-cast-clearance");
    const random = nextFishingRandom(this._randomState);
    const cast = normalizeFishingRecord(
      {
        id: this._nextId,
        ownerId,
        hand,
        slotKey: owner.slotKey,
        handRevision: owner.handRevision,
        rod: cloneStack(owner.stack, this.context),
        dimension: owner.dimension,
        origin: positionOf(owner.position),
        ...launch,
        phase: "flying",
        remaining: 0,
        total: 0,
        flightTicks: 0,
        randomState: random.state,
        openWater: false,
        accumulator: 0,
        approachAngle: 0,
        lure: stats.lure,
        luck: stats.luck,
      },
      this.context
    );
    if (!cast) return failed("invalid-cast");
    const guard = captureAquaticArea(this.world, this.context, bobberBox(cast));
    if (!guard) return failed("frontier");
    const ownerGuard = this._ownerGuard(cast, owner);
    const own = this._prepare(new Map([[ownerId, cast]]), {
      randomState: random.state,
      nextId: cast.id + 1,
      prerequisite: () => guard() && ownerGuard(),
      events: [
        {
          type: "cast",
          id: cast.id,
          ownerId,
          hand,
          position: positionOf(cast),
        },
      ],
    });
    return own
      ? { ok: true, action: "cast", id: cast.id, participants: [own] }
      : failed("cast-rejected");
  }

  cast(request) {
    return this.commit(this.prepareCast(request));
  }

  _removal(cast, type, reason, prerequisite) {
    const own = this._prepare(new Map([[cast.ownerId, null]]), {
      prerequisite,
      events: [
        {
          type,
          reason,
          id: cast.id,
          ownerId: cast.ownerId,
          position: positionOf(cast),
        },
      ],
    });
    return own
      ? { ok: true, action: type, id: cast.id, participants: [own] }
      : failed("unavailable");
  }

  prepareCancel(ownerId = "player", reason = "cancelled") {
    const cast = this._casts.get(ownerId);
    if (!cast || !this._ready()) return failed("no-cast");
    return this._removal(cast, "cancel", reason);
  }

  cancel(ownerId = "player", reason = "cancelled") {
    return this.commit(this.prepareCancel(ownerId, reason));
  }

  prepareReel(ownerId = "player") {
    if (!this._ready()) return failed("unavailable");
    const cast = this._casts.get(ownerId);
    if (!cast) return failed("no-cast");
    if (cast.dimension !== this.world.dimension)
      return failed("inactive-dimension");
    if (this._unbound.has(cast.id)) return failed("needs-owner-binding");
    const owner = this._owner(ownerId, cast.hand);
    if (!this._rodMatches(cast, owner)) return failed("rod-changed");
    if (!this._inRange(cast, owner)) return failed("out-of-range");
    const ownerGuard = this._ownerGuard(cast, owner);
    if (cast.phase !== "hook" || cast.remaining <= 0)
      return this._removal(cast, "empty-reel", undefined, ownerGuard);
    const contact = aquaticSample(
      this.world,
      { ...cast, y: cast.y - 0.08 },
      this.sampleFluid
    );
    if (!contact) return failed("frontier");
    if (!contact.water)
      return this._removal(cast, "empty-reel", "left-water", ownerGuard);
    if (
      [this.prepareHandCost, this.prepareDrops, this.prepareExperience].some(
        (callback) => !synchronousAquaticCallback(callback)
      )
    )
      return failed("missing-prepared-rewards");
    const water = inspectFishingOpenWater(this.world, cast);
    if (!water.loaded) return failed("frontier");
    const guard = captureAquaticArea(
      this.world,
      this.context,
      fishingOpenWaterBounds(cast)
    );
    if (!guard) return failed("frontier");
    const catchResult = rollFishingCatch(cast.randomState, {
      luck: cast.luck,
      openWater: cast.openWater && water.valid,
      tables: this._tables,
      context: this.context,
    });
    const position = { x: cast.x, y: cast.y + 0.15, z: cast.z };
    const velocity = {
      x: (owner.position.x - cast.x) * 0.15,
      y: 2.5 + Math.max(-1, Math.min(1, (owner.position.y - cast.y) * 0.1)),
      z: (owner.position.z - cast.z) * 0.15,
    };
    const own = this._prepare(new Map([[ownerId, null]]), {
      randomState: catchResult.randomState,
      prerequisite: () => guard() && ownerGuard(),
      events: [
        {
          type: "catch",
          id: cast.id,
          ownerId,
          position: positionOf(cast),
          category: catchResult.category,
          stack: cloneStack(catchResult.stack, this.context),
          experience: catchResult.experience,
        },
      ],
    });
    if (!own) return failed("catch-rejected");
    const cost = this._callback("prepareHandCost", {
      ownerId,
      hand: cast.hand,
      stack: cloneStack(owner.stack, this.context),
      handRevision: owner.handRevision,
      slotKey: owner.slotKey,
      wear: 1,
    });
    if (!cost) return failed("hand-cost-rejected");
    const drop = this._callback("prepareDrops", {
      stacks: [cloneStack(catchResult.stack, this.context)],
      position: { ...position },
      dimension: cast.dimension,
      velocity: { ...velocity },
      pickupDelay: 0.25,
      reason: "fishing-catch",
    });
    if (!drop) return failed("drop-rejected");
    const experience = this._callback("prepareExperience", {
      amount: catchResult.experience,
      position: { ...position },
      dimension: cast.dimension,
      velocity: { x: velocity.x * 0.5, y: 1.5, z: velocity.z * 0.5 },
      pickupDelay: 0.25,
    });
    if (!experience) return failed("experience-rejected");
    return {
      ok: true,
      action: "catch",
      id: cast.id,
      catch: {
        ...catchResult,
        stack: cloneStack(catchResult.stack, this.context),
      },
      participants: [own, cost, drop, experience],
    };
  }

  reel(ownerId) {
    return this.commit(this.prepareReel(ownerId));
  }

  use(request = {}) {
    const ownerId = request.ownerId ?? "player";
    const cast = this._casts.get(ownerId);
    if (!cast) return this.cast(request);
    if (
      cast.dimension === this.world.dimension &&
      !this._rodMatches(cast, this._owner(ownerId, cast.hand))
    )
      return this.cancel(ownerId, "rod-changed");
    return this.reel(ownerId);
  }

  /** Read-only staging check; a supplied projection can never publish a bind. */
  checkLoadedOwner(ownerId, owner) {
    const cast = this._casts.get(ownerId);
    if (!this._ready(true) || !cast || !this._unbound.has(cast.id))
      return failed("not-awaiting-binding");
    if (cast.dimension !== this.world.dimension)
      return failed("inactive-dimension");
    if (
      !finitePoint(owner?.position) ||
      !this._rodMatches(cast, owner, { binding: true }) ||
      !this._inRange(cast, owner)
    )
      return failed("saved-rod-mismatch");
    return { ok: true };
  }

  /** A saved hand revision is process-local; only an admitted saved cast can rebind. */
  prepareBindLoadedOwner(ownerId = "player") {
    const cast = this._casts.get(ownerId);
    if (!this._ready() || !cast || !this._unbound.has(cast.id))
      return failed("not-awaiting-binding");
    const owner = this._owner(ownerId, cast.hand);
    const checked = this.checkLoadedOwner(ownerId, owner);
    if (!checked.ok) return checked;
    const next = { ...cast, handRevision: owner.handRevision };
    const own = this._prepare(new Map([[ownerId, next]]), {
      bind: [cast.id],
      prerequisite: this._ownerGuard(cast, owner, { binding: true }),
    });
    return own
      ? { ok: true, action: "bind", id: cast.id, participants: [own] }
      : failed("binding-rejected");
  }

  bindLoadedOwner(ownerId = "player") {
    return this.commit(this.prepareBindLoadedOwner(ownerId));
  }

  update(dt) {
    if (
      !this.activeSize ||
      !this._ready() ||
      this._updating ||
      !Number.isFinite(dt) ||
      dt <= 0
    )
      return IDLE_UPDATE;
    const current = captureEntityContext(this.world, this.context);
    let ticks = 0;
    const observerErrors = [];
    this._updating = true;
    try {
      for (const original of [...this._casts.values()]) {
        if (!current()) break;
        if (
          original.dimension !== this.world.dimension ||
          this._casts.get(original.ownerId) !== original ||
          this._unbound.has(original.id)
        )
          continue;
        const owner = this._owner(original.ownerId, original.hand);
        if (!owner || owner.dimension !== original.dimension) continue;
        if (
          !this._rodMatches(original, owner) ||
          !this._inRange(original, owner)
        ) {
          const result = this.cancel(
            original.ownerId,
            owner.dead
              ? "owner-dead"
              : this._rodMatches(original, owner)
                ? "out-of-range"
                : "rod-changed"
          );
          if (result.ok) observerErrors.push(...result.observerErrors);
          continue;
        }
        if (!loadedAquaticArea(this.world, bobberBox(original))) continue;
        let next = { ...original };
        let accumulator = Math.min(
          original.accumulator + dt,
          MAX_FISHING_STEPS * FISHING_TICK
        );
        let executed = 0,
          blocked = false;
        const events = [];
        while (
          accumulator + 1e-10 >= FISHING_TICK &&
          executed < MAX_FISHING_STEPS
        ) {
          const result = stepFishingCast(this.world, next, this.sampleFluid);
          if (!result) {
            blocked = true;
            break;
          }
          next = result.bobber;
          events.push(
            ...result.events.map((event) => ({
              ...event,
              id: original.id,
              ownerId: original.ownerId,
              position: next ? positionOf(next) : positionOf(original),
            }))
          );
          executed++;
          accumulator = Math.max(0, accumulator - FISHING_TICK);
          if (next === null) break;
        }
        if (blocked && executed === 0) continue;
        if (next)
          next.accumulator = blocked
            ? 0
            : Math.min(accumulator, FISHING_TICK - 1e-10);
        const own = this._prepare(new Map([[original.ownerId, next]]), {
          prerequisite: this._ownerGuard(original, owner),
          events,
        });
        if (!own) continue;
        const result = this.coordinator.commit([own]);
        if (result.ok) {
          ticks += executed;
          observerErrors.push(...result.observerErrors);
        }
      }
    } finally {
      this._updating = false;
    }
    return { ticks, observerErrors };
  }

  /**
   * Postcommit World hook. Large mutations conservatively invalidate eligibility
   * in all active attempts instead of scanning an unbounded change list.
   */
  onMutation(event) {
    if (
      !this.activeSize ||
      !this._ready() ||
      !event ||
      event.dimension !== this.world.dimension ||
      (event.epoch !== undefined && event.epoch !== this.world.epoch) ||
      !Array.isArray(event.changes)
    )
      return false;
    const changes = new Map();
    for (const cast of this._casts.values()) {
      if (
        cast.dimension !== this.world.dimension ||
        !cast.openWater ||
        !["wait-retry", "waiting", "approach", "hook"].includes(cast.phase)
      )
        continue;
      const large = event.changes.length > 1024;
      if (
        !large &&
        !event.changes.some((change) =>
          mutationTouchesFishingWater(cast, change)
        )
      )
        continue;
      const water = large ? null : inspectFishingOpenWater(this.world, cast);
      const after = large
        ? null
        : inspectFishingMutationWater(this.world, cast, event.changes);
      if (
        large ||
        !water.loaded ||
        !water.valid ||
        !after.loaded ||
        !after.valid
      )
        changes.set(cast.ownerId, { ...cast, openWater: false });
    }
    if (!changes.size) return false;
    const own = this._prepare(changes);
    return own !== null && this.coordinator.commit([own]).ok;
  }

  raycast(origin, direction, maxDistance = 6) {
    if (
      !this.activeSize ||
      !this._ready() ||
      !finitePoint(origin) ||
      !finitePoint(direction) ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0
    )
      return null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!length) return null;
    const vector = [
      direction.x / length,
      direction.y / length,
      direction.z / length,
    ];
    let best = null;
    for (const cast of this._casts.values()) {
      if (
        cast.dimension !== this.world.dimension ||
        this._unbound.has(cast.id) ||
        !loadedAquaticArea(this.world, bobberBox(cast))
      )
        continue;
      const hit = intersectRayBox(
        [origin.x, origin.y, origin.z],
        vector,
        bobberBox(cast),
        Math.min(6, maxDistance)
      );
      if (hit && (!best || hit.distance < best.distance))
        best = {
          type: "fishing-bobber",
          id: cast.id,
          ownerId: cast.ownerId,
          distance: hit.distance,
        };
    }
    return best;
  }

  interact(hit, { ownerId = "player" } = {}) {
    return hit?.type === "fishing-bobber" &&
      hit.ownerId === ownerId &&
      this._casts.get(ownerId)?.id === hit.id
      ? this.reel(ownerId)
      : failed("not-owned-bobber");
  }

  render(viewer, dt = 0) {
    if (!this.renderer) return;
    if (
      !this.activeSize &&
      !this.renderer.hasFeedback &&
      this.renderer.bobbers.count === 0
    )
      return;
    const owners = this._renderOwners,
      casts = this._renderCasts;
    owners.clear();
    casts.length = 0;
    if (this.activeSize && this._ready())
      for (const cast of this._casts.values()) {
        if (
          cast.dimension !== this.world.dimension ||
          this._unbound.has(cast.id) ||
          !loadedAquaticArea(this.world, bobberBox(cast))
        )
          continue;
        const owner = this._owner(cast.ownerId, cast.hand);
        if (!owner || owner.dimension !== cast.dimension) continue;
        owners.set(cast.ownerId, owner);
        casts.push(cast);
      }
    this.renderer.render(casts, viewer, owners, dt, this.world.dimension);
  }

  serialize() {
    return {
      version: 1,
      seed: String(this.context.seed),
      generatorVersion: this.context.generatorVersion,
      nextId: this._nextId,
      randomState: this._randomState,
      casts: [...this._casts.values()].map((cast) =>
        cloneFishingRecord(cast, this.context)
      ),
    };
  }

  prepareLoad(data, { context = this.context } = {}) {
    if (!this._ready(true) || this._updating) return null;
    const nextContext = entityContextFor(this.world, context);
    if (!matchesEntityContext(this.world, nextContext)) return null;
    const parsed = normalizeFishingSnapshot(data, nextContext);
    if (!parsed) return null;
    const bytes =
      FISHING_HEADER_RESERVED_BYTES +
      parsed.casts.length * FISHING_RECORD_RESERVED_BYTES;
    return prepareVehicleSnapshot(
      this,
      {
        context: nextContext,
        _casts: new Map(parsed.casts.map((cast) => [cast.ownerId, cast])),
        _dimensionCounts: vehicleDimensionCounts(parsed.casts),
        _unbound: new Set(parsed.casts.map((cast) => cast.id)),
        _nextId: parsed.nextId,
        _randomState: parsed.randomState,
      },
      bytes
    );
  }

  load(data, { context = this.context, allowOverBudget = false } = {}) {
    const participant = this.prepareLoad(data, { context });
    if (
      !participant ||
      !commitVehicleSnapshots(this.coordinator, [participant], allowOverBudget)
    )
      return false;
    this.renderer?.clearFeedback();
    this._renderOwners.clear();
    this._renderCasts.length = 0;
    this.renderer?.render(this._renderCasts, null, this._renderOwners);
    return true;
  }

  diagnostics() {
    return {
      casts: this.size,
      limit: MAX_FISHING_CASTS,
      awaitingBinding: this._unbound.size,
      activeDimensionRecords: this.activeSize,
      maxTicksPerUpdate: MAX_FISHING_CASTS * MAX_FISHING_STEPS,
      reservedBytes: this._bytes,
      renderer: this.renderer?.diagnostics() ?? null,
    };
  }

  dispose() {
    if (
      this._disposed ||
      this._preparing ||
      this._updating ||
      !this.coordinator.release(this)
    )
      return;
    this._disposed = true;
    this._revision++;
    this._casts.clear();
    this._dimensionCounts = vehicleDimensionCounts();
    this._unbound.clear();
    this._renderOwners.clear();
    this._renderCasts.length = 0;
    this._bytes = 0;
    this.renderer?.dispose();
    this.readOwner =
      this.prepareHandCost =
      this.prepareDrops =
      this.prepareExperience =
      this.available =
      this.onEvent =
      this.onChange =
        null;
  }
}
