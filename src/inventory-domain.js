import { validCraftingGrid } from "./crafting.js";
import { isValidExperience } from "./experience.js";
import {
  normalizeStackData,
  sameStackKind,
  stackIdentity,
} from "./item-stack-data.js";
import {
  clickStackSlot,
  cloneSlots,
  cloneStack,
  insertStack,
  isMergeable,
  isValidSlots,
  isValidStack,
  takeStack,
} from "./inventory-slots.js";
import { getItem } from "./items.js";

export const INVENTORY_SLOTS = 36;
export const EQUIPMENT_SLOTS = Object.freeze(["head", "chest", "legs", "feet"]);
export const HOTBAR_INDICES = Object.freeze(
  Array.from({ length: 9 }, (_, i) => i)
);
export const BAG_INDICES = Object.freeze(
  Array.from({ length: 27 }, (_, i) => i + 9)
);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const optionalStack = (stack, context) =>
  stack === null || isValidStack(stack, context);
const fail = (message = "Invalid inventory action") => ({ ok: false, message });

export function emptyOwnedInventory() {
  return {
    slots: Array(INVENTORY_SLOTS).fill(null),
    cursor: null,
    offhand: null,
    equipment: Object.fromEntries(EQUIPMENT_SLOTS.map((slot) => [slot, null])),
    craftingGrid: Array(9).fill(null),
    craftingSize: 2,
    experienceTotal: 0,
    fuelTime: 0,
  };
}

export function acceptsEquipment(slot, stack) {
  return stack === null || getItem(stack.id)?.equipmentSlot === slot;
}

export function validOwnedInventory(state, context) {
  return (
    object(state) &&
    isValidSlots(state.slots, INVENTORY_SLOTS, context) &&
    optionalStack(state.cursor, context) &&
    optionalStack(state.offhand, context) &&
    object(state.equipment) &&
    Object.keys(state.equipment).length === EQUIPMENT_SLOTS.length &&
    Object.keys(state.equipment).every((slot) =>
      EQUIPMENT_SLOTS.includes(slot)
    ) &&
    EQUIPMENT_SLOTS.every(
      (slot) =>
        optionalStack(state.equipment[slot], context) &&
        acceptsEquipment(slot, state.equipment[slot])
    ) &&
    validCraftingGrid(state.craftingGrid, state.craftingSize, context) &&
    isValidExperience(state.experienceTotal) &&
    Number.isFinite(state.fuelTime) &&
    state.fuelTime >= 0 &&
    state.fuelTime <= 80
  );
}

export function cloneOwnedInventory(state, context) {
  return {
    slots: cloneSlots(state.slots, context),
    cursor: cloneStack(state.cursor, context),
    offhand: cloneStack(state.offhand, context),
    equipment: Object.fromEntries(
      EQUIPMENT_SLOTS.map((slot) => [
        slot,
        cloneStack(state.equipment[slot], context),
      ])
    ),
    craftingGrid: cloneSlots(state.craftingGrid, context),
    craftingSize: state.craftingSize,
    experienceTotal: state.experienceTotal,
    fuelTime: state.fuelTime,
  };
}

/** Legacy count/Map projections cover the 36 inventory slots, not UI escrows. */
export function countSlots(slots) {
  const counts = new Map();
  for (const stack of slots) {
    if (stack) counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count);
  }
  return counts;
}

/** Recipe/legacy ID accounting must not silently spend decorated items. */
export function countPlainSlots(slots) {
  return countSlots(
    slots.filter(
      (stack) => stack && normalizeStackData(stack.id, stack.data) === undefined
    )
  );
}

export function countStackKind(slots, kind) {
  stackIdentity(kind);
  return slots.reduce(
    (count, stack) =>
      count + (stack && sameStackKind(stack, kind) ? stack.count : 0),
    0
  );
}

export function durabilitySlots(slots) {
  const wear = new Map();
  for (const stack of slots) {
    if (stack?.durability !== undefined) {
      if (!wear.has(stack.id)) wear.set(stack.id, []);
      wear.get(stack.id).push(stack.durability);
    }
  }
  return wear;
}

export function armorPoints(equipment) {
  return Math.min(
    20,
    EQUIPMENT_SLOTS.reduce(
      (sum, slot) => sum + (getItem(equipment[slot]?.id)?.armorPoints ?? 0),
      0
    )
  );
}

