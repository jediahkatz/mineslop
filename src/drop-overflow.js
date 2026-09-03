import {
  cloneStackData,
  normalizeStackData,
  stackIdentity,
} from "./item-stack-data.js";
import { getItem } from "./items.js";
import {
  isLooseDimension,
  isLooseMotion,
  isLoosePosition,
  isLooseRecord,
  looseMotion,
  serializeLooseMotion,
} from "./loose-entity.js";
import { encodedBytes } from "./save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export const MAX_OVERFLOW_RECORDS = 1_000_000;
const MAX_FLUSH_WORK = 64;
const keyFor = (entry) =>
  JSON.stringify([
    entry.dimension,
    entry.x,
    entry.y,
    entry.z,
    stackIdentity(entry),
    entry.wear ?? null,
    entry.pickupDelay,
    entry.velocity.x,
    entry.velocity.y,
    entry.velocity.z,
  ]);
const itemFor = (id) =>
  Number.isSafeInteger(id) && id > 0 ? getItem(id) : null;

function cloneEntry(entry) {
  return {
    ...entry,
    velocity: { ...entry.velocity },
    ...(entry.data === undefined ? {} : { data: cloneStackData(entry.data) }),
  };
}

function freezeEntry(entry) {
  Object.freeze(entry.velocity);
  if (entry.data) {
    for (const value of Object.values(entry.data))
      if (value && typeof value === "object") Object.freeze(value);
    Object.freeze(entry.data);
  }
  return Object.freeze(entry);
}

function wearCounts(item, count, durability) {
  // Canonical Stack wear is scalar and count=1. Older chest/drop payloads hold
  // one remaining-durability value per item; neither representation may repair
  // a worn tool or collapse differently worn duplicates.
  if (typeof durability === "number") {
    if (count !== 1) return null;
    durability = [durability];
  }
  if (durability === undefined) return new Map([[item.durability, count]]);
  if (
    !item.durability ||
    !Array.isArray(durability) ||
    durability.length !== count
  )
    return null;
  const counts = new Map();
  for (const wear of durability) {
    if (!Number.isInteger(wear) || wear <= 0 || wear > item.durability)
      return null;
    counts.set(wear, (counts.get(wear) ?? 0) + 1);
  }
  return counts;
}

/** Pure detached archive normalization; no budget registration or publication. */
export function normalizeOverflowSnapshot(data, options = {}) {
  if (!isLooseRecord(options)) return null;
  const { context, maxEntries = MAX_OVERFLOW_RECORDS } = options;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_OVERFLOW_RECORDS ||
    !isLooseRecord(data) ||
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    data.entries.length > maxEntries
  )
    return null;
  const entries = [];
  const seen = new Set();
  for (const entry of data.entries) {
    if (
      !isLooseDimension(entry?.dimension) ||
      !isLoosePosition(entry, context) ||
      !isLooseMotion(entry) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      entry.durability !== undefined
    )
      return null;
    const item = itemFor(entry.id);
    if (!item) return null;
    if (
      entry.wear !== undefined &&
      (!item.durability ||
        !Number.isInteger(entry.wear) ||
        entry.wear <= 0 ||
        entry.wear > item.durability)
    )
      return null;
    let stackData;
    try {
      stackData = normalizeStackData(entry.id, entry.data, context);
    } catch {
      return null;
    }
    const clean = {
      id: entry.id,
      count: entry.count,
      dimension: entry.dimension,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      ...serializeLooseMotion(looseMotion(entry, 2.2)),
      ...(entry.wear === undefined ? {} : { wear: entry.wear }),
      ...(stackData === undefined ? {} : { data: stackData }),
    };
    // Implicit-full/explicit-full legacy wear remain distinct, as before.
    const key = keyFor(clean);
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push(clean);
  }
  return { version: 1, entries };
}

/**
 * A persistent, sparse spill buffer. Rendered pickups are capped; owned loot isn't
 * discarded when a chest contains more stacks than the active pickup pool fits.
 * Exact position, ID/data kind, wear, delay and velocity form each merge key.
 * Queued time is frozen; entries never expire. Changed records alone are encoded
 * for the shared reservation. Publications never flush, toast, or schedule saves.
 */
