import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  consumeCraftingInputs,
  matchCraftingRecipe,
  recipeLayout,
  recipeOutput,
} from "../src/crafting.js";
import { armorItemId, toolItemId } from "../src/gear-content.js";
import { ARMOR_MATERIALS, TOOL_KINDS, TOOL_MATERIALS } from "../src/gear.js";
import { isValidStack, normalizeStack } from "../src/inventory-slots.js";
import { FUEL_ITEMS, getItem, ITEM } from "../src/items.js";
import { BREWING_CRAFTING_REQUIREMENTS } from "../src/potion-rules.js";
import { getRecipe, RECIPES, SMITHING_RECIPES } from "../src/recipes.js";
import {
  CHARCOAL_LOG_ITEMS,
  PLANK_ITEMS,
  WOOD_FAMILIES,
  WOOD_SLAB_ITEMS,
} from "../src/wood-content.js";

const stack = (id, count = 1) =>
  normalizeStack({
    id,
    count,
    ...(getItem(id)?.durability ? { durability: getItem(id).durability } : {}),
  });
const sortedCosts = (inputs) => {
  const totals = new Map();
  for (const { id, count } of inputs)
    totals.set(id, (totals.get(id) ?? 0) + count);
  return [...totals].sort(([a], [b]) => a - b);
};
const gridFor = (recipe, size, choose = (input) => input.id) => {
  const layout = recipeLayout(recipe, size);
  assert.ok(layout, `${recipe.id} must fit its declared station`);
  const grid = Array(9).fill(null);
  for (const { index, ingredient } of layout)
    grid[index] = stack(choose(ingredient, index));
  return grid;
};
const requireRecipe = (id) => {
  const recipe = getRecipe(id);
  assert.ok(recipe, `Missing real recipe ${id}`);
  return recipe;
};

test("all real recipes have valid immutable inputs, outputs and exact pattern accounting", () => {
  assert.equal(new Set(RECIPES.map(({ id }) => id)).size, RECIPES.length);
  for (const recipe of RECIPES) {
    assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.output));
    assert.ok(Object.isFrozen(recipe.ingredients));
    assert.ok(isValidStack(recipeOutput(recipe)), recipe.id);
    assert.ok(recipe.ingredients.length > 0);
    assert.ok(["hand", "table", "furnace"].includes(recipe.station), recipe.id);
    assert.equal(recipe.duration > 0, recipe.station === "furnace");
    for (const input of recipe.ingredients) {
      assert.ok(Object.isFrozen(input));
      assert.ok(Number.isSafeInteger(input.count) && input.count > 0);
      const ids = [input.id, ...(input.alternatives ?? [])];
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids)
        assert.ok(getItem(id), `${recipe.id} ingredient ${id}`);
      if (input.alternatives) assert.ok(Object.isFrozen(input.alternatives));
    }
    if (recipe.duration) {
      assert.equal(recipe.ingredients.length, 1, recipe.id);
      assert.equal(recipe.ingredients[0].count, 1, recipe.id);
      continue;
    }
    const size = recipe.station === "hand" ? 2 : 3;
    const layout = recipeLayout(recipe, size);
    assert.ok(layout, recipe.id);
    assert.deepEqual(
      sortedCosts(
        layout.map(({ ingredient }) => ({ id: ingredient.id, count: 1 }))
      ),
      sortedCosts(recipe.ingredients),
      `${recipe.id}: cells and costs must not disagree`
    );
    if (recipe.pattern) {
      assert.ok(Object.isFrozen(recipe.pattern) && Object.isFrozen(recipe.key));
      assert.ok(
        recipe.pattern.every((row) => row.length === recipe.pattern[0].length)
      );
      const used = [
        ...new Set(recipe.pattern.join("").replaceAll(" ", "")),
      ].sort();
      assert.deepEqual(Object.keys(recipe.key).sort(), used);
      for (const input of Object.values(recipe.key)) {
        assert.ok(Object.isFrozen(input));
        assert.equal(input.count, 1);
      }
    } else assert.equal(recipe.shapeless, true, recipe.id);
    const grid = gridFor(recipe, size);
    const before = structuredClone(grid);
    const match = matchCraftingRecipe(grid, size);
    assert.equal(
      match?.recipe.id,
      recipe.id,
      `${recipe.id}: no collision with another real recipe`
    );
    assert.deepEqual(match.output, recipeOutput(recipe));
    assert.deepEqual(grid, before, "A preview must not consume its inputs");
    consumeCraftingInputs(grid, match);
    assert.ok(
      grid.every((value) => value === null),
      recipe.id
    );
  }
});

