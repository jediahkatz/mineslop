import {
  freezeProgressData,
  progressArray,
  progressId,
  progressRecord,
  progressionInteger,
  progressionRandom,
} from "./progression-common.js";
import { normalizeProgressionContext } from "./progression-context.js";
import {
  missingProgressionItems,
  normalizeProgressStack,
  progressionStack,
  requireProgressionItems,
} from "./progression-items.js";

export const TRADE_OFFER_VERSION = 1;
export const MAX_TRADE_OFFERS = 12;
export const MAX_TRADE_USES = 64;
export const MAX_TRADER_XP = 2_147_483_647;
export const TRADER_LEVEL_THRESHOLDS = Object.freeze([0, 10, 70, 150, 250]);
export const TRADING_PROFESSIONS = Object.freeze([
  "farmer", "fisher", "armorer", "toolsmith", "librarian", "cleric",
]);
export const TRADING_JOBSITES = Object.freeze({
  farmer: "COMPOSTER",
  fisher: "BARREL",
  armorer: "BLAST_FURNACE",
  toolsmith: "SMITHING_TABLE",
  librarian: "LECTERN",
  cleric: "BREWING_STAND",
});

const stack = (symbol, low = 1, high = low) => ({ symbol, count: [low, high] });
const offer = (id, level, inputs, output, xp, maxUses = 12, dataChoices) => ({
  id, level, inputs, output, xp, maxUses, playerXp: 3,
  ...(dataChoices ? { dataChoices } : {}),
});
const buy = (id, level, symbol, amount, xp = 2, maxUses = 16) =>
  offer(id, level, [stack(symbol, amount)], stack("EMERALD"), xp, maxUses);
const sell = (id, level, symbol, amount, price, xp = 5, maxUses = 12, data) =>
  offer(id, level, [stack("EMERALD", ...price)], stack(symbol, amount), xp, maxUses, data);
const enchant = (enchantments) => ({ version: 1, enchantments });
const book = (id, level, price, xp, choices) => offer(
  id, level, [stack("EMERALD", ...price), stack("BOOK")],
  stack("ENCHANTED_BOOK"), xp, 8, choices.map(enchant)
);

/**
 * Finite practical roster. Standard world-independent professions: no
 * experimental biome-restricted librarian rebalance. Tables/price choices are
 * frozen at admission, including later-level offers; reopening never samples.
 */
