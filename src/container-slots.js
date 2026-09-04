import {
  acceptsFurnaceStack,
  syncFurnaceRecipe,
  takeFurnaceExperience,
} from "./furnace.js";
import { isStorageKind, isFurnaceKind } from "./container-kinds.js";
import {
  clickStackSlot,
  cloneSlots,
  cloneStack,
  insertStack,
  isMergeable,
  isValidSlots,
  isValidStack,
  splitStackPayload,
  takeStack,
} from "./inventory-slots.js";
import {
  normalizeStackData,
  sameStackKind,
  stackIdentity,
} from "./item-stack-data.js";
import { getItem } from "./items.js";

export const CHEST_SLOTS = 27;
const EQUIPMENT = ["head", "chest", "legs", "feet"];
const INVENTORY_ORDER = [
  ...Array.from({ length: 27 }, (_, index) => index + 9),
  ...Array.from({ length: 9 }, (_, index) => index),
];
const validIndex = (index, length) =>
  Number.isInteger(index) && index >= 0 && index < length;
const failure = () => ({ ok: false });

export function validSlotArray(slots, size, context) {
  return isValidSlots(slots, size, context);
}

/** Explicit component-v1 migration; durable aggregates become separate tools. */
export function migrateChestItems(items, context) {
  if (!Array.isArray(items) || items.length > CHEST_SLOTS) return null;
  const slots = Array(CHEST_SLOTS).fill(null);
  const seen = new Set();
  for (const entry of items) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Number.isInteger(entry.id) ||
      entry.id <= 0 ||
      seen.has(entry.id)
    )
      return null;
    const item = getItem(entry.id);
    if (
      !item ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      entry.count > CHEST_SLOTS * item.stackSize
    )
      return null;
    seen.add(entry.id);
    if (entry.durability !== undefined && !Array.isArray(entry.durability))
      return null;
    const stacks = splitStackPayload(entry, CHEST_SLOTS, context);
    if (!stacks || stacks.some((stack) => insertStack(slots, stack)))
      return null;
  }
  return slots;
}

function counts(slots) {
  const result = new Map();
  for (const stack of slots)
    if (stack) result.set(stack.id, (result.get(stack.id) ?? 0) + stack.count);
  return result;
}

