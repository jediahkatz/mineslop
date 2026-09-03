import {
  experienceForLevel,
  experienceState,
  experienceToNextLevel,
  isValidExperience,
} from "./experience.js";
import { getArmorSpec, getToolSpec } from "./gear.js";
import { normalizeStack } from "./inventory-slots.js";
import { normalizeStackData, STACK_DATA_VERSION } from "./item-stack-data.js";
import { getItem } from "./items.js";

/** Internal shared validation/math; this module owns no inventory or RNG state. */
export const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

export function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value !== null && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, immutable(child)])
      )
    );
  return value;
}

export const refusal = (reason, details = {}) =>
  immutable({ ok: false, reason, ...details });

export function dataRecord(value, fields, label = "record") {
  if (
    value === null ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new RangeError(`Invalid ${label}`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw new RangeError(`Unknown or non-data ${label} field`);
  }
  return value;
}

export function integer(
  value,
  label,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid ${label}`);
  return value;
}

export function finite(value, label, minimum = 0, maximum = Number.MAX_VALUE) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid ${label}`);
  return value;
}

export function randomUnit(value) {
  finite(value, "random sample", 0, 1);
  if (value === 1) throw new RangeError("Random samples must be below one");
  return value;
}

export function equipmentMode(mode) {
  if (!["survival", "adventure", "creative"].includes(mode))
    throw new RangeError("Invalid equipment operation mode");
  return mode;
}

/**
 * A project-owned, full-period uint32 sequence, NOT Mojang's RNG. Zero is a valid
 * persisted seed, never an instruction to reroll. The caller installs this next
 * seed only with a successfully committed enchantment transaction.
 */
