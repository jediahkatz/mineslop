import assert from "node:assert/strict";
import test from "node:test";
import {
  createBrewingCatalog,
  fillWaterBottle,
  getBrewingResult,
} from "../src/brewing.js";
import {
  bindFishingLootSymbols,
  ENCHANTING_RESOURCES,
  FISHING_TREASURE_ADDITIONS,
} from "../src/content-bindings.js";
import {
  createEnchantingPlayer,
  getEnchantingOffers,
  planEnchanting,
} from "../src/enchanting.js";
import { activeEnchantmentLevel } from "../src/enchantment-effects.js";
import { getEnchantmentRule, getSupportedEnchantments } from "../src/enchantment-rules.js";
import { experienceForLevel } from "../src/experience.js";
import {
  compileFishingLootTables,
  DEFAULT_FISHING_TABLES,
  FISHING_ENCHANTMENT_REQUIREMENTS,
  fishingRodStats,
} from "../src/fishing-loot.js";
import { isValidStack, normalizeStack } from "../src/inventory-slots.js";
import {
  ENCHANTMENTS,
  getEnchantment,
  MAX_STACK_ENCHANTMENTS,
  normalizePotionData,
  normalizeStackData,
  sameStackKind,
  STACK_DATA_VERSION,
} from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import { BREWABLE_POTIONS, BREWING_INGREDIENTS } from "../src/potion-rules.js";
import { SMITHING_RECIPES } from "../src/recipes.js";
import { previewSmithing } from "../src/smithing.js";
import { generateTraderOffers, TRADE_TEMPLATES } from "../src/trading-offers.js";
import { createWorldContext } from "../src/world-spec.js";

const context = createWorldContext({ seed: "content-checkpoint", generatorVersion: 4 });
const stack = (id, data, durability = getItem(id)?.durability) => normalizeStack({
  id, count: 1,
  ...(durability === undefined ? {} : { durability }),
  ...(data === undefined ? {} : { data: { version: 1, ...data } }),
}, context);

test("Lure and Luck of the Sea extend the bounded v1 schema without removing any shipped enchantment", () => {
  const previousLevels = {
    aqua_affinity: 1, bane_of_arthropods: 5, binding_curse: 1,
    blast_protection: 4, depth_strider: 3, efficiency: 5, feather_falling: 4,
    fire_aspect: 2, fire_protection: 4, flame: 1, fortune: 3, frost_walker: 2,
    infinity: 1, knockback: 2, looting: 3, mending: 1, power: 5,
    projectile_protection: 4, protection: 4, punch: 2, respiration: 3,
    sharpness: 5, silk_touch: 1, smite: 5, soul_speed: 3, sweeping_edge: 3,
    swift_sneak: 3, thorns: 3, unbreaking: 3, vanishing_curse: 1,
  };
  assert.equal(STACK_DATA_VERSION, 1);
  assert.equal(MAX_STACK_ENCHANTMENTS, 16);
  assert.deepEqual(Object.keys(ENCHANTMENTS).sort(),
    [...Object.keys(previousLevels), "lure", "luck_of_the_sea"].sort());
  for (const [name, maxLevel] of Object.entries(previousLevels))
    assert.equal(getEnchantment(name)?.maxLevel, maxLevel, name);
  for (const [name, requirement] of Object.entries(FISHING_ENCHANTMENT_REQUIREMENTS)) {
    const definition = getEnchantment(name);
    assert.equal(definition?.maxLevel, requirement.maxLevel);
    assert.equal(definition.eligible(getItem(ITEM.FISHING_ROD)), true);
    assert.ok(getSupportedEnchantments({ tableOnly: true }).includes(name));
    assert.equal(getEnchantmentRule(name)?.primary, "fishing");
    assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.conflicts));
    for (const id of [ITEM.FISHING_ROD, ITEM.ENCHANTED_BOOK]) {
      for (const level of [1, 2, 3])
        assert.equal(normalizeStackData(id, { version: 1, enchantments: { [name]: level } }).enchantments[name], level);
      for (const level of [0, -1, 4, 1.5, "3"])
        assert.throws(() => normalizeStackData(id, { version: 1, enchantments: { [name]: level } }), RangeError);
    }
    for (const id of [ITEM.IRON_PICKAXE, ITEM.NETHERITE_SWORD, ITEM.DIAMOND_HELMET, ITEM.BOOK, ITEM.PAPER, ITEM.RAW_COD])
      assert.throws(() => normalizeStackData(id, { version: 1, enchantments: { [name]: 1 } }), RangeError);
  }
  const rod = stack(ITEM.FISHING_ROD, { enchantments: { lure: 3, luck_of_the_sea: 2, unbreaking: 3 } }, 32);
  assert.deepEqual(fishingRodStats(rod, context), { lure: 3, luck: 2 });
  const book = stack(ITEM.ENCHANTED_BOOK, { enchantments: { lure: 3, luck_of_the_sea: 2 } });
  assert.equal(activeEnchantmentLevel(book, "lure", context), 0, "Stored book data is not an equipped fishing effect");
});

