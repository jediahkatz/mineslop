import { acceptsBrewingStack, changeBrewingSlots } from "./brewing.js";
import { isPlainEnchantableBook } from "./enchantment-domain.js";
import { applySlotAction, ownedSlot, validOwnedInventory, BAG_INDICES, HOTBAR_INDICES } from "./inventory-domain.js";
import { cloneStack, insertStack, isMergeable, normalizeStack } from "./inventory-slots.js";
import { getItem, ITEM } from "./items.js";
import { normalizeStationRecord, stationSlots } from "./progression-station-state.js";
import { smithingOutputItem } from "./smithing.js";

const fail = (reason = "invalid_slot_action") => ({ ok: false, reason });
const addressKey = ({ area, index }) => `${area}:${index}`;
const playerAreas = ["inventory", "offhand", "equipment"];

/** Trading exposes owned hands/gear/bag only, never the hidden crafting grid. */
export function applyProgressionInventoryAction(owned, action, context) {
  return applyProgressionSlotAction(null, null, owned, action, null, context);
}

export function stationSlotLimit(kind, index, stack) {
  return Math.min(getItem(stack?.id)?.stackSize ?? 64,
    (kind === "enchanting" && index === 0) ||
    (kind === "brewing" && index < 3) ||
    (kind === "smithing" && index === 1) ? 1 : 64);
}

export function acceptsStationStack(kind, index, stack, catalog, context) {
  if (stack === null) return true;
  const item = getItem(stack.id);
  if (!item || stack.count > stationSlotLimit(kind, index, stack)) return false;
  if (kind === "enchanting")
    return index === 1 ? stack.id === ITEM.LAPIS :
      index === 0 && (Boolean(item.durability) || isPlainEnchantableBook(item) ||
        item.enchantmentCarrier === true);
  if (kind === "anvil") return index === 0 || index === 1;
  if (kind === "brewing") return acceptsBrewingStack(index, stack, catalog, context);
  if (kind === "smithing")
    return index === 0 ? item.smithingTemplate === "netherite_upgrade" :
      index === 1 ? smithingOutputItem(stack) !== null :
        index === 2 && item.resourceLocation === "minecraft:netherite_ingot";
  return false;
}

/**
 * Only detached drafts are edited. The host commits Gameplay + station + any
 * retained drops once. Import normalization keeps ineligible inputs withdrawable;
 * insertion restrictions never erase a saved stack. Existing crafting/Creative
 * palette actions are deliberately outside this reducer.
 */
