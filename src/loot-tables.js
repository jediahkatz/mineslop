import {
  memberIdentity,
  normalizeExplorationMarker,
  normalizeTreasureMapTarget,
} from "./exploration-markers.js";
import {
  freezeProgressData,
  MAX_STRUCTURE_MEMBER_ID_LENGTH,
  normalizeProgressContext,
  progressArray,
  progressRecord,
  progressionInteger,
  progressionRandom,
} from "./progression-common.js";
import {
  missingProgressionItems,
  progressionStack,
  requireProgressionItems,
} from "./progression-items.js";

export const LOOT_TABLE_VERSION = 1;
export const MAX_LOOT_STACKS = 27;
export const MAX_LOOT_IDENTITY_LENGTH = MAX_STRUCTURE_MEMBER_ID_LENGTH + 512;
const entry = (symbol, weight, min, max = min, metadata) => ({
  symbol,
  weight,
  min,
  max,
  ...(metadata ? { metadata } : {}),
});
const table = (dimension, rolls, entries, guaranteed = []) => ({
  dimension,
  rolls,
  entries,
  guaranteed,
});

/**
 * Original finite, useful loot selections, not a claim of exact Java weight parity.
 * No monument chest tables: its eight gold blocks, sponge rooms and three elders
 * belong to generated structure/encounter content.
 */
export const LOOT_TABLES = freezeProgressData({
  shipwreck_supply: table(
    "overworld",
    [4, 7],
    [
      entry("BREAD", 8, 2, 5),
      entry("WHEAT", 8, 8, 16),
      entry("COAL", 6, 2, 8),
      entry("LEATHER", 3, 1, 3),
      entry("STRING", 4, 2, 6),
    ]
  ),
  shipwreck_treasure: table(
    "overworld",
    [3, 6],
    [
      entry("IRON_INGOT", 10, 2, 6),
      entry("GOLD_INGOT", 5, 1, 4),
      entry("GOLD_NUGGET", 8, 4, 12),
      entry("EMERALD", 3, 1, 3),
      entry("DIAMOND", 1, 1),
    ]
  ),
  shipwreck_map: table(
    "overworld",
    [2, 4],
    [
      entry("PAPER", 10, 3, 10),
      entry("BOOK", 3, 1, 3),
      entry("FEATHER", 4, 1, 5),
    ],
    [entry("TREASURE_MAP", 1, 1, 1, "treasure_map")]
  ),
  ocean_ruin_warm: table(
    "overworld",
    [2, 5],
    [
      entry("GOLD_NUGGET", 8, 2, 8),
      entry("WHEAT", 8, 2, 8),
      entry("COAL", 6, 1, 4),
      entry("EMERALD", 1, 1),
      entry("TREASURE_MAP", 1, 1, 1, "treasure_map"),
    ]
  ),
  ocean_ruin_cold: table(
    "overworld",
    [2, 5],
    [
      entry("COAL", 8, 2, 6),
      entry("WHEAT", 8, 2, 8),
      entry("IRON_INGOT", 3, 1, 3),
      entry("STONE_AXE", 1, 1),
      entry("TREASURE_MAP", 1, 1, 1, "treasure_map"),
    ]
  ),
  ocean_ruin_annex: table(
    "overworld",
    [2, 4],
    [
      entry("COAL", 8, 1, 4),
      entry("WHEAT", 8, 2, 6),
      entry("IRON_INGOT", 3, 1, 2),
      entry("STRING", 3, 1, 4),
    ]
  ),
  buried_treasure: table(
    "overworld",
    [4, 7],
    [
      entry("IRON_INGOT", 10, 3, 8),
      entry("GOLD_INGOT", 6, 2, 6),
      entry("EMERALD", 4, 2, 5),
      entry("DIAMOND", 2, 1, 2),
    ],
    [entry("HEART_OF_THE_SEA", 1, 1)]
  ),
  village_house: table(
    "overworld",
    [3, 5],
    [
      entry("BREAD", 10, 1, 4),
      entry("APPLE", 7, 1, 4),
      entry("PAPER", 3, 1, 5),
      entry("BOOK", 2, 1),
    ]
  ),
  village_farm: table(
    "overworld",
    [3, 6],
    [
      entry("WHEAT", 10, 4, 12),
      entry("SEEDS", 8, 3, 8),
      entry("BREAD", 6, 1, 4),
      entry("PUMPKIN", 2, 1, 3),
    ]
  ),
  village_smith: table(
    "overworld",
    [3, 5],
    [
      entry("IRON_INGOT", 10, 2, 6),
      entry("IRON_PICKAXE", 2, 1),
      entry("IRON_SWORD", 2, 1),
      entry("IRON_ARMOR", 1, 1),
      entry("OBSIDIAN", 4, 2, 4),
    ]
  ),
  nether_fortress: table(
    "nether",
    [3, 6],
    [
      entry("IRON_INGOT", 8, 1, 5),
      entry("GOLD_INGOT", 8, 1, 4),
      entry("DIAMOND", 2, 1, 2),
      entry("FLINT_AND_STEEL", 3, 1),
      entry("OBSIDIAN", 3, 2, 4),
      entry("IRON_SWORD", 2, 1),
    ]
  ),
  bastion_bridge: table(
    "nether",
    [3, 6],
    [
      entry("GOLD_NUGGET", 10, 8, 24),
      entry("GOLD_INGOT", 6, 2, 5),
      entry("IRON_INGOT", 6, 2, 6),
      entry("STRING", 4, 3, 8),
      entry("LEATHER", 4, 2, 5),
    ]
  ),
  bastion_treasure: table(
    "nether",
    [4, 7],
    [
      entry("GOLD_INGOT", 10, 4, 10),
      entry("DIAMOND", 3, 1, 3),
      entry("IRON_ARMOR", 2, 1),
      entry("IRON_SWORD", 2, 1),
      entry("OBSIDIAN", 5, 3, 8),
      entry("ARROW", 6, 8, 24),
    ],
    [entry("NETHERITE_UPGRADE_TEMPLATE", 1, 1)]
  ),
  bastion_armory: table(
    "nether",
    [3, 5],
    [
      entry("IRON_SWORD", 3, 1),
      entry("IRON_ARMOR", 2, 1),
      entry("IRON_INGOT", 6, 2, 5),
      entry("GOLD_INGOT", 6, 2, 4),
      entry("ARROW", 8, 8, 20),
    ]
  ),
  dungeon_cache: table(
    "overworld",
    [3, 6],
    [
      entry("IRON_INGOT", 6, 1, 4),
      entry("COAL", 8, 2, 6),
      entry("STRING", 8, 2, 6),
      entry("BREAD", 6, 1, 3),
      entry("GUNPOWDER", 4, 1, 4),
    ]
  ),
});

