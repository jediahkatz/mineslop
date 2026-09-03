import { BLOCK_IDS as B, ITEM_IDS as I } from "./content-ids.js";
import {
  contentIngredient as ingredient,
  contentRecipe as recipe,
  shapedContentRecipe as shaped,
} from "./recipe-content.js";
import { WOOD_FAMILIES } from "./wood-content.js";

export function woodRecipes() {
  const recipes = [
    shaped("bamboo_block", B.BAMBOO_BLOCK, 1, ["BBB", "BBB", "BBB"], {
      B: ingredient(B.BAMBOO),
    }),
    shaped(
      "bamboo_stick",
      I.STICK,
      1,
      ["B", "B"],
      {
        B: ingredient(B.BAMBOO),
      },
      "hand"
    ),
  ];
  for (const family of WOOD_FAMILIES) {
    // Oak's existing recipe names are save/recipe-book compatible. Every other
    // family gets its own output; no birch-to-oak or stem-to-oak conversion.
    if (family.key !== "oak") {
      recipes.push(
        recipe(`${family.key}_planks`, family.planks, family.plankCount, [
          ingredient(family.source),
        ])
      );
      for (const [part, count, pattern] of [
        ["slab", 6, ["PPP"]],
        ["stairs", 4, ["P  ", "PP ", "PPP"]],
        ["door", 3, ["PP", "PP", "PP"]],
        ["trapdoor", 2, ["PPP", "PPP"]],
        ["fence", 3, ["PSP", "PSP"]],
        ["fence_gate", 1, ["SPS", "SPS"]],
      ]) {
        recipes.push(
          shaped(`${family.key}_${part}`, family[part], count, pattern, {
            P: ingredient(family.planks),
            S: ingredient(I.STICK),
          })
        );
      }
    }
    if (family.vehicle !== null)
      recipes.push(
        shaped(
          `${family.key}_${family.vehicle}`,
          family.boat,
          1,
          ["P P", "PPP"],
          {
            P: ingredient(family.planks),
          }
        )
      );
  }
  return recipes;
}
