import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM, ITEMS } from "../src/items.js";
import { getRecipe } from "../src/recipes.js";
import {
  catalogItems,
  craftingJobs,
  createOverlayNotifier,
  durabilityView,
  filterBiomes,
  filterItems,
  heldItemLabel,
  itemCount,
  normalizeHotbar,
  recipeView,
  stationName,
  storageView,
} from "../src/ui/model.js";

test("the transient selected-item name is a plain item label, not a persistent target readout", () => {
  assert.equal(heldItemLabel(getItem(BLOCK.STONE)), "Stone");
  assert.equal(heldItemLabel(getItem(BLOCK.MOSS)), "Moss");
  assert.equal(heldItemLabel(getItem(ITEM.WOOD_PICKAXE)), "Wooden pickaxe");
  assert.equal(heldItemLabel(null), "");
});

test("hotbar normalization retains empty slots and item IDs without inventing supplies", () => {
  const input = [ITEM.APPLE, 0, ITEM.WOOD_PICKAXE, -2, NaN, 1.5];
  const bar = normalizeHotbar(input);
  assert.equal(bar.length, 9);
  assert.deepEqual(bar.slice(0, 3), input.slice(0, 3));
  assert.ok(bar.slice(3).every((id) => id === 0));
  assert.deepEqual(normalizeHotbar(null), Array(9).fill(0));
  assert.equal(itemCount({}, ITEM.APPLE), 0);
});

test("counts are authoritative, including an empty snapshot after the last item is consumed", () => {
  const staleInventory = [{ id: ITEM.APPLE, count: 4 }];
  assert.equal(itemCount({ inventory: staleInventory }, ITEM.APPLE), 4);
  assert.equal(
    itemCount({ counts: {}, inventory: staleInventory }, ITEM.APPLE),
    0
  );
  assert.equal(
    itemCount(
      { counts: { [ITEM.APPLE]: 0 }, inventory: staleInventory },
      ITEM.APPLE
    ),
    0
  );
  assert.equal(itemCount({ counts: { [ITEM.APPLE]: -1 } }, ITEM.APPLE), 0);
  assert.equal(itemCount({ counts: { 0: 100 } }, 0), 0);
});

test("canonical slots override old aggregate projections and legacy Maps remain readable", () => {
  const state = {
    slots: [{ id: ITEM.APPLE, count: 2 }, null, { id: ITEM.APPLE, count: 5 }],
    counts: { [ITEM.APPLE]: 99 },
  };
  assert.equal(itemCount(state, ITEM.APPLE), 7);
  assert.equal(itemCount({ ...state, slots: [] }, ITEM.APPLE), 0);
  assert.equal(
    itemCount({ inventory: new Map([[ITEM.APPLE, 4]]) }, ITEM.APPLE),
    4
  );
  assert.equal(itemCount({ inventory: {} }, ITEM.APPLE), 0);
});

test("backpack exposes owned tools and food while the creative palette is unlimited", () => {
  const items = catalogItems(ITEMS);
  const state = {
    counts: { [ITEM.APPLE]: 4, [ITEM.WOOD_PICKAXE]: 1, [BLOCK.DIRT]: 2 },
  };
  assert.deepEqual(
    filterItems(items, { state, category: "food" }).map((item) => item.id),
    [ITEM.APPLE]
  );
  assert.deepEqual(
    filterItems(items, { state, query: "PICKAXE" }).map((item) => item.id),
    [ITEM.WOOD_PICKAXE]
  );
  assert.ok(
    filterItems(items, { state: {}, creative: true, category: "tools" }).some(
      (item) => item.id === ITEM.DIAMOND_PICKAXE
    )
  );
  assert.equal(filterItems(items, { state: {} }).length, 0);
  assert.ok(!items.some((item) => item.id === 0));
});

test("tool wear uses the item's actual maximum and bounds damaged values", () => {
  const item = getItem(ITEM.WOOD_PICKAXE);
  assert.equal(durabilityView(item, item.durability / 2).fraction, 0.5);
  assert.equal(durabilityView(item, -2).fraction, 0);
  assert.equal(durabilityView(item, item.durability * 2).fraction, 1);
  assert.equal(durabilityView(item, undefined), null);
  assert.equal(durabilityView(getItem(ITEM.APPLE), 1), null);
});