export function getLootTable(role) {
  return typeof role === "string" && Object.hasOwn(LOOT_TABLES, role)
    ? LOOT_TABLES[role]
    : null;
}

/** Both guaranteed charts and weighted ruin maps need an explicit lookup result. */
export function lootNeedsMap(role) {
  const definition = getLootTable(role);
  if (!definition) throw new RangeError("Unknown loot role");
  return [...definition.entries, ...definition.guaranteed].some(
    ({ metadata }) => metadata === "treasure_map"
  );
}

export function lootItemSymbols(role) {
  const definition = getLootTable(role);
  if (!definition) throw new RangeError("Unknown loot role");
  return [
    ...new Set([
      ...definition.entries.map(({ symbol }) => symbol),
      ...definition.guaranteed.map(({ symbol }) => symbol),
    ]),
  ].sort();
}

export const missingLootItems = (role) =>
  missingProgressionItems(lootItemSymbols(role));

/** Machine-readable acquisition matrix, including guaranteed resources. */
export const LOOT_ACQUISITION = freezeProgressData(
  Object.fromEntries(
    [...new Set(Object.keys(LOOT_TABLES).flatMap(lootItemSymbols))]
      .sort()
      .map((symbol) => [
        symbol,
        {
          tables: Object.keys(LOOT_TABLES).filter((role) =>
            lootItemSymbols(role).includes(symbol)
          ),
          guaranteed: Object.keys(LOOT_TABLES).filter((role) =>
            LOOT_TABLES[role].guaranteed.some((item) => item.symbol === symbol)
          ),
        },
      ])
  )
);