/**
 * Plain-data ID adapter. Decorated ingredients require an explicit stack kind
 * or a selected-slot take; ID-only recipe accounting cannot destroy metadata.
 */
export function takeItem(slots, id, count, preferredIndex = -1) {
  return takeStackKind(slots, { id }, count, preferredIndex);
}

/** Debit one ID/data kind; wear is separate, and a preferred copy is spent first. */
export function takeStackKind(slots, kind, count, preferredIndex = -1) {
  if (!isValidSlots(slots) || !Number.isSafeInteger(count) || count <= 0)
    return false;
  try {
    if (countStackKind(slots, kind) < count) return false;
  } catch {
    return false;
  }
  const indices = slots.map((_, i) => i);
  if (indices.includes(preferredIndex)) {
    indices.splice(preferredIndex, 1);
    indices.unshift(preferredIndex);
  }
  let remaining = count;
  for (const index of indices) {
    if (!sameStackKind(slots[index], kind)) continue;
    const amount = Math.min(remaining, slots[index].count);
    takeStack(slots, index, amount);
    remaining -= amount;
    if (!remaining) return true;
  }
  return false;
}

/**
 * A reference into a validated transaction draft. `cursor` index 0 is an
 * additional address for outside-panel drops; it is not a second inventory.
 */
export function ownedSlot(draft, area, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  let get;
  let set;
  let accepts = () => true;
  if (
    (area === "inventory" && index < INVENTORY_SLOTS) ||
    (area === "crafting" && index < draft.craftingSize * draft.craftingSize)
  ) {
    const slots = area === "inventory" ? draft.slots : draft.craftingGrid;
    get = () => slots[index];
    set = (stack) => {
      slots[index] = stack;
    };
  } else if ((area === "offhand" || area === "cursor") && index === 0) {
    get = () => draft[area];
    set = (stack) => {
      draft[area] = stack;
    };
  } else if (area === "equipment" && index < EQUIPMENT_SLOTS.length) {
    const slot = EQUIPMENT_SLOTS[index];
    get = () => draft.equipment[slot];
    set = (stack) => {
      draft.equipment[slot] = stack;
    };
    accepts = (stack) => acceptsEquipment(slot, stack);
  } else return null;
  return { get, set, accepts };
}

function allSlotReferences(draft) {
  return [
    ...draft.slots.map((_, index) => ownedSlot(draft, "inventory", index)),
    ownedSlot(draft, "offhand", 0),
    ...EQUIPMENT_SLOTS.map((_, index) => ownedSlot(draft, "equipment", index)),
    ...draft.craftingGrid
      .slice(0, draft.craftingSize * draft.craftingSize)
      .map((_, index) => ownedSlot(draft, "crafting", index)),
  ];
}

/** Return cursor/grid escrow to the bag; keep any overflow for atomic acceptance. */
export function returnInputs(
  draft,
  { cursor = true, crafting = true, canFit = () => true } = {}
) {
  const drops = [];
  const giveBack = (stack) => {
    // The caller can reserve paid output space. Try the largest fitting portion
    // of this bounded (<=64) stack, retaining the rest for atomic world drops.
    for (let count = stack.count; count > 0; count--) {
      const next = cloneSlots(draft.slots);
      const remainder = insertStack(next, { ...stack, count });
      if (!canFit(next)) continue;
      const inserted = count - (remainder?.count ?? 0);
      draft.slots = next;
      if (inserted < stack.count)
        drops.push({ ...cloneStack(stack), count: stack.count - inserted });
      return;
    }
    drops.push(cloneStack(stack));
  };
  if (cursor && draft.cursor) {
    giveBack(draft.cursor);
    draft.cursor = null;
  }
  if (crafting) {
    for (const stack of draft.craftingGrid) {
      if (!stack) continue;
      giveBack(stack);
    }
    draft.craftingGrid.fill(null);
  }
  return drops;
}

