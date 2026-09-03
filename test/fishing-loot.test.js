import assert from "node:assert/strict";
import test from "node:test";
import {
  fishingLootWeights,
  fishingWaitTicks as applyFishingLure,
} from "../src/enchantment-effects.js";
import {
  compileFishingLootTables,
  DEFAULT_FISHING_TABLES,
  fishingCategoryWeights,
  fishingRodStats,
  fishingWaitTicks,
  nextFishingRandom,
  rollFishingCatch,
} from "../src/fishing-loot.js";
import { getItem, ITEM } from "../src/items.js";
import { createWorldContext } from "../src/world-spec.js";
import { requiredAquaticItem } from "./vehicle-fishing-fixture.js";

const context = createWorldContext({
  seed: "fishing-loot-fixture",
  generatorVersion: 4,
});

test("legacy fish table symbols resolve to canonical raw food IDs without registry aliases", () => {
  const tables = compileFishingLootTables(
    {
      ...DEFAULT_FISHING_TABLES,
      fish: [
        { item: "COD", weight: 60 },
        { item: "SALMON", weight: 25 },
      ],
    },
    context
  );
  assert.deepEqual(
    tables.fish.map((entry) => [entry.item, entry.stack.id]),
    [
      ["RAW_COD", ITEM.RAW_COD],
      ["RAW_SALMON", ITEM.RAW_SALMON],
    ]
  );
  assert.equal(ITEM.COD, undefined);
  assert.equal(ITEM.SALMON, undefined);
  assert.ok(
    tables.fish.every((entry) => getItem(entry.stack.id).kind === "food")
  );
});

test("registered rod metadata actually changes waiting and treasure/junk weights", () => {
  const rod = requiredAquaticItem("FISHING_ROD");
  const stack = {
    id: rod.id,
    count: 1,
    durability: 64,
    data: { version: 1, enchantments: { lure: 3, luck_of_the_sea: 3 } },
  };
  assert.deepEqual(fishingRodStats(stack, context), { lure: 3, luck: 3 });
  const normal = fishingWaitTicks(7),
    enchanted = fishingWaitTicks(7, 3);
  assert.equal(enchanted.state, normal.state);
  assert.equal(enchanted.value, applyFishingLure(normal.value, 3));
  assert.equal(
    enchanted.value,
    -81,
    "a nonpositive roll is a retry, never a one-tick wait"
  );
  const tables = compileFishingLootTables(DEFAULT_FISHING_TABLES, context);
  let ordinaryTreasure = 0,
    luckyTreasure = 0,
    ordinaryJunk = 0,
    luckyJunk = 0;
  for (let seed = 0; seed < 4096; seed++) {
    const normal = rollFishingCatch(seed, { tables, context, openWater: true });
    const lucky = rollFishingCatch(seed, {
      tables,
      context,
      openWater: true,
      luck: 3,
    });
    ordinaryTreasure += Number(normal.category === "treasure");
    luckyTreasure += Number(lucky.category === "treasure");
    ordinaryJunk += Number(normal.category === "junk");
    luckyJunk += Number(lucky.category === "junk");
  }
  assert.ok(luckyTreasure > ordinaryTreasure);
  assert.ok(luckyJunk < ordinaryJunk);
});

test("each Lure wait consumes exactly one persisted draw, including zero and negative results", () => {
  for (const [seed, lure, state, value, nextState, nextValue] of [
    [7, 3, 1_025_555_898, -81, 3_923_423_697, 257],
    [1972, 1, 1_380_227, 0, 628_748_038, 73],
  ]) {
    assert.deepEqual(fishingWaitTicks(seed, lure), { state, value });
    assert.equal(nextFishingRandom(seed).state, state);
    assert.deepEqual(fishingWaitTicks(state, lure), {
      state: nextState,
      value: nextValue,
    });
    assert.equal(nextFishingRandom(state).state, nextState);
  }
});

test("Luck of the Sea delegates exact helper weights once and requires explicit open water", () => {
  for (let luck = 0; luck <= 3; luck++)
    for (const openWater of [false, true])
      assert.deepEqual(
        fishingCategoryWeights(luck, openWater),
        fishingLootWeights(luck, { openWater })
      );
  assert.deepEqual(fishingCategoryWeights(0, true), {
    fish: 85,
    junk: 10,
    treasure: 5,
  });
  assert.deepEqual(fishingCategoryWeights(3, true), {
    fish: 82,
    junk: 4,
    treasure: 11,
  });
  assert.deepEqual(fishingCategoryWeights(3), {
    fish: 82,
    junk: 4,
    treasure: 0,
  });
});