export const TRADE_TEMPLATES = freezeProgressData({
  farmer: [
    buy("wheat", 1, "WHEAT", 20),
    sell("bread", 1, "BREAD", 6, [1, 1], 1, 16),
    buy("pumpkin", 2, "PUMPKIN", 6, 10, 12),
    buy("melon", 3, "MELON", 4, 20, 12),
    sell("apples", 4, "APPLE", 4, [1, 2], 15, 16),
    sell("golden-carrot", 5, "GOLDEN_CARROT", 3, [3, 3], 30, 12),
  ],
  fisher: [
    buy("string", 1, "STRING", 20),
    buy("raw-cod", 1, "RAW_COD", 15),
    buy("coal", 2, "COAL", 10, 10),
    offer("cook-cod", 2, [stack("EMERALD"), stack("RAW_COD", 6)],
      stack("COOKED_COD", 6), 5, 16),
    sell("bucket", 3, "BUCKET", 1, [3, 4], 10),
    sell("fishing-rod", 4, "FISHING_ROD", 1, [7, 10], 15, 8),
    sell("durable-rod", 5, "FISHING_ROD", 1, [12, 16], 30, 3,
      [enchant({ unbreaking: 3 })]),
  ],
  armorer: [
    buy("coal", 1, "COAL", 15),
    sell("boots", 1, "IRON_BOOTS", 1, [4, 6], 1),
    buy("iron", 2, "IRON_INGOT", 4, 10),
    sell("helmet", 2, "IRON_HELMET", 1, [5, 7], 5),
    sell("leggings", 3, "IRON_LEGGINGS", 1, [8, 10], 10),
    sell("chestplate", 4, "IRON_ARMOR", 1, [12, 16], 15),
    sell("protected-chestplate", 5, "IRON_ARMOR", 1, [18, 22], 30, 3,
      [enchant({ protection: 2, unbreaking: 2 })]),
  ],
  toolsmith: [
    buy("coal", 1, "COAL", 15),
    sell("stone-pickaxe", 1, "STONE_PICKAXE", 1, [1, 2], 1),
    buy("iron", 2, "IRON_INGOT", 4, 10),
    sell("iron-axe", 2, "IRON_AXE", 1, [5, 7], 5),
    sell("iron-pickaxe", 3, "IRON_PICKAXE", 1, [7, 9], 10),
    sell("diamond-pickaxe", 4, "DIAMOND_PICKAXE", 1, [18, 22], 15, 4),
    sell("efficient-pickaxe", 5, "DIAMOND_PICKAXE", 1, [24, 30], 30, 3,
      [enchant({ efficiency: 3, unbreaking: 2 })]),
  ],
  librarian: [
    buy("paper", 1, "PAPER", 24),
    book("first-book", 1, [5, 12], 1,
      [{ efficiency: 1 }, { unbreaking: 1 }, { protection: 1 }]),
    buy("books", 2, "BOOK", 4, 10),
    sell("bookshelf", 2, "BOOKSHELF", 1, [8, 10], 5),
    sell("glass", 3, "GLASS", 4, [1, 1], 10),
    book("expert-book", 4, [14, 22], 15,
      [{ efficiency: 3 }, { unbreaking: 2 }, { protection: 3 }]),
    book("master-book", 5, [24, 32], 30,
      [{ efficiency: 4 }, { unbreaking: 3 }, { protection: 4 }]),
  ],
  cleric: [
    buy("gold", 1, "GOLD_INGOT", 3),
    sell("redstone", 1, "REDSTONE", 2, [1, 1], 1, 16),
    sell("lapis", 2, "LAPIS", 2, [1, 1], 5),
    sell("glowstone", 3, "GLOWSTONE", 1, [4, 4], 10),
    sell("ender-pearl", 4, "ENDER_PEARL", 1, [5, 6], 15),
    sell("potion", 5, "POTION", 1, [8, 12], 30, 4, [
      { version: 1, potion: { id: "water_breathing", form: "drinkable" } },
      { version: 1, potion: { id: "healing", form: "drinkable" } },
      { version: 1, potion: { id: "fire_resistance", form: "drinkable" } },
    ]),
  ],
});

export function traderLevel(xp) {
  if (!Number.isSafeInteger(xp) || xp < 0 || xp > MAX_TRADER_XP)
    throw new RangeError("Invalid villager experience");
  return TRADER_LEVEL_THRESHOLDS.filter((threshold) => xp >= threshold).length;
}

export function tradeItemSymbols(profession) {
  if (typeof profession !== "string")
    throw new RangeError("Unknown trading profession");
  if (["unemployed", "nitwit"].includes(profession)) return [];
  if (!Object.hasOwn(TRADE_TEMPLATES, profession))
    throw new RangeError("Unknown trading profession");
  return [...new Set(TRADE_TEMPLATES[profession].flatMap((definition) => [
    ...definition.inputs.map(({ symbol }) => symbol),
    definition.output.symbol,
  ]))].sort();
}

export const missingTradeItems = (profession) =>
  missingProgressionItems(tradeItemSymbols(profession));

export const TRADE_ACQUISITION = freezeProgressData(Object.fromEntries(
  [...new Set(TRADING_PROFESSIONS.flatMap(tradeItemSymbols))].sort().map((symbol) => [
    symbol,
    {
      soldBy: TRADING_PROFESSIONS.filter((profession) =>
        TRADE_TEMPLATES[profession].some((definition) => definition.output.symbol === symbol)
      ),
      boughtBy: TRADING_PROFESSIONS.filter((profession) =>
        TRADE_TEMPLATES[profession].some((definition) =>
          definition.inputs.some((input) => input.symbol === symbol)
        )
      ),
    },
  ])
));