test("legacy plain and decorated stacks retain their exact data and rejection rules", () => {
  const legacy = {
    id: ITEM.IRON_PICKAXE, count: 1, durability: 17,
    data: { version: 1, enchantments: { efficiency: 5, unbreaking: 3 }, name: "Old pick", repairCost: 7 },
  };
  assert.deepEqual(normalizeStack(legacy), legacy);
  assert.deepEqual(normalizeStack(JSON.parse(JSON.stringify(legacy))), legacy);
  assert.deepEqual(normalizeStack({ id: ITEM.APPLE, count: 4 }), { id: ITEM.APPLE, count: 4 });
  assert.equal(normalizeStackData(ITEM.APPLE, { version: 1, enchantments: {}, repairCost: 0 }), undefined);
  assert.throws(() => normalizeStackData(ITEM.FISHING_ROD, { version: 2, enchantments: { lure: 1 } }), RangeError);
  assert.throws(() => normalizeStackData(ITEM.IRON_PICKAXE, {
    version: 1, enchantments: { fortune: 3, silk_touch: 1 },
  }), RangeError);
  assert.throws(() => normalizeStackData(ITEM.BOW, {
    version: 1, enchantments: { infinity: 1, mending: 1 },
  }), RangeError);
});

test("canonical fishing tables and explicitly bound legacy vocabulary compile without catalog substitutions", () => {
  const defaultsBefore = JSON.stringify(DEFAULT_FISHING_TABLES);
  const tables = bindFishingLootSymbols({
    ...DEFAULT_FISHING_TABLES,
    treasure: [...DEFAULT_FISHING_TABLES.treasure, ...FISHING_TREASURE_ADDITIONS],
  });
  const compiled = compileFishingLootTables(tables, context);
  for (const entries of Object.values(compiled))
    for (const entry of entries) {
      assert.equal(entry.stack.id, ITEM[entry.item]);
      assert.equal(isValidStack(entry.stack, context), true, entry.item);
    }
  assert.equal(compiled.fish.find(({ item }) => item === "RAW_COD").stack.id, ITEM.RAW_COD);
  assert.equal(compiled.fish.find(({ item }) => item === "RAW_SALMON").stack.id, ITEM.RAW_SALMON);
  assert.equal(compiled.treasure.find(({ item }) => item === "NAUTILUS_SHELL").stack.id, ITEM.NAUTILUS_SHELL);
  const book = compiled.treasure.find(({ item }) => item === "ENCHANTED_BOOK").stack;
  assert.equal(book.id, ITEM.ENCHANTED_BOOK);
  assert.deepEqual(book.data.enchantments, { mending: 1 });
  const legacyVocabulary = {
    ...DEFAULT_FISHING_TABLES,
    fish: [{ item: "COD", weight: 60 }, { item: "SALMON", weight: 25 }],
  };
  const sourceBefore = structuredClone(legacyVocabulary);
  const bound = bindFishingLootSymbols(legacyVocabulary);
  assert.deepEqual(bound.fish.map(({ item }) => item), ["RAW_COD", "RAW_SALMON"]);
  assert.deepEqual(compileFishingLootTables(bound, context).fish.map(({ stack: result }) => result.id), [ITEM.RAW_COD, ITEM.RAW_SALMON]);
  assert.deepEqual(legacyVocabulary, sourceBefore);
  assert.equal(JSON.stringify(DEFAULT_FISHING_TABLES), defaultsBefore);
  assert.equal(Object.hasOwn(ITEM, "COD"), false);
  assert.equal(Object.hasOwn(ITEM, "SALMON"), false);
  assert.throws(() => bindFishingLootSymbols({ fish: [] }), RangeError);
  assert.throws(() => compileFishingLootTables({
    ...tables, fish: [{ item: "UNREGISTERED_FISH", weight: 1 }],
  }), RangeError);
});

