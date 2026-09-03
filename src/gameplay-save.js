import { HOTBAR } from "./blocks.js";
import { experienceState, isValidExperience } from "./experience.js";
import {
  BAG_INDICES,
  cloneOwnedInventory,
  countSlots,
  durabilitySlots,
  emptyOwnedInventory,
  HOTBAR_INDICES,
  INVENTORY_SLOTS,
  validOwnedInventory,
} from "./inventory-domain.js";
import {
  cloneSlots,
  insertStack,
  splitStackPayload,
  splitStacks,
} from "./inventory-slots.js";
import { getItem } from "./items.js";
import { getRecipe } from "./recipes.js";

export const MAX_CRAFT_QUEUE = 16;
export const TIMER_LIMITS = Object.freeze({
  drowning: 1,
  lava: 0.5,
  starvation: 4,
  regen: 4,
});
export const freshTimers = () => ({
  drowning: 0,
  lava: 0,
  starvation: 0,
  regen: 0,
});
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const index = (value) => Number.isInteger(value) && value >= 0 && value < 9;
const validId = (id) => Number.isInteger(id) && id > 0 && getItem(id) !== null;
const validHotbar = (bar) =>
  Array.isArray(bar) &&
  bar.length === 9 &&
  Array.from(bar).every((id) => id === 0 || validId(id));

/** Legacy prepaid outputs still reserve real capacity; no recipe is paid twice. */
export function fitsQueuedOutputs(slots, queue, context) {
  const next = cloneSlots(slots, context);
  for (const job of queue) {
    const recipe = getRecipe(job.recipeId);
    if (!recipe?.duration) return false;
    const stacks = splitStackPayload(recipe.output, INVENTORY_SLOTS, context);
    if (!stacks || stacks.some((stack) => insertStack(next, stack)))
      return false;
  }
  return true;
}

/** A paid queue stores recipe identity/progress, never arbitrary saved outputs. */
export function normalizeCraftQueue(value, { legacy = false } = {}) {
  if (!Array.isArray(value) || value.length > MAX_CRAFT_QUEUE) return null;
  const queue = [];
  for (const job of value) {
    const recipe = getRecipe(job?.recipeId);
    if (
      !object(job) ||
      !recipe?.duration ||
      !inRange(job.remaining, legacy ? Number.MIN_VALUE : 0, recipe.duration) ||
      (queue.length > 0 && job.remaining !== recipe.duration)
    )
      return null;
    queue.push({ recipeId: recipe.id, remaining: job.remaining });
  }
  return queue;
}

export function inventoryProjections(owned, mode, creativeHotbar) {
  const survivalHotbar = owned.slots.slice(0, 9).map((stack) => stack?.id ?? 0);
  return {
    inventory: [...countSlots(owned.slots)].map(([id, count]) => ({
      id,
      count,
    })),
    hotbar: mode === "creative" ? [...creativeHotbar] : [...survivalHotbar],
    survivalHotbar,
    durability: Object.fromEntries(durabilitySlots(owned.slots)),
  };
}

function matchesProjections(data, projection) {
  for (const key of ["hotbar", "survivalHotbar"]) {
    if (
      data[key] !== undefined &&
      (!validHotbar(data[key]) ||
        data[key].some((id, i) => id !== projection[key][i]))
    )
      return false;
  }
  if (data.inventory !== undefined) {
    if (
      !Array.isArray(data.inventory) ||
      data.inventory.length !== projection.inventory.length ||
      !Array.from(data.inventory).every(
        (entry, i) =>
          object(entry) &&
          entry.data === undefined &&
          entry.id === projection.inventory[i].id &&
          entry.count === projection.inventory[i].count
      )
    )
      return false;
  }
  if (data.durability !== undefined) {
    if (
      !object(data.durability) ||
      Object.keys(data.durability).length !==
        Object.keys(projection.durability).length
    )
      return false;
    for (const [id, wear] of Object.entries(projection.durability)) {
      const values = data.durability[id];
      if (
        !Array.isArray(values) ||
        values.length !== wear.length ||
        !Array.from(values).every((value, i) => value === wear[i])
      )
        return false;
    }
  }
  return true;
}

