import { parseStructureIdentity } from "./canonical-structure-identity.js";
import { isSupportedGeneratorVersion } from "./generator-version.js";
import { getItem } from "./items.js";
import { getWorldSpec } from "./world-spec.js";

export const STACK_DATA_VERSION = 1;
export const MAX_STACK_NAME_LENGTH = 50;
export const MAX_STACK_ENCHANTMENTS = 16;
export const MAX_REPAIR_COST = 2_147_483_647;
const DIMENSIONS = new Set(["overworld", "nether", "end"]);
const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const durable = (item) =>
  Number.isInteger(item.durability) && item.durability > 0;
const tool =
  (...names) =>
  (item) =>
    durable(item) && names.includes(item.tool);
const armor = (item) => durable(item) && Boolean(item.equipmentSlot);
const equipment =
  (...slots) =>
  (item) =>
    armor(item) && slots.includes(item.equipmentSlot);
const damageEnchantments = ["sharpness", "smite", "bane_of_arthropods"];
const protectionEnchantments = [
  "protection",
  "fire_protection",
  "blast_protection",
  "projectile_protection",
];
const enchantment = (maxLevel, eligible, conflicts = []) =>
  Object.freeze({ maxLevel, eligible, conflicts: Object.freeze(conflicts) });

/**
 * Schema/eligibility registry, NOT a claim that gameplay implements each effect.
 * Eligibility uses capabilities, never numeric ID ranges. An explicitly declared
 * `enchantmentCarrier: true` item may store these enchantments; an ordinary book
 * or paper does not acquire that capability just because of its catalog name.
 */
export const ENCHANTMENTS = Object.freeze({
  aqua_affinity: enchantment(1, equipment("head")),
  bane_of_arthropods: enchantment(5, tool("sword", "axe"), damageEnchantments),
  binding_curse: enchantment(1, armor),
  blast_protection: enchantment(4, armor, protectionEnchantments),
  depth_strider: enchantment(3, equipment("feet"), ["frost_walker"]),
  efficiency: enchantment(5, tool("pickaxe", "axe", "shovel", "hoe", "shears")),
  feather_falling: enchantment(4, equipment("feet")),
  fire_aspect: enchantment(2, tool("sword")),
  fire_protection: enchantment(4, armor, protectionEnchantments),
  flame: enchantment(1, tool("bow")),
  fortune: enchantment(3, tool("pickaxe", "axe", "shovel", "hoe"), [
    "silk_touch",
  ]),
  frost_walker: enchantment(2, equipment("feet"), ["depth_strider"]),
  infinity: enchantment(1, tool("bow"), ["mending"]),
  knockback: enchantment(2, tool("sword")),
  looting: enchantment(3, tool("sword")),
  luck_of_the_sea: enchantment(3, tool("fishing_rod")),
  lure: enchantment(3, tool("fishing_rod")),
  mending: enchantment(1, durable, ["infinity"]),
  power: enchantment(5, tool("bow")),
  projectile_protection: enchantment(4, armor, protectionEnchantments),
  protection: enchantment(4, armor, protectionEnchantments),
  punch: enchantment(2, tool("bow")),
  respiration: enchantment(3, equipment("head")),
  sharpness: enchantment(5, tool("sword", "axe"), damageEnchantments),
  silk_touch: enchantment(1, tool("pickaxe", "axe", "shovel", "hoe"), [
    "fortune",
  ]),
  smite: enchantment(5, tool("sword", "axe"), damageEnchantments),
  soul_speed: enchantment(3, equipment("feet")),
  sweeping_edge: enchantment(3, tool("sword")),
  swift_sneak: enchantment(3, equipment("legs")),
  thorns: enchantment(3, armor),
  unbreaking: enchantment(3, durable),
  vanishing_curse: enchantment(1, durable),
});

const potion = (extended = false, strong = false) =>
  Object.freeze({ extended, strong });