/** A live, read-only Map facade; the only mutable authority remains the slots. */
export class ChestCounts extends Map {
  constructor(readSlots) {
    super();
    this.readSlots = readSlots;
  }
  get size() {
    return counts(this.readSlots()).size;
  }
  get(id) {
    return counts(this.readSlots()).get(id);
  }
  has(id) {
    return counts(this.readSlots()).has(id);
  }
  entries() {
    return counts(this.readSlots()).entries();
  }
  keys() {
    return counts(this.readSlots()).keys();
  }
  values() {
    return counts(this.readSlots()).values();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(callback, thisArg) {
    for (const [id, count] of this) callback.call(thisArg, count, id, this);
  }
  set() {
    throw new TypeError("Chest counts are read-only; use containerAction");
  }
  delete() {
    throw new TypeError("Chest counts are read-only; use containerAction");
  }
  clear() {
    throw new TypeError("Chest counts are read-only; use containerAction");
  }
}

function slotRef(container, owned, area, index) {
  const slots =
    area === "container"
      ? container.slots
      : area === "inventory"
        ? owned.slots
        : area === "crafting"
          ? owned.craftingGrid
          : null;
  const length =
    area === "crafting"
      ? owned.craftingSize * owned.craftingSize
      : slots?.length;
  if (slots && validIndex(index, length)) {
    return {
      area,
      index,
      get: () => slots[index],
      set: (stack) => {
        slots[index] = stack;
      },
    };
  }
  if (area === "offhand" && index === 0 && "offhand" in owned)
    return {
      area,
      index,
      get: () => owned.offhand,
      set: (stack) => {
        owned.offhand = stack;
      },
    };
  if (
    area === "equipment" &&
    validIndex(index, EQUIPMENT.length) &&
    owned.equipment
  )
    return {
      area,
      index,
      get: () => owned.equipment[EQUIPMENT[index]],
      set: (stack) => {
        owned.equipment[EQUIPMENT[index]] = stack;
      },
    };
  return null;
}

const accepts = (container, index, stack) =>
  isStorageKind(container.kind) ||
  ((stack === null || normalizeStackData(stack.id, stack.data) === undefined) &&
    acceptsFurnaceStack(index, stack, undefined, container.kind));

function acceptsRef(container, ref, stack) {
  if (ref.area === "container") return accepts(container, ref.index, stack);
  if (ref.area === "equipment")
    return (
      stack === null ||
      getItem(stack.id)?.equipmentSlot === EQUIPMENT[ref.index]
    );
  return true;
}

function insertionIndices(container, stack) {
  if (isStorageKind(container.kind)) return undefined;
  if (accepts(container, 0, stack)) return [0];
  if (accepts(container, 1, stack)) return [1];
  return [];
}

/**
 * Pure ownership reducer. Both arguments are transaction-owned working copies.
 * Drops are only a proposal: the transaction must retain them before committing.
 * Non-container player actions remain Gameplay.inventoryAction's responsibility.
 */
export function applyContainerAction(container, owned, action) {
  if (
    !action ||
    typeof action !== "object" ||
    !owned ||
    !container ||
    !(isStorageKind(container.kind) || isFurnaceKind(container.kind)) ||
    !validSlotArray(
      container.slots,
      isStorageKind(container.kind) ? CHEST_SLOTS : 3
    ) ||
    !validSlotArray(owned.slots, 36) ||
    !(owned.cursor === null || isValidStack(owned.cursor))
  )
    return failure();
  let experience = 0;
  const extract = (ref, count) => {
    const source = ref.get();
    const taken = { ...cloneStack(source), count };
    ref.set(
      count === source.count
        ? null
        : { ...cloneStack(source), count: source.count - count }
    );
    if (
      isFurnaceKind(container.kind) &&
      ref.area === "container" &&
      ref.index === 2
    )
      experience += takeFurnaceExperience(container, count);
    return taken;
  };
  const succeed = (extra = {}) => {
    if (isFurnaceKind(container.kind)) syncFurnaceRecipe(container);
    return { ok: true, ...(experience ? { experience } : {}), ...extra };
  };

  if (action.type === "distribute") {
    if (
      !owned.cursor ||
      ![0, 2].includes(action.button) ||
      !Array.isArray(action.targets) ||
      !action.targets.length ||
      action.targets.length > 128
    )
      return failure();
    const targets = [];
    const seen = new Set();
    for (const target of action.targets) {
      if (
        !target ||
        ![
          "container",
          "inventory",
          "offhand",
          "equipment",
          "crafting",
        ].includes(target.area)
      )
        return failure();
      const ref = slotRef(container, owned, target.area, target.index);
      const key = `${target.area}:${target.index}`;
      if (!ref) return failure();
      if (seen.has(key)) continue;
      seen.add(key);
      const stack = ref.get();
      if (
        !acceptsRef(container, ref, owned.cursor) ||
        (stack && !isMergeable(stack, owned.cursor)) ||
        (stack?.count ?? 0) >= getItem(owned.cursor.id).stackSize
      )
        continue;
      targets.push(ref);
    }
    if (!targets.length) return failure();
    const count =
      action.button === 2 ? 1 : Math.floor(owned.cursor.count / targets.length);
    if (!count) return failure();
    for (const ref of targets) {
      if (!owned.cursor) break;
      const destination = [cloneStack(ref.get())];
      const amount = Math.min(
        count,
        owned.cursor.count,
        getItem(owned.cursor.id).stackSize - (ref.get()?.count ?? 0)
      );
      insertStack(destination, { ...owned.cursor, count: amount });
      ref.set(destination[0]);
      owned.cursor =
        amount === owned.cursor.count
          ? null
          : { ...cloneStack(owned.cursor), count: owned.cursor.count - amount };
    }
    return succeed();
  }

  const ref = slotRef(container, owned, action.area, action.index);
  if (!ref) return failure();
  const source = ref.get();

  if (action.type === "collect") {
    let changed = false;
    if (owned.cursor === null) {
      if (!source) return failure();
      owned.cursor = extract(ref, source.count);
      changed = true;
    }
    let needed = getItem(owned.cursor.id).stackSize - owned.cursor.count;
    if (!needed) return changed ? succeed() : failure();
    const previous = needed;
    for (const [area, length] of [
      ["inventory", owned.slots.length],
      ["container", container.slots.length],
      ["offhand", 1],
      ["equipment", EQUIPMENT.length],
      ["crafting", owned.craftingSize * owned.craftingSize],
    ]) {
      for (let index = 0; index < length && needed; index++) {
        const candidate = slotRef(container, owned, area, index);
        if (!candidate || !isMergeable(candidate.get(), owned.cursor)) continue;
        const amount = Math.min(needed, candidate.get().count);
        extract(candidate, amount);
        owned.cursor = {
          ...cloneStack(owned.cursor),
          count: owned.cursor.count + amount,
        };
        needed -= amount;
      }
    }
    return changed || previous !== needed ? succeed() : failure();
  }

  if (action.type === "quickMove") {
    if (!source) return failure();
    const destination =
      ref.area === "container" ? owned.slots : container.slots;
    const indices =
      ref.area === "container"
        ? INVENTORY_ORDER
        : insertionIndices(container, source);
    const remainder = insertStack(destination, cloneStack(source), indices);
    const moved = source.count - (remainder?.count ?? 0);
    if (!moved) return failure();
    extract(ref, moved);
    return succeed();
  }

  if (action.area !== "container") return failure();
  if (action.type === "click") {
    if (![0, 2].includes(action.button)) return failure();
    if (isFurnaceKind(container.kind) && action.index === 2) {
      if (!source || (owned.cursor && !isMergeable(source, owned.cursor)))
        return failure();
      const room = getItem(source.id).stackSize - (owned.cursor?.count ?? 0);
      const count = Math.min(
        room,
        action.button === 2 ? Math.ceil(source.count / 2) : source.count
      );
      if (!count) return failure();
      const taken = extract(ref, count);
      owned.cursor = { ...taken, count: count + (owned.cursor?.count ?? 0) };
      return succeed();
    }
    if (!accepts(container, action.index, owned.cursor)) return failure();
    const clicked = clickStackSlot(
      container.slots,
      action.index,
      owned.cursor,
      action.button
    );
    if (!clicked.changed) return failure();
    owned.cursor = clicked.cursor;
    return succeed();
  }
  if (action.type === "swapHotbar" || action.type === "swapOffhand") {
    if (action.type === "swapHotbar" && !validIndex(action.hotbarIndex, 9))
      return failure();
    const target = slotRef(
      container,
      owned,
      action.type === "swapHotbar" ? "inventory" : "offhand",
      action.type === "swapHotbar" ? action.hotbarIndex : 0
    );
    if (
      !target ||
      (!source && !target.get()) ||
      !accepts(container, action.index, target.get())
    )
      return failure();
    const incoming = cloneStack(target.get());
    target.set(source ? extract(ref, source.count) : null);
    ref.set(incoming);
    return succeed();
  }
  if (action.type === "drop") {
    if (
      !source ||
      (action.wholeStack !== undefined &&
        typeof action.wholeStack !== "boolean")
    )
      return failure();
    const dropped = extract(ref, action.wholeStack ? source.count : 1);
    return succeed({ drops: [dropped] });
  }
  return failure();
}

/** Plain-data compatibility transfer; decorated callers specify their kind. */
export function transferItem(source, destination, id, count) {
  return transferStackKind(source, destination, { id }, count);
}

/**
 * All-or-nothing transfer of an exact ID/data kind, preserving slot order and
 * individual wear. Capacity or count rejection leaves BOTH arrays untouched.
 */
export function transferStackKind(source, destination, kind, count) {
  if (
    source === destination ||
    !isValidSlots(source) ||
    !isValidSlots(destination) ||
    !Number.isSafeInteger(count) ||
    count <= 0
  )
    return false;
  try {
    stackIdentity(kind);
  } catch {
    return false;
  }
  const nextSource = cloneSlots(source);
  const nextDestination = cloneSlots(destination);
  let remaining = count;
  for (let index = 0; index < nextSource.length && remaining; index++) {
    const stack = nextSource[index];
    if (!sameStackKind(stack, kind)) continue;
    const amount = Math.min(remaining, stack.count);
    const taken = takeStack(nextSource, index, amount);
    if (insertStack(nextDestination, taken)) return false;
    remaining -= amount;
  }
  if (remaining) return false;
  for (let index = 0; index < source.length; index++)
    source[index] = nextSource[index];
  for (let index = 0; index < destination.length; index++)
    destination[index] = nextDestination[index];
  return true;
}