export function nextEnchantingSeed(seed) {
  integer(seed, "enchanting seed", 0, 0xffffffff);
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

/** An ephemeral local generator for a pure calculation, not a saved authority. */
export function enchantingRandom(seed) {
  integer(seed, "enchanting seed", 0, 0xffffffff);
  let state = seed;
  const next = () => {
    state = nextEnchantingSeed(state);
    return state / 0x100000000;
  };
  return {
    next,
    int(maximum) {
      integer(maximum, "random integer maximum", 0, 0xffffffff);
      return Math.floor(next() * (maximum + 1));
    },
  };
}

/**
 * Spend LEVELS, not the same number of raw XP points. Java retains bar progress
 * when spending levels. This app persists only integer total XP, so project the
 * old bar fraction onto the new level, rounding down by at most one XP point.
 * Never persist a second derived level/bar authority. A refusal returns null.
 */
export function spendExperienceLevels(total, levels) {
  if (!isValidExperience(total))
    throw new RangeError("Invalid experience total");
  integer(levels, "experience level cost");
  const before = experienceState(total);
  if (levels > before.level) return null;
  if (levels === 0) return total;
  const level = before.level - levels;
  const progressPoints = total - experienceForLevel(before.level);
  return (
    experienceForLevel(level) +
    Math.floor(
      (progressPoints * experienceToNextLevel(level)) /
        experienceToNextLevel(before.level)
    )
  );
}

export const isPlainEnchantableBook = (item) =>
  item?.kind === "book" &&
  item.enchantable === true &&
  item.enchantmentCarrier !== true;

export const isEnchantmentCarrier = (item) => item?.enchantmentCarrier === true;

/**
 * Capability binding, not an alternate catalog. Every stack and output still
 * goes through getItem/normalizeStack/normalizeStackData.
 *
 * Default registered capabilities:
 *   gearMaterial: a key of gear.js's material tables;
 *   enchantability: explicit value for non-tiered enchantable equipment;
 *   repairIngredients: symbolic alternatives for non-tiered repairable items;
 *   resourceLocation: "minecraft:iron_ingot", etc.;
 *   tags: ["minecraft:planks"], etc. (no leading '#').
 *
 * During catalog integration, bindings.materialForItem(item),
 * bindings.symbolForItem(item), and bindings.itemHasTag(item, tag) may resolve
 * these capabilities from explicit registered-item mappings. They must be
 * synchronous/read-only. Never infer materials from names, numeric ranges,
 * internal mining tiers, or matching textures.
 */
export function equipmentProfile(itemId, bindings = {}) {
  const item = getItem(itemId);
  if (!item) throw new RangeError("Unregistered equipment item");
  if (
    bindings.materialForItem !== undefined &&
    !synchronous(bindings.materialForItem)
  )
    throw new RangeError("Invalid material capability resolver");
  const material = bindings.materialForItem
    ? bindings.materialForItem(item)
    : item.gearMaterial;
  let spec;
  if (material !== undefined && material !== null) {
    spec = item.equipmentSlot
      ? getArmorSpec(material, item.equipmentSlot)
      : getToolSpec(material, item.tool);
    if (
      spec.durability !== item.durability ||
      (item.equipmentSlot && spec.armorPoints !== item.armorPoints)
    )
      throw new RangeError(
        "Gear capability does not match the registered item"
      );
  }
  let enchantability = spec?.enchantability ?? item.enchantability;
  if (enchantability === undefined) {
    if (
      isPlainEnchantableBook(item) ||
      ["bow", "crossbow", "fishing_rod", "trident"].includes(item.tool)
    )
      enchantability = 1;
    else enchantability = 0;
  }
  integer(enchantability, "enchantability", 0, 255);
  if (item.enchantable === false || isEnchantmentCarrier(item))
    enchantability = 0;
  const repairIngredients =
    spec?.repairIngredients ??
    item.repairIngredients ??
    (item.tool === "shield" ? ["#minecraft:planks"] : []);
  if (
    !Array.isArray(repairIngredients) ||
    Array.from(repairIngredients).some(
      (symbol) =>
        typeof symbol !== "string" ||
        !/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(symbol)
    )
  )
    throw new RangeError("Invalid symbolic repair ingredients");
  return immutable({
    durability: item.durability ?? null,
    enchantability,
    repairIngredients,
  });
}

export function matchesRepairIngredient(
  stack,
  alternatives,
  bindings = {},
  context
) {
  const clean = normalizeStack(stack, context);
  const item = getItem(clean.id);
  for (const callback of [bindings.symbolForItem, bindings.itemHasTag]) {
    if (callback !== undefined && !synchronous(callback))
      throw new RangeError("Invalid repair capability resolver");
  }
  const symbol = bindings.symbolForItem
    ? bindings.symbolForItem(item)
    : item.resourceLocation;
  if (symbol !== undefined && typeof symbol !== "string")
    throw new RangeError("Invalid registered item resource location");
  return alternatives.some((reference) =>
    reference.startsWith("#")
      ? bindings.itemHasTag
        ? bindings.itemHasTag(item, reference.slice(1)) === true
        : Array.isArray(item.tags) && item.tags.includes(reference.slice(1))
      : symbol === reference
  );
}

/**
 * No fallback book identity. The integrator supplies a real registered output
 * with the canonical enchantmentCarrier capability and singleton stack size.
 */
export function enchantedBookOutput(resources) {
  const id = resources?.enchantedBook;
  const item = Number.isSafeInteger(id) ? getItem(id) : null;
  return item &&
    isEnchantmentCarrier(item) &&
    item.stackSize === 1 &&
    item.durability === undefined
    ? id
    : null;
}

/** Canonical metadata retention/removal, including an explicit item conversion. */
export function withEnchantmentData(
  stack,
  changes,
  { id = stack.id, context } = {}
) {
  const source = normalizeStack(stack, context);
  const output = { ...source, id };
  const data = normalizeStackData(
    id,
    { version: STACK_DATA_VERSION, ...source.data, ...changes },
    context
  );
  if (data === undefined) delete output.data;
  else output.data = data;
  return normalizeStack(output, context);
}