/** Known payload IDs only. This neither allocates item IDs nor brews potions. */
export const POTION_DATA_TYPES = Object.freeze({
  water: potion(),
  mundane: potion(),
  thick: potion(),
  awkward: potion(),
  night_vision: potion(true),
  invisibility: potion(true),
  leaping: potion(true, true),
  fire_resistance: potion(true),
  swiftness: potion(true, true),
  slowness: potion(true, true),
  water_breathing: potion(true),
  healing: potion(false, true),
  harming: potion(false, true),
  poison: potion(true, true),
  regeneration: potion(true, true),
  strength: potion(true, true),
  weakness: potion(true),
  turtle_master: potion(true, true),
  slow_falling: potion(true),
  luck: potion(),
  wind_charged: potion(),
  weaving: potion(),
  oozing: potion(),
  infested: potion(),
});

function record(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new RangeError("Invalid stack metadata record");
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      !property.enumerable ||
      !Object.hasOwn(property, "value")
    )
      throw new RangeError("Unknown or non-data stack metadata field");
  }
}

function boundedText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum * 2 &&
    [...value].length <= maximum &&
    value.trim().length > 0 &&
    !unsafeText.test(value)
  );
}

/** Data-only schema helper; it checks levels/conflicts without inventing items. */
export function normalizeEnchantments(value) {
  record(value, Object.keys(ENCHANTMENTS));
  const names = Object.keys(value).sort();
  if (names.length > MAX_STACK_ENCHANTMENTS)
    throw new RangeError("Too many enchantments");
  const result = {};
  for (const name of names) {
    const definition = ENCHANTMENTS[name];
    const level = value[name];
    if (!Number.isInteger(level) || level < 1 || level > definition.maxLevel)
      throw new RangeError("Invalid enchantment level");
    if (
      definition.conflicts.some(
        (other) => other !== name && names.includes(other)
      )
    )
      throw new RangeError("Conflicting enchantments");
    result[name] = level;
  }
  return result;
}

/** Schema-only: flags default to false, and false/omitted encode identically. */
export function normalizePotionData(value) {
  record(value, ["id", "form", "extended", "strong"]);
  const definition =
    typeof value.id === "string" && Object.hasOwn(POTION_DATA_TYPES, value.id)
      ? POTION_DATA_TYPES[value.id]
      : null;
  if (
    !definition ||
    !["drinkable", "splash", "lingering"].includes(value.form) ||
    (value.extended !== undefined && typeof value.extended !== "boolean") ||
    (value.strong !== undefined && typeof value.strong !== "boolean") ||
    (value.extended && value.strong) ||
    (value.extended && !definition.extended) ||
    (value.strong && !definition.strong)
  )
    throw new RangeError("Invalid potion metadata");
  return {
    id: value.id,
    form: value.form,
    extended: value.extended ?? false,
    strong: value.strong ?? false,
  };
}

/**
 * Schema-only structure reference, not a structure-existence assertion.
 * Context is optional {seed,generatorVersion,specForDimension(dimension)}.
 * When supplied, world identity must match, including inactive dimensions.
 * Catalog IDs keep their complete encoded seed and canonical owner coordinates.
 * Short legacy opaque IDs retain their old grammar and encode no trusted owner.
 */
