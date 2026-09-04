import { BLOCK } from "./blocks.js";
import {
  cellAfterBreaking,
  isWaterFluid,
  normalizeCell,
} from "./block-state.js";
import {
  applyContainerAction,
  CHEST_SLOTS,
  ChestCounts,
  transferItem,
} from "./container-slots.js";
import { matchesIngredient } from "./crafting.js";
import {
  acceptsCropSoil, cropBlock, cropDrops, cropRule, cropSpeciesForItem,
  CROP_RECORD_VERSION, CROP_SPECIES,
} from "./crop-rules.js";
import {
  advanceFurnace,
  cloneFurnace,
  createFurnace,
  furnaceProgress,
} from "./furnace.js";
import { isSupportedGeneratorVersion } from "./generator-version.js";
import { cloneSlots, insertStack, takeStack } from "./inventory-slots.js";
import { getItem } from "./items.js";
import { prepareCropBatch } from "./settlement-crop-batch.js";
import {
  captureStationRead,
  CROP_GROW_SECONDS,
  isRecord,
  normalizeSettlementContext,
  normalizeSettlementSnapshot,
  ownStationRecord,
  SETTLEMENT_VERSION,
  settlementPositionValid,
  STATION_KINDS,
  stationKey,
  stationPosition,
  stationRecordBytes,
} from "./settlement-state.js";
import {
  prepareSettlementContainers,
  prepareStationOwnership,
  prepareStationRecords,
  synchronousStationCallback,
} from "./settlement-transactions.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import { createWorldContext, DIMENSIONS } from "./world-spec.js";

export { CHEST_SLOTS, CROP_GROW_SECONDS, SETTLEMENT_VERSION };
export { normalizeSettlementSnapshot } from "./settlement-state.js";

const CONTAINER_BLOCKS = new Map([
  [BLOCK.CHEST, "chest"],
  [BLOCK.FURNACE, "furnace"],
]);
const failure = (message) => ({ ok: false, ...(message ? { message } : {}) });

function hasWater(world, { x, y, z }) {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (!world.isLoaded(x + dx, z + dz)) continue;
      for (let dy = 1; dy <= 2; dy++) {
        const cell = world.getCell(x + dx, y - dy, z + dz);
        if (cell && isWaterFluid(cell.fluid)) return true;
      }
    }
  }
  return false;
}

// Furnace advancement changes only slot IDs/counts, never existing metadata.
const sameFurnaceSlots = (a, b) =>
  a.slots.every(
    (stack, index) =>
      stack?.id === b.slots[index]?.id &&
      stack?.count === b.slots[index]?.count &&
      stack?.durability === b.slots[index]?.durability
  );

export class Settlement {
  constructor({
    coordinator = new TransactionCoordinator(),
    context,
    onChange,
  } = {}) {
    this.coordinator = coordinator;
    this.context = normalizeSettlementContext(context);
    this.onChange = onChange;
    this.chests = new Map();
    this.furnaces = new Map();
    this.crops = new Map();
    this._chestViews = new Map();
    this._recordBytes = new Map();
    this._bytes = 0;
    this._revision = 0;
    this._water = new Map();
    this._clock = 0;
    this._busy = false;
    this._disposed = false;
    this._world = null;
    this._worldSeed = undefined;
    this._worldGenerator = undefined;
    this._containerAccess = null;
    if (!coordinator.register(this, 0))
      throw new RangeError("Cannot register settlement");
  }

  get reservedBytes() {
    return this._bytes;
  }

  get revision() {
    return this._revision;
  }

  _matchesWorld(world, context = this.context, checkBinding = true) {
    return (
      !this._disposed &&
      isRecord(world) &&
      DIMENSIONS.includes(world.dimension) &&
      typeof world.seed === "string" &&
      world.seed.length <= 80 &&
      isSupportedGeneratorVersion(world.generatorVersion) &&
      world.coordinator === this.coordinator &&
      typeof world.isLoaded === "function" &&
      typeof world.get === "function" &&
      typeof world.getCell === "function" &&
      (!context ||
        (context.seed === world.seed &&
          context.generatorVersion === world.generatorVersion)) &&
      (!checkBinding ||
        !this._world ||
        (this._world === world &&
          this._worldSeed === world.seed &&
          this._worldGenerator === world.generatorVersion))
    );
  }