export function applyProgressionSlotAction(kind, record, owned, action, catalog, context) {
  if (!action || typeof action !== "object" || !validOwnedInventory(owned, context))
    return fail();
  const slots = kind === null ? [] : stationSlots(kind, record, context);
  const touched = new Set();
  const ref = (area, index) => {
    if (area !== "container") {
      if (!playerAreas.includes(area) && !(area === "cursor" && action.type === "drop")) return null;
      const target = ownedSlot(owned, area, index);
      return target && { ...target, area, index, limit: (stack) => getItem(stack.id).stackSize };
    }
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return null;
    return {
      area, index, get: () => slots[index],
      set: (stack) => { slots[index] = cloneStack(stack, context); touched.add(index); },
      accepts: (stack) => acceptsStationStack(kind, index, stack, catalog, context),
      limit: (stack) => stationSlotLimit(kind, index, stack),
    };
  };
  const extract = (source, count) => {
    const stack = source.get();
    const taken = { ...cloneStack(stack, context), count };
    source.set(stack.count === count ? null : { ...cloneStack(stack, context), count: stack.count - count });
    return taken;
  };
  const receive = (target, payload, maximum = payload.count) => {
    const previous = target.get();
    if (previous && !isMergeable(previous, payload)) return 0;
    const count = Math.min(payload.count, maximum, target.limit(payload) - (previous?.count ?? 0));
    if (count <= 0) return 0;
    const stack = { ...cloneStack(payload, context), count: count + (previous?.count ?? 0) };
    if (!target.accepts(stack)) return 0;
    target.set(stack);
    return count;
  };
  const debitCursor = (count) => {
    owned.cursor = count === owned.cursor.count ? null :
      { ...cloneStack(owned.cursor, context), count: owned.cursor.count - count };
  };
  const succeed = (extra = {}) => {
    if (kind === null) return { ok: true, ...extra };
    const next = kind === "brewing"
      ? changeBrewingSlots(record, slots, catalog, {
          context, touchedBottleSlots: [...touched].filter((index) => index < 3),
        })
      : normalizeStationRecord(kind,
          kind === "enchanting" ? { version: 1, input: slots[0], lapis: slots[1] } :
            kind === "anvil" ? { version: 1, left: slots[0], right: slots[1] } :
              { version: 1, template: slots[0], base: slots[1], addition: slots[2] },
          catalog, context);
    return { ok: true, record: next, ...extra };
  };

  if (action.type === "distribute") {
    if (!owned.cursor || ![0, 2].includes(action.button) ||
        !Array.isArray(action.targets) || !action.targets.length || action.targets.length > 64)
      return fail();
    const unique = new Set(), targets = [];
    for (const value of action.targets) {
      const target = value && ref(value.area, value.index);
      if (!target) return fail();
      const key = addressKey(value);
      if (unique.has(key)) continue;
      unique.add(key);
      const probe = { ...owned.cursor, count: 1 };
      if ((!target.get() || isMergeable(target.get(), probe)) &&
          target.accepts({ ...probe, count: (target.get()?.count ?? 0) + 1 }) &&
          (target.get()?.count ?? 0) < target.limit(probe))
        targets.push(target);
    }
    if (!targets.length) return fail("no_available_slots");
    const count = action.button === 2 ? 1 : Math.floor(owned.cursor.count / targets.length);
    if (!count) return fail("no_available_slots");
    for (const target of targets) {
      if (!owned.cursor) break;
      const moved = receive(target, owned.cursor, count);
      if (moved) debitCursor(moved);
    }
    return succeed();
  }
  const source = ref(action.area, action.index);
  if (!source) return fail();
  const stack = source.get();
  if (action.type === "click") {
    if (![0, 2].includes(action.button) || action.area === "cursor") return fail();
    if (!owned.cursor) {
      if (!stack) return fail("empty_slot");
      owned.cursor = extract(source, action.button === 2 ? Math.ceil(stack.count / 2) : stack.count);
    } else if (!stack || isMergeable(stack, owned.cursor)) {
      const count = receive(source, owned.cursor, action.button === 2 ? 1 : owned.cursor.count);
      if (!count) return fail("slot_rejected");
      debitCursor(count);
    } else {
      if (!source.accepts(owned.cursor)) return fail("slot_rejected");
      source.set(owned.cursor);
      owned.cursor = cloneStack(stack, context);
    }
    return succeed();
  }
  if (action.type === "quickMove") {
    if (!stack || action.area === "cursor") return fail("empty_slot");
    // Source addressing was restricted above. The ordinary bag/hotbar routing
    // is safe here; collection below deliberately omits hidden crafting escrow.
    if (kind === null) return applySlotAction(owned, action);
    if (action.area === "container") {
      const rest = insertStack(owned.slots, cloneStack(stack, context), [...BAG_INDICES, ...HOTBAR_INDICES]);
      if (rest?.count === stack.count) return fail("inventory_full");
      source.set(rest);
    } else {
      let remaining = stack.count;
      // Blaze powder first fills the fuel slot; manual placement can put it in
      // the ingredient slot for Strength. No other recipe routing is implicit.
      const order = kind === "brewing" ? [4, 3, 0, 1, 2] : slots.map((_, index) => index);
      for (const index of order) {
        if (!remaining) break;
        const amount = receive(ref("container", index), { ...stack, count: remaining });
        remaining -= amount;
      }
      if (remaining === stack.count) return fail("station_slots_full");
      source.set(remaining ? { ...cloneStack(stack, context), count: remaining } : null);
    }
    return succeed();
  }
  if (action.type === "swapHotbar" || action.type === "swapOffhand") {
    if (action.type === "swapHotbar" &&
        (!Number.isInteger(action.hotbarIndex) || action.hotbarIndex < 0 || action.hotbarIndex > 8))
      return fail();
    const target = ref(action.type === "swapHotbar" ? "inventory" : "offhand",
      action.type === "swapHotbar" ? action.hotbarIndex : 0);
    if (!target || !source.accepts(target.get()) || !target.accepts(stack)) return fail("slot_rejected");
    const incoming = cloneStack(target.get(), context);
    target.set(cloneStack(stack, context));
    source.set(incoming);
    return succeed();
  }
  if (action.type === "drop") {
    if (!stack || (action.wholeStack !== undefined && typeof action.wholeStack !== "boolean"))
      return fail();
    return succeed({ drops: [extract(source, action.wholeStack ? stack.count : 1)] });
  }
  if (action.type === "collect") {
    if (!owned.cursor) {
      if (!stack) return fail("empty_slot");
      owned.cursor = extract(source, stack.count);
    }
    const targets = [
      ...owned.slots.map((_, index) => ref("inventory", index)),
      ...slots.map((_, index) => ref("container", index)),
      ref("offhand", 0),
      ...Object.keys(owned.equipment).map((_, index) => ref("equipment", index)),
    ];
    for (const target of targets) {
      const needed = getItem(owned.cursor.id).stackSize - owned.cursor.count;
      if (!needed) break;
      if (!isMergeable(target.get(), owned.cursor)) continue;
      const count = Math.min(needed, target.get().count);
      extract(target, count);
      owned.cursor = normalizeStack({ ...owned.cursor, count: owned.cursor.count + count }, context);
    }
    return succeed();
  }
  return fail();
}
