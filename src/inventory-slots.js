import {
  cloneStackData,
  normalizeStackData,
  sameStackKind,
} from "./item-stack-data.js";
import { getItem } from "./items.js";

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/** A finite stack, not an aggregate item count. Durable copies never stack. */
export function isValidStack(stack, context) {
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) return false;
  const item = getItem(stack.id);
  if (
    !Number.isInteger(stack.id) ||
    stack.id <= 0 ||
    !item ||
    !positiveInteger(stack.count) ||
    stack.count > item.stackSize
  )
    return false;
  try {
    normalizeStackData(stack.id, stack.data, context);
  } catch {
    return false;
  }
  return item.durability
    ? stack.count === 1 &&
        Number.isInteger(stack.durability) &&
        stack.durability > 0 &&
        stack.durability <= item.durability
    : stack.durability === undefined;
}

export function cloneStack(stack, context) {
  if (stack === null) return null;
  const data = normalizeStackData(stack.id, stack.data, context);
  return {
    id: stack.id,
    count: stack.count,
    ...(stack.durability === undefined ? {} : { durability: stack.durability }),
    ...(data === undefined ? {} : { data }),
  };
}

export function cloneSlots(slots, context) {
  return slots.map((stack) => cloneStack(stack, context));
}

/** Detached canonical stack, with the same rejection rules as isValidStack. */
export function normalizeStack(stack, context) {
  if (!isValidStack(stack, context)) throw new RangeError("Invalid stack");
  return cloneStack(stack, context);
}

export function isValidSlots(slots, length = slots?.length, context) {
  return (
    Array.isArray(slots) &&
    slots.length === length &&
    Array.from(slots).every(
      (stack) => stack === null || isValidStack(stack, context)
    )
  );
}

export function isMergeable(a, b) {
  return (
    isValidStack(a) &&
    isValidStack(b) &&
    sameStackKind(a, b) &&
    !getItem(a.id).durability
  );
}

function checkedIndices(slots, indices) {
  if (!isValidSlots(slots)) throw new RangeError("Invalid slots");
  const result =
    indices === undefined ? slots.map((_, index) => index) : indices;
  if (
    !Array.isArray(result) ||
    !Array.from(result).every(
      (index) => Number.isInteger(index) && index >= 0 && index < slots.length
    ) ||
    new Set(result).size !== result.length
  )
    throw new RangeError("Invalid slot indices");
  return result;
}

/**
 * Mutates only a caller-owned working array. Merge first, then use empty slots;
 * returns an unaliased remainder. All helper arguments are validated before
 * writing; malformed arguments throw RangeError without partial edits.
 */
export function insertStack(slots, stack, indices) {
  const order = checkedIndices(slots, indices);
  if (!isValidStack(stack)) throw new RangeError("Invalid stack");
  let remaining = stack.count;
  for (const index of order) {
    const existing = slots[index];
    if (!isMergeable(existing, stack)) continue;
    const count = Math.min(
      remaining,
      getItem(stack.id).stackSize - existing.count
    );
    if (count)
      slots[index] = { ...cloneStack(existing), count: existing.count + count };
    remaining -= count;
    if (!remaining) return null;
  }
  for (const index of order) {
    if (slots[index] !== null) continue;
    slots[index] = { ...cloneStack(stack), count: remaining };
    return null;
  }
  return { ...cloneStack(stack), count: remaining };
}

/** An omitted count takes the whole slot; a larger count takes what is present. */
export function takeStack(slots, index, count) {
  checkedIndices(slots, [index]);
  if (count !== undefined && !positiveInteger(count))
    throw new RangeError("Invalid take count");
  const stack = slots[index];
  if (stack === null) return null;
  const amount = Math.min(count ?? stack.count, stack.count);
  slots[index] =
    amount === stack.count
      ? null
      : { ...cloneStack(stack), count: stack.count - amount };
  return { ...cloneStack(stack), count: amount };
}

/** Java pickup semantics: left = whole/merge/swap, right = half/one/swap. */
export function clickStackSlot(slots, index, cursor, button) {
  checkedIndices(slots, [index]);
  if (
    (cursor !== null && !isValidStack(cursor)) ||
    (button !== 0 && button !== 2)
  )
    throw new RangeError("Invalid cursor or mouse button");
  const existing = slots[index];
  if (cursor === null) {
    return {
      cursor: takeStack(
        slots,
        index,
        existing && button === 2 ? Math.ceil(existing.count / 2) : undefined
      ),
      changed: existing !== null,
    };
  }
  if (existing === null || isMergeable(existing, cursor)) {
    const count = Math.min(
      button === 2 ? 1 : cursor.count,
      getItem(cursor.id).stackSize - (existing?.count ?? 0)
    );
    if (!count) return { cursor: cloneStack(cursor), changed: false };
    slots[index] = {
      ...cloneStack(cursor),
      count: (existing?.count ?? 0) + count,
    };
    return {
      cursor:
        cursor.count === count
          ? null
          : { ...cloneStack(cursor), count: cursor.count - count },
      changed: true,
    };
  }
  slots[index] = cloneStack(cursor);
  return { cursor: cloneStack(existing), changed: true };
}

/**
 * Convert a legacy aggregate or pickup into canonical stacks. Durability arrays
 * are consumed exactly once, in order. Bound allocation by the caller's capacity.
 */
export function splitStacks(id, count, durability, limit = 36) {
  if (durability !== undefined && !Array.isArray(durability)) return null;
  return splitStackPayload({ id, count, durability }, limit);
}

/**
 * Lossless bridge for loot structs: canonical scalar wear (count=1) or legacy
 * per-copy wear arrays, with one uniform metadata kind. No fabricated item IDs.
 * Old splitStacks stays a plain-data adapter; metadata callers pass the payload.
 */
export function splitStackPayload(payload, limit = 36, context) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const { id, count } = payload;
  let { durability } = payload;
  const item = getItem(id);
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !item ||
    !positiveInteger(count) ||
    !positiveInteger(limit) ||
    Math.ceil(count / item.stackSize) > limit
  )
    return null;
  if (typeof durability === "number") {
    if (count !== 1) return null;
    durability = [durability];
  }
  if (
    durability !== undefined &&
    (!item.durability ||
      !Array.isArray(durability) ||
      durability.length !== count ||
      !Array.from(durability).every(
        (wear) => Number.isInteger(wear) && wear > 0 && wear <= item.durability
      ))
  )
    return null;
  let data;
  try {
    data = normalizeStackData(id, payload.data, context);
  } catch {
    return null;
  }
  const stacks = [];
  for (let remaining = count; remaining > 0; remaining -= item.stackSize) {
    stacks.push({
      id,
      count: Math.min(remaining, item.stackSize),
      ...(item.durability
        ? { durability: durability?.[stacks.length] ?? item.durability }
        : {}),
      ...(data === undefined ? {} : { data: cloneStackData(data, context) }),
    });
  }
  return stacks;
}