  _rememberWorld(world, context) {
    this._world = world;
    this._worldSeed = world.seed;
    this._worldGenerator = world.generatorVersion;
    this.context = context;
  }

  _matchesGameplay(world, gameplay) {
    return (
      gameplay &&
      !gameplay.dead &&
      gameplay.coordinator === this.coordinator &&
      (!gameplay.context ||
        (gameplay.context.seed === world?.seed &&
          gameplay.context.generatorVersion === world?.generatorVersion))
    );
  }

  /** Eager binding validates detached records against the supplied world too. */
  bindWorld(world) {
    if (this._busy || !this._matchesWorld(world)) return false;
    const context = this.context ?? createWorldContext(world);
    if (
      !this.context &&
      !normalizeSettlementSnapshot(this.serialize(), context)
    )
      return false;
    this._rememberWorld(world, context);
    this._revision++;
    return true;
  }

  chestKey(world, x, y, z) {
    try {
      const context =
        this.context ??
        (world?.generatorVersion === undefined ? undefined : world);
      return settlementPositionValid(world?.dimension, x, y, z, context)
        ? stationKey(world.dimension, x, y, z)
        : null;
    } catch {
      return null;
    }
  }

  _hitKey(world, hit) {
    if (
      !this._matchesWorld(world) ||
      !isRecord(hit) ||
      (hit.world !== undefined && hit.world !== world) ||
      (hit.dimension !== undefined && hit.dimension !== world.dimension)
    )
      return null;
    return this.chestKey(world, hit.x, hit.y, hit.z);
  }

  _liveContainer(world, hit, expectedKind) {
    const key = this._hitKey(world, hit);
    if (!key) return null;
    const read = captureStationRead(world, hit.x, hit.y, hit.z);
    const kind = CONTAINER_BLOCKS.get(read?.before.id);
    if (
      !kind ||
      (expectedKind && expectedKind !== kind) ||
      (hit.id !== undefined && hit.id !== read.before.id) ||
      this.crops.has(key) ||
      (kind === "chest" ? this.furnaces.has(key) : this.chests.has(key))
    )
      return null;
    return { key, kind, read };
  }

  _store(kind) {
    return kind === "chest"
      ? this.chests
      : kind === "furnace"
        ? this.furnaces
        : this.crops;
  }

  _containerDraft({ key, kind }) {
    return kind === "chest"
      ? {
          kind,
          slots: cloneSlots(
            this.chests.get(key) ?? Array(CHEST_SLOTS).fill(null),
            this.context
          ),
        }
      : {
          kind,
          ...cloneFurnace(
            this.furnaces.get(key) ?? createFurnace(),
            this.context
          ),
        };
  }

  _prepareRecords(changes, options) {
    return prepareStationRecords(this, changes, options);
  }

  /** Detached inspection: never establishes empty ownership for a natural chest. */
  inspectContainer(world, hit) {
    if (this._busy || this._disposed) return null;
    const live = this._liveContainer(world, hit);
    if (!live) return null;
    const draft = this._containerDraft(live);
    return {
      kind: live.kind,
      initialized: this._store(live.kind).has(live.key),
      slots: draft.slots,
      experience: live.kind === "furnace" ? draft.experience : 0,
      before: { ...live.read.before },
    };
  }

  /** One prepared participant for first-fill/adoption/read/clear/removal batches. */
  prepareContainers(world, requests, options) {
    return prepareSettlementContainers(this, world, requests, options);
  }

  /** A lifecycle-owned read gate blocks lazy paths until exploration is resolved. */
  bindContainerAccess(owner, check) {
    if (
      this._busy ||
      this._disposed ||
      this.coordinator.usage(owner) === undefined ||
      !synchronousStationCallback(check) ||
      (this._containerAccess && this._containerAccess.owner !== owner) ||
      !this.coordinator.register(this, this._bytes, { allowOverBudget: true })
    )
      return false;
    this._containerAccess = { owner, check };
    this._revision++;
    return true;
  }

  unbindContainerAccess(owner) {
    if (!this._containerAccess) return true;
    if (
      this._busy ||
      this._containerAccess.owner !== owner ||
      !this.coordinator.register(this, this._bytes, { allowOverBudget: true })
    )
      return false;
    this._containerAccess = null;
    this._revision++;
    return true;
  }

  ownsContainerAccess(owner) {
    return this._containerAccess?.owner === owner;
  }