test("each wood source produces only its own planks and every family construction has the exact yield", () => {
  const parts = [
    ["slab", 3, 0, 6],
    ["stairs", 6, 0, 4],
    ["door", 6, 0, 3],
    ["trapdoor", 6, 0, 2],
    ["fence", 4, 2, 3],
    ["fence_gate", 2, 4, 1],
  ];
  assert.equal(WOOD_FAMILIES.length, 12);
  for (const family of WOOD_FAMILIES) {
    const plankRecipe = requireRecipe(
      family.key === "oak" ? "planks" : `${family.key}_planks`
    );
    assert.deepEqual(plankRecipe.output, {
      id: family.planks,
      count: family.key === "bamboo" ? 2 : 4,
    });
    assert.deepEqual(plankRecipe.ingredients, [
      { id: family.source, count: 1 },
    ]);
    assert.equal(plankRecipe.station, "hand");
    const source = Array(9).fill(null);
    source[3] = stack(family.source, 2);
    const match = matchCraftingRecipe(source, 2);
    assert.equal(match?.recipe.id, plankRecipe.id, family.key);
    consumeCraftingInputs(source, match);
    assert.deepEqual(source[3], stack(family.source), family.key);
    for (const [part, plankCount, stickCount, yieldCount] of parts) {
      const recipe = requireRecipe(`${family.key}_${part}`);
      assert.deepEqual(recipe.output, { id: family[part], count: yieldCount });
      assert.equal(recipe.station, "table");
      assert.deepEqual(
        sortedCosts(recipe.ingredients),
        sortedCosts([
          { id: family.planks, count: plankCount },
          ...(stickCount ? [{ id: ITEM.STICK, count: stickCount }] : []),
        ]),
        `${family.key}_${part}`
      );
      assert.ok(
        recipe.ingredients.every((input) => !input.alternatives?.length)
      );
      const other = WOOD_FAMILIES.find(({ key }) => key !== family.key);
      const mixed = gridFor(recipe, 3);
      mixed[mixed.findIndex((entry) => entry?.id === family.planks)] = stack(
        other.planks
      );
      assert.equal(
        matchCraftingRecipe(mixed, 3),
        null,
        `${recipe.id} rejects mixed-family construction`
      );
    }
    if (family.vehicle !== null) {
      const recipe = requireRecipe(`${family.key}_${family.vehicle}`);
      assert.deepEqual(recipe.output, { id: family.boat, count: 1 });
      assert.deepEqual(recipe.ingredients, [{ id: family.planks, count: 5 }]);
      assert.deepEqual(recipe.pattern, ["P P", "PPP"]);
    } else {
      assert.equal(getRecipe(`${family.key}_boat`), null);
      assert.equal(family.boat, null);
    }
  }
  assert.deepEqual(requireRecipe("bamboo_block").ingredients, [
    { id: BLOCK.BAMBOO, count: 9 },
  ]);
  assert.deepEqual(requireRecipe("bamboo_stick").ingredients, [
    { id: BLOCK.BAMBOO, count: 2 },
  ]);
  assert.deepEqual(requireRecipe("bamboo_stick").output, {
    id: ITEM.STICK,
    count: 1,
  });
});

