import * as THREE from "three";
import { cloneStack, isValidStack } from "./inventory-slots.js";
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
  loadedLooseColumns,
  looseDistanceSquared,
  looseMotion,
  sameLooseMotion,
  serializeLooseMotion,
  stepLooseEntity,
} from "./loose-entity.js";
import { encodedBytes } from "./save-budget.js";
import { CHUNK_SIZE } from "./terrain.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export const MAX_PICKUPS = 256;
// Covers bounded v1 metadata, all finite coordinate/motion encodings, and a
// separator. Motion never changes the reservation or serializes the whole pool.
export const PICKUP_RECORD_RESERVED_BYTES = 4096;
const HALF_SIZE = 0.14;
const FOOTPRINT = HALF_SIZE * Math.SQRT2;
const PICKUP_DISTANCE_SQ = 1.8 ** 2;
const MERGE_DISTANCE_SQ = 1.5 ** 2;
const ACTIVE_DISTANCE_SQ = 80 ** 2;
const RETRY_DELAY = 1;
const FULL_NOTICE_DELAY = 3;
const TAU = Math.PI * 2;
const validCount = (count) => Number.isSafeInteger(count) && count > 0;
const itemFor = (id) =>
  Number.isSafeInteger(id) && id > 0 ? getItem(id) : null;
const positionInWorld = (position, world) =>
  isLooseDimension(world?.dimension) &&
  isLooseRecord(position) &&
  isLoosePosition(
    { x: position.x, y: position.y, z: position.z, dimension: world.dimension },
    world
  );

function validDurability(item, count, durability) {
  if (durability === undefined) return true;
  if (
    !item.durability ||
    !Array.isArray(durability) ||
    durability.length !== count
  )
    return false;
  for (const value of durability) {
    if (!Number.isInteger(value) || value <= 0 || value > item.durability)
      return false;
  }
  return true;
}

function parsePickupSnapshot(data, context) {
  if (data === undefined) return [];
  if (
    !isLooseRecord(data) ||
    data.version !== 1 ||
    !Array.isArray(data.items) ||
    data.items.length > MAX_PICKUPS
  )
    return null;
  const items = [];
  for (const entry of data.items) {
    if (
      !isLooseDimension(entry?.dimension) ||
      !isLoosePosition(entry, context) ||
      !isLooseMotion(entry) ||
      !validCount(entry.count)
    )
      return null;
    const item = itemFor(entry.id);
    if (
      !item ||
      entry.count > item.stackSize ||
      !validDurability(item, entry.count, entry.durability)
    )
      return null;
    let stackData;
    try {
      stackData = normalizeStackData(entry.id, entry.data, context);
    } catch {
      return null;
    }
    items.push({
      id: entry.id,
      count: entry.count,
      position: { x: entry.x, y: entry.y, z: entry.z },
      dimension: entry.dimension,
      motion: looseMotion(entry),
      durability:
        entry.durability === undefined ? undefined : [...entry.durability],
      ...(stackData === undefined ? {} : { data: stackData }),
    });
  }
  return items;
}

/** Pure archive preflight; missing components are empty, malformed ones fail. */
export const validatePickups = (data, context) =>
  parsePickupSnapshot(data, context) !== null;

function serializeDrop(drop) {
  const { id, count, dimension, x, y, z, durability, data } = drop;
  return {
    id,
    count,
    dimension,
    x,
    y,
    z,
    ...serializeLooseMotion(drop),
    ...(durability === undefined ? {} : { durability: [...durability] }),
    ...(data === undefined ? {} : { data: cloneStackData(data) }),
  };
}

/** Detached normalized archive for preflight, with no scene/renderer allocation. */
export function normalizePickupSnapshot(data, context) {
  const parsed = parsePickupSnapshot(data, context);
  if (parsed === null) return null;
  return {
    version: 1,
    items: parsed.map(({ position, motion, ...entry }) =>
      serializeDrop({ ...entry, ...position, ...motion })
    ),
  };
}

function makeDrop(id, count, position, dimension, motion, durability, data) {
  return {
    id,
    count,
    dimension,
    x: position.x,
    y: position.y,
    z: position.z,
    ...motion,
    retryIn: 0,
    phase: (position.x * 13 + position.z * 17 + id) % TAU,
    color: new THREE.Color(getItem(id).color),
    ...(durability === undefined ? {} : { durability: [...durability] }),
    ...(data === undefined ? {} : { data: cloneStackData(data) }),
    kind: stackIdentity({ id, data }),
  };
}

function dropStack(drop, count = drop.count) {
  const item = getItem(drop.id);
  return cloneStack({
    id: drop.id,
    count,
    ...(item.durability
      ? { durability: drop.durability?.[0] ?? item.durability }
      : {}),
    ...(drop.data === undefined ? {} : { data: drop.data }),
  });
}