  _containerAccessible(world, hit) {
    try {
      return (
        !this._containerAccess ||
        (this.coordinator.usage(this._containerAccess.owner) !== undefined &&
          this._containerAccess.check(world, hit) === true)
      );
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return false;
    }
  }

  /** Guard preparation only. ALL guards are released before joint notifications. */
  _prepare(work) {
    if (this._busy || this._disposed) return null;
    this._busy = true;
    try {
      const plan = work();
      return plan
        ? Object.freeze({
            participants: Object.freeze(plan.participants),
            result: Object.freeze(plan.result),
          })
        : null;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this._busy = false;
    }
  }

  _commit(plan) {
    if (!plan) return failure("The transfer could not be completed");
    // Publication invariant failures must propagate, never become a retryable veto.
    const committed = this.coordinator.commit(plan.participants);
    return committed.ok
      ? { ...plan.result, observerErrors: committed.observerErrors }
      : failure("The transfer could not be completed");
  }

  _ownershipPlan(gameplay, edit, prepareSource, options = {}) {
    return prepareStationOwnership(
      this,
      gameplay,
      edit,
      prepareSource,
      options
    );
  }

  _ensureContainer(live, world) {
    if (!this._containerAccessible(world, stationPosition(live.key)))
      return false;
    if (this._store(live.kind).has(live.key))
      return this._world ? true : this.bindWorld(world);
    const plan = this._prepare(() => {
      const context = this.context ?? createWorldContext(world);
      const draft = this._containerDraft(live);
      const source = this._prepareRecords(
        [
          {
            kind: live.kind,
            key: live.key,
            next: live.kind === "chest" ? draft.slots : draft,
          },
        ],
        { world, context, validate: live.read.validate }
      );
      return source ? { participants: [source], result: { ok: true } } : null;
    });
    return this._commit(plan).ok;
  }

  /** Live read-only counts; all finite ownership stays in the canonical slots. */
  getChest(world, hit) {
    const live = this._liveContainer(world, hit, "chest");
    if (!live || !this._ensureContainer(live, world)) return null;
    if (!this._chestViews.has(live.key))
      this._chestViews.set(
        live.key,
        new ChestCounts(() => this.chests.get(live.key) ?? [])
      );
    return this._chestViews.get(live.key);
  }

  getContainerState(world, hit, gameplay) {
    if (
      !this._matchesGameplay(world, gameplay) ||
      typeof gameplay.getState !== "function"
    )
      return null;
    const live = this._liveContainer(world, hit);
    if (!live || !this._ensureContainer(live, world)) return null;
    const next = this._containerDraft(live);
    return {
      kind: live.kind,
      title: live.kind === "chest" ? "Chest" : "Furnace",
      position: stationPosition(live.key),
      slots: next.slots,
      ...(live.kind === "furnace" ? furnaceProgress(next) : {}),
      gameplay: gameplay.getState(),
    };
  }

  containerAction(world, hit, gameplay, action, options = {}) {
    if (
      this._busy ||
      this._disposed ||
      !isRecord(action) ||
      !isRecord(options) ||
      !this._containerAccessible(world, hit) ||
      !this._matchesGameplay(world, gameplay)
    )
      return failure();
    const live = this._liveContainer(world, hit);
    if (!live) return failure("That container is no longer available");
    const crossContainer =
      action.area === "container" ||
      ["quickMove", "collect"].includes(action.type) ||
      (action.type === "distribute" &&
        Array.isArray(action.targets) &&
        action.targets.some((target) => target?.area === "container"));
    if (!crossContainer)
      return typeof gameplay.inventoryAction === "function"
        ? gameplay.inventoryAction(action, {
            prepareDrops: options.prepareDrops,
          })
        : failure();
    const plan = this._prepare(() => {
      const context = this.context ?? createWorldContext(world);
      const next = this._containerDraft(live);
      return this._ownershipPlan(
        gameplay,
        (owned) => applyContainerAction(next, owned, action),
        () =>
          this._prepareRecords(
            [
              {
                kind: live.kind,
                key: live.key,
                next: live.kind === "chest" ? next.slots : next,
              },
            ],
            { world, context, validate: live.read.validate }
          ),
        options
      );
    });
    return this._commit(plan);
  }