/** Required acquisition/use hooks for resources not in the original catalog. */
export const PROGRESSION_ACQUISITION_HOOKS = freezeProgressData({
  HEART_OF_THE_SEA: {
    source: "guaranteed buried_treasure chest",
    use: "real conduit recipe/mechanic; no unrelated substitute",
  },
  TREASURE_MAP: {
    source: "guaranteed shipwreck_map chest",
    use: "mapTarget navigation to a real buried-treasure descriptor",
  },
  RAW_COD: {
    source: "fishing and cod ecology drops",
    use: "fisher currency and cook-cod input; food",
  },
  COOKED_COD: {
    source: "fisher cook-cod offer; optional furnace recipe",
    use: "food",
  },
  FISHING_ROD: {
    source: "expert/master fisher offers; stick/string crafting hook",
    use: "fishing interaction and durable-item wear",
  },
  GOLDEN_CARROT: {
    source: "master farmer offer",
    use: "food",
  },
  ENCHANTED_BOOK: {
    source: "novice/expert/master librarian offers",
    use: "anvil transfer of registered enchantment metadata",
  },
  POTION: {
    source: "master cleric offer",
    use: "drink registered healing/fire-resistance/water-breathing effects",
  },
});

export function normalizeTradeOffer(value, context) {
  progressRecord(value, [
    "id", "level", "inputs", "output", "maxUses", "uses", "xp", "playerXp",
  ]);
  progressId(value.id, 96);
  const inputs = progressArray(value.inputs, 2)
    .map((input) => normalizeProgressStack(input, context));
  if (
    inputs.length < 1 ||
    !Number.isInteger(value.level) || value.level < 1 || value.level > 5 ||
    !Number.isInteger(value.maxUses) || value.maxUses < 1 || value.maxUses > MAX_TRADE_USES ||
    !Number.isInteger(value.uses) || value.uses < 0 || value.uses > value.maxUses ||
    !Number.isInteger(value.xp) || value.xp < 1 || value.xp > 30 ||
    !Number.isInteger(value.playerXp) || value.playerXp < 0 || value.playerXp > 16
  )
    throw new RangeError("Invalid persistent offer price, stock or experience");
  return {
    id: value.id, level: value.level, inputs,
    output: normalizeProgressStack(value.output, context),
    maxUses: value.maxUses, uses: value.uses,
    xp: value.xp, playerXp: value.playerXp,
  };
}

/** All choices are keyed by NPC + profession + offer identity, not list position. */
export function generateTraderOffers(npcId, profession, context) {
  context = normalizeProgressionContext(context);
  progressId(npcId);
  const symbols = tradeItemSymbols(profession);
  requireProgressionItems(symbols);
  if (!TRADING_PROFESSIONS.includes(profession)) return [];
  return TRADE_TEMPLATES[profession].map((definition) => {
    const random = progressionRandom(JSON.stringify([
      "trades", TRADE_OFFER_VERSION, context.seed, context.generatorVersion,
      npcId, profession, definition.id,
    ]));
    const resolve = ({ symbol, count }, data) => progressionStack(
      symbol, progressionInteger(random, ...count), context, data
    );
    const inputs = definition.inputs.map((input) => resolve(input));
    const data = definition.dataChoices?.[
      progressionInteger(random, 0, definition.dataChoices.length - 1)
    ];
    return normalizeTradeOffer({
      id: `${profession}/${definition.id}`,
      level: definition.level,
      inputs,
      output: resolve(definition.output, data),
      maxUses: definition.maxUses,
      uses: 0,
      xp: definition.xp,
      playerXp: definition.playerXp,
    }, context);
  });
}