test("generic wooden recipes accept real mixed planks and slabs without accepting logs or unrelated materials", () => {
  for (const id of [
    "sticks",
    "crafting_table",
    "chest",
    "bookshelf",
    "white_bed",
    "shield",
    "composter",
    "lectern",
    "cartography_table",
    "smithing_table",
    "barrel",
    ...TOOL_KINDS.map((tool) => `wood_${tool}`),
  ]) {
    const recipe = requireRecipe(id);
    let replacements = 0;
    const size = recipe.station === "hand" ? 2 : 3;
    const grid = gridFor(recipe, size, (input, index) => {
      const group =
        input.id === BLOCK.PLANKS
          ? PLANK_ITEMS
          : input.id === BLOCK.OAK_SLAB
            ? WOOD_SLAB_ITEMS
            : null;
      if (!group) return input.id;
      assert.deepEqual(
        [input.id, ...(input.alternatives ?? [])].sort((a, b) => a - b),
        [...group].sort((a, b) => a - b)
      );
      replacements++;
      return group[(index + replacements) % group.length];
    });
    assert.ok(replacements > 0, id);
    assert.equal(matchCraftingRecipe(grid, size)?.recipe.id, id);
    const first = grid.findIndex(
      (entry) =>
        PLANK_ITEMS.includes(entry?.id) || WOOD_SLAB_ITEMS.includes(entry?.id)
    );
    grid[first] = stack(BLOCK.OAK_LOG);
    assert.equal(
      matchCraftingRecipe(grid, size),
      null,
      `${id}: logs are not planks`
    );
    grid[first] = stack(BLOCK.DIRT);
    assert.equal(
      matchCraftingRecipe(grid, size),
      null,
      `${id}: no unrelated material substitution`
    );
  }
});

test("all craftable gear has exact material/stick costs and non-craftable gear cannot bypass smithing or loot", () => {
  const toolCost = {
    pickaxe: [3, 2],
    axe: [3, 2],
    sword: [2, 1],
    shovel: [1, 2],
    hoe: [2, 2],
  };
  const armorCost = { head: 5, chest: 8, legs: 7, feet: 4 };
  const materialId = {
    wood: BLOCK.PLANKS,
    stone: BLOCK.COBBLESTONE,
    copper: ITEM.COPPER_INGOT,
    iron: ITEM.IRON_INGOT,
    gold: ITEM.GOLD_INGOT,
    diamond: ITEM.DIAMOND,
    leather: ITEM.LEATHER,
    turtle: ITEM.SCUTE,
  };
  for (const [material, definition] of Object.entries(TOOL_MATERIALS)) {
    for (const tool of TOOL_KINDS) {
      const recipes = RECIPES.filter(
        ({ output }) => output.id === toolItemId(material, tool)
      );
      assert.equal(
        recipes.length,
        definition.craftable ? 1 : 0,
        `${material}_${tool}`
      );
      if (!definition.craftable) continue;
      const [recipe] = recipes;
      assert.deepEqual(
        sortedCosts(recipe.ingredients),
        sortedCosts([
          { id: materialId[material], count: toolCost[tool][0] },
          { id: ITEM.STICK, count: toolCost[tool][1] },
        ])
      );
      if (material === "stone")
        assert.deepEqual(
          new Set([recipe.key.M.id, ...recipe.key.M.alternatives]),
          new Set([
            BLOCK.COBBLESTONE,
            BLOCK.COBBLED_DEEPSLATE,
            BLOCK.BLACKSTONE,
          ])
        );
    }
  }
  for (const [material, definition] of Object.entries(ARMOR_MATERIALS)) {
    for (const slot of Object.keys(definition.armorPoints)) {
      const recipes = RECIPES.filter(
        ({ output }) => output.id === armorItemId(material, slot)
      );
      assert.equal(
        recipes.length,
        definition.craftable ? 1 : 0,
        `${material}_${slot}`
      );
      if (!definition.craftable) continue;
      assert.deepEqual(recipes[0].ingredients, [
        { id: materialId[material], count: armorCost[slot] },
      ]);
    }
  }
  assert.equal(SMITHING_RECIPES.length, 9);
  for (const recipe of SMITHING_RECIPES) {
    assert.equal(recipe.station, "smithing");
    assert.deepEqual(recipe.template, {
      id: ITEM.NETHERITE_UPGRADE_TEMPLATE,
      count: 1,
    });
    assert.deepEqual(recipe.addition, { id: ITEM.NETHERITE_INGOT, count: 1 });
    assert.equal(recipe.base.count, 1);
    assert.equal(recipe.output.count, 1);
    assert.equal(getItem(recipe.base.id).gearMaterial, "diamond");
    assert.equal(getItem(recipe.output.id).gearMaterial, "netherite");
    assert.equal(recipe.preserveMetadata, true);
    assert.equal(recipe.durabilityPolicy, "preserve_damage");
    assert.equal(
      getRecipe(recipe.id),
      null,
      "A smithing upgrade is not an ordinary grid recipe"
    );
  }
});