export function normalizeMapTarget(value, context) {
  record(value, [
    "seed",
    "generatorVersion",
    "dimension",
    "structureId",
    "x",
    "y",
    "z",
  ]);
  if (
    // This is a World identity, not a display name. Preserve its raw spelling.
    typeof value.seed !== "string" ||
    value.seed.length > 80 ||
    !isSupportedGeneratorVersion(value.generatorVersion) ||
    !DIMENSIONS.has(value.dimension) ||
    typeof value.structureId !== "string" ||
    ![value.x, value.y, value.z].every(Number.isSafeInteger) ||
    value.x < -30_000_000 ||
    value.x >= 30_000_000 ||
    value.z < -30_000_000 ||
    value.z >= 30_000_000 ||
    (context?.seed !== undefined && context.seed !== value.seed) ||
    (context?.generatorVersion !== undefined &&
      context.generatorVersion !== value.generatorVersion)
  )
    throw new RangeError("Invalid map target");
  const owner = parseStructureIdentity(
    value.structureId,
    value.seed,
    value.generatorVersion,
    value.dimension
  );
  if (
    owner &&
    (Math.floor(value.x / owner.spacing) !== owner.gx ||
      Math.floor(value.z / owner.spacing) !== owner.gz)
  )
    throw new RangeError("Map target is outside its canonical structure owner");
  const spec = context?.specForDimension
    ? context.specForDimension(value.dimension)
    : getWorldSpec(value.generatorVersion, value.dimension);
  if (
    !spec ||
    !Number.isSafeInteger(spec.minY) ||
    !Number.isSafeInteger(spec.maxY) ||
    value.y < spec.minY ||
    value.y >= spec.maxY
  )
    throw new RangeError("Map target is outside its world bounds");
  return {
    seed: value.seed,
    generatorVersion: value.generatorVersion,
    dimension: value.dimension,
    structureId: value.structureId,
    x: value.x,
    y: value.y,
    z: value.z,
  };
}

/**
 * Data-only normalization for schema fixtures and detached clones. Unknown
 * fields/versions throw RangeError, including on otherwise plain items.
 * Empty v1 metadata, empty enchantments and repairCost:0 normalize to absence.
 * Names are literal text, not HTML: consumers must use textContent/text nodes.
 */
export function normalizeStackDataSchema(data, context) {
  if (data === undefined) return undefined;
  record(data, [
    "version",
    "enchantments",
    "potion",
    "name",
    "repairCost",
    "mapTarget",
  ]);
  if (data.version !== STACK_DATA_VERSION)
    throw new RangeError("Unsupported stack metadata version");
  const result = { version: STACK_DATA_VERSION };
  if (data.enchantments !== undefined) {
    const enchantments = normalizeEnchantments(data.enchantments);
    if (Object.keys(enchantments).length) result.enchantments = enchantments;
  }
  if (data.potion !== undefined)
    result.potion = normalizePotionData(data.potion);
  if (data.name !== undefined) {
    if (!boundedText(data.name, MAX_STACK_NAME_LENGTH))
      throw new RangeError("Invalid custom item name");
    result.name = data.name;
  }
  if (data.repairCost !== undefined) {
    if (
      !Number.isSafeInteger(data.repairCost) ||
      data.repairCost < 0 ||
      data.repairCost > MAX_REPAIR_COST
    )
      throw new RangeError("Invalid repair cost");
    if (data.repairCost) result.repairCost = data.repairCost;
  }
  if (data.mapTarget !== undefined)
    result.mapTarget = normalizeMapTarget(data.mapTarget, context);
  return Object.keys(result).length === 1 ? undefined : result;
}

/**
 * Normalize metadata for a real catalog item. Returns detached canonical data
 * or undefined; throws RangeError on invalid data or eligibility.
 * Catalog capability hooks for later real definitions:
 *   enchantmentCarrier:true, potionForm:"drinkable"|"splash"|"lingering", map:true.
 * Count and current wear are intentionally outside this API.
 */
export function normalizeStackData(itemId, data, context) {
  const item =
    Number.isSafeInteger(itemId) && itemId > 0 ? getItem(itemId) : null;
  if (!item) throw new RangeError("Unknown metadata item");
  const clean = normalizeStackDataSchema(data, context);
  if (!clean) return undefined;
  if (
    clean.enchantments &&
    item.enchantmentCarrier !== true &&
    Object.keys(clean.enchantments).some(
      (name) => !ENCHANTMENTS[name].eligible(item)
    )
  )
    throw new RangeError("Ineligible enchantment");
  if (clean.potion && item.potionForm !== clean.potion.form)
    throw new RangeError("Ineligible potion metadata");
  if (clean.mapTarget && item.map !== true)
    throw new RangeError("Ineligible map metadata");
  if (clean.repairCost && !durable(item) && item.enchantmentCarrier !== true)
    throw new RangeError("Ineligible repair cost");
  return clean;
}