/**
 * Bounded, persistent drops. Positions are cube centers; update receives player
 * feet. No renderer, DOM, textures, timers, or world generation are required.
 */
export class Pickups {
  constructor(
    scene,
    world,
    {
      onCollect,
      onCollectStack,
      onFull,
      onChange,
      coordinator = new TransactionCoordinator(),
    } = {}
  ) {
    this.scene = scene;
    this.world = world;
    this.onCollect = onCollect;
    this.onCollectStack = onCollectStack;
    this.onFull = onFull;
    this.onChange = onChange;
    this.coordinator = coordinator;
    this._bytes = 0;
    this._revision = 0;
    this._legacyBusy = false;
    if (!coordinator.register(this, 0))
      throw new RangeError("Cannot register pickup reservation");
    this._items = [];
    this._disposed = false;
    this._fullNoticeIn = 0;
    this._matrix = new THREE.Object3D();
    this.geometry = new THREE.BoxGeometry(
      HALF_SIZE * 2,
      HALF_SIZE * 2,
      HALF_SIZE * 2
    );
    this.material = new THREE.MeshLambertMaterial({
      emissive: "#ffffff",
      emissiveIntensity: 0.08,
    });
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_PICKUPS
    );
    this.mesh.name = "item-pickups";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  get size() {
    return this._items.length;
  }

  get revision() {
    return this._revision;
  }

  get reservedBytes() {
    return this._bytes;
  }

  getStack(index) {
    return Number.isInteger(index) && this._items[index]
      ? dropStack(this._items[index])
      : null;
  }