test("family-specific planks show available resources and conserve the same material as gameplay", () => {
  const game = new Gameplay();
  game.add(BLOCK.BIRCH_LOG, 1);
  const view = recipeView(getRecipe("birch_planks"), game.getState());
  assert.equal(view.canCraft, true);
  assert.equal(view.outputId, BLOCK.BIRCH_PLANKS);
  assert.equal(view.outputCount, 4);
  assert.equal(view.costs[0].id, BLOCK.BIRCH_LOG);
  assert.equal(view.costs[0].count, 1);
  assert.equal(view.costs[0].have, 1);
  assert.match(getItem(view.costs[0].id).name, /birch log/i);
  assert.equal(
    recipeView(getRecipe("planks"), game.getState()).canCraft,
    false
  );
  const result = game.craft("birch_planks");
  assert.equal(result.ok, true);
  assert.equal(game.count(BLOCK.BIRCH_LOG), 0);
  assert.equal(game.count(view.outputId), view.outputCount);
  assert.equal(game.count(BLOCK.PLANKS), 0);
  assert.equal(
    recipeView(getRecipe("birch_planks"), game.getState()).canCraft,
    false
  );
});

test("recipe costs use plain canonical stacks instead of decorated aggregate counts", () => {
  const game = new Gameplay();
  const namedLog = {
    id: BLOCK.OAK_LOG,
    count: 8,
    data: { version: 1, name: "Do not craft" },
  };
  assert.equal(game.addStack(namedLog), true);
  const state = game.getState();
  assert.equal(itemCount(state, BLOCK.OAK_LOG), 8);
  const before = structuredClone(state);
  const view = recipeView(getRecipe("planks"), state);
  assert.equal(view.costs[0].have, 0);
  assert.equal(view.canCraft, false);
  assert.deepEqual(state, before);
  assert.equal(
    recipeView({ ...getRecipe("planks"), canCraft: true }, state).canCraft,
    false,
    "an older positive availability flag cannot spend newly decorated slots"
  );
  assert.equal(game.add(BLOCK.OAK_LOG, 1), true);
  const available = recipeView(getRecipe("planks"), game.getState());
  assert.equal(available.costs[0].have, 1);
  assert.equal(available.canCraft, true);
});

test("specialized recipe eligibility reserves exact kinds independently and rejects decorated fuel", () => {
  const data = { version: 1, name: "Reserved" };
  const slots = [
    { id: BLOCK.PLANKS, count: 2, data },
    { id: BLOCK.PLANKS, count: 1 },
  ];
  const recipe = {
    output: { id: ITEM.STICK, count: 4 },
    ingredients: [
      { id: BLOCK.PLANKS, count: 2, metadata: "exact", data },
      { id: BLOCK.PLANKS, count: 1 },
    ],
  };
  const view = recipeView(recipe, { slots });
  assert.equal(view.canCraft, true);
  assert.deepEqual(
    view.costs.map((cost) => cost.have),
    [2, 1]
  );
  assert.equal(
    recipeView(
      {
        ...recipe,
        ingredients: [...recipe.ingredients, { id: BLOCK.PLANKS, count: 1 }],
      },
      { slots }
    ).canCraft,
    false
  );
  const furnace = new Gameplay();
  assert.equal(furnace.add(ITEM.RAW_IRON, 1), true);
  assert.equal(
    furnace.addStack({
      id: ITEM.COAL,
      count: 2,
      data: { version: 1, name: "Souvenir" },
    }),
    true
  );
  const unfueled = recipeView(
    getRecipe("iron_ingot"),
    furnace.getState(),
    "furnace"
  );
  assert.equal(unfueled.canCraft, false);
  assert.equal(unfueled.fuel.missing, getRecipe("iron_ingot").duration);
});

