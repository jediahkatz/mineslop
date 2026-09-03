import { isValidExperience } from "./experience.js";
import { INVENTORY_SLOTS } from "./inventory-domain.js";
import { cloneSlots, cloneStack, insertStack, isValidSlots } from "./inventory-slots.js";
import { sameStackKind } from "./item-stack-data.js";
import { synchronousProgressCallback } from "./progression-common.js";
import { TransactionInvariantError } from "./transactions.js";
import { MAX_TRADE_USES, normalizeTradeOffer } from "./trading-offers.js";

/**
 * A reducer for Gameplay.prepareInventory's detached draft, not another
 * inventory. Pay exact ID/data/wear kinds, then fit all outputs and player XP.
 * Even this working draft stays unchanged on failure; no overflow is discarded.
 */
export function applyTradeToInventory(owned, value, count, context) {
  try {
    const offer = normalizeTradeOffer(value, context);
    if (
      !owned ||
      !Number.isInteger(count) || count < 1 || count > MAX_TRADE_USES ||
      !isValidSlots(owned.slots, INVENTORY_SLOTS, context) ||
      !isValidExperience(owned.experienceTotal)
    )
      return false;
    const slots = cloneSlots(owned.slots, context);
    for (const input of offer.inputs) {
      let remaining = input.count * count;
      for (let i = 0; i < slots.length && remaining; i++) {
        const stack = slots[i];
        if (
          !stack ||
          !sameStackKind(stack, input, context) ||
          stack.durability !== input.durability
        )
          continue;
        const taken = Math.min(remaining, stack.count);
        slots[i] = taken === stack.count ? null : { ...stack, count: stack.count - taken };
        remaining -= taken;
      }
      if (remaining) return false;
    }
    for (let i = 0; i < count; i++)
      if (insertStack(slots, cloneStack(offer.output, context))) return false;
    const experience = owned.experienceTotal + offer.playerXp * count;
    if (!isValidExperience(experience)) return false;
    owned.slots = slots;
    owned.experienceTotal = experience;
    return true;
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return false;
  }
}

/** Adapter to the existing inventory owner; stock and villager XP stay separate. */
export function prepareTradeInventory(inventory, offer, count, coordinator, context) {
  if (
    !inventory ||
    inventory.coordinator !== coordinator ||
    inventory.context?.seed !== context.seed ||
    inventory.context?.generatorVersion !== context.generatorVersion ||
    !synchronousProgressCallback(inventory.prepareInventory)
  )
    return null;
  const prepared = inventory.prepareInventory((owned) =>
    applyTradeToInventory(owned, offer, count, context)
  );
  return prepared?.owner === inventory ? prepared : null;
}
