import { ITEM_IDS as I } from "./content-ids.js";
import { WOOD_FAMILIES } from "./wood-content.js";

// These are adapter vocabulary mappings, NOT numeric aliases in ITEM. A caller
// may keep the older fishing domain's names without introducing duplicate IDs.
export const FISHING_SYMBOL_BINDINGS = Object.freeze({
  COD: "RAW_COD",
  SALMON: "RAW_SALMON",
});

// Append to the domain's treasure table at composition, then compile normally.
// This is a finite authored subset, not exact Java weights/enchantment sampling.
export const FISHING_TREASURE_ADDITIONS = Object.freeze([
  Object.freeze({ item: "SADDLE", weight: 1 }),
  Object.freeze({ item: "NAUTILUS_SHELL", weight: 1 }),
  Object.freeze({
    item: "ENCHANTED_BOOK",
    weight: 1,
    data: Object.freeze({
      version: 1,
      enchantments: Object.freeze({ mending: 1 }),
    }),
  }),
]);

/** Pass the result as Fishing's lootTables option; the domain validates it. */
export function bindFishingLootSymbols(tables) {
  if (
    !tables ||
    typeof tables !== "object" ||
    Array.isArray(tables) ||
    Object.keys(tables).some(
      (key) => !["fish", "junk", "treasure"].includes(key)
    )
  )
    throw new RangeError("Invalid fishing content tables");
  return Object.freeze(
    Object.fromEntries(
      ["fish", "junk", "treasure"].map((category) => {
        if (!Array.isArray(tables[category]))
          throw new RangeError(`Missing fishing content category: ${category}`);
        return [
          category,
          Object.freeze(
            tables[category].map((entry) => {
              if (!entry || typeof entry.item !== "string")
                throw new RangeError("Missing fishing content symbol");
              return Object.freeze({
                ...entry,
                item: Object.hasOwn(FISHING_SYMBOL_BINDINGS, entry.item)
                  ? FISHING_SYMBOL_BINDINGS[entry.item]
                  : entry.item,
              });
            })
          ),
        ];
      })
    )
  );
}

/** In particular oak resolves to legacy PLANKS, never an OAK_PLANKS alias. */
export const BOAT_RECIPE_PLANKS = Object.freeze(
  Object.fromEntries(
    WOOD_FAMILIES.filter(({ vehicle }) => vehicle !== null).map(
      ({ key, planks }) => [key, planks]
    )
  )
);

export const ENCHANTING_RESOURCES = Object.freeze({
  lapis: I.LAPIS,
  enchantedBook: I.ENCHANTED_BOOK,
});

/**
 * Every hook names its real resource and owning mechanic. This matrix records
 * composition work still required; it does not register drops or effects.
 */
export const CONTENT_ACQUISITION_HOOKS = Object.freeze(
  Object.fromEntries(
    [
      [
        "SADDLE",
        "three leather and one iron ingot / fishing treasure",
        "horse saddle ownership and riding",
      ],
      [
        "RAW_COD",
        "cod drops / fishing",
        "food, dolphin feeding and fisher trading",
      ],
      ["RAW_SALMON", "salmon fishing", "food and dolphin feeding"],
      ["TROPICAL_FISH", "tropical-fish fishing", "food"],
      [
        "PUFFERFISH",
        "pufferfish fishing",
        "brewing; poisonous consumptionEffects",
      ],
      ["INK_SAC", "squid drops", "black dye and dark prismarine"],
      [
        "SCUTE",
        "one baby-turtle adulthood reward, never a death drop",
        "turtle shell crafting and repair",
      ],
      [
        "NAUTILUS_SHELL",
        "fishing treasure / shell-carrying drowned",
        "conduit recipe",
      ],
      [
        "HEART_OF_THE_SEA",
        "guaranteed buried_treasure chest",
        "conduit recipe",
      ],
      [
        "TREASURE_MAP",
        "shipwreck_map / ocean-ruin map loot",
        "navigation using mapTarget, not invented coordinates",
      ],
      [
        "NETHERITE_UPGRADE_TEMPLATE",
        "guaranteed bastion_treasure chest",
        "smithing; duplication consumes diamonds and netherrack",
      ],
      [
        "ENCHANTED_BOOK",
        "enchanting a BOOK / librarian trades / fishing treasure",
        "anvil transfer; empty carrier is not a free enchantment",
      ],
      [
        "BLAZE_ROD",
        "player-credited blaze death",
        "stand crafting, blaze powder and furnace fuel",
      ],
      ["GHAST_TEAR", "ghast drops", "regeneration brewing"],
      [
        "SPIDER_EYE",
        "player-credited spider death",
        "poison brewing and fermented spider eye",
      ],
      [
        "GLOWSTONE_DUST",
        "GLOWSTONE harvest (2–4, Silk Touch keeps block)",
        "brewing and glowstone crafting",
      ],
      [
        "CARROT",
        "finite novice farmer offer (1 emerald for 2), then mature CARROT_CROP",
        "renewable farming and golden carrots",
      ],
      [
        "MELON_SLICE",
        "MELON harvest (3–7, Silk Touch keeps block)",
        "food and glistering melon",
      ],
      [
        "ROTTEN_FLESH",
        "drowned/zombie drops",
        "food with probabilistic consumptionEffects",
      ],
      [
        "POTION",
        "fill GLASS_BOTTLE at a loaded source; brewing or cleric trade",
        "metadata-driven drink and GLASS_BOTTLE remainder",
      ],
      [
        "SPLASH_POTION",
        "brew a drinkable potion with gunpowder",
        "metadata-driven projectile splash",
      ],
    ].map(([symbol, source, use]) => [
      symbol,
      Object.freeze({ source, use, runtimeBindingRequired: true }),
    ])
  )
);
