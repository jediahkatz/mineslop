import { BLOCK, BLOCKS } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { cloneStack, isValidStack } from "../src/inventory-slots.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  createWorldContext,
  getWorldSpec,
  inWorldBounds,
  isEditablePosition,
} from "../src/world-spec.js";

/**
 * Loaded, authored cells and prepared ownership only. This is not a terrain
 * generator, World implementation substitute, or rendered gameplay evidence.
 */
export class InteractionWorld {
  constructor({
    coordinator = new TransactionCoordinator(),
    seed = "interaction-fixture",
    generatorVersion = 3,
    floor = null,
  } = {}) {
    Object.assign(this, {
      coordinator,
      seed,
      generatorVersion,
      floor,
      dimension: "overworld",
      epoch: 0,
      _editRevision: 0,
      _bytes: 0,
      cells: new Map(),
      recordBytes: new Map(),
      blocked: new Set(),
      unloaded: new Set(),
      writes: [],
    });
    if (!coordinator.register(this, 0))
      throw new Error("Fixture registration failed");
  }

  get spec() {
    return getWorldSpec(this.generatorVersion, this.dimension);
  }
  get context() {
    return createWorldContext(this);
  }
  key(x, y, z) {
    return `${this.dimension}:${x},${y},${z}`;
  }
  column(x, z) {
    return `${this.dimension}:${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  }
  isLoaded(x, z) {
    return !this.unloaded.has(this.column(x, z));
  }
  setLoaded(x, z, loaded) {
    if (loaded) this.unloaded.delete(this.column(x, z));
    else this.unloaded.add(this.column(x, z));
    this.epoch++;
  }
  baseCell(y) {
    return normalizeCell({
      id: this.floor !== null && y <= this.floor ? BLOCK.STONE : BLOCK.AIR,
    });
  }
  getCell(x, y, z) {
    if (!inWorldBounds(x, y, z, this.spec) || !this.isLoaded(x, z)) return null;
    return { ...(this.cells.get(this.key(x, y, z)) ?? this.baseCell(y)) };
  }
  get(x, y, z) {
    return this.getCell(x, y, z)?.id ?? BLOCK.AIR;
  }
  getBlockState(x, y, z) {
    return this.getCell(x, y, z)?.state ?? 0;
  }
  getFluid(x, y, z) {
    return this.getCell(x, y, z)?.fluid ?? 0;
  }
  isSolid(x, y, z) {
    return BLOCKS[this.get(x, y, z)]?.solid === true;
  }
  set(x, y, z, id) {
    return this.setCell(x, y, z, { id });
  }
  setCell(x, y, z, after) {
    const plan = this.prepareMutation([
      {
        x,
        y,
        z,
        before: this.getCell(x, y, z),
        after,
      },
    ]);
    return plan !== null && this.coordinator.commit([plan]).ok;
  }

  prepareMutation(changes, { reads = [], epoch = this.epoch, notify } = {}) {
    if (!Array.isArray(changes) || !changes.length || epoch !== this.epoch)
      return null;
    const { dimension, seed, generatorVersion, _editRevision: revision } = this;
    const beforeBytes = this._bytes;
    const records = [];
    const prerequisites = [];
    const keys = new Set();
    let afterBytes = beforeBytes;
    try {
      for (const { x, y, z, before, after } of changes) {
        const key = this.key(x, y, z);
        const expected = normalizeCell(before);
        if (
          keys.has(key) ||
          !isEditablePosition(x, y, z, generatorVersion, dimension) ||
          !this.isLoaded(x, z) ||
          this.blocked.has(key) ||
          !cellsEqual(expected, this.getCell(x, y, z)) ||
          expected.id === BLOCK.BEDROCK
        )
          return null;
        keys.add(key);
        const next = normalizeCell(after);
        if (cellsEqual(expected, next)) continue;
        const remove = cellsEqual(next, this.baseCell(y));
        const bytes = remove
          ? 0
          : encodedBytes([
              dimension,
              x,
              y,
              z,
              next.id,
              next.state,
              next.fluid,
            ]) + 1;
        afterBytes += bytes - (this.recordBytes.get(key) ?? 0);
        records.push({
          x,
          y,
          z,
          key,
          before: expected,
          after: next,
          bytes,
          remove,
        });
      }
      for (const { x, y, z, before } of reads) {
        const expected = before === null ? null : normalizeCell(before);
        if (!cellsEqual(expected, this.getCell(x, y, z))) return null;
        prerequisites.push({ x, y, z, before: expected });
      }
    } catch {
      return null;
    }
    if (!records.length) return null;
    let used = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        this.epoch === epoch &&
        this.dimension === dimension &&
        this.seed === seed &&
        this.generatorVersion === generatorVersion &&
        this._editRevision === revision &&
        this._bytes === beforeBytes &&
        [...records, ...prerequisites].every(({ x, y, z, before }) =>
          cellsEqual(this.getCell(x, y, z), before)
        ) &&
        records.every(({ key }) => !this.blocked.has(key)),
      publish: () => {
        used = true;
        for (const { key, after, bytes, remove, x, y, z } of records) {
          if (remove) {
            this.cells.delete(key);
            this.recordBytes.delete(key);
          } else {
            this.cells.set(key, Object.freeze(after));
            this.recordBytes.set(key, bytes);
          }
          this.writes.push({ dimension, x, y, z, ...after });
        }
        this._bytes = afterBytes;
        this._editRevision++;
      },
      notify: () => {
        this.onMutation?.({ dimension, epoch, changes: records });
        notify?.({ dimension, epoch, changes: records });
      },
    };
  }
}

function recordSink(coordinator, records) {
  const sink = {
    coordinator,
    records,
    revision: 0,
    accept: true,
    prepare(value) {
      if (!this.accept) return null;
      const revision = this.revision;
      const beforeBytes = coordinator.usage(this);
      const next = structuredClone(value);
      let used = false;
      return {
        owner: this,
        beforeBytes,
        afterBytes: beforeBytes + encodedBytes(next),
        validate: () => !used && this.accept && this.revision === revision,
        publish: () => {
          used = true;
          this.records.push(next);
          this.revision++;
        },
        notify: () => this.onChange?.(next),
      };
    },
    serialize() {
      return structuredClone(this.records);
    },
  };
  if (!coordinator.register(sink, 0))
    throw new Error("Fixture sink registration failed");
  return sink;
}

/** Scene-less sinks expose the real prepared surface, not eager spawn callbacks. */
export function interactionSinks(world, drops, experience) {
  const { coordinator } = world;
  const pickups = recordSink(coordinator, drops);
  Object.assign(pickups, {
    world,
    prepareSpawnStack(stack, position, options = {}) {
      if (!isValidStack(stack, world.context)) return null;
      return this.prepare({
        ...cloneStack(stack, world.context),
        position: { ...position },
        options: {
          ...options,
          ...(stack.durability === undefined
            ? {}
            : { durability: [stack.durability] }),
        },
      });
    },
    spawn(id, count, position, options = {}) {
      const plan = this.prepareSpawnStack(
        {
          id,
          count,
          ...(options.durability ? { durability: options.durability[0] } : {}),
        },
        position,
        options
      );
      return plan !== null && coordinator.commit([plan]).ok;
    },
  });
  Object.defineProperty(pickups, "size", { get: () => drops.length });
  const experienceOrbs = recordSink(coordinator, experience);
  Object.assign(experienceOrbs, {
    world,
    prepareSpawn(amount, position, options = {}) {
      if (!Number.isSafeInteger(amount) || amount < 1) return null;
      return this.prepare({
        amount,
        position: { ...position },
        options: { ...options },
      });
    },
    spawn(amount, position, options) {
      const plan = this.prepareSpawn(amount, position, options);
      return plan !== null && coordinator.commit([plan]).ok;
    },
  });
  return { pickups, experienceOrbs };
}

export function interactionSnapshot(game) {
  return {
    world: structuredClone([...game.world.cells]),
    writes: structuredClone(game.world.writes),
    gameplay: game.gameplay.serialize(),
    settlement: game.settlement.serialize(),
    overflow: game.overflow.serialize(),
    pickups: game.pickups.serialize(),
    experience: game.experienceOrbs.serialize(),
    bytes: game.gameplay.coordinator.budget.totalBytes,
  };
}
