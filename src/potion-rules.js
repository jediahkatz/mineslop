import { normalizePotionData } from "./item-stack-data.js";

/**
 * Java 26.2 subset, not the complete metadata registry. No item IDs live here.
 * Sources: https://minecraft.wiki/w/Brewing (oldid=3750437),
 * https://minecraft.wiki/w/Potion, /w/Poison and /w/Regeneration.
 * Durations are game ticks, including Poison II's 432 and Regeneration II's 450.
 */
const timed = (effect, base, extended, strong, strongAmplifier = 1) =>
  Object.freeze({ effect, base, extended, strong, strongAmplifier });
const instant = (effect) => Object.freeze({ effect, instant: true });

export const POTION_DRINK_SECONDS = 1.6; // 32 Java game ticks.

export const BREWABLE_POTIONS = Object.freeze({
  water: Object.freeze({}),
  awkward: Object.freeze({}),
  mundane: Object.freeze({}),
  thick: Object.freeze({}),
  water_breathing: timed("water_breathing", 3600, 9600),
  night_vision: timed("night_vision", 3600, 9600),
  fire_resistance: timed("fire_resistance", 3600, 9600),
  swiftness: timed("speed", 3600, 9600, 1800),
  strength: timed("strength", 3600, 9600, 1800),
  healing: instant("instant_health"),
  regeneration: timed("regeneration", 900, 1800, 450),
  poison: timed("poison", 900, 1800, 432),
  weakness: timed("weakness", 1800, 4800),
  slowness: timed("slowness", 1800, 4800, 400, 3),
  harming: instant("instant_damage"),
});

export const BREWING_INGREDIENTS = Object.freeze({
  NETHER_WART: "nether_wart",
  BLAZE_POWDER: "blaze_powder",
  GOLDEN_CARROT: "golden_carrot",
  GLISTERING_MELON_SLICE: "glistering_melon_slice",
  PUFFERFISH: "pufferfish",
  SUGAR: "sugar",
  SPIDER_EYE: "spider_eye",
  FERMENTED_SPIDER_EYE: "fermented_spider_eye",
  GHAST_TEAR: "ghast_tear",
  MAGMA_CREAM: "magma_cream",
  REDSTONE: "redstone",
  GLOWSTONE_DUST: "glowstone_dust",
  GUNPOWDER: "gunpowder",
});

const awkwardIngredients = Object.freeze({
  pufferfish: "water_breathing",
  golden_carrot: "night_vision",
  magma_cream: "fire_resistance",
  sugar: "swiftness",
  blaze_powder: "strength",
  glistering_melon_slice: "healing",
  ghast_tear: "regeneration",
  spider_eye: "poison",
});
const mundaneIngredients = new Set([
  "redstone",
  "sugar",
  "blaze_powder",
  "glistering_melon_slice",
  "ghast_tear",
  "spider_eye",
  "magma_cream",
]);

/** Unsupported effects/forms are retained by stack metadata, not activated here. */
export function normalizeSupportedPotion(value) {
  const potion = normalizePotionData(value);
  if (
    !Object.hasOwn(BREWABLE_POTIONS, potion.id) ||
    potion.form === "lingering"
  )
    throw new RangeError("Unsupported brewing potion");
  return potion;
}

/** No mutation; null means no recipe and MUST NOT charge ingredient or fuel. */
export function brewPotionData(value, ingredient) {
  if (typeof ingredient !== "string") return null;
  let potion;
  try {
    potion = normalizeSupportedPotion(value);
  } catch {
    return null;
  }
  const result = (id, flags = {}) =>
    normalizePotionData({ id, form: potion.form, ...flags });
  if (ingredient === "gunpowder")
    return potion.form === "drinkable" ? { ...potion, form: "splash" } : null;
  if (potion.id === "water") {
    if (ingredient === "nether_wart") return result("awkward");
    if (ingredient === "glowstone_dust") return result("thick");
    if (ingredient === "fermented_spider_eye") return result("weakness");
    if (mundaneIngredients.has(ingredient)) return result("mundane");
    return null;
  }
  if (potion.id === "awkward" && Object.hasOwn(awkwardIngredients, ingredient))
    return result(awkwardIngredients[ingredient]);
  const definition = BREWABLE_POTIONS[potion.id];
  if (ingredient === "redstone")
    return !potion.extended && !potion.strong && definition.extended
      ? result(potion.id, { extended: true })
      : null;
  if (ingredient === "glowstone_dust")
    return !potion.extended &&
      !potion.strong &&
      (definition.strong || definition.instant)
      ? result(potion.id, { strong: true })
      : null;
  if (ingredient === "fermented_spider_eye") {
    if (potion.id === "swiftness" && !potion.strong)
      return result("slowness", { extended: potion.extended });
    if (potion.id === "healing" || potion.id === "poison")
      return result("harming", { strong: potion.strong });
  }
  // No Strength -> Weakness, mundane/thick -> Weakness, or strong Speed
  // corruption (Bedrock/removed recipes). Invisibility is not implemented.
  return null;
}

