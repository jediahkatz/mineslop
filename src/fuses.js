import { BLOCK } from "./blocks.js";
import {
  captureEntityContext,
  entityContextFor,
  matchesEntityContext,
} from "./entity-context.js";
import { hasExpandedTerrain } from "./generator-version.js";
import { TransactionCoordinator } from "./transactions.js";
import { inWorldBounds, isDimension } from "./world-spec.js";

export const MAX_FUSES = 64;
// Integer cell coordinates plus a bounded floating-point countdown and separator.
export const FUSE_RECORD_RESERVED_BYTES = 256;
const fields = new Set(["dimension", "x", "y", "z", "remaining"]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function valid(fuse, context) {
  return (
    record(fuse) &&
    Object.keys(fuse).every((key) => fields.has(key)) &&
    isDimension(fuse.dimension) &&
    inWorldBounds(
      fuse.x,
      fuse.y,
      fuse.z,
      context.specForDimension(fuse.dimension)
    ) &&
    (hasExpandedTerrain(context.generatorVersion) || fuse.y !== 0) &&
    Number.isFinite(fuse.remaining) &&
    fuse.remaining >= 0 &&
    fuse.remaining <= 60
  );
}

/** Detached archive validation, including explosives in inactive dimensions. */
export function normalizeFuseSnapshot(data, context) {
  if (data === undefined) return { version: 1, entries: [] };
  if (
    !record(data) ||
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    data.entries.length > MAX_FUSES ||
    Object.keys(data).some((key) => key !== "version" && key !== "entries")
  )
    return null;
  try {
    const bounds = entityContextFor(undefined, context);
    const entries = [];
    for (const fuse of data.entries) {
      if (!valid(fuse, bounds)) return null;
      entries.push({
        dimension: fuse.dimension,
        x: fuse.x,
        y: fuse.y,
        z: fuse.z,
        remaining: fuse.remaining,
      });
    }
    return { version: 1, entries };
  } catch {
    return null;
  }
}

/** Primed explosives belong to a world/dimension, not to the travelling player. */
export class Fuses {
  constructor({ coordinator = new TransactionCoordinator(), context } = {}) {
    this.coordinator = coordinator;
    this.context = context;
    this.entries = Object.freeze([]);
    this._revision = 0;
    this._bytes = 0;
    this._disposed = false;
    this._updating = false;
    if (!coordinator.register(this, 0))
      throw new RangeError("Cannot register explosive reservation");
  }

  get revision() {
    return this._revision;
  }

  get reservedBytes() {
    return this._bytes;
  }

  _prepareReplacement(next, { world, context = this.context, notify } = {}) {
    if (this._disposed || next.length > MAX_FUSES) return null;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const afterBytes = next.length * FUSE_RECORD_RESERVED_BYTES;
    const coordinator = this.coordinator;
    const previousContext = this.context;
    const current = captureEntityContext(world, context);
    const entries = Object.freeze(
      next.map((entry) => Object.freeze({ ...entry }))
    );
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._disposed &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this.coordinator === coordinator &&
        coordinator.usage(this) === beforeBytes &&
        this.context === previousContext &&
        current(),
      publish: () => {
        used = true;
        this.entries = entries;
        this.context = context;
        this._bytes = afterBytes;
        this._revision++;
      },
      ...(notify ? { notify } : {}),
    });
  }

  prime(world, hit, delay = 2) {
    const participants = this.preparePrime(world, hit, delay);
    return participants !== null && this.coordinator.commit(participants).ok;
  }

  /** Commit this array together; callers may append prepared hand-use costs. */
  preparePrime(world, hit, delay = 2) {
    if (
      this._disposed ||
      !world ||
      !hit ||
      world.coordinator !== this.coordinator ||
      typeof world.prepareMutation !== "function" ||
      typeof world.getCell !== "function" ||
      typeof world.isLoaded !== "function" ||
      !matchesEntityContext(world, this.context) ||
      (hit.dimension !== undefined && hit.dimension !== world.dimension) ||
      this.entries.length >= MAX_FUSES
    )
      return null;
    let context;
    try {
      context = entityContextFor(world, this.context ?? world);
    } catch {
      return null;
    }
    const fuse = {
      dimension: world.dimension,
      x: hit.x,
      y: hit.y,
      z: hit.z,
      remaining: delay,
    };
    if (!valid(fuse, context) || !world.isLoaded(hit.x, hit.z)) return null;
    const before = world.getCell(hit.x, hit.y, hit.z);
    if (before?.id !== BLOCK.TNT) return null;
    const remove = world.prepareMutation([
      {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        before,
        after: { id: BLOCK.AIR, state: 0, fluid: 0 },
      },
    ]);
    const retain = this._prepareReplacement([...this.entries, fuse], {
      world,
      context,
    });
    return remove && retain ? [remove, retain] : null;
  }

  update(dt, world, onExplode) {
    if (
      this._disposed ||
      this._updating ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !isDimension(world?.dimension) ||
      typeof world.isLoaded !== "function" ||
      typeof onExplode !== "function" ||
      Object.prototype.toString.call(onExplode) !== "[object Function]" ||
      !matchesEntityContext(world, this.context)
    )
      return;
    const next = [];
    const due = [];
    let advanced = false;
    for (const fuse of this.entries) {
      if (
        fuse.dimension !== world.dimension ||
        !world.isLoaded(fuse.x, fuse.z)
      ) {
        next.push(fuse);
        continue;
      }
      advanced = true;
      const remaining = Math.max(0, fuse.remaining - Math.min(dt, 5));
      if (remaining > 0) next.push({ ...fuse, remaining });
      else due.push(fuse);
    }
    if (!advanced) return;
    this._updating = true;
    try {
      const participant = this._prepareReplacement(next, {
        world,
        context: entityContextFor(world, this.context ?? world),
        notify: () => {
          // Every due record and reservation is gone before the first callback.
          // One failed observer must not suppress the other one-shot explosions.
          const errors = [];
          for (const fuse of due) {
            try {
              onExplode(
                { x: fuse.x + 0.5, y: fuse.y + 0.5, z: fuse.z + 0.5 },
                3.5
              );
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(errors, "Explosive observers failed");
        },
      });
      return participant ? this.coordinator.commit([participant]) : null;
    } finally {
      this._updating = false;
    }
  }

  serialize() {
    return { version: 1, entries: this.entries.map((fuse) => ({ ...fuse })) };
  }

  load(data, options = {}) {
    if (!record(options) || this._disposed || this._updating) return false;
    const { context = this.context, allowOverBudget = false } = options;
    if (typeof allowOverBudget !== "boolean") return false;
    const snapshot = normalizeFuseSnapshot(data, context);
    if (!snapshot) return false;
    const next = Object.freeze(
      snapshot.entries.map((fuse) => Object.freeze(fuse))
    );
    const bytes = next.length * FUSE_RECORD_RESERVED_BYTES;
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this.entries = next;
    this.context = context;
    this._bytes = bytes;
    this._revision++;
    return true;
  }

  dispose() {
    if (this._disposed) return;
    if (
      this.coordinator.usage(this) !== undefined &&
      !this.coordinator.release(this)
    )
      return;
    this._disposed = true;
    this.entries = Object.freeze([]);
    this._bytes = 0;
    this._revision++;
  }
}