test("brewing ingredient recipes honor every declared real input and do not create free potions", () => {
  for (const requirement of BREWING_CRAFTING_REQUIREMENTS) {
    const recipe = requireRecipe(requirement.id);
    assert.deepEqual(recipe.output, {
      id: ITEM[requirement.output],
      count: requirement.count,
    });
    if (requirement.pattern) {
      assert.deepEqual(recipe.pattern, requirement.pattern);
      assert.equal(recipe.station, requirement.station);
      for (const [key, names] of Object.entries(requirement.key)) {
        const ids = (Array.isArray(names) ? names : [names]).map(
          (symbol) => ITEM[symbol]
        );
        assert.deepEqual(
          new Set([
            recipe.key[key].id,
            ...(recipe.key[key].alternatives ?? []),
          ]),
          new Set(ids)
        );
      }
    } else {
      assert.equal(recipe.shapeless, true);
      assert.deepEqual(
        sortedCosts(recipe.ingredients),
        sortedCosts(
          requirement.ingredients.map((symbol) => ({
            id: ITEM[symbol],
            count: 1,
          }))
        )
      );
    }
  }
  for (const id of [
    ITEM.POTION,
    ITEM.SPLASH_POTION,
    ITEM.ENCHANTED_BOOK,
    ITEM.HEART_OF_THE_SEA,
    ITEM.NAUTILUS_SHELL,
    ITEM.SCUTE,
  ])
    assert.equal(
      RECIPES.some(({ output }) => output.id === id),
      false,
      `No free grid source for ${getItem(id).name}`
    );
  const duplication = requireRecipe("duplicate_netherite_upgrade_template");
  assert.deepEqual(duplication.output, {
    id: ITEM.NETHERITE_UPGRADE_TEMPLATE,
    count: 2,
  });
  assert.deepEqual(
    sortedCosts(duplication.ingredients),
    sortedCosts([
      { id: ITEM.DIAMOND, count: 7 },
      { id: ITEM.NETHERITE_UPGRADE_TEMPLATE, count: 1 },
      { id: BLOCK.NETHERRACK, count: 1 },
    ])
  );
  assert.deepEqual(
    sortedCosts(requireRecipe("conduit").ingredients),
    sortedCosts([
      { id: ITEM.NAUTILUS_SHELL, count: 8 },
      { id: ITEM.HEART_OF_THE_SEA, count: 1 },
    ])
  );
  for (const [recipeId, input, output] of [
    ["cooked_cod", ITEM.RAW_COD, ITEM.COOKED_COD],
    ["cooked_salmon", ITEM.RAW_SALMON, ITEM.COOKED_SALMON],
    ["dried_kelp", BLOCK.KELP, ITEM.DRIED_KELP],
    ["smooth_stone", BLOCK.STONE, BLOCK.SMOOTH_STONE],
  ]) {
    const recipe = requireRecipe(recipeId);
    assert.equal(recipe.station, "furnace");
    assert.equal(recipe.duration, 10);
    assert.deepEqual(recipe.ingredients, [{ id: input, count: 1 }]);
    assert.deepEqual(recipe.output, { id: output, count: 1 });
  }
});