test("recipes enforce resources and real stations, including multiple nearby stations", () => {
  const game = new Gameplay();
  const recipe = getRecipe("wood_pickaxe");
  game.add(BLOCK.PLANKS, 3);
  assert.equal(recipeView(recipe, game.getState(), "table").canCraft, false);
  game.add(ITEM.STICK, 2);
  const withoutTable = recipeView(recipe, game.getState(), "hand");
  assert.equal(withoutTable.canCraft, false);
  assert.match(withoutTable.reason, /crafting table/i);
  const atBoth = recipeView(recipe, game.getState(), ["table", "furnace"]);
  assert.equal(atBoth.canCraft, true);
  assert.equal(
    game.craft(recipe.id, { station: ["table", "furnace"] }).ok,
    true
  );
  assert.equal(game.count(ITEM.WOOD_PICKAXE), 1);
  assert.match(stationName(["table", "furnace"]), /Crafting table.*Furnace/);
});

test("the same log cannot pay both a charcoal ingredient and its furnace fuel", () => {
  const game = new Gameplay();
  game.add(BLOCK.OAK_LOG, 1);
  const recipe = getRecipe("charcoal");
  const missingFuel = recipeView(recipe, game.getState(), "furnace");
  assert.equal(missingFuel.canCraft, false);
  assert.equal(missingFuel.fuel.missing, recipe.duration);
  assert.equal(game.craft("charcoal", { station: "furnace" }).ok, false);
  game.add(BLOCK.BIRCH_LOG, 1);
  const fueled = recipeView(recipe, game.getState(), "furnace");
  assert.equal(fueled.canCraft, true);
  assert.deepEqual(
    fueled.costs
      .filter((cost) => cost.fuel)
      .map(({ id, count }) => [id, count]),
    [[BLOCK.BIRCH_LOG, 1]]
  );
  assert.equal(game.craft("charcoal", { station: "furnace" }).ok, true);
  assert.equal(game.count(BLOCK.OAK_LOG), 0);
  assert.equal(game.count(BLOCK.BIRCH_LOG), 0);
});

test("prepared recipes display the fuel and material choices made by gameplay", () => {
  const game = new Gameplay();
  game.add(ITEM.RAW_IRON, 1);
  game.add(ITEM.COAL, 1);
  const recipe = game
    .getCraftableRecipes("furnace")
    .find((entry) => entry.id === "iron_ingot");
  const view = recipeView(recipe, game.getState());
  assert.equal(
    view.canCraft,
    true,
    "authoritative prepared availability includes the nearby station"
  );
  assert.deepEqual(
    view.costs.filter((cost) => cost.fuel).map(({ id, count }) => [id, count]),
    recipe.fuel.map(({ id, count }) => [id, count])
  );
  assert.equal(game.craft(recipe.id, { station: "furnace" }).ok, true);
  assert.equal(game.count(ITEM.COAL), 0);
  assert.equal(game.count(ITEM.RAW_IRON), 0);
  const state = game.getState();
  assert.equal(state.fuelTime, getItem(ITEM.COAL).fuel - recipe.duration);
  game.update(2);
  const jobs = craftingJobs(game.getState().crafting);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].remaining, recipe.duration - 2);
  assert.ok(Math.abs(jobs[0].progress - 2 / recipe.duration) < 1e-8);
  game.update(recipe.duration);
  assert.deepEqual(craftingJobs(game.getState().crafting), []);
  assert.equal(game.count(ITEM.IRON_INGOT), 1);
});

test("missing furnace fuel from prepared recipes remains visibly unaffordable", () => {
  const game = new Gameplay();
  game.add(ITEM.RAW_IRON, 1);
  const recipe = game
    .getCraftableRecipes("furnace")
    .find((entry) => entry.id === "iron_ingot");
  const view = recipeView(recipe, game.getState(), "furnace");
  assert.equal(view.canCraft, false);
  assert.match(view.reason, /fuel|coal/i);
  assert.ok(view.costs.some((cost) => cost.fuel && cost.have < cost.count));
});

test("authoritative recipe restrictions are never replaced with a local affordability guess", () => {
  const recipe = {
    ...getRecipe("planks"),
    canCraft: false,
    reason: "Backpack full",
  };
  const state = { counts: { [BLOCK.OAK_LOG]: 10 } };
  assert.equal(recipeView(recipe, state).canCraft, false);
  assert.equal(recipeView(recipe, state).reason, "Backpack full");
  assert.equal(
    recipeView({ output: { id: BLOCK.PLANKS, count: 4 } }, state).canCraft,
    false
  );
});