test("persisted RNG yields reproducible physical catch stacks, useful species and bounded XP", () => {
  const tables = compileFishingLootTables(DEFAULT_FISHING_TABLES, context);
  const counts = { fish: 0, junk: 0, treasure: 0 };
  const species = new Set();
  let state = 173;
  for (let index = 0; index < 4096; index++) {
    const result = rollFishingCatch(state, {
      tables,
      context,
      openWater: true,
    });
    assert.deepEqual(
      rollFishingCatch(state, { tables, context, openWater: true }),
      result
    );
    counts[result.category]++;
    if (result.category === "fish") species.add(result.item);
    assert.equal(result.stack.count, 1);
    assert.ok(result.experience >= 1 && result.experience <= 6);
    if (result.stack.durability !== undefined)
      assert.ok(
        result.stack.durability >= 1 &&
          result.stack.durability <= getItem(result.stack.id).durability
      );
    state = result.randomState;
  }
  assert.deepEqual([...species].sort(), [
    "PUFFERFISH",
    "RAW_COD",
    "RAW_SALMON",
    "TROPICAL_FISH",
  ]);
  // Exercises category selection, not a restatement of a hand-maintained list.
  assert.ok(Math.abs(counts.fish / 4096 - 0.85) < 0.03);
  assert.ok(Math.abs(counts.junk / 4096 - 0.1) < 0.025);
  assert.ok(Math.abs(counts.treasure / 4096 - 0.05) < 0.02);
});

test("invalid open water removes treasure from the roll without requiring fish entities", () => {
  const tables = compileFishingLootTables(DEFAULT_FISHING_TABLES, context);
  let state = 42;
  const categories = new Set();
  for (let index = 0; index < 512; index++) {
    const result = rollFishingCatch(state, {
      tables,
      context,
      openWater: false,
      luck: 3,
    });
    assert.deepEqual(
      rollFishingCatch(state, { tables, context, luck: 3 }),
      result
    );
    assert.notEqual(result.category, "treasure");
    categories.add(result.category);
    state = result.randomState;
  }
  assert.deepEqual([...categories].sort(), ["fish", "junk"]);
  assert.notEqual(nextFishingRandom(0).state, 0);
});

test("requested unregistered rewards, ordinary enchanted books and non-map paper fail explicitly", () => {
  const tables = (entry) => ({ ...DEFAULT_FISHING_TABLES, treasure: [entry] });
  assert.throws(
    () =>
      compileFishingLootTables(
        tables({ item: "UNREGISTERED_FISHING_REWARD", weight: 1 }),
        context
      ),
    /unregistered requested item/
  );
  assert.throws(
    () =>
      compileFishingLootTables(
        tables({
          item: "BOOK",
          weight: 1,
          data: { version: 1, enchantments: { mending: 1 } },
        }),
        context
      ),
    /unsupported metadata/
  );
  assert.throws(
    () =>
      compileFishingLootTables(
        tables({
          item: "PAPER",
          weight: 1,
          data: {
            version: 1,
            mapTarget: {
              seed: context.seed,
              generatorVersion: 4,
              dimension: "overworld",
              structureId: "authored-fixture",
              x: 0,
              y: 10,
              z: 0,
            },
          },
        }),
        context
      ),
    /unsupported metadata/
  );
});

test("compiled loot detaches metadata and never repairs a rolled worn tool", () => {
  const definition = {
    item: "BOW",
    weight: 1,
    remaining: [0.2, 0.4],
    data: { version: 1, enchantments: { power: 3 } },
  };
  const tables = compileFishingLootTables(
    { ...DEFAULT_FISHING_TABLES, treasure: [definition] },
    context
  );
  definition.data.enchantments.power = 1;
  let result;
  for (let seed = 0; seed < 4096; seed++) {
    result = rollFishingCatch(seed, { tables, context, openWater: true });
    if (result.category === "treasure") break;
  }
  assert.equal(result.category, "treasure");
  assert.equal(result.stack.data.enchantments.power, 3);
  assert.ok(
    result.stack.durability <=
      Math.floor(getItem(result.stack.id).durability * 0.4)
  );
});