export class DropOverflow {
  constructor({
    maxEntries = MAX_OVERFLOW_RECORDS,
    coordinator = new TransactionCoordinator(),
    context,
    onChange,
  } = {}) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > MAX_OVERFLOW_RECORDS
    )
      throw new RangeError("Invalid loose-item archive capacity");
    this.maxEntries = maxEntries;
    this.coordinator = coordinator;
    this.context = context;
    this.onChange = onChange;
    this.entries = new Map();
    this.cursor = null;
    this._recordBytes = new Map();
    this._bytes = 0;
    this._revision = 0;
    this._legacyBusy = false;
    this._disposed = false;
    if (!coordinator.register(this, 0))
      throw new RangeError("Cannot register loose-item archive");
  }

  get size() {
    return this.entries.size;
  }

  get revision() {
    return this._revision;
  }

  get reservedBytes() {
    return this._bytes;
  }

  _prepareChanges(pending, prerequisite = () => true) {
    if (this._disposed || this._legacyBusy) return null;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const beforeSize = this.entries.size;
    const maximum = this.maxEntries;
    const entries = this.entries;
    const context = this.context;
    const seed = context?.seed;
    const generatorVersion = context?.generatorVersion;
    const specForDimension = context?.specForDimension;
    let afterSize = beforeSize;
    let cost = beforeBytes + (beforeSize ? 1 : 0);
    const changes = [];
    for (const [key, value] of pending) {
      const previous = entries.get(key);
      if (previous) {
        cost -= this._recordBytes.get(key);
        afterSize--;
      }
      const next = value === null ? null : freezeEntry(cloneEntry(value));
      const bytes = next === null ? 0 : encodedBytes(next) + 1;
      if (next !== null) {
        cost += bytes;
        afterSize++;
      }
      changes.push({ key, previous, next, bytes });
    }
    const afterBytes = cost - (afterSize ? 1 : 0);
    if (
      afterSize > maximum ||
      !Number.isSafeInteger(afterBytes) ||
      afterBytes < 0
    )
      return null;
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._disposed &&
        !this._legacyBusy &&
        this._revision === revision &&
        this.entries === entries &&
        this.entries.size === beforeSize &&
        this.maxEntries === maximum &&
        this._bytes === beforeBytes &&
        this.coordinator.usage(this) === beforeBytes &&
        this.context === context &&
        context?.seed === seed &&
        context?.generatorVersion === generatorVersion &&
        context?.specForDimension === specForDimension &&
        changes.every(({ key, previous }) => entries.get(key) === previous) &&
        prerequisite(),
      publish: () => {
        used = true;
        for (const { key, next, bytes } of changes) {
          if (next === null) {
            entries.delete(key);
            this._recordBytes.delete(key);
          } else {
            entries.set(key, next);
            this._recordBytes.set(key, bytes);
          }
        }
        this._bytes = afterBytes;
        this._revision++;
      },
      notify: () => this.onChange?.(),
    });
  }

  /**
   * Retain ALL entries before the caller debits any owned stacks.
   * Entries: { id, count, data?, x, y, z, dimension, durability?: number | number[],
   *            pickupDelay?: seconds, velocity?: {x,y,z} }.
   * Returns true only after a full validation/capacity pass; false changes
   * neither this archive nor visible pickups. No spawn callbacks run here.
   */
  addBatch(entries) {
    const participant = this.prepareAddBatch(entries);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  /** Multi-owner callers commit this participant with the source debit. */
  prepareAddBatch(entries) {
    if (this._disposed || this._legacyBusy) return null;
    if (!Array.isArray(entries) || entries.length > MAX_OVERFLOW_RECORDS)
      return null;
    const pending = new Map();
    let newRecords = 0;
    for (const source of entries) {
      if (
        !isLooseDimension(source?.dimension) ||
        !isLoosePosition(source, this.context) ||
        !isLooseMotion(source) ||
        !Number.isSafeInteger(source.count) ||
        source.count <= 0 ||
        source.wear !== undefined
      )
        return null;
      const item = itemFor(source.id);
      if (!item) return null;
      const counts = wearCounts(item, source.count, source.durability);
      if (!counts) return null;
      let data;
      try {
        data = normalizeStackData(source.id, source.data, this.context);
      } catch {
        return null;
      }
      const motion = looseMotion(source, 2.2);
      for (const [wear, amount] of counts) {
        const entry = {
          id: source.id,
          count: amount,
          x: source.x,
          y: source.y,
          z: source.z,
          dimension: source.dimension,
          ...serializeLooseMotion(motion),
          ...(data === undefined ? {} : { data: cloneStackData(data) }),
        };
        if (wear !== undefined) entry.wear = wear;
        const key = keyFor(entry);
        const previous = pending.get(key) ?? this.entries.get(key);
        if (previous) {
          const total = previous.count + amount;
          if (!Number.isSafeInteger(total)) return null;
          pending.set(key, { ...previous, count: total });
        } else {
          if (this.entries.size + ++newRecords > this.maxEntries) return null;
          pending.set(key, entry);
        }
      }
    }
    return this._prepareChanges(pending);
  }

  /** Compatibility wrapper; uniform optional delay/velocity applies to each drop. */
  enqueue(drops, position, dimension, options = {}) {
    const participant = this.prepareEnqueue(
      drops,
      position,
      dimension,
      options
    );
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  prepareEnqueue(drops, position, dimension, options = {}) {
    if (
      !isLooseDimension(dimension) ||
      !isLooseRecord(position) ||
      !isLoosePosition({ ...position, dimension }, this.context) ||
      !isLooseMotion(options) ||
      options.data !== undefined ||
      options.durability !== undefined ||
      !Array.isArray(drops) ||
      drops.length > MAX_OVERFLOW_RECORDS
    )
      return null;
    const entries = [];
    for (const drop of drops) {
      if (!isLooseRecord(drop) || drop.wear !== undefined) return null;
      entries.push({
        id: drop.id,
        count: drop.count,
        durability: drop.durability,
        data: drop.data,
        x: position.x,
        y: position.y,
        z: position.z,
        dimension,
        pickupDelay: options.pickupDelay,
        velocity: options.velocity,
      });
    }
    return this.prepareAddBatch(entries);
  }

  /**
   * Stage one retained stack moving to the visible pool. Returns
   * {count,participants:[overflow,pickups]} or null. No eager spawn or debit;
   * callers may combine these with other owners in the SAME coordinator commit.
   */
  prepareFlushRecord(key, world, pickups) {
    const entry = this.entries.get(key);
    if (
      !entry ||
      this._disposed ||
      this._legacyBusy ||
      !isLooseDimension(world?.dimension) ||
      entry.dimension !== world.dimension ||
      typeof world.isLoaded !== "function" ||
      !world.isLoaded(Math.floor(entry.x), Math.floor(entry.z)) ||
      pickups?.coordinator !== this.coordinator ||
      pickups.world !== world ||
      typeof pickups.prepareSpawnStack !== "function"
    )
      return null;
    const item = getItem(entry.id);
    const count = Math.min(entry.count, item.stackSize);
    const stack = {
      id: entry.id,
      count,
      ...(item.durability ? { durability: entry.wear ?? item.durability } : {}),
      ...(entry.data === undefined ? {} : { data: cloneStackData(entry.data) }),
    };
    const pickup = pickups.prepareSpawnStack(
      stack,
      { x: entry.x, y: entry.y, z: entry.z },
      { pickupDelay: entry.pickupDelay, velocity: { ...entry.velocity } }
    );
    if (!pickup) return null;
    const { seed, generatorVersion, dimension, epoch } = world;
    const overflow = this._prepareChanges(
      new Map([
        [
          key,
          count === entry.count
            ? null
            : { ...entry, count: entry.count - count },
        ],
      ]),
      () =>
        world.seed === seed &&
        world.generatorVersion === generatorVersion &&
        world.dimension === dimension &&
        world.epoch === epoch &&
        world.isLoaded(Math.floor(entry.x), Math.floor(entry.z))
    );
    return overflow
      ? Object.freeze({
          count,
          participants: Object.freeze([overflow, pickup]),
        })
      : null;
  }

  /**
   * Bounded round-robin work. Shared-coordinator pools use a two-owner commit.
   * The legacy raw spawn adapter is PLAIN DATA ONLY and must not re-enqueue.
   * Decorated records remain retained until the shared bridge is installed.
   */
  flush(world, pickups, budget = 8) {
    if (this._disposed || this._legacyBusy) return 0;
    if (!this.entries.size) {
      this.cursor = null;
      return 0;
    }
    if (
      !Number.isSafeInteger(budget) ||
      budget <= 0 ||
      !isLooseDimension(world?.dimension) ||
      typeof world?.isLoaded !== "function" ||
      typeof pickups?.spawn !== "function"
    )
      return 0;
    this.cursor ??= this.entries.keys();
    let spawned = 0;
    for (
      let inspected = 0;
      inspected < MAX_FLUSH_WORK && spawned < budget;
      inspected++
    ) {
      if (!this.cursor || this._disposed) break;
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = null;
        break;
      }
      const key = next.value;
      const entry = this.entries.get(key);
      if (
        !entry ||
        entry.dimension !== world.dimension ||
        !world.isLoaded(Math.floor(entry.x), Math.floor(entry.z))
      )
        continue;
      const amount = Math.min(entry.count, getItem(entry.id).stackSize);
      if (pickups.coordinator === this.coordinator) {
        const plan = this.prepareFlushRecord(key, world, pickups);
        if (plan && this.coordinator.commit(plan.participants).ok) spawned++;
        continue;
      }
      if (entry.data !== undefined) continue;
      const durability =
        entry.wear === undefined ? undefined : Array(amount).fill(entry.wear);
      const debit = this._prepareChanges(
        new Map([
          [
            key,
            amount === entry.count
              ? null
              : { ...entry, count: entry.count - amount },
          ],
        ])
      );
      if (!debit) continue;
      let accepted;
      this._legacyBusy = true;
      try {
        accepted = pickups.spawn(
          entry.id,
          amount,
          { x: entry.x, y: entry.y, z: entry.z },
          {
            durability,
            pickupDelay: entry.pickupDelay,
            velocity: { ...entry.velocity },
          }
        );
      } finally {
        this._legacyBusy = false;
      }
      if (accepted !== true) continue;
      if (!this.coordinator.commit([debit]).ok)
        throw new TransactionInvariantError(
          "accepted legacy drop could not relinquish ownership"
        );
      spawned++;
    }
    return spawned;
  }

  serialize() {
    return {
      version: 1,
      entries: [...this.entries.values()].map(cloneEntry),
    };
  }

  /** allowOverBudget is only for an already-validated staged archive load. */
  load(data, options = {}) {
    if (!isLooseRecord(options)) return false;
    const { context = this.context, allowOverBudget = false } = options;
    if (
      this._disposed ||
      this._legacyBusy ||
      typeof allowOverBudget !== "boolean"
    )
      return false;
    const parsed = normalizeOverflowSnapshot(data, {
      context,
      maxEntries: this.maxEntries,
    });
    if (!parsed) return false;
    const entries = new Map();
    const recordBytes = new Map();
    let bytes = 0;
    for (const entry of parsed.entries) {
      const key = keyFor(entry);
      const cost = encodedBytes(entry) + 1;
      bytes += cost;
      entries.set(key, freezeEntry(entry));
      recordBytes.set(key, cost);
    }
    if (entries.size) bytes--;
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this.entries = entries;
    this._recordBytes = recordBytes;
    this._bytes = bytes;
    this._revision++;
    this.context = context;
    this.cursor = null;
    return true;
  }

  dispose() {
    if (this._disposed || this._legacyBusy) return;
    this._disposed = true;
    this._revision++;
    this.coordinator.release(this);
    this.entries.clear();
    this._recordBytes.clear();
    this._bytes = 0;
    this.cursor = null;
    this.onChange = null;
  }
}