function normalizeEntry(value) {
  progressRecord(value, ["symbol", "weight", "min", "max", "metadata"]);
  if (
    typeof value.symbol !== "string" ||
    value.symbol.length > 64 ||
    !/^[A-Z][A-Z0-9_]*$/.test(value.symbol) ||
    !Number.isInteger(value.weight) ||
    value.weight < 1 ||
    value.weight > 1000 ||
    !Number.isInteger(value.min) ||
    value.min < 1 ||
    !Number.isInteger(value.max) ||
    value.max < value.min ||
    value.max > 64 ||
    (value.metadata !== undefined &&
      (value.metadata !== "treasure_map" || value.symbol !== "TREASURE_MAP"))
  )
    throw new RangeError("Invalid loot table entry");
  return { ...value };
}

/**
 * Pure bounded roller also usable with an authored empty-table fixture. Unknown
 * resources reject the entire table BEFORE selection, never disappear or change
 * into a different resource. These detached stacks do not own any inventory.
 * mapTarget:null explicitly means a bounded lookup found no target. Map rolls
 * then produce no item (and are not rerolled/replaced); undefined is an error.
 * Even that absence requires ALL declared item capabilities to be registered.
 */
export function rollLootTable(
  definition,
  identity,
  context,
  { mapTarget } = {}
) {
  context = normalizeProgressContext(context);
  progressRecord(definition, ["dimension", "rolls", "entries", "guaranteed"]);
  progressArray(definition.rolls, 2);
  const [low, high] = definition.rolls;
  if (
    !["overworld", "nether"].includes(definition.dimension) ||
    typeof identity !== "string" ||
    identity.length > MAX_LOOT_IDENTITY_LENGTH ||
    definition.rolls.length !== 2 ||
    !Number.isInteger(low) ||
    !Number.isInteger(high) ||
    low < 0 ||
    high < low ||
    high > MAX_LOOT_STACKS
  )
    throw new RangeError("Invalid loot table");
  const entries = progressArray(definition.entries, 32).map(normalizeEntry);
  const guaranteed = progressArray(definition.guaranteed, 8).map(
    normalizeEntry
  );
  if (
    high + guaranteed.length > MAX_LOOT_STACKS ||
    (high > 0 && !entries.length)
  )
    throw new RangeError("Loot table exceeds container bounds");
  const all = [...entries, ...guaranteed];
  requireProgressionItems(all.map(({ symbol }) => symbol));
  const needsMap = all.some(({ metadata }) => metadata === "treasure_map");
  const target = needsMap
    ? mapTarget === null
      ? null
      : normalizeTreasureMapTarget(mapTarget, context)
    : undefined;
  if (
    (needsMap && definition.dimension !== "overworld") ||
    (!needsMap && mapTarget !== undefined)
  )
    throw new RangeError("Unexpected treasure map destination");
  const random = progressionRandom(
    JSON.stringify([LOOT_TABLE_VERSION, identity])
  );
  const toStack = (item) => {
    const count = progressionInteger(random, item.min, item.max);
    if (item.metadata && target === null) return null;
    return progressionStack(
      item.symbol,
      count,
      context,
      item.metadata ? { version: 1, mapTarget: target } : undefined
    );
  };
  const stacks = guaranteed.map(toStack).filter((stack) => stack !== null);
  const rolls = progressionInteger(random, low, high);
  const weight = entries.reduce((sum, item) => sum + item.weight, 0);
  for (let i = 0; i < rolls; i++) {
    let ticket = progressionInteger(random, 1, weight);
    const selected = entries.find((item) => (ticket -= item.weight) <= 0);
    const stack = toStack(selected);
    if (stack !== null) stacks.push(stack);
  }
  return stacks;
}

export function rollStructureLoot(value, context, options) {
  const marker = normalizeExplorationMarker(value, context);
  const definition = getLootTable(marker.role);
  if (
    marker.type !== "container" ||
    !definition ||
    marker.dimension !== definition.dimension
  )
    throw new RangeError("No chest loot table for this structure member");
  return rollLootTable(
    definition,
    JSON.stringify([memberIdentity(marker, context), marker.role]),
    context,
    options
  );
}