test("workstations and marine construction require their actual resource chains", () => {
  for (const [id, output, count, costs] of [
    [
      "barrel",
      BLOCK.BARREL,
      1,
      [
        [BLOCK.PLANKS, 6],
        [BLOCK.OAK_SLAB, 2],
      ],
    ],
    [
      "blast_furnace",
      BLOCK.BLAST_FURNACE,
      1,
      [
        [ITEM.IRON_INGOT, 5],
        [BLOCK.FURNACE, 1],
        [BLOCK.SMOOTH_STONE, 3],
      ],
    ],
    [
      "enchanting_table",
      BLOCK.ENCHANTING_TABLE,
      1,
      [
        [ITEM.BOOK, 1],
        [ITEM.DIAMOND, 2],
        [BLOCK.OBSIDIAN, 4],
      ],
    ],
    ["iron_block", BLOCK.IRON_BLOCK, 1, [[ITEM.IRON_INGOT, 9]]],
    ["iron_ingots", ITEM.IRON_INGOT, 9, [[BLOCK.IRON_BLOCK, 1]]],
    [
      "anvil",
      BLOCK.ANVIL,
      1,
      [
        [BLOCK.IRON_BLOCK, 3],
        [ITEM.IRON_INGOT, 4],
      ],
    ],
    [
      "dark_prismarine",
      BLOCK.DARK_PRISMARINE,
      1,
      [
        [ITEM.PRISMARINE_SHARD, 8],
        [ITEM.BLACK_DYE, 1],
      ],
    ],
    ["black_dye", ITEM.BLACK_DYE, 1, [[ITEM.INK_SAC, 1]]],
    ["magma_block", BLOCK.MAGMA_BLOCK, 1, [[ITEM.MAGMA_CREAM, 4]]],
    ["glowstone", BLOCK.GLOWSTONE, 1, [[ITEM.GLOWSTONE_DUST, 4]]],
    ["melon", BLOCK.MELON, 1, [[ITEM.MELON_SLICE, 9]]],
    ["dried_kelp_block", BLOCK.DRIED_KELP_BLOCK, 1, [[ITEM.DRIED_KELP, 9]]],
    [
      "dried_kelp_from_block",
      ITEM.DRIED_KELP,
      9,
      [[BLOCK.DRIED_KELP_BLOCK, 1]],
    ],
    ["shears", ITEM.SHEARS, 1, [[ITEM.IRON_INGOT, 2]]],
  ]) {
    const recipe = requireRecipe(id);
    assert.deepEqual(recipe.output, { id: output, count }, id);
    assert.deepEqual(
      sortedCosts(recipe.ingredients),
      sortedCosts(costs.map(([id, count]) => ({ id, count }))),
      id
    );
  }
  for (const id of [
    BLOCK.CHIPPED_ANVIL,
    BLOCK.DAMAGED_ANVIL,
    BLOCK.TURTLE_EGG,
    BLOCK.CARROT_CROP,
  ])
    assert.equal(
      RECIPES.some(({ output }) => output.id === id),
      false,
      `${getItem(id).name}: wear, ecology and crops are not free grid outputs`
    );
});

test("fuel and charcoal paths exclude Nether stems and preserve all legitimate wood sources", () => {
  const charcoal = requireRecipe("charcoal").ingredients[0];
  assert.deepEqual([charcoal.id, ...charcoal.alternatives], CHARCOAL_LOG_ITEMS);
  for (const family of WOOD_FAMILIES) {
    for (const part of [
      "source",
      "planks",
      "slab",
      "stairs",
      "door",
      "trapdoor",
      "fence",
      "fence_gate",
    ])
      assert.equal(
        getItem(family[part]).fuel > 0,
        !family.fireproof,
        `${family.key}.${part}`
      );
    assert.equal(
      CHARCOAL_LOG_ITEMS.includes(family.source),
      !family.fireproof && family.key !== "bamboo"
    );
  }
  assert.equal(getItem(BLOCK.DRIED_KELP_BLOCK).fuel, 200);
  assert.equal(getItem(ITEM.BLAZE_ROD).fuel, 120);
  assert.equal(new Set(FUEL_ITEMS).size, FUEL_ITEMS.length);
  for (const id of FUEL_ITEMS) assert.ok(getItem(id)?.fuel > 0);
});
