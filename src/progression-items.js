import { normalizeStack } from "./inventory-slots.js";
import { getItem, ITEM } from "./items.js";
import {
  freezeProgressData,
  progressArray,
  progressRecord,
} from "./progression-common.js";

/** Symbolic activation requirements, not new catalog IDs or substitute items. */
export const PROGRESSION_ITEM_CAPABILITIES = freezeProgressData({
  HEART_OF_THE_SEA: [],
  TREASURE_MAP: ["map"],
  ENCHANTED_BOOK: ["enchantmentCarrier", "single"],
  POTION: ["potion:drinkable", "single"],
  RAW_COD: ["food"],
  COOKED_COD: ["food"],
  FISHING_ROD: ["durable", "tool:fishing_rod", "single"],
  GOLDEN_CARROT: ["food"],
});

function capable(item, capability) {
  if (capability === "durable")
    return Number.isSafeInteger(item.durability) && item.durability > 0;
  if (capability === "food") return Number.isFinite(item.food) && item.food > 0;
  if (capability === "single") return item.stackSize === 1;
  if (capability.startsWith("tool:")) return item.tool === capability.slice(5);
  if (capability.startsWith("potion:"))
    return item.potionForm === capability.slice(7);
  return item[capability] === true;
}

export function missingProgressionItems(symbols) {
  const missing = [];
  progressArray(symbols, 128);
  for (const symbol of symbols) {
    if (
      typeof symbol !== "string" ||
      symbol.length > 64 ||
      !/^[A-Z][A-Z0-9_]*$/.test(symbol)
    )
      throw new RangeError("Invalid symbolic progression item");
  }
  for (const symbol of [...new Set(symbols)].sort()) {
    const item = Object.hasOwn(ITEM, symbol) ? getItem(ITEM[symbol]) : null;
    const capabilities = PROGRESSION_ITEM_CAPABILITIES[symbol] ?? [];
    if (!item || capabilities.some((capability) => !capable(item, capability)))
      missing.push({ symbol, capabilities: ["registered", ...capabilities] });
  }
  return missing;
}

export class MissingProgressionItemsError extends RangeError {
  constructor(requirements) {
    super(
      `Missing progression item capabilities: ${requirements
        .map(({ symbol }) => symbol)
        .join(", ")}`
    );
    this.name = "MissingProgressionItemsError";
    this.requirements = freezeProgressData(structuredClone(requirements));
  }
}

export function requireProgressionItems(symbols) {
  const missing = missingProgressionItems(symbols);
  if (missing.length) throw new MissingProgressionItemsError(missing);
}

export function normalizeProgressStack(value, context) {
  progressRecord(value, ["id", "count", "durability", "data"]);
  return normalizeStack(value, context);
}

/** Actual catalog lookup and item-aware metadata validation, with fresh wear. */
export function progressionStack(symbol, count, context, data) {
  requireProgressionItems([symbol]);
  const id = ITEM[symbol];
  const item = getItem(id);
  return normalizeProgressStack(
    {
      id,
      count,
      ...(item.durability ? { durability: item.durability } : {}),
      ...(data === undefined ? {} : { data }),
    },
    context
  );
}