export const cloneStackData = (data, context) =>
  normalizeStackDataSchema(data, context);

/** Schema-only identity for future payload fixtures; it does not identify an item. */
export const stackDataIdentity = (data, context) =>
  JSON.stringify(normalizeStackDataSchema(data, context) ?? null);

/**
 * Unambiguous merge-kind key for {id,data?}; count and wear do not participate.
 * This is NOT a held-use identity: callers also need their own hand revision,
 * and must not cancel an ongoing self-use merely because that use changes wear.
 */
export function stackIdentity(stack, context) {
  if (!stack || typeof stack !== "object" || Array.isArray(stack))
    throw new RangeError("Invalid stack kind");
  return JSON.stringify([
    stack.id,
    normalizeStackData(stack.id, stack.data, context) ?? null,
  ]);
}

/** Kind equality is distinct from mergeability: two durable copies never merge. */
export function sameStackKind(a, b, context) {
  if (!a || !b) return false;
  return stackIdentity(a, context) === stackIdentity(b, context);
}

export function getEnchantment(name) {
  return typeof name === "string" && Object.hasOwn(ENCHANTMENTS, name)
    ? ENCHANTMENTS[name]
    : null;
}

/** Unknown names return zero; invalid stack metadata still rejects. */
export function enchantmentLevel(stack, name, context) {
  const data = normalizeStackData(stack.id, stack.data, context);
  return getEnchantment(name) ? (data?.enchantments?.[name] ?? 0) : 0;
}

/**
 * Pure numeric projections only; gameplay must explicitly consume them.
 * `effectiveMiningTool` enables Efficiency ONLY on an effective tool.
 * `targetFamily` may be "undead"/"arthropod" for conditional melee damage.
 * `damageType` may be "fire"/"explosion"/"projectile"/"fall" for protection.
 * Protection is an enchantment factor, NOT additional armor points; sum across
 * armor and cap at 20 in the damage owner. Power scales bow projectile damage,
 * never melee damage. Unbreaking on armor has its separate 60% wear rule.
 * No mending, loot, fire, knockback, potion, curse, or movement effects are
 * simulated or advertised here; their stored levels remain lookup-only.
 */
export function resolveItemStats(stack, options = {}) {
  const data = normalizeStackData(stack.id, stack.data, options.context);
  const item = getItem(stack.id);
  const level = (name) =>
    ENCHANTMENTS[name].eligible(item) ? (data?.enchantments?.[name] ?? 0) : 0;
  const sharpness = level("sharpness");
  const efficiency = level("efficiency");
  const power = level("power");
  const conditionalDamage =
    options.targetFamily === "undead"
      ? level("smite") * 2.5
      : options.targetFamily === "arthropod"
        ? level("bane_of_arthropods") * 2.5
        : 0;
  const specializedProtection = {
    fire: level("fire_protection") * 2,
    explosion: level("blast_protection") * 2,
    projectile: level("projectile_protection") * 2,
    fall: level("feather_falling") * 3,
  };
  return {
    damage:
      (item.damage ?? 1) +
      (sharpness ? 0.5 * sharpness + 0.5 : 0) +
      conditionalDamage,
    speed:
      (item.speed ?? 1) +
      (options.effectiveMiningTool === true && item.speed > 1 && efficiency
        ? efficiency ** 2 + 1
        : 0),
    armorPoints: item.armorPoints ?? 0,
    maxDurability: item.durability ?? null,
    durabilityUseChance: durable(item)
      ? armor(item)
        ? 0.6 + 0.4 / (level("unbreaking") + 1)
        : 1 / (level("unbreaking") + 1)
      : null,
    projectileDamageMultiplier: power ? 1 + 0.25 * (power + 1) : 1,
    protectionFactor:
      level("protection") +
      (Object.hasOwn(specializedProtection, options.damageType)
        ? specializedProtection[options.damageType]
        : 0),
  };
}
