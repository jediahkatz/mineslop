import {
  activeEnchantmentLevel,
  fishingLootWeights,
  fishingWaitTicks as applyFishingLure,
} from "./enchantment-effects.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { normalizeStackData } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";

export const FISHING_ROD_DURABILITY = 64;
export const FISHING_ITEM_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "FISHING_ROD",
    name: "Fishing rod",
    kind: "tool",
    tool: "fishing_rod",
    durability: FISHING_ROD_DURABILITY,
    stackSize: 1,
    art: Object.freeze({ kind: "fishing_rod" }),
    recipe: Object.freeze({
      station: "table",
      pattern: Object.freeze(["  S", " ST", "S T"]),
      S: "STICK",
      T: "STRING",
    }),
  }),
  ...[
    ["RAW_COD", "Raw cod", "cod", 2, 0.4],
    ["RAW_SALMON", "Raw salmon", "salmon", 2, 0.4],
    ["PUFFERFISH", "Pufferfish", "pufferfish", 1, 0.2],
    ["TROPICAL_FISH", "Tropical fish", "tropical", 1, 0.2],
  ].map(([key, name, variant, food, saturation]) =>
    Object.freeze({
      key,
      name,
      kind: "food",
      food,
      saturation,
      stackSize: 64,
      art: Object.freeze({ kind: "fish", variant }),
    })
  ),
]);

/** Metadata owner registers these with eligible(item.tool === "fishing_rod"). */
export const FISHING_ENCHANTMENT_REQUIREMENTS = Object.freeze({
  lure: Object.freeze({ maxLevel: 3, tool: "fishing_rod" }),
  luck_of_the_sea: Object.freeze({ maxLevel: 3, tool: "fishing_rod" }),
});

// A useful registered subset of Java junk/treasure, not invented books/maps.
// Extra entries are opt-in and validated in full, never silently substituted.
export const DEFAULT_FISHING_TABLES = Object.freeze({
  fish: Object.freeze([
    Object.freeze({ item: "RAW_COD", weight: 60 }),
    Object.freeze({ item: "RAW_SALMON", weight: 25 }),
    Object.freeze({ item: "PUFFERFISH", weight: 13 }),
    Object.freeze({ item: "TROPICAL_FISH", weight: 2 }),
  ]),
  junk: Object.freeze([
    Object.freeze({ item: "LEATHER", weight: 10 }),
    Object.freeze({ item: "BONE", weight: 10 }),
    Object.freeze({ item: "STRING", weight: 5 }),
    Object.freeze({ item: "STICK", weight: 5 }),
    Object.freeze({
      item: "FISHING_ROD",
      weight: 2,
      remaining: Object.freeze([0.1, 0.8]),
    }),
  ]),
  treasure: Object.freeze([
    Object.freeze({
      item: "BOW",
      weight: 1,
      remaining: Object.freeze([0.5, 1]),
      data: Object.freeze({
        version: 1,
        enchantments: Object.freeze({ power: 3, unbreaking: 3 }),
      }),
    }),
    Object.freeze({
      item: "FISHING_ROD",
      weight: 1,
      remaining: Object.freeze([0.5, 1]),
      data: Object.freeze({
        version: 1,
        enchantments: Object.freeze({ lure: 2, luck_of_the_sea: 2 }),
      }),
    }),
  ]),
});

export class FishingLootError extends RangeError {
  constructor(message) {
    super(`Fishing loot: ${message}`);
    this.name = "FishingLootError";
  }
}

export const validFishingRandomState = (state) =>
  Number.isSafeInteger(state) && state >= 0 && state <= 0xffffffff;

/** Pure persisted LCG; state zero is valid and is not an absorbing state. */
export function nextFishingRandom(state) {
  if (!validFishingRandomState(state))
    throw new RangeError("Invalid fishing random state");
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return { state: next, value: next / 0x100000000 };
}

export function fishingRandomInt(state, min, max) {
  const next = nextFishingRandom(state);
  return {
    state: next.state,
    value: min + Math.floor(next.value * (max - min + 1)),
  };
}

/** One owned RNG draw. A nonpositive result requests a reroll NEXT 20Hz tick. */
export function fishingWaitTicks(state, lure = 0) {
  const next = fishingRandomInt(state, 100, 600);
  return { state: next.state, value: applyFishingLure(next.value, lure) };
}