/** Pure working-state mutations. The caller validates/commits and retains drops. */
export function applySlotAction(draft, action, { canFit } = {}) {
  if (!object(action) || !validOwnedInventory(draft)) return fail();
  if (action.type === "close") {
    const drops = returnInputs(draft, { canFit });
    draft.craftingSize = 2;
    return { ok: true, drops };
  }
  if (action.type === "distribute") return distribute(draft, action);
  const source = ownedSlot(draft, action.area, action.index);
  if (!source) return fail();
  if (action.area === "cursor" && action.type !== "drop") return fail();

  if (action.type === "click") {
    if (action.button !== 0 && action.button !== 2) return fail();
    const cell = [cloneStack(source.get())];
    const result = clickStackSlot(cell, 0, draft.cursor, action.button);
    if (!source.accepts(cell[0]))
      return fail("That item does not fit this equipment slot");
    source.set(cell[0]);
    draft.cursor = result.cursor;
    return { ok: true };
  }
  if (action.type === "swapHotbar" || action.type === "swapOffhand") {
    const target = ownedSlot(
      draft,
      action.type === "swapHotbar" ? "inventory" : "offhand",
      action.type === "swapHotbar" ? action.hotbarIndex : 0
    );
    if (
      !target ||
      (action.type === "swapHotbar" && action.hotbarIndex > 8) ||
      !source.accepts(target.get()) ||
      !target.accepts(source.get())
    )
      return fail();
    const a = cloneStack(source.get());
    const b = cloneStack(target.get());
    source.set(b);
    target.set(a);
    return { ok: true };
  }
  if (action.type === "quickMove") {
    const stack = source.get();
    if (!stack) return fail("Empty slot");
    if (action.area === "inventory") {
      const item = getItem(stack.id);
      const equipment = item.equipmentSlot;
      if (equipment && !draft.equipment[equipment]) {
        draft.equipment[equipment] = cloneStack(stack);
        source.set(null);
        return { ok: true };
      }
      if (item.shield && !draft.offhand) {
        draft.offhand = cloneStack(stack);
        source.set(null);
        return { ok: true };
      }
    }
    const indices =
      action.area === "inventory"
        ? action.index < 9
          ? BAG_INDICES
          : HOTBAR_INDICES
        : undefined;
    const rest = insertStack(draft.slots, stack, indices);
    if (rest?.count === stack.count) return fail("No room for that stack");
    source.set(rest);
    return { ok: true };
  }
  if (action.type === "drop") {
    if (
      action.wholeStack !== undefined &&
      typeof action.wholeStack !== "boolean"
    )
      return fail();
    const cell = [cloneStack(source.get())];
    const drop = takeStack(cell, 0, action.wholeStack ? undefined : 1);
    if (!drop) return fail("Empty slot");
    source.set(cell[0]);
    return { ok: true, drops: [drop] };
  }
  if (action.type === "collect") {
    if (!draft.cursor) {
      draft.cursor = cloneStack(source.get());
      source.set(null);
    }
    if (!draft.cursor) return fail("Empty slot");
    if (getItem(draft.cursor.id).stackSize === 1) return { ok: true };
    for (const slot of allSlotReferences(draft)) {
      const stack = slot.get();
      if (!isMergeable(stack, draft.cursor)) continue;
      const count = Math.min(
        stack.count,
        getItem(stack.id).stackSize - draft.cursor.count
      );
      if (!count) break;
      draft.cursor.count += count;
      slot.set(
        count === stack.count
          ? null
          : { ...cloneStack(stack), count: stack.count - count }
      );
    }
    return { ok: true };
  }
  return fail();
}

function distribute(draft, action) {
  if (
    !draft.cursor ||
    !Array.isArray(action.targets) ||
    action.targets.length < 1 ||
    action.targets.length > 128 ||
    (action.button !== 0 && action.button !== 2)
  )
    return fail();
  const seen = new Set();
  const targets = [];
  for (const target of action.targets) {
    if (!object(target) || target.area === "cursor") return fail();
    const slot = ownedSlot(draft, target.area, target.index);
    if (!slot) return fail();
    const key = `${target.area}:${target.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      slot.accepts(draft.cursor) &&
      (slot.get() === null || isMergeable(slot.get(), draft.cursor)) &&
      (slot.get()?.count ?? 0) < getItem(draft.cursor.id).stackSize
    )
      targets.push(slot);
  }
  if (!targets.length) return fail("No available slots");
  const each =
    action.button === 2 ? 1 : Math.floor(draft.cursor.count / targets.length);
  for (const slot of targets) {
    if (!draft.cursor || !each) break;
    const count = Math.min(
      each,
      draft.cursor.count,
      getItem(draft.cursor.id).stackSize - (slot.get()?.count ?? 0)
    );
    slot.set({
      ...cloneStack(draft.cursor),
      count: (slot.get()?.count ?? 0) + count,
    });
    draft.cursor.count -= count;
    if (!draft.cursor.count) draft.cursor = null;
  }
  return { ok: true };
}