test("creative crafting is free but death always blocks crafting", () => {
  const recipe = getRecipe("diamond_pickaxe");
  assert.equal(recipeView(recipe, { mode: "creative" }).canCraft, true);
  assert.equal(
    recipeView({ ...recipe, canCraft: true }, { mode: "creative", dead: true })
      .canCraft,
    false
  );
});

test("repeated ingredients reserve resources before evaluating the next requirement", () => {
  const recipe = {
    output: { id: ITEM.STICK, count: 4 },
    ingredients: [
      { id: BLOCK.PLANKS, count: 2 },
      { id: BLOCK.PLANKS, count: 2 },
    ],
  };
  assert.equal(
    recipeView(recipe, { counts: { [BLOCK.PLANKS]: 3 } }).canCraft,
    false
  );
  assert.equal(
    recipeView(recipe, { counts: { [BLOCK.PLANKS]: 4 } }).canCraft,
    true
  );
});

test("crafting progress never fabricates elapsed work and bounds out-of-range input", () => {
  assert.deepEqual(craftingJobs(undefined), []);
  assert.equal(
    craftingJobs([{ recipeId: "iron_ingot", duration: 10, remaining: 10 }])[0]
      .progress,
    0
  );
  assert.equal(
    craftingJobs([{ recipeId: "iron_ingot", progress: 2, remaining: -2 }])[0]
      .progress,
    1
  );
  assert.equal(
    craftingJobs([{ recipeId: "iron_ingot", progress: -1, remaining: 4 }])[0]
      .progress,
    0
  );
});

test("atlas grouping contains every registry biome exactly once", () => {
  const groups = filterBiomes(BIOMES);
  const entries = groups.flatMap((group) => group.biomes);
  assert.equal(entries.length, BIOMES.length);
  assert.equal(new Set(entries.map((biome) => biome.id)).size, BIOMES.length);
  for (const group of groups)
    assert.ok(group.biomes.every((biome) => biome.dimension === group.id));
});

test("atlas search combines case-insensitive names, registry IDs, description, category, and dimension", () => {
  const biomes = [
    {
      id: "green_grove",
      name: "Green Grove",
      dimension: "overworld",
      category: "forest",
      description: "Soft moss and broad leaves",
    },
    {
      id: "ashen_grove",
      name: "Ashen Grove",
      dimension: "nether",
      category: "forest",
      description: "Spore-covered red crowns",
    },
    {
      id: "pale_island",
      name: "Pale Island",
      dimension: "end",
      category: "island",
      description: "A quiet void",
    },
  ];
  const ids = (options) =>
    filterBiomes(biomes, options).flatMap((group) =>
      group.biomes.map((biome) => biome.id)
    );
  assert.deepEqual(ids({ query: "GREEN_GROVE" }), ["green_grove"]);
  assert.deepEqual(ids({ query: "moss" }), ["green_grove"]);
  assert.deepEqual(
    ids({ query: "grove", dimension: "nether", category: "forest" }),
    ["ashen_grove"]
  );
  assert.deepEqual(ids({ query: "grove", category: "island" }), []);
});

test("inventory, atlas, and death notify one shared pause boundary without flicker", () => {
  const changes = [];
  const notify = createOverlayNotifier((open) => changes.push(open));
  notify(null, false);
  notify("inventory", false);
  notify("inventory", false);
  notify("atlas", false);
  notify(null, true);
  notify(null, true);
  assert.deepEqual(changes, [true]);
  notify(null, false);
  assert.deepEqual(changes, [true, false]);
  assert.doesNotThrow(() => createOverlayNotifier()("atlas", false));
});

test("save status keeps caller error messages and error styling", () => {
  assert.deepEqual(
    storageView({ ok: false, error: new Error("Invalid save version") }),
    {
      message: "Invalid save version",
      state: "error",
    }
  );
  assert.equal(storageView("Browser storage is full").state, "error");
  assert.equal(
    storageView({ state: "busy", message: "Saving…" }).state,
    "busy"
  );
});