test("registered book/lapis resources produce funded metadata-bearing enchanting plans", () => {
  const input = stack(ITEM.BOOK, { name: "Harbor ledger" });
  const playerState = createEnchantingPlayer(123456789);
  const options = { input, playerState, bookshelfPower: 15, resources: ENCHANTING_RESOURCES, context };
  const menu = getEnchantingOffers(options);
  assert.equal(menu.ok, true);
  const offer = menu.offers.find(({ available }) => available);
  assert.ok(offer, "The real plain book must have at least one registered table offer");
  const record = { version: 1, input, lapis: { id: ITEM.LAPIS, count: 3 } };
  const before = structuredClone(record);
  const plan = planEnchanting({
    ...options, record, index: offer.index, offerKey: offer.key,
    experienceTotal: experienceForLevel(40),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.output.id, ITEM.ENCHANTED_BOOK);
  assert.equal(plan.output.count, 1);
  assert.equal(plan.output.data.name, "Harbor ledger");
  assert.ok(Object.keys(plan.output.data.enchantments).length > 0);
  assert.equal(isValidStack(plan.output, context), true);
  assert.equal(plan.lapisCost, offer.index + 1);
  assert.deepEqual(record, before, "The pure plan must not publish escrow edits");
  assert.throws(() => normalizeStackData(ITEM.BOOK, plan.output.data), RangeError);
});

test("all declared brewing effects, strengths and forms are reachable with the real ingredient catalog", () => {
  const catalog = createBrewingCatalog(ITEM);
  const water = fillWaterBottle(stack(ITEM.GLASS_BOTTLE, { name: "River vial" }), catalog, context);
  assert.equal(water.id, ITEM.POTION);
  assert.equal(water.data.potion.id, "water");
  assert.equal(getBrewingResult(stack(ITEM.POTION), stack(ITEM.NETHER_WART), catalog, context), null,
    "A metadata-less potion is not free water");
  const identity = (potion) => JSON.stringify(normalizePotionData(potion));
  const reached = new Map([[identity(water.data.potion), water]]);
  const pending = [water];
  for (let at = 0; at < pending.length; at++) {
    assert.ok(pending.length < 128, "Brewing closure must remain finite");
    const bottle = pending[at];
    const before = structuredClone(bottle);
    for (const symbol of Object.keys(BREWING_INGREDIENTS)) {
      const result = getBrewingResult(bottle, stack(ITEM[symbol]), catalog, context);
      if (result === null) continue; // A non-recipe, not a skipped content requirement.
      assert.equal(result.id, catalog.bottles[result.data.potion.form]);
      assert.equal(result.data.name, "River vial");
      assert.equal(isValidStack(result, context), true);
      const key = identity(result.data.potion);
      if (!reached.has(key)) {
        reached.set(key, result);
        pending.push(result);
      }
    }
    assert.deepEqual(bottle, before);
  }
  for (const [id, definition] of Object.entries(BREWABLE_POTIONS)) {
    const flags = [
      {}, ...(definition.extended ? [{ extended: true }] : []),
      ...(definition.strong || definition.instant ? [{ strong: true }] : []),
    ];
    for (const form of ["drinkable", "splash"])
      for (const variant of flags)
        assert.ok(reached.has(identity({ id, form, ...variant })), `Missing actual brewing path ${id}/${form}/${JSON.stringify(variant)}`);
  }
  const potion = water.data;
  assert.throws(() => normalizeStackData(ITEM.GLASS_BOTTLE, potion), RangeError);
  assert.throws(() => normalizeStackData(ITEM.SPLASH_POTION, potion), RangeError);
  assert.equal(sameStackKind(water, stack(ITEM.POTION, { potion: { id: "healing", form: "drinkable" } })), false);
});

test("every offered trade metadata choice validates against its real output, not just a lucky roll", () => {
  for (const [profession, definitions] of Object.entries(TRADE_TEMPLATES)) {
    const offers = generateTraderOffers(`catalog:${profession}`, profession, context);
    assert.equal(offers.length, definitions.length);
    for (const offer of offers) {
      assert.equal(isValidStack(offer.output, context), true);
      for (const input of offer.inputs) assert.equal(isValidStack(input, context), true);
    }
    for (const definition of definitions)
      for (const data of definition.dataChoices ?? [undefined])
        assert.equal(isValidStack(stack(ITEM[definition.output.symbol],
          data === undefined ? undefined : { ...data }), context), true);
  }
});

test("all nine real smithing upgrades preserve absolute damage and old metadata without grid shortcuts", () => {
  for (const recipe of SMITHING_RECIPES) {
    const baseItem = getItem(recipe.base.id);
    const outputItem = getItem(recipe.output.id);
    const base = stack(baseItem.id, {
      enchantments: { unbreaking: 3, mending: 1 }, name: "Kept equipment", repairCost: 7,
    }, baseItem.durability - 18);
    const record = { version: 1, template: { ...recipe.template }, base, addition: { ...recipe.addition } };
    const before = structuredClone(record);
    const preview = previewSmithing(record, context);
    assert.equal(preview.ok, true, recipe.id);
    assert.equal(preview.output.id, recipe.output.id);
    assert.equal(preview.output.durability, outputItem.durability - 18);
    assert.deepEqual(preview.output.data, base.data);
    assert.equal(isValidStack(preview.output, context), true);
    assert.deepEqual(preview.after.record, { version: 1, template: null, base: null, addition: null });
    assert.deepEqual(record, before, "A preview cannot consume its owners' stacks");
    assert.equal(previewSmithing({ ...record, template: null }, context).ok, false);
    assert.equal(previewSmithing({ ...record, addition: { id: ITEM.IRON_INGOT, count: 1 } }, context).ok, false);
  }
});

test("treasure-map metadata preserves full structure identity and rejects unrelated paper and wrong worlds", () => {
  const mapTarget = {
    seed: context.seed, generatorVersion: 4, dimension: "overworld",
    structureId: `structure:v1:${encodeURIComponent(JSON.stringify(context.seed))}:overworld:buried_treasure:0:-1`,
    x: 12, y: -14, z: -16,
  };
  const chart = stack(ITEM.TREASURE_MAP, { mapTarget });
  assert.deepEqual(normalizeStack(JSON.parse(JSON.stringify(chart)), context), chart);
  assert.deepEqual(chart.data.mapTarget, mapTarget);
  assert.throws(() => normalizeStackData(ITEM.PAPER, chart.data, context), RangeError);
  assert.throws(() => normalizeStack(chart, createWorldContext({ seed: "different-world", generatorVersion: 4 })), RangeError);
  for (const id of [ITEM.TREASURE_MAP, ITEM.ENCHANTED_BOOK, ITEM.POTION, ITEM.SPLASH_POTION, ITEM.OAK_BOAT])
    assert.equal(isValidStack({ id, count: 2 }), false, `${getItem(id).name} must remain singleton`);
});