export function fishingRodStats(stack, context) {
  const item = getItem(stack?.id);
  if (
    !isValidStack(stack, context) ||
    item?.tool !== "fishing_rod" ||
    item.durability !== FISHING_ROD_DURABILITY ||
    item.stackSize !== 1
  )
    return null;
  return {
    lure: activeEnchantmentLevel(stack, "lure", context),
    luck: activeEnchantmentLevel(stack, "luck_of_the_sea", context),
  };
}

/** The saved `luck` field is Luck of the Sea, not the separate player attribute. */
export function fishingCategoryWeights(luckOfTheSea = 0, openWater = false) {
  return fishingLootWeights(luckOfTheSea, { openWater });
}

export function compileFishingLootTables(
  tables = DEFAULT_FISHING_TABLES,
  context
) {
  if (
    !tables ||
    typeof tables !== "object" ||
    Object.keys(tables).some(
      (key) => !["fish", "junk", "treasure"].includes(key)
    )
  )
    throw new FishingLootError("invalid category table");
  const result = {};
  for (const category of ["fish", "junk", "treasure"]) {
    const entries = tables[category];
    if (!Array.isArray(entries) || !entries.length || entries.length > 64)
      throw new FishingLootError(`invalid ${category} entries`);
    result[category] = Object.freeze(
      entries.map((entry) => {
        if (
          !entry ||
          typeof entry.item !== "string" ||
          !Number.isInteger(entry.weight) ||
          entry.weight < 1 ||
          entry.weight > 10_000 ||
          Object.keys(entry).some(
            (key) => !["item", "weight", "data", "remaining"].includes(key)
          )
        )
          throw new FishingLootError(`invalid ${category} entry`);
        // These old symbolic table names mean uncooked fish, not new materials
        // or central registry aliases. Saved stacks always carry the real ID.
        const name =
          entry.item === "COD"
            ? "RAW_COD"
            : entry.item === "SALMON"
              ? "RAW_SALMON"
              : entry.item;
        const id = ITEM[name];
        const item = getItem(id);
        if (!item || item.id !== id)
          throw new FishingLootError(
            `unregistered requested item ${entry.item}`
          );
        let data;
        try {
          data = normalizeStackData(id, entry.data, context);
        } catch {
          throw new FishingLootError(`unsupported metadata for ${entry.item}`);
        }
        const range = entry.remaining ?? [1, 1];
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(
            (value) => Number.isFinite(value) && value > 0 && value <= 1
          ) ||
          range[0] > range[1] ||
          (entry.remaining !== undefined && !item.durability)
        )
          throw new FishingLootError(
            `invalid remaining durability for ${entry.item}`
          );
        const minDurability = item.durability
          ? Math.max(1, Math.floor(item.durability * range[0]))
          : undefined;
        const maxDurability = item.durability
          ? Math.max(1, Math.floor(item.durability * range[1]))
          : undefined;
        const stack = {
          id,
          count: 1,
          ...(item.durability ? { durability: maxDurability } : {}),
          ...(data === undefined ? {} : { data }),
        };
        if (!isValidStack(stack, context))
          throw new FishingLootError(`invalid stack for ${entry.item}`);
        return Object.freeze({
          item: name,
          weight: entry.weight,
          stack,
          minDurability,
          maxDurability,
        });
      })
    );
  }
  return Object.freeze(result);
}

function weighted(values, unit, weight) {
  const total = values.reduce((sum, entry) => sum + weight(entry), 0);
  let target = unit * total;
  for (const entry of values) {
    target -= weight(entry);
    if (target < 0) return entry;
  }
  return values[values.length - 1];
}

/** No inventory mutation. Publish this returned RNG progress with catch ownership. */
export function rollFishingCatch(
  randomState,
  { luck = 0, openWater = false, tables, context } = {}
) {
  if (!tables) throw new FishingLootError("compiled tables are required");
  const weights = fishingCategoryWeights(luck, openWater);
  let random = nextFishingRandom(randomState);
  const category = weighted(
    Object.keys(weights),
    random.value,
    (key) => weights[key]
  );
  random = nextFishingRandom(random.state);
  const entry = weighted(
    tables[category],
    random.value,
    (value) => value.weight
  );
  const stack = cloneStack(entry.stack, context);
  if (entry.minDurability !== undefined) {
    random = fishingRandomInt(
      random.state,
      entry.minDurability,
      entry.maxDurability
    );
    stack.durability = random.value;
  }
  const experience = fishingRandomInt(random.state, 1, 6);
  return {
    randomState: experience.state,
    category,
    item: entry.item,
    stack,
    experience: experience.value,
  };
}