  _transferChest(world, hit, gameplay, itemId, count, intoChest) {
    if (
      !Number.isSafeInteger(itemId) ||
      !getItem(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      !this._containerAccessible(world, hit) ||
      !this._matchesGameplay(world, gameplay)
    )
      return false;
    const plan = this._prepare(() => {
      const live = this._liveContainer(world, hit, "chest");
      if (!live) return null;
      const context = this.context ?? createWorldContext(world);
      const next = this._containerDraft(live);
      return this._ownershipPlan(
        gameplay,
        (owned) => ({
          ok: transferItem(
            intoChest ? owned.slots : next.slots,
            intoChest ? next.slots : owned.slots,
            itemId,
            count
          ),
        }),
        () =>
          this._prepareRecords(
            [{ kind: "chest", key: live.key, next: next.slots }],
            { world, context, validate: live.read.validate }
          )
      );
    });
    return this._commit(plan).ok;
  }

  /** Plain-stack aggregate compatibility. Metadata callers use clicked slots. */
  transferToChest(world, hit, gameplay, itemId, count = 1) {
    return this._transferChest(world, hit, gameplay, itemId, count, true);
  }

  transferFromChest(world, hit, gameplay, itemId, count = 1) {
    return this._transferChest(world, hit, gameplay, itemId, count, false);
  }

  /**
   * A composable {participants,result} plan. A live block is removed in the same
   * transaction; already-cleared explosion records may also be relinquished.
   * Nonempty loot MUST have a prepared destination. Result drops are detached
   * receipts, already retained after commit, never a second spawn instruction.
   * A supplied prepareDrops also receives empty batches, so Game can include
   * the block's own loot in the SAME destination participant.
   */
  prepareRemoveContainer(world, hit, options = {}) {
    if (!isRecord(options) || !this._containerAccessible(world, hit))
      return null;
    return this._prepare(() => {
      const {
        prepareDrops,
        prepareExperience,
        gameplay,
        kind: expectedKind,
        participants = [],
      } = options;
      if (
        !Array.isArray(participants) ||
        (prepareDrops !== undefined &&
          !synchronousStationCallback(prepareDrops)) ||
        (prepareExperience !== undefined &&
          !synchronousStationCallback(prepareExperience))
      )
        return null;
      const key = this._hitKey(world, hit);
      const storedKind = this.chests.has(key)
        ? "chest"
        : this.furnaces.has(key)
          ? "furnace"
          : null;
      const read = key && captureStationRead(world, hit.x, hit.y, hit.z);
      const block = read?.before.id;
      const kind = storedKind ?? CONTAINER_BLOCKS.get(block);
      if (
        !kind ||
        !read ||
        this.crops.has(key) ||
        (expectedKind && expectedKind !== kind) ||
        (hit.id !== undefined && CONTAINER_BLOCKS.get(hit.id) !== kind) ||
        (block !== BLOCK.AIR && CONTAINER_BLOCKS.get(block) !== kind)
      )
        return null;
      const context = this.context ?? createWorldContext(world);
      const next = this._containerDraft({ key, kind });
      const drops = cloneSlots(next.slots.filter(Boolean), context);
      const experience = kind === "furnace" ? next.experience : 0;
      const source = this._prepareRecords(
        storedKind ? [{ kind, key, next: null }] : [],
        {
          world,
          context,
          validate: () =>
            read.validate() &&
            (storedKind !== null ||
              STATION_KINDS.every((entry) => !this._store(entry).has(key))),
        }
      );
      if (!source) return null;
      const prepared = [source, ...participants];
      if (block !== BLOCK.AIR) {
        const mutation = world.prepareMutation?.([
          {
            x: hit.x,
            y: hit.y,
            z: hit.z,
            before: read.before,
            after: cellAfterBreaking(read.before),
          },
        ]);
        if (!mutation) return null;
        prepared.push(mutation);
      }
      if (drops.length || prepareDrops !== undefined) {
        if (!prepareDrops) return null;
        const destination = prepareDrops(cloneSlots(drops, context));
        if (!destination) return null;
        prepared.push(destination);
      }
      if (experience) {
        const reward =
          prepareExperience !== undefined
            ? prepareExperience(experience)
            : this._matchesGameplay(world, gameplay)
              ? gameplay.prepareExperience?.(experience)
              : null;
        if (!reward) return null;
        prepared.push(reward);
      }
      return {
        participants: prepared,
        result: {
          ok: true,
          kind,
          drops,
          experience,
          ...(prepareDrops ? { dropsCommitted: true } : {}),
          ...(experience ? { experienceCommitted: true } : {}),
        },
      };
    });
  }

  removeContainer(world, hit, options = {}) {
    const result = this._commit(
      this.prepareRemoveContainer(world, hit, options)
    );
    return result.ok ? result : { ok: false, drops: [], experience: 0 };
  }

  removeChest(world, hit, options = {}) {
    if (!isRecord(options)) return [];
    return this.removeContainer(world, hit, { ...options, kind: "chest" })
      .drops;
  }

  removeFurnace(world, hit, options = {}) {
    return this.removeContainer(
      world,
      hit,
      isRecord(options) ? { ...options, kind: "furnace" } : options
    );
  }

  /** Pure targeting gate: failed valid-target transactions must not eat carrots. */
  canPlant(world, hit, gameplay, { hand = "main" } = {}) {
    if (!this._hitKey(world, hit) || !this._matchesGameplay(world, gameplay) ||
        !["main", "offhand"].includes(hand)) return false;
    const stack = gameplay.getHandStack?.(hand);
    const species = cropSpeciesForItem(stack?.id);
    if (!species || !matchesIngredient(stack, { id: CROP_SPECIES[species].item }))
      return false;
    const { x, y, z } = hit;
    if (!settlementPositionValid(world.dimension, x, y + 1, z, this.context, true))
      return false;
    const soil = captureStationRead(world, x, y, z);
    const target = captureStationRead(world, x, y + 1, z);
    const key = stationKey(world.dimension, x, y + 1, z);
    return Boolean(soil && target &&
      (hit.id === undefined || hit.id === soil.before.id) &&
      (hit.state === undefined || hit.state === soil.before.state) &&
      (hit.fluid === undefined || hit.fluid === soil.before.fluid) &&
      acceptsCropSoil(species, soil.before.id) &&
      target.before.id === BLOCK.AIR && !target.before.fluid &&
      !STATION_KINDS.some((kind) => this._store(kind).has(key)));
  }

  /** Creative requires the requested plain planting item but never spends it. */
  plant(world, hit, gameplay, options = {}) {
    if (!isRecord(options) ||
        (options.validate !== undefined && !synchronousStationCallback(options.validate)))
      return false;
    const plan = this._prepare(() => {
      const { hand = "main" } = options;
      if (
        !this.canPlant(world, hit, gameplay, { hand })
      )
        return null;
      const species = cropSpeciesForItem(gameplay.getHandStack(hand).id);
      const rule = CROP_SPECIES[species];
      const mode = gameplay.mode;
      const selected = gameplay.selected;
      const handRevision = gameplay.getHandRevision?.(hand);
      const context = this.context ?? createWorldContext(world);
      const { x, y, z } = hit;
      if (!settlementPositionValid(world.dimension, x, y + 1, z, context, true))
        return null;
      const soil = captureStationRead(world, x, y, z);
      const target = captureStationRead(world, x, y + 1, z);
      const key = stationKey(world.dimension, x, y + 1, z);
      if (
        !soil ||
        !target ||
        !acceptsCropSoil(species, soil.before.id) ||
        target.before.id !== BLOCK.AIR ||
        STATION_KINDS.some((kind) => this._store(kind).has(key))
      )
        return null;
      const changes = [
        {
          x,
          y: y + 1,
          z,
          before: target.before,
          after: normalizeCell({ id: rule.young }),
        },
      ];
      if (species === "wheat" && soil.before.id !== BLOCK.FARMLAND)
        changes.push({
          x,
          y,
          z,
          before: soil.before,
          after: normalizeCell({ id: BLOCK.FARMLAND }),
        });
      const mutation = world.prepareMutation?.(changes, {
        reads: [{ x, y, z, before: soil.before }],
      });
      if (!mutation) return null;
      return this._ownershipPlan(
        gameplay,
        (owned) => {
          const slots = hand === "offhand" ? [owned.offhand] : owned.slots;
          const index = hand === "offhand" ? 0 : selected;
          if (
            (mode !== "creative" || hand === "offhand") &&
            !matchesIngredient(slots[index], { id: rule.item })
          )
            return failure();
          if (mode !== "creative") {
            if (takeStack(slots, index, 1)?.count !== 1) return failure();
            if (hand === "offhand") owned.offhand = slots[0];
          }
          return { ok: true };
        },
        () =>
          this._prepareRecords(
            [
              {
                kind: "crop",
                key,
                next: { dimension: world.dimension, x, y: y + 1, z, age: 0,
                  version: CROP_RECORD_VERSION, species },
              },
            ],
            {
              world,
              context,
              water: [[key, null]],
              validate: () =>
                soil.validate() &&
                target.validate() &&
                this._matchesGameplay(world, gameplay) &&
                (options.validate === undefined || options.validate() === true) &&
                gameplay.mode === mode &&
                gameplay.selected === selected &&
                gameplay.getHandRevision?.(hand) === handRevision,
            }
          ),
        {
          ...options,
          participants: [mutation, ...(options.participants ?? [])],
        }
      );
    });
    return this._commit(plan).ok;
  }

  /** Active simulation only. Inactive dimensions and unloaded stations do not tick. */
  update(dt, world) {
    if (!Number.isFinite(dt) || dt <= 0 || !this._matchesWorld(world))
      return false;
    const furnaceDt = Math.min(dt, 60);
    const cropDt = Math.min(dt, CROP_GROW_SECONDS);
    const plan = this._prepare(() => {
      const context = this.context ?? createWorldContext(world);
      const clock = this._clock + cropDt;
      const records = [];
      const reads = [];
      const changes = [];
      const water = [];
      for (const [key, furnace] of this.furnaces) {
        const { dimension, x, y, z } = stationPosition(key);
        if (dimension !== world.dimension) continue;
        const read = captureStationRead(world, x, y, z);
        if (read?.before.id !== BLOCK.FURNACE) continue;
        const next = cloneFurnace(furnace, context);
        if (!advanceFurnace(next, furnaceDt)) continue;
        records.push({
          kind: "furnace",
          key,
          next,
          reuseBytes: sameFurnaceSlots(furnace, next),
        });
        reads.push(read);
      }
      for (const [key, crop] of this.crops) {
        if (crop.dimension !== world.dimension) continue;
        const rule = cropRule(crop);
        if (!rule) continue;
        const { x, y, z } = crop;
        const read = captureStationRead(world, x, y, z);
        const soil = captureStationRead(world, x, y - 1, z);
        if (!read || !soil) continue;
        const block = read.before.id;
        // Removal must include a retained reward destination. The growth tick
        // cannot destroy an unsupported plant or silently forget its ownership.
        if (block !== cropBlock(crop) || soil.before.id !== rule.soil) continue;
        if (crop.age >= rule.maxAge) continue;
        let hydration = this._water.get(key);
        if (rule.hydrated && (!hydration || hydration.until <= clock)) {
          hydration = { wet: hasWater(world, crop), until: clock + 1 };
          water.push([key, hydration]);
        }
        let age = Math.min(
          rule.maxAge,
          crop.age + cropDt * (rule.hydrated && hydration?.wet ? 1.5 : 1)
        );
        if (age >= rule.maxAge - 1e-8) {
          age = rule.maxAge;
          if (block !== rule.mature)
            changes.push({
              x,
              y,
              z,
              before: read.before,
              after: normalizeCell({ id: rule.mature }),
            });
        }
        records.push({
          kind: "crop",
          key,
          next: { ...crop, age },
          reuseBytes: true,
        });
        reads.push(read, soil);
      }
      if (!records.length) {
        this._clock = clock;
        return null;
      }
      const source = this._prepareRecords(records, {
        world,
        context,
        clock,
        water,
        validate: () => reads.every((read) => read.validate()),
      });
      if (!source) return null;
      const participants = [source];
      if (changes.length) {
        const mutation = world.prepareMutation?.(changes);
        if (!mutation) return null;
        participants.push(mutation);
      }
      return { participants, result: { ok: true } };
    });
    return this._commit(plan).ok;
  }

  hasCrop(world, hit) {
    return this.crops.has(this._hitKey(world, hit));
  }

  /** Source-only crop debit and planned yields; the caller commits all owners. */
  prepareRemoveCrops(world, frozenPlants) {
    return prepareCropBatch(this, world, frozenPlants);
  }

  /** Same plan shape as prepareRemoveContainer; overflow is retained, never lost. */
  prepareHarvestCrop(world, hit, gameplay, options = {}) {
    if (!isRecord(options)) return null;
    return this._prepare(() => {
      const key = this._hitKey(world, hit);
      const crop = this.crops.get(key);
      const read = key && captureStationRead(world, hit.x, hit.y, hit.z);
      if (
        !crop ||
        !read ||
        !this._matchesGameplay(world, gameplay) ||
        (hit.id !== undefined && hit.id !== cropBlock(crop)) ||
        (read.before.id !== BLOCK.AIR && read.before.id !== cropBlock(crop))
      )
        return null;
      const context = this.context ?? createWorldContext(world);
      const mode = gameplay.mode;
      const participants = [...(options.participants ?? [])];
      if (read.before.id !== BLOCK.AIR) {
        const mutation = world.prepareMutation?.([
          {
            x: hit.x,
            y: hit.y,
            z: hit.z,
            before: read.before,
            after: cellAfterBreaking(read.before),
          },
        ]);
        if (!mutation) return null;
        participants.push(mutation);
      }
      return this._ownershipPlan(
        gameplay,
        (owned) => {
          const drops =
            mode === "creative"
              ? []
              : cropDrops(crop);
          return {
            ok: true,
            drops: drops
              .map((stack) => insertStack(owned.slots, stack))
              .filter(Boolean),
          };
        },
        (proposal) =>
          this._prepareRecords([{ kind: "crop", key, next: null }], {
            world,
            context,
            validate: () => read.validate() && gameplay.mode === mode,
            notify: proposal.drops.length
              ? () =>
                  gameplay.onToast?.(
                    "Backpack full — extra harvested crops dropped nearby"
                  )
              : undefined,
          }),
        { ...options, participants }
      );
    });
  }

  harvestCrop(world, hit, gameplay, options = {}) {
    return this._commit(this.prepareHarvestCrop(world, hit, gameplay, options))
      .ok;
  }

  serialize() {
    return {
      version: SETTLEMENT_VERSION,
      chests: [...this.chests].map(([key, slots]) => ({
        ...stationPosition(key),
        slots: cloneSlots(slots, this.context),
      })),
      furnaces: [...this.furnaces].map(([key, furnace]) => ({
        ...stationPosition(key),
        ...cloneFurnace(furnace, this.context),
      })),
      crops: [...this.crops.values()].map((crop) => ({ ...crop })),
    };
  }

  /** Validate and reserve first; rejected/replaced snapshots never leak owners. */
  load(data, options = {}) {
    if (!isRecord(options) || this._busy || this._disposed) return false;
    const { world, allowOverBudget = false } = options;
    if (typeof allowOverBudget !== "boolean") return false;
    let context;
    try {
      context = normalizeSettlementContext(
        options.context === undefined
          ? (this.context ??
              (world === undefined ? undefined : createWorldContext(world)))
          : options.context
      );
    } catch {
      return false;
    }
    if (world !== undefined && !this._matchesWorld(world, context, false))
      return false;
    const parsed = normalizeSettlementSnapshot(data, context);
    if (!parsed) return false;
    const stores = [new Map(), new Map(), new Map()];
    const recordBytes = new Map();
    let bytes = 0;
    const arrays = [parsed.chests, parsed.furnaces, parsed.crops];
    for (const [index, entries] of arrays.entries()) {
      const kind = STATION_KINDS[index];
      for (const entry of entries) {
        const key = stationKey(entry.dimension, entry.x, entry.y, entry.z);
        const value = ownStationRecord(
          kind,
          kind === "chest" ? entry.slots : entry,
          context
        );
        const cost = stationRecordBytes(kind, key, value);
        stores[index].set(key, value);
        recordBytes.set(key, cost);
        bytes += cost;
      }
      if (entries.length) bytes--;
    }
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    [this.chests, this.furnaces, this.crops] = stores;
    this._recordBytes = recordBytes;
    this._bytes = bytes;
    this._revision++;
    this.context = context;
    this._chestViews.clear();
    this._water.clear();
    this._clock = 0;
    this._world = null;
    this._worldSeed = undefined;
    this._worldGenerator = undefined;
    if (world !== undefined) this._rememberWorld(world, context);
    return true;
  }

  dispose() {
    if (this._busy || this._disposed) return;
    this._disposed = true;
    this._revision++;
    this.coordinator.release(this);
    for (const kind of STATION_KINDS) this._store(kind).clear();
    this._recordBytes.clear();
    this._chestViews.clear();
    this._water.clear();
    this._containerAccess = null;
    this._bytes = 0;
    this._world = null;
    this.onChange = undefined;
  }
}
