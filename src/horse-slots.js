import {
  applySlotAction, BAG_INDICES, HOTBAR_INDICES, ownedSlot, validOwnedInventory,
} from "./inventory-domain.js";
import { cloneStack, insertStack, isMergeable, isValidStack } from "./inventory-slots.js";
import { getItem } from "./items.js";
import { isHorseSaddle } from "./horse-definitions.js";
import { horseDataRecord } from "./horse-save.js";

const fail = (reason = "invalid-slot-action") => ({ ok: false, reason });
const playerAreas = ["inventory", "offhand", "equipment"];
const validSaddle = (stack, context) => stack === null ||
  (isHorseSaddle(stack) && isValidStack(stack, context));

/** Only detached Gameplay + horse drafts are mutated. No overflow is needed
 * unless the user explicitly DROPS a stack. A full bag never blocks cursor
 * withdrawal, a swap, or equipping from an existing finite inventory slot.
 */
export function applyHorseSlotAction(horse, owned, action, context) {
  if (!horse.alive || !horse.tamed || !validOwnedInventory(owned, context) ||
    !horseDataRecord(action, ["type", "area", "index", "button", "hotbarIndex",
      "wholeStack", "targets"], ["type"])) return fail();
  const ref = (area, index) => {
    if (area === "container")
      return index === 0 ? {
        get: () => horse.saddle,
        set: (stack) => { horse.saddle = cloneStack(stack, context); },
        accepts: (stack) => validSaddle(stack, context),
        limit: () => 1,
      } : null;
    if (!playerAreas.includes(area) && !(area === "cursor" && action.type === "drop")) return null;
    const slot = ownedSlot(owned, area, index);
    return slot && { ...slot, limit: (stack) => getItem(stack.id).stackSize };
  };
  const extract = (source, count) => {
    const stack = source.get(), taken = { ...cloneStack(stack, context), count };
    source.set(stack.count === count ? null : { ...cloneStack(stack, context), count: stack.count - count });
    return taken;
  };
  const receive = (target, payload, maximum = payload.count) => {
    const prior = target.get();
    if (prior && !isMergeable(prior, payload)) return 0;
    const count = Math.min(maximum, payload.count, target.limit(payload) - (prior?.count ?? 0));
    if (count <= 0) return 0;
    const next = { ...cloneStack(payload, context), count: count + (prior?.count ?? 0) };
    if (!target.accepts(next)) return 0;
    target.set(next);
    return count;
  };
  const debitCursor = (count) => {
    owned.cursor = count === owned.cursor.count ? null :
      { ...cloneStack(owned.cursor, context), count: owned.cursor.count - count };
  };
  if (action.type === "distribute") {
    if (!owned.cursor || ![0, 2].includes(action.button) || !Array.isArray(action.targets) ||
      !action.targets.length || action.targets.length > 41) return fail();
    const seen = new Set(), targets = [];
    for (const item of action.targets) {
      const slot = item && ref(item.area, item.index), key = `${item?.area}:${item?.index}`;
      if (!slot) return fail();
      if (seen.has(key)) continue;
      seen.add(key);
      const prior = slot.get();
      const probe = { ...owned.cursor, count: (prior?.count ?? 0) + 1 };
      if ((!prior || isMergeable(prior, owned.cursor)) && slot.accepts(probe) &&
        (prior?.count ?? 0) < slot.limit(probe)) targets.push(slot);
    }
    if (!targets.length) return fail("no-available-slots");
    const count = action.button === 2 ? 1 : Math.floor(owned.cursor.count / targets.length);
    if (!count) return fail("no-available-slots");
    for (const target of targets) {
      if (!owned.cursor) break;
      const moved = receive(target, owned.cursor, count);
      if (moved) debitCursor(moved);
    }
    return { ok: true };
  }
  const source = ref(action.area, action.index);
  if (!source) return fail();
  const stack = source.get();
  if (action.type === "click") {
    if (![0, 2].includes(action.button) || action.area === "cursor") return fail();
    if (owned.cursor === null) {
      if (!stack) return fail("empty-slot");
      owned.cursor = extract(source, action.button === 2 ? Math.ceil(stack.count / 2) : stack.count);
    } else if (stack === null || isMergeable(stack, owned.cursor)) {
      const count = receive(source, owned.cursor, action.button === 2 ? 1 : owned.cursor.count);
      if (!count) return fail("slot-rejected");
      debitCursor(count);
    } else {
      if (!source.accepts(owned.cursor)) return fail("slot-rejected");
      source.set(owned.cursor);
      owned.cursor = cloneStack(stack, context);
    }
    return { ok: true };
  }
  if (action.type === "quickMove") {
    if (!stack || action.area === "cursor") return fail("empty-slot");
    if (action.area === "container") {
      const rest = insertStack(owned.slots, cloneStack(stack, context), [...BAG_INDICES, ...HOTBAR_INDICES]);
      if (rest) return fail("inventory-full");
      source.set(null);
    } else if (validSaddle(stack, context) && horse.saddle === null) {
      horse.saddle = extract(source, 1);
    } else {
      return applySlotAction(owned, action);
    }
    return { ok: true };
  }
  if (action.type === "swapHotbar" || action.type === "swapOffhand") {
    if (action.type === "swapHotbar" && (!Number.isInteger(action.hotbarIndex) ||
      action.hotbarIndex < 0 || action.hotbarIndex > 8)) return fail();
    const target = ref(action.type === "swapHotbar" ? "inventory" : "offhand",
      action.type === "swapHotbar" ? action.hotbarIndex : 0);
    if (!target || !source.accepts(target.get()) || !target.accepts(stack)) return fail("slot-rejected");
    const incoming = cloneStack(target.get(), context);
    target.set(cloneStack(stack, context));
    source.set(incoming);
    return { ok: true };
  }
  if (action.type === "drop") {
    if (!stack || (action.wholeStack !== undefined && typeof action.wholeStack !== "boolean"))
      return fail("empty-slot");
    return { ok: true, drops: [extract(source, action.wholeStack ? stack.count : 1)] };
  }
  if (action.type === "collect") {
    if (!owned.cursor) {
      if (!stack) return fail("empty-slot");
      owned.cursor = extract(source, stack.count);
    }
    const targets = [...owned.slots.map((_, index) => ref("inventory", index)),
      ref("offhand", 0), ref("container", 0),
      ...Object.keys(owned.equipment).map((_, index) => ref("equipment", index))];
    for (const target of targets) {
      const needed = getItem(owned.cursor.id).stackSize - owned.cursor.count;
      if (!needed) break;
      if (!isMergeable(target.get(), owned.cursor)) continue;
      const taken = extract(target, Math.min(needed, target.get().count));
      owned.cursor = { ...cloneStack(owned.cursor, context), count: owned.cursor.count + taken.count };
    }
    return { ok: true };
  }
  return fail();
}