function migrateV1(data) {
  if (
    !Array.isArray(data.inventory) ||
    data.inventory.length > INVENTORY_SLOTS ||
    !object(data.durability) ||
    !validHotbar(data.hotbar) ||
    !validHotbar(data.survivalHotbar)
  )
    return null;
  const pools = new Map();
  let used = 0;
  for (const entry of data.inventory) {
    // The old aggregate schema cannot describe distinct metadata kinds.
    if (!object(entry) || entry.data !== undefined || pools.has(entry.id))
      return null;
    const item = getItem(entry.id);
    if (item?.durability && !Object.hasOwn(data.durability, entry.id))
      return null;
    const stacks = splitStacks(
      entry.id,
      entry.count,
      data.durability[entry.id]
    );
    if (!stacks) return null;
    used += stacks.length;
    if (used > INVENTORY_SLOTS) return null;
    pools.set(entry.id, stacks);
  }
  for (const [key, wear] of Object.entries(data.durability)) {
    const id = Number(key);
    if (
      String(id) !== key ||
      !getItem(id)?.durability ||
      !pools.has(id) ||
      !Array.isArray(wear)
    )
      return null;
  }
  if (
    data.survivalHotbar.some((id) => id !== 0 && !pools.has(id)) ||
    (data.mode === "survival" &&
      data.hotbar.some((id) => id !== 0 && !pools.has(id)))
  )
    return null;
  const owned = emptyOwnedInventory();
  owned.fuelTime = data.fuelTime;
  const shortcuts =
    data.mode === "creative" ? data.survivalHotbar : data.hotbar;
  // The selected shortcut receives the first old instance. Duplicate shortcuts
  // consume a pool entry once; they never materialize another copy of a tool.
  const order = [
    data.selected,
    ...HOTBAR_INDICES.filter((i) => i !== data.selected),
  ];
  for (const slot of order) {
    owned.slots[slot] = pools.get(shortcuts[slot])?.shift() ?? null;
  }
  const remainingOrder = [...BAG_INDICES, ...HOTBAR_INDICES];
  for (const stacks of pools.values()) {
    for (const stack of stacks) {
      if (insertStack(owned.slots, stack, remainingOrder)) return null;
    }
  }
  return {
    owned,
    creativeHotbar: data.mode === "creative" ? [...data.hotbar] : [...HOTBAR],
    creativeSelected: data.selected,
    survivalSelected: data.selected,
  };
}

function readCanonical(data, context) {
  if (
    !validHotbar(data.creativeHotbar) ||
    !index(data.creativeSelected) ||
    !index(data.survivalSelected) ||
    !object(data.experience) ||
    !isValidExperience(data.experience.total) ||
    data.selected !==
      (data.mode === "creative" ? data.creativeSelected : data.survivalSelected)
  )
    return null;
  const experience = experienceState(data.experience.total);
  if (
    (data.experience.level !== undefined &&
      data.experience.level !== experience.level) ||
    (data.experience.progress !== undefined &&
      data.experience.progress !== experience.progress)
  )
    return null;
  const owned = {
    slots: data.slots,
    cursor: data.cursor,
    offhand: data.offhand,
    equipment: data.equipment,
    craftingGrid: data.craftingGrid,
    craftingSize: data.craftingSize,
    experienceTotal: data.experience.total,
    fuelTime: data.fuelTime,
  };
  if (
    !validOwnedInventory(owned, context) ||
    !matchesProjections(
      data,
      inventoryProjections(owned, data.mode, data.creativeHotbar)
    )
  )
    return null;
  return {
    owned: cloneOwnedInventory(owned, context),
    creativeHotbar: [...data.creativeHotbar],
    creativeSelected: data.creativeSelected,
    survivalSelected: data.survivalSelected,
  };
}

/** Parse in isolation. A null result cannot change live state or fire callbacks. */
export function parseGameplaySave(data, context) {
  try {
    if (
      !object(data) ||
      ![1, 2, 3].includes(data.version) ||
      (data.mode !== "survival" && data.mode !== "creative") ||
      ![data.health, data.hunger, data.air, data.saturation].every((value) =>
        inRange(value, 0, 20)
      ) ||
      !inRange(data.exhaustion, 0, 4) ||
      data.exhaustion === 4 ||
      !inRange(data.fuelTime, 0, 80) ||
      typeof data.dead !== "boolean" ||
      data.dead !== (data.health === 0) ||
      (data.deathCause !== null &&
        (typeof data.deathCause !== "string" || data.deathCause.length > 80)) ||
      (!data.dead && data.deathCause !== null) ||
      !index(data.selected) ||
      (data.mode === "creative" &&
        (data.dead ||
          data.health !== 20 ||
          data.hunger !== 20 ||
          data.air !== 20))
    )
      return null;
    const migrated =
      data.version === 1 ? migrateV1(data) : readCanonical(data, context);
    if (!migrated || !validOwnedInventory(migrated.owned, context)) return null;
    const queue = normalizeCraftQueue(data.crafting, {
      legacy: data.version === 1,
    });
    if (
      !queue ||
      !fitsQueuedOutputs(migrated.owned.slots, queue, context) ||
      !object(data.timers)
    )
      return null;
    const timers = freshTimers();
    for (const [name, limit] of Object.entries(TIMER_LIMITS)) {
      if (!inRange(data.timers[name], 0, limit) || data.timers[name] === limit)
        return null;
      timers[name] = data.timers[name];
    }
    return {
      ...migrated,
      mode: data.mode,
      health: data.health,
      hunger: data.hunger,
      air: data.air,
      saturation: data.saturation,
      exhaustion: data.exhaustion,
      dead: data.dead,
      deathCause: data.deathCause,
      selected: data.selected,
      queue,
      timers,
    };
  } catch {
    return null;
  }
}