  _prepareReplacement(next, notify = () => this.onChange?.()) {
    if (this._disposed || this._legacyBusy) return null;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const afterBytes = next.length * PICKUP_RECORD_RESERVED_BYTES;
    const world = this.world;
    const { epoch, seed, generatorVersion, dimension } = world;
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
        this._bytes === beforeBytes &&
        this.coordinator.usage(this) === beforeBytes &&
        this.world === world &&
        world.epoch === epoch &&
        world.seed === seed &&
        world.generatorVersion === generatorVersion &&
        world.dimension === dimension,
      publish: () => {
        used = true;
        this._items = next;
        this._bytes = afterBytes;
        this._revision++;
        this.mesh.count = 0;
      },
      ...(notify ? { notify } : {}),
    });
  }

  /**
   * Plain-data compatibility adapter: merge/split or refuse everything.
   * options: { durability?: number[], pickupDelay?: seconds, velocity?: {x,y,z} }.
   * Metadata callers use spawnStack/prepareSpawnStack; options.data is rejected,
   * never silently discarded. Omitted legacy wear remains omitted in saves.
   */
  spawn(id, count, position, options = {}) {
    const participant = this.prepareSpawn(id, count, position, options);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  prepareSpawn(id, count, position, options = {}) {
    const item = itemFor(id);
    const dimension = this.world.dimension;
    if (
      this._disposed ||
      this._legacyBusy ||
      !item ||
      !validCount(count) ||
      count > item.stackSize * MAX_PICKUPS ||
      !isLooseDimension(dimension) ||
      !positionInWorld(position, this.world) ||
      !isLooseMotion(options) ||
      options.data !== undefined ||
      !validDurability(item, count, options.durability)
    )
      return null;
    return this._prepareSpawns([
      {
        id,
        count,
        position,
        dimension,
        motion: looseMotion(options, 2.2),
        durability: options.durability,
      },
    ]);
  }

  spawnStack(stack, position, options = {}) {
    const participant = this.prepareSpawnStack(stack, position, options);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  prepareSpawnStack(stack, position, options = {}) {
    if (
      !isLooseDimension(this.world.dimension) ||
      !isValidStack(stack, this.world) ||
      !positionInWorld(position, this.world) ||
      !isLooseMotion(options) ||
      options.data !== undefined ||
      options.durability !== undefined
    )
      return null;
    return this.prepareSpawnBatch([
      {
        ...cloneStack(stack, this.world),
        x: position.x,
        y: position.y,
        z: position.z,
        dimension: this.world.dimension,
        pickupDelay: options.pickupDelay,
        velocity: options.velocity,
      },
    ]);
  }

  /**
   * One participant for flat canonical spawn records:
   * {...Stack,x,y,z,dimension?,pickupDelay?,velocity?}. All records target the
   * current dimension. Preparing never merges, spawns, notifies, or reserves.
   */
  prepareSpawnBatch(records) {
    if (!Array.isArray(records) || records.length > MAX_PICKUPS) return null;
    const pending = [];
    for (const record of records) {
      if (
        !isLooseDimension(this.world.dimension) ||
        !isValidStack(record, this.world) ||
        (record.dimension !== undefined &&
          record.dimension !== this.world.dimension) ||
        !positionInWorld(record, this.world) ||
        !isLooseMotion(record)
      )
        return null;
      const stack = cloneStack(record, this.world);
      pending.push({
        id: stack.id,
        count: stack.count,
        position: { x: record.x, y: record.y, z: record.z },
        dimension: this.world.dimension,
        motion: looseMotion(record, 2.2),
        durability:
          stack.durability === undefined ? undefined : [stack.durability],
        data: stack.data,
      });
    }
    return this._prepareSpawns(pending);
  }

  _prepareSpawns(pending) {
    if (this._disposed || this._legacyBusy) return null;
    const next = this._items.slice();
    for (const {
      id,
      count,
      position,
      dimension,
      motion,
      durability,
      data,
    } of pending) {
      const item = getItem(id);
      const kind = stackIdentity({ id, data });
      let remaining = count;
      for (let index = 0; index < next.length; index++) {
        const drop = next[index];
        if (
          item.durability ||
          drop.kind !== kind ||
          drop.dimension !== dimension ||
          drop.count >= item.stackSize ||
          !sameLooseMotion(drop, motion) ||
          looseDistanceSquared(drop, position) > MERGE_DISTANCE_SQ
        )
          continue;
        const amount = Math.min(remaining, item.stackSize - drop.count);
        next[index] = { ...drop, count: drop.count + amount };
        remaining -= amount;
        if (!remaining) break;
      }
      if (next.length + Math.ceil(remaining / item.stackSize) > MAX_PICKUPS)
        return null;
      while (remaining > 0) {
        const amount = Math.min(remaining, item.stackSize);
        const offset = count - remaining;
        const drop = makeDrop(
          id,
          amount,
          position,
          dimension,
          motion,
          durability?.slice(offset, offset + amount),
          data
        );
        if (
          encodedBytes(serializeDrop(drop)) + 1 >
          PICKUP_RECORD_RESERVED_BYTES
        )
          return null;
        next.push(drop);
        remaining -= amount;
      }
    }
    return this._prepareReplacement(next);
  }

  /**
   * Returns {stack,participant}; commit with the receiving owner's participant.
   * Partial non-durable takes retain metadata, motion, and the remaining count.
   * notify:false is for update's deferred, post-mesh collection notifications.
   */
  prepareTake(index, count, options = {}) {
    if (!isLooseRecord(options)) return null;
    const { notify = true } = options;
    const drop = Number.isInteger(index) ? this._items[index] : null;
    const amount = count === undefined ? drop?.count : count;
    if (
      !drop ||
      !validCount(amount) ||
      amount > drop.count ||
      typeof notify !== "boolean"
    )
      return null;
    const stack = dropStack(drop, amount);
    const next = this._items.slice();
    if (amount === drop.count) next.splice(index, 1);
    else next[index] = { ...drop, count: drop.count - amount };
    const participant = this._prepareReplacement(
      next,
      notify ? () => this._notifyCollected(stack) : null
    );
    return participant ? { stack: cloneStack(stack), participant } : null;
  }

  _notifyCollected(stack) {
    this.onCollect?.(stack.id, stack.count);
    this.onCollectStack?.(cloneStack(stack));
    this.onChange?.();
  }

  _collect(index, gameplay) {
    const drop = this._items[index];
    if (typeof gameplay.prepareAddStack === "function") {
      if (gameplay.coordinator !== this.coordinator) return false;
      const take = this.prepareTake(index, undefined, { notify: false });
      const receive = take && gameplay.prepareAddStack(cloneStack(take.stack));
      return Boolean(
        receive && this.coordinator.commit([take.participant, receive]).ok
      );
    }
    // Deprecated isolated callers can collect plain records only. The real
    // Gameplay uses prepareAddStack and the shared coordinator above.
    if (drop.data !== undefined || typeof gameplay.add !== "function")
      return false;
    let accepted;
    this._legacyBusy = true;
    try {
      accepted =
        drop.durability === undefined
          ? gameplay.add(drop.id, drop.count)
          : gameplay.add(drop.id, drop.count, {
              durability: [...drop.durability],
            });
    } finally {
      this._legacyBusy = false;
    }
    if (accepted !== true) return false;
    const take = this.prepareTake(index, undefined, { notify: false });
    if (!take || !this.coordinator.commit([take.participant]).ok)
      throw new TransactionInvariantError(
        "accepted legacy pickup could not relinquish ownership"
      );
    return true;
  }

  update(dt, elapsed, playerPosition, gameplay) {
    if (this._disposed || this._legacyBusy) return;
    const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const step = Math.min(delta, 0.1);
    const phase = Number.isFinite(elapsed) ? elapsed % TAU : 0;
    this._fullNoticeIn = Math.max(0, this._fullNoticeIn - delta);
    const hasPlayer = positionInWorld(playerPosition, this.world);
    if (hasPlayer) {
      // Instance matrices are Float32. Keep their translations local; the
      // mesh/camera world transforms cancel the large origin in double precision.
      this.mesh.position.set(
        Math.floor(playerPosition.x / CHUNK_SIZE) * CHUNK_SIZE,
        Math.floor(playerPosition.y / CHUNK_SIZE) * CHUNK_SIZE,
        Math.floor(playerPosition.z / CHUNK_SIZE) * CHUNK_SIZE
      );
    }
    const canCollect =
      step > 0 &&
      hasPlayer &&
      (typeof gameplay?.add === "function" ||
        typeof gameplay?.prepareAddStack === "function") &&
      !gameplay.dead;
    const collected = [];
    let full = null;
    let visible = 0;

    for (let i = 0; i < this._items.length; ) {
      const drop = this._items[i];
      if (
        !hasPlayer ||
        drop.dimension !== this.world.dimension ||
        (drop.x - playerPosition.x) ** 2 + (drop.z - playerPosition.z) ** 2 >
          ACTIVE_DISTANCE_SQ
      ) {
        i++;
        continue;
      }
      const columns = loadedLooseColumns(this.world, drop, FOOTPRINT);
      if (!columns) {
        i++;
        continue;
      }
      const advanced = stepLooseEntity(this.world, drop, step, {
        halfSize: HALF_SIZE,
        footprint: FOOTPRINT,
      });
      if (advanced) {
        drop.retryIn = Math.max(0, drop.retryIn - delta);
        drop.pickupDelay = Math.max(0, drop.pickupDelay - delta);
        this._revision++;
      }
      if (
        canCollect &&
        advanced &&
        drop.pickupDelay === 0 &&
        drop.retryIn === 0 &&
        looseDistanceSquared(drop, playerPosition) <= PICKUP_DISTANCE_SQ
      ) {
        const added = this._collect(i, gameplay);
        if (added === true) {
          collected.push(dropStack(drop));
          continue;
        }
        drop.retryIn = RETRY_DELAY;
        this._revision++;
        if (this._fullNoticeIn === 0) {
          this._fullNoticeIn = FULL_NOTICE_DELAY;
          full = [drop.id, drop.count];
        }
      }

      this._matrix.position.set(
        drop.x - this.mesh.position.x,
        drop.y -
          this.mesh.position.y +
          0.04 +
          Math.sin(phase * 2 + drop.phase) * 0.03,
        drop.z - this.mesh.position.z
      );
      this._matrix.rotation.set(0, phase + drop.phase, 0);
      this._matrix.updateMatrix();
      this.mesh.setMatrixAt(visible, this._matrix.matrix);
      this.mesh.setColorAt(visible, drop.color);
      visible++;
      i++;
    }
    this.mesh.count = visible;
    if (visible) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    // Notify only after state and mesh are consistent; callbacks may spawn drops.
    for (const stack of collected) this._notifyCollected(stack);
    if (full) this.onFull?.(...full);
  }

  /** Save all dimensions, including frozen and invisible drops. */
  serialize() {
    return {
      version: 1,
      items: this._items.map(serializeDrop),
    };
  }

  /**
   * Invalid saves return false without changing existing drops. Old v1 entries
   * without motion fields load stationary and immediately eligible (delay 0).
   * A missing component (undefined) loads an empty pool.
   */
  load(data, options = {}) {
    if (!isLooseRecord(options)) return false;
    const { context = this.world, allowOverBudget = false } = options;
    if (
      this._disposed ||
      this._legacyBusy ||
      typeof allowOverBudget !== "boolean"
    )
      return false;
    const parsed = parsePickupSnapshot(data, context);
    if (parsed === null) return false;
    const next = parsed.map(
      ({
        id,
        count,
        position,
        dimension,
        motion,
        durability,
        data: stackData,
      }) =>
        makeDrop(id, count, position, dimension, motion, durability, stackData)
    );
    if (
      next.some(
        (drop) =>
          encodedBytes(serializeDrop(drop)) + 1 > PICKUP_RECORD_RESERVED_BYTES
      )
    )
      return false;
    const bytes = next.length * PICKUP_RECORD_RESERVED_BYTES;
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this._items = next;
    this._bytes = bytes;
    this._revision++;
    this._fullNoticeIn = 0;
    this.mesh.count = 0;
    return true;
  }

  dispose() {
    if (this._disposed || this._legacyBusy) return;
    this._disposed = true;
    this._revision++;
    this.coordinator.release(this);
    this._bytes = 0;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this._items.length = 0;
    this.mesh.count = 0;
    this.onCollect = this.onCollectStack = this.onFull = this.onChange = null;
  }
}