export function potionEffect(value) {
  const potion = normalizeSupportedPotion(value);
  const definition = BREWABLE_POTIONS[potion.id];
  if (!definition.effect) return null;
  return {
    id: definition.effect,
    amplifier: potion.strong ? (definition.strongAmplifier ?? 1) : 0,
    durationTicks: definition.instant
      ? 0
      : potion.extended
        ? definition.extended
        : potion.strong
          ? definition.strong
          : definition.base,
  };
}

/**
 * Lead registration/acquisition contract, not installed recipes or a second
 * catalog. Every ingredient item needs the indicated brewingIngredient value;
 * blaze powder ALSO needs brewingFuelOperations:20. Ordinary IDs stay symbolic.
 */
export const BREWING_CONTENT_REQUIREMENTS = Object.freeze({
  stand: Object.freeze({
    symbol: "BREWING_STAND",
    station: "brewing",
    inventoryOwner: "ProgressionStations",
  }),
  bottles: Object.freeze([
    Object.freeze({ symbol: "GLASS_BOTTLE", emptyBottle: true, stackSize: 64 }),
    Object.freeze({ symbol: "POTION", potionForm: "drinkable", stackSize: 1 }),
    Object.freeze({
      symbol: "SPLASH_POTION",
      potionForm: "splash",
      stackSize: 1,
    }),
  ]),
  ingredients: BREWING_INGREDIENTS,
  fuel: Object.freeze({ symbol: "BLAZE_POWDER", brewingFuelOperations: 20 }),
  use: Object.freeze({
    drinkable: Object.freeze({
      seconds: POTION_DRINK_SECONDS,
      alwaysConsumable: true,
      survivalRemainder: "GLASS_BOTTLE",
    }),
    splash: Object.freeze({ projectile: true, survivalRemainder: null }),
  }),
  acquisition: Object.freeze({
    water:
      "Fill GLASS_BOTTLE at a loaded source-water cell; never spend water.",
    BLAZE_ROD:
      "Obtainable Nether blaze drop; fuels both stand crafting and powder.",
    NETHER_WART: "Obtainable Nether wart harvest; renewable wart on soul sand.",
    GHAST_TEAR: "Obtainable Nether ghast drop.",
    MAGMA_CREAM: "Magma cube drop or SLIME_BALL + BLAZE_POWDER.",
    PUFFERFISH: "Pufferfish catch/drop; not a generic raw-fish substitution.",
    SPIDER_EYE: "Spider drop.",
    GLOWSTONE_DUST: "Glowstone harvest; not the GLOWSTONE block item.",
    CARROT: "Carrot crop/loot for GOLDEN_CARROT.",
    MELON_SLICE: "Melon harvest for GLISTERING_MELON_SLICE.",
    REDSTONE: "Existing redstone ore drops.",
    GUNPOWDER: "Existing creeper drops.",
    BROWN_MUSHROOM: "Existing brown mushroom harvest.",
    SUGAR_CANE: "Existing sugar cane harvest.",
    GOLD_NUGGET: "Existing nuggets or GOLD_INGOT -> 9 nuggets.",
    GLASS: "Existing glass smelting.",
  }),
});

/** Shaped keys name symbols; repeated characters are individual input costs. */
export const BREWING_CRAFTING_REQUIREMENTS = Object.freeze([
  Object.freeze({
    id: "brewing_stand",
    output: "BREWING_STAND",
    count: 1,
    station: "table",
    pattern: Object.freeze([" R ", "CCC"]),
    key: Object.freeze({
      R: "BLAZE_ROD",
      C: Object.freeze(["COBBLESTONE", "BLACKSTONE", "COBBLED_DEEPSLATE"]),
    }),
  }),
  Object.freeze({
    id: "glass_bottles",
    output: "GLASS_BOTTLE",
    count: 3,
    station: "table",
    pattern: Object.freeze(["G G", " G "]),
    key: Object.freeze({ G: "GLASS" }),
  }),
  Object.freeze({
    id: "blaze_powder",
    output: "BLAZE_POWDER",
    count: 2,
    ingredients: Object.freeze(["BLAZE_ROD"]),
  }),
  Object.freeze({
    id: "sugar",
    output: "SUGAR",
    count: 1,
    ingredients: Object.freeze(["SUGAR_CANE"]),
  }),
  Object.freeze({
    id: "fermented_spider_eye",
    output: "FERMENTED_SPIDER_EYE",
    count: 1,
    ingredients: Object.freeze(["SPIDER_EYE", "SUGAR", "BROWN_MUSHROOM"]),
  }),
  Object.freeze({
    id: "magma_cream",
    output: "MAGMA_CREAM",
    count: 1,
    ingredients: Object.freeze(["SLIME_BALL", "BLAZE_POWDER"]),
  }),
  ...[
    ["golden_carrot", "GOLDEN_CARROT", "CARROT"],
    ["glistering_melon_slice", "GLISTERING_MELON_SLICE", "MELON_SLICE"],
  ].map(([id, output, center]) =>
    Object.freeze({
      id,
      output,
      count: 1,
      station: "table",
      pattern: Object.freeze(["NNN", "NCN", "NNN"]),
      key: Object.freeze({ N: "GOLD_NUGGET", C: center }),
    })
  ),
]);
