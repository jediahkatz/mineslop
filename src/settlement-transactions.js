import { CHEST_SLOTS, validSlotArray } from "./container-slots.js";
import { isStorageKind, isFurnaceKind } from "./container-kinds.js";
import { isValidExperience } from "./experience.js";
import { isValidFurnace } from "./furnace.js";
import { cloneSlots, insertStack, normalizeStack } from "./inventory-slots.js";
import {
  CROP_GROW_SECONDS,
  MAX_SETTLEMENT_ENTRIES,
  normalizeSettlementSnapshot,
  ownStationRecord,
  settlementPositionValid,
  STATION_KINDS,
  stationRecordBytes,
  stationPosition,
} from "./settlement-state.js";
import { createWorldContext } from "./world-spec.js";

export const MAX_PREPARED_CONTAINERS = 32;

export const synchronousStationCallback = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

function validRecord(kind, next, context) {
  if (isStorageKind(kind)) return validSlotArray(next, CHEST_SLOTS, context);
  if (kind === "furnace") return isValidFurnace(next, context);
  return (
    settlementPositionValid(
      next.dimension,
      next.x,
      next.y,
      next.z,
      context,
      true
    ) &&
    Number.isFinite(next.age) &&
    next.age >= 0 &&
    next.age <= CROP_GROW_SECONDS
  );
}

/**
 * Internal record installation: changed slots are encoded exactly, while
 * progress-only updates reuse their bounded record reservation. No callbacks,
 * world writes, allocation of new owners, or vetoes belong in publication.
 */
export function prepareStationRecords(
  owner,
  changes,
  { world, context, validate = () => true, clock, water = [], notify } = {}
) {
  // A context-free historical load binds once, validating untouched metadata as
  // well. With a bound context, no action or tick serializes the whole domain.
  if (
    !owner.context &&
    context &&
    !normalizeSettlementSnapshot(owner.serialize(), context)
  )
    return null;
  const revision = owner._revision;
  const beforeBytes = owner._bytes;
  const previousContext = owner.context;
  const coordinator = owner.coordinator;
  const stores = STATION_KINDS.map((kind) => owner._store(kind));
  const sizes = stores.map((store) => store.size);
  const afterSizes = [...sizes];
  const records = [];
  const seen = new Set();
  let cost = beforeBytes + sizes.filter(Boolean).length;
  for (const { kind, key, next: value, reuseBytes = false } of changes) {
    const index = STATION_KINDS.indexOf(kind);
    if (index < 0 || seen.has(key)) return null;
    seen.add(key);
    const store = stores[index];
    const previous = store.get(key);
    if (previous !== undefined) {
      cost -= owner._recordBytes.get(key);
      afterSizes[index]--;
    } else if (value === null || stores.some((other) => other.has(key)))
      return null;
    const next = value === null ? null : ownStationRecord(kind, value, context);
    if (next !== null && !validRecord(kind, next, context)) return null;
    const bytes =
      next === null
        ? 0
        : reuseBytes && previous !== undefined
          ? owner._recordBytes.get(key)
          : stationRecordBytes(kind, key, next);
    if (next !== null) {
      cost += bytes;
      afterSizes[index]++;
    }
    records.push({ key, store, previous, next, bytes });
  }
  const afterBytes = cost - afterSizes.filter(Boolean).length;
  if (
    afterSizes.some((size) => size > MAX_SETTLEMENT_ENTRIES) ||
    !Number.isSafeInteger(afterBytes) ||
    afterBytes < 0
  )
    return null;
  let used = false;
  return Object.freeze({
    owner,
    beforeBytes,
    afterBytes,
    validate: () =>
      !used &&
      !owner._disposed &&
      !owner._busy &&
      owner._revision === revision &&
      owner._bytes === beforeBytes &&
      owner.context === previousContext &&
      owner.coordinator === coordinator &&
      stores.every(
        (store, index) =>
          owner._store(STATION_KINDS[index]) === store &&
          store.size === sizes[index]
      ) &&
      records.every(
        ({ store, key, previous }) => store.get(key) === previous
      ) &&
      (!world || owner._matchesWorld(world, context)) &&
      validate() === true,
    publish: () => {
      used = true;
      for (const { key, store, next, bytes } of records) {
        if (next === null) {
          store.delete(key);
          owner._recordBytes.delete(key);
          owner._chestViews.delete(key);
          owner._water.delete(key);
        } else {
          store.set(key, next);
          owner._recordBytes.set(key, bytes);
        }
      }
      for (const [key, value] of water) {
        if (value === null) owner._water.delete(key);
        else owner._water.set(key, value);
      }
      if (clock !== undefined) owner._clock = clock;
      if (world) owner._rememberWorld(world, context);
      owner._bytes = afterBytes;
      owner._revision++;
    },
    notify: () => {
      try {
        notify?.();
      } finally {
        owner.onChange?.();
      }
    },
  });
}

