import { cloneStackData, normalizeStackData } from "../item-stack-data.js";
import { getItem } from "../items.js";
import { durabilityView, itemCount, normalizeHotbar } from "./model.js";

export const EQUIPMENT_SLOTS = ["head", "chest", "legs", "feet"];
export const EQUIPMENT_LABELS = ["Helmet", "Chestplate", "Leggings", "Boots"];

export function displayStack(value, context) {
  if (
    !value ||
    !Number.isInteger(value.id) ||
    !getItem(value.id) ||
    !Number.isInteger(value.count) ||
    value.count < 1
  )
    return null;
  try {
    const data = normalizeStackData(value.id, value.data, context);
    return {
      id: value.id,
      count: value.count,
      ...(Number.isFinite(value.durability)
        ? { durability: value.durability }
        : {}),
      ...(data === undefined ? {} : { data }),
    };
  } catch {
    // Invalid/unknown metadata is not rendered as a different, plain item.
    return null;
  }
}

// This is a read-only compatibility projection, never an inventory authority.
// Old aggregate saves are rendered once per owned stack until Gameplay supplies
// stable slots. Slot mutations remain disabled for that transitional snapshot.
export function ownedSlotStacks(state = {}) {
  if (Array.isArray(state.slots))
    return Array.from({ length: 36 }, (_, index) =>
      displayStack(state.slots[index])
    );
  const slots = Array(36).fill(null);
  const entries = state.counts
    ? Object.entries(state.counts).map(([id, count]) => ({
        id: Number(id),
        count: Number(count),
      }))
    : state.inventory instanceof Map
      ? [...state.inventory].map(([id, count]) => ({ id, count }))
      : Array.isArray(state.inventory)
        ? state.inventory
        : [];
  const remaining = new Map(
    entries
      .filter((entry) => getItem(entry.id) && entry.count > 0)
      .map(({ id, count }) => [id, Math.floor(count)])
  );
  const take = (id) => {
    const count = Math.min(
      remaining.get(id) || 0,
      getItem(id)?.stackSize || 64
    );
    if (!count) return null;
    remaining.set(id, remaining.get(id) - count);
    const wear = state.durability?.[id];
    const durability = durabilityView(getItem(id), wear)?.remaining;
    return { id, count, ...(durability !== undefined ? { durability } : {}) };
  };
  normalizeHotbar(state.hotbar).forEach((id, index) => {
    slots[index] = take(id);
  });
  for (const [id] of remaining) {
    for (const index of [
      ...Array.from({ length: 27 }, (_, i) => i + 9),
      ...Array.from({ length: 9 }, (_, i) => i),
    ]) {
      if (!slots[index]) slots[index] = take(id);
      if (!remaining.get(id)) break;
    }
  }
  return slots;
}

export function hotbarSlotView(state, index) {
  if (state.mode === "creative") {
    const palette = normalizeHotbar(state.creativeHotbar ?? state.hotbar);
    const id = palette[index];
    // AIR is registered world content, but zero denotes an empty palette slot.
    return {
      stack: id > 0 && getItem(id) ? { id, count: 1 } : null,
      unlimited: true,
    };
  }
  if (Array.isArray(state.slots))
    return { stack: displayStack(state.slots[index]), unlimited: false };
  const id = normalizeHotbar(state.hotbar)[index];
  const count = itemCount(state, id);
  return {
    stack:
      getItem(id) && count
        ? {
            id,
            count,
            ...(state.durability?.[id] !== undefined
              ? {
                  durability: durabilityView(getItem(id), state.durability[id])
                    ?.remaining,
                }
              : {}),
          }
        : null,
    unlimited: false,
  };
}

export function stackAt(state, { area, index }) {
  if (area === "inventory") return ownedSlotStacks(state)[index] || null;
  if (area === "cursor") return displayStack(state.cursor);
  if (area === "offhand") return displayStack(state.offhand);
  if (area === "equipment")
    return displayStack(state.equipment?.[EQUIPMENT_SLOTS[index]]);
  if (area === "crafting") return displayStack(state.craftingGrid?.[index]);
  if (area === "result") return displayStack(state.craftingResult);
  if (area === "container") return displayStack(state.containerSlots?.[index]);
  return null;
}

const title = (value) =>
  value
    .replaceAll("_", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
const roman = ["", "I", "II", "III", "IV", "V"];

/** Literal text only. Data-only fixtures need no fabricated potion/map items. */
export function stackMetadataDetails(value) {
  const data = cloneStackData(value);
  if (!data) return [];
  const lines = [];
  if (data.enchantments)
    lines.push(
      `Stored enchantments: ${Object.entries(data.enchantments)
        .map(([name, level]) => `${title(name)} ${roman[level] ?? level}`)
        .join(", ")}`
    );
  if (data.potion)
    lines.push(
      `Potion: ${[
        title(data.potion.id),
        title(data.potion.form),
        ...(data.potion.extended ? ["Extended"] : []),
        ...(data.potion.strong ? ["Strong"] : []),
      ].join(" · ")}`
    );
  if (data.mapTarget) {
    const { seed, generatorVersion, dimension, structureId, x, y, z } =
      data.mapTarget;
    lines.push(
      `Map target: ${structureId} (${title(dimension)})`,
      `Coordinates: ${x}, ${y}, ${z}`,
      `World: ${seed} (generator ${generatorVersion})`
    );
  }
  if (data.repairCost) lines.push(`Prior repair cost: ${data.repairCost}`);
  return lines;
}

export function stackDisplayName(value) {
  const stack = displayStack(value);
  return stack?.data?.name ?? getItem(stack?.id)?.name ?? "Empty slot";
}

export function stackDescription(stack, { unlimited = false } = {}) {
  stack = displayStack(stack);
  const item = getItem(stack?.id);
  if (!item) return "Empty slot";
  const wear = durabilityView(item, stack.durability);
  return [
    stack.data?.name ?? item.name,
    ...(stack.data?.name ? [item.name] : []),
    unlimited ? "Unlimited palette item" : `${stack.count}`,
    ...(wear
      ? [`Durability ${Math.ceil(wear.remaining)} / ${wear.maximum}`]
      : []),
    ...stackMetadataDetails(stack.data),
  ].join(" · ");
}

export function slotAddress(node) {
  const area = node?.dataset?.area;
  const index = Number(node?.dataset?.index);
  return area && Number.isInteger(index) && index >= 0 ? { area, index } : null;
}

// Kept pure so UI shortcuts can be verified without a renderer or DOM shim.
export function slotKeyAction(event, address) {
  if (!address || event.repeat || event.altKey || event.metaKey) return null;
  if (/^Digit[1-9]$/.test(event.code))
    return {
      type: "swapHotbar",
      ...address,
      hotbarIndex: Number(event.code.slice(-1)) - 1,
    };
  if (event.code === "KeyF") return { type: "swapOffhand", ...address };
  if (event.code === "KeyQ")
    return { type: "drop", ...address, wholeStack: Boolean(event.ctrlKey) };
  return null;
}

export function uniqueSlotTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    if (!target || target.area === "result" || target.area === "catalog")
      return false;
    const key = `${target.area}:${target.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