/**
 * The public Settlement.prepareContainers bridge. This prepares ONLY Settlement:
 * no lazy creation, World removal, Gameplay cost, XP award or drop destination.
 * Receipts are detached proposals, never authorization to spawn after commit.
 */
export function prepareSettlementContainers(
  settlement,
  world,
  requests,
  { validate = () => true } = {}
) {
  return settlement._prepare(() => {
    if (
      !Array.isArray(requests) ||
      !requests.length ||
      requests.length > MAX_PREPARED_CONTAINERS ||
      !synchronousStationCallback(validate) ||
      validate() !== true
    )
      return null;
    const context = settlement.context ?? createWorldContext(world);
    const changes = [];
    const reads = [];
    const records = [];
    const seen = new Set();
    for (const request of requests) {
      if (
        !request ||
        !["initialize", "adopt", "observe", "clear", "remove"].includes(
          request.action
        ) ||
        (request.expectedInitialized !== undefined &&
          typeof request.expectedInitialized !== "boolean") ||
        (request.action !== "initialize" && request.stacks !== undefined)
      )
        return null;
      const live = settlement._liveContainer(world, request.hit);
      if (!live || seen.has(live.key)) return null;
      seen.add(live.key);
      const initialized = settlement._store(live.kind).has(live.key);
      if (
        (request.expectedInitialized !== undefined &&
          initialized !== request.expectedInitialized) ||
        (["adopt", "clear"].includes(request.action) && !initialized) ||
        (request.action === "initialize" &&
          (initialized || !isStorageKind(live.kind))) ||
        (request.action === "clear" && !isStorageKind(live.kind))
      )
        return null;
      const draft = settlement._containerDraft(live);
      const drops = ["clear", "remove"].includes(request.action)
        ? cloneSlots(draft.slots.filter(Boolean), context)
        : [];
      if (request.action === "initialize") {
        if (
          !Array.isArray(request.stacks) ||
          request.stacks.length > CHEST_SLOTS ||
          Array.from(request.stacks).some((stack) =>
            insertStack(draft.slots, normalizeStack(stack, context))
          )
        )
          return null;
        changes.push({ kind: live.kind, key: live.key, next: draft.slots });
      } else if (request.action === "clear") {
        changes.push({
          kind: live.kind,
          key: live.key,
          next: Array(CHEST_SLOTS).fill(null),
        });
      } else if (request.action === "remove" && initialized) {
        changes.push({ kind: live.kind, key: live.key, next: null });
      }
      reads.push(live.read);
      records.push({
        position: stationPosition(live.key),
        kind: live.kind,
        initialized,
        before: { ...live.read.before },
        slots: cloneSlots(draft.slots, context),
        drops,
        experience:
          request.action === "remove" && isFurnaceKind(live.kind)
            ? draft.experience
            : 0,
      });
    }
    const source = settlement._prepareRecords(changes, {
      world,
      context,
      validate: () =>
        reads.every((read) => read.validate()) && validate() === true,
    });
    return source
      ? { participants: [source], result: { ok: true, records } }
      : null;
  });
}

/**
 * Prepare the player edit, station debit, retained loot, and XP as one plan.
 * Direct scene-less XP shares the inventory participant, never a duplicate
 * Gameplay owner. An explicit reward refusal MUST NOT fall back to direct XP.
 */
export function prepareStationOwnership(
  settlement,
  gameplay,
  edit,
  prepareSource,
  { prepareDrops, prepareExperience, participants = [] } = {}
) {
  if (
    !gameplay ||
    gameplay.dead ||
    gameplay.coordinator !== settlement.coordinator ||
    !synchronousStationCallback(gameplay.prepareInventory) ||
    !Array.isArray(participants) ||
    (prepareDrops !== undefined && !synchronousStationCallback(prepareDrops)) ||
    (prepareExperience !== undefined &&
      !synchronousStationCallback(prepareExperience))
  )
    return null;
  let proposal;
  const player = gameplay.prepareInventory((owned) => {
    proposal = edit(owned);
    if (proposal?.ok !== true) return false;
    if (proposal.experience && prepareExperience === undefined) {
      const total = owned.experienceTotal + proposal.experience;
      if (!isValidExperience(total)) return false;
      owned.experienceTotal = total;
    }
    return true;
  });
  if (!player || proposal?.ok !== true) return null;
  const source = prepareSource(proposal);
  if (!source) return null;
  const prepared = [source, player, ...participants];
  if (proposal.drops?.length) {
    if (!prepareDrops) return null;
    const destination = prepareDrops(
      cloneSlots(proposal.drops, settlement.context)
    );
    if (!destination) return null;
    prepared.push(destination);
  }
  if (proposal.experience && prepareExperience !== undefined) {
    const reward = prepareExperience(proposal.experience);
    if (!reward) return null;
    prepared.push(reward);
  }
  return {
    participants: prepared,
    result: {
      ok: true,
      ...(proposal.drops?.length ? { dropsCommitted: true } : {}),
      ...(proposal.experience
        ? { experience: proposal.experience, experienceCommitted: true }
        : {}),
    },
  };
}
