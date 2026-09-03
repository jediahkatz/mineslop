import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { BLOCK_STATE, FLUID, isValidCell, stateMaskFor } from "../src/block-state.js";
import {
  BOAT_ITEM_REQUIREMENTS,
  BOAT_WOODS,
  boatWoodForItem,
} from "../src/boat-definitions.js";
import { createBrewingCatalog } from "../src/brewing.js";
import {
  BOAT_RECIPE_PLANKS,
  CONTENT_ACQUISITION_HOOKS,
  ENCHANTING_RESOURCES,
} from "../src/content-bindings.js";
import { ITEM_IDS } from "../src/content-ids.js";
import {
  equipmentProfile,
  matchesRepairIngredient,
} from "../src/enchantment-domain.js";
import {
  ECOLOGY_CONTENT_PROPOSALS,
  ECOLOGY_SPECIES,
} from "../src/expansion-ecology.js";
import { FISHING_ITEM_REQUIREMENTS } from "../src/fishing-loot.js";
import { armorItemId, toolItemId } from "../src/gear-content.js";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  TOOL_KINDS,
  TOOL_MATERIALS,
  getArmorSpec,
  getToolSpec,
} from "../src/gear.js";
import { getItem, ITEM, ITEMS } from "../src/items.js";
import { LOOT_TABLES, missingLootItems } from "../src/loot-tables.js";
import { BREWING_CONTENT_REQUIREMENTS } from "../src/potion-rules.js";
import {
  PROGRESSION_ITEM_CAPABILITIES,
  missingProgressionItems,
} from "../src/progression-items.js";
import { progressionStationKind } from "../src/progression-station-state.js";
import { ORDINARY_ITEM_RESOURCE_LOCATIONS } from "../src/resource-content.js";
import { requireTerrainV4Content } from "../src/terrain-v4-content.js";
import {
  TRADING_JOBSITES,
  TRADING_PROFESSIONS,
  missingTradeItems,
} from "../src/trading-offers.js";
import { WOOD_FAMILIES } from "../src/wood-content.js";

const realItem = (symbol) => {
  assert.ok(Object.hasOwn(ITEM, symbol), `Missing canonical symbol ${symbol}`);
  const item = getItem(ITEM[symbol]);
  assert.ok(item, `Missing actual catalog entry ${symbol}`);
  return item;
};

test("every vehicle and fishing requirement binds to its actual immutable catalog entry", () => {
  assert.deepEqual(
    WOOD_FAMILIES.filter(({ vehicle }) => vehicle !== null).map(({ key }) => key).sort(),
    [...BOAT_WOODS].sort()
  );
  for (const requirement of [...BOAT_ITEM_REQUIREMENTS, ...FISHING_ITEM_REQUIREMENTS]) {
    const { key, name, recipe, ...capabilities } = requirement;
    const item = realItem(key);
    assert.equal(item.name.toLowerCase(), name.toLowerCase());
    if (recipe) assert.equal(recipe.station, "table");
    for (const [capability, value] of Object.entries(capabilities))
      assert.deepEqual(item[capability], value, `${key}.${capability}`);
    assert.ok(Object.isFrozen(item));
  }
  for (const requirement of BOAT_ITEM_REQUIREMENTS) {
    const item = realItem(requirement.key);
    assert.equal(boatWoodForItem(item.id), requirement.wood);
    assert.equal(BOAT_RECIPE_PLANKS[requirement.wood], ITEM[requirement.recipe.ingredient]);
  }
  assert.equal(BOAT_RECIPE_PLANKS.oak, BLOCK.PLANKS);
  assert.equal(boatWoodForItem(ITEM.FISHING_ROD), null);
  for (const invalid of ["OAK_PLANKS", "CRIMSON_BOAT", "WARPED_BOAT", "BAMBOO_BOAT", "COD", "SALMON"])
    assert.equal(Object.hasOwn(ITEM, invalid), false, invalid);
});

test("every wood construction declares valid shape states, connection groups and waterlogging", () => {
  const S = BLOCK_STATE;
  const states = {
    planks: 0, slab: S.TOP | S.DOUBLE, stairs: S.FACING_MASK | S.TOP,
    door: S.FACING_MASK | S.OPEN | S.HINGE_RIGHT | S.PART,
    trapdoor: S.FACING_MASK | S.TOP | S.OPEN,
    fence: 0, fence_gate: S.FACING_MASK | S.OPEN,
  };
  const waterlogged = new Set(["slab", "stairs", "trapdoor", "fence"]);
  for (const family of WOOD_FAMILIES) {
    for (const [part, mask] of Object.entries(states)) {
      const id = family[part];
      const block = BLOCKS[id];
      assert.equal(block.shape, part === "planks" ? "cube" : part);
      assert.equal(block.drop, id, `${family.key}.${part}`);
      assert.equal(block.solid, true);
      assert.equal(stateMaskFor(id), mask);
      assert.equal(block.fireproof, family.fireproof);
      assert.equal(isValidCell({ id, state: 0, fluid: FLUID.NONE }), true);
      assert.equal(isValidCell({ id, state: 0, fluid: FLUID.WATER_SOURCE }), waterlogged.has(part));
      assert.equal(isValidCell({ id, state: 0, fluid: FLUID.WATER_1 }), false);
    }
    assert.equal(BLOCKS[family.fence].fenceGroup, "wood");
    assert.equal(BLOCKS[family.fence_gate].fenceGroup, "wood");
    assert.equal(BLOCKS[family.door].multipart, "door");
    assert.equal(isValidCell({ id: family.door, state: S.OPEN | S.PART | S.HINGE_RIGHT | 2 }), true);
    assert.equal(isValidCell({ id: family.slab, state: S.DOUBLE, fluid: FLUID.WATER_SOURCE }), false);
    assert.equal(isValidCell({ id: family.slab, state: S.DOUBLE | S.TOP }), false);
  }
  assert.equal(stateMaskFor(BLOCK.BAMBOO_BLOCK), S.AXIS_X | S.AXIS_Z);
  assert.equal(isValidCell({ id: BLOCK.BAMBOO_BLOCK, state: S.AXIS_X }), true);
  assert.equal(isValidCell({ id: ITEM.OAK_BOAT }), false);
});

test("all progression, loot, trade and ecology symbols have real required capabilities", () => {
  assert.deepEqual(missingProgressionItems(Object.keys(PROGRESSION_ITEM_CAPABILITIES)), []);
  for (const role of Object.keys(LOOT_TABLES))
    assert.deepEqual(missingLootItems(role), [], role);
  for (const profession of TRADING_PROFESSIONS) {
    assert.deepEqual(missingTradeItems(profession), [], profession);
    const jobSite = realItem(TRADING_JOBSITES[profession]);
    assert.equal(BLOCKS[jobSite.id]?.jobSite, profession);
  }
  for (const symbol of [
    ...Object.keys(ECOLOGY_CONTENT_PROPOSALS.newItems),
    ...Object.keys(ECOLOGY_CONTENT_PROPOSALS.newBlocks),
    ...ECOLOGY_CONTENT_PROPOSALS.existingContent,
    "INK_SAC", "NAUTILUS_SHELL", "ROTTEN_FLESH", "TROPICAL_FISH", "PUFFERFISH",
  ])
    realItem(symbol);
  for (const symbol of ECOLOGY_SPECIES.dolphin.foodNames)
    assert.ok(realItem(symbol).food > 0, symbol);
  for (const symbol of ECOLOGY_SPECIES.turtle.foodNames)
    assert.equal(realItem(symbol).blockId, BLOCK.SEAGRASS);
  assert.equal(BLOCKS[BLOCK.TURTLE_EGG].ecologyBlock, "turtle_egg");
  assert.equal(BLOCKS[BLOCK.TURTLE_EGG].solid, false);
  assert.equal(BLOCKS[BLOCK.TURTLE_EGG].drop, BLOCK.AIR, "Scutes are growth rewards, not egg/kill drops");
  for (const [symbol, hook] of Object.entries(CONTENT_ACQUISITION_HOOKS)) {
    realItem(symbol);
    assert.ok(hook.source && hook.use);
    assert.equal(hook.runtimeBindingRequired, true, "A catalog hook is not completed gameplay");
  }
  assert.doesNotThrow(() => requireTerrainV4Content());
});

test("the brewing owner accepts the actual bottles, roles, stand and distinct fuel", () => {
  const catalog = createBrewingCatalog(ITEM);
  const requirements = BREWING_CONTENT_REQUIREMENTS;
  assert.equal(BLOCKS[BLOCK[requirements.stand.symbol]].station, requirements.stand.station);
  for (const { symbol, ...capabilities } of requirements.bottles) {
    const item = realItem(symbol);
    for (const [key, value] of Object.entries(capabilities))
      assert.equal(item[key], value, `${symbol}.${key}`);
  }
  assert.equal(catalog.emptyBottle, ITEM.GLASS_BOTTLE);
  assert.deepEqual(catalog.bottles, { drinkable: ITEM.POTION, splash: ITEM.SPLASH_POTION });
  assert.equal(catalog.fuelItem, ITEM.BLAZE_POWDER);
  assert.equal(realItem(requirements.fuel.symbol).brewingFuelOperations, requirements.fuel.brewingFuelOperations);
  for (const [symbol, role] of Object.entries(requirements.ingredients)) {
    assert.equal(realItem(symbol).brewingIngredient, role);
    assert.equal(catalog.ingredients[role], ITEM[symbol]);
    assert.equal(catalog.ingredientById[ITEM[symbol]], role);
  }
  const identities = [catalog.emptyBottle, ...Object.values(catalog.bottles), ...Object.values(catalog.ingredients)];
  assert.equal(new Set(identities).size, identities.length);
  assert.notEqual(ITEM.GLOWSTONE_DUST, BLOCK.GLOWSTONE);
  assert.notEqual(ITEM.MELON_SLICE, BLOCK.MELON);
  assert.equal(realItem("POTION").alwaysConsumable, requirements.use.drinkable.alwaysConsumable);
  assert.equal(realItem("POTION").useSeconds, requirements.use.drinkable.seconds);
  assert.equal(realItem("POTION").useRemainder, ITEM[requirements.use.drinkable.survivalRemainder]);
});

test("all 35 tiered tools and 29 armor pieces use gear.js without invented numeric projections", () => {
  const toolIds = [];
  const armorIds = [];
  const checkSpec = (id, spec, material) => {
    const item = getItem(id);
    assert.ok(item, `${material} ${spec.tool ?? spec.slot}`);
    assert.equal(item.stackSize, 1);
    assert.equal(item.gearMaterial, material);
    for (const [key, value] of Object.entries(spec))
      assert.deepEqual(item[key], value, `${item.name}.${key}`);
    const profile = equipmentProfile(id);
    assert.equal(profile.durability, spec.durability);
    assert.equal(profile.enchantability, spec.enchantability);
    assert.deepEqual(profile.repairIngredients, spec.repairIngredients);
    for (const reference of spec.repairIngredients) {
      const matches = ITEMS.filter((candidate) => reference.startsWith("#")
        ? candidate.tags?.includes(reference.slice(1))
        : candidate.resourceLocation === reference);
      assert.ok(matches.length > 0, `${item.name} requires obtainable ${reference}`);
      for (const materialItem of matches)
        assert.equal(matchesRepairIngredient({ id: materialItem.id, count: 1 }, [reference]), true);
    }
  };
  for (const material of Object.keys(TOOL_MATERIALS)) {
    for (const tool of TOOL_KINDS) {
      const id = toolItemId(material, tool);
      const spec = getToolSpec(material, tool);
      toolIds.push(id);
      checkSpec(id, spec, material);
      assert.equal(getItem(id).tier, spec.harvestLevel + 1, "Legacy tier is a harvest-level projection");
      assert.equal(getItem(id).damage, spec.attackDamage);
      assert.equal(getItem(id).miningEfficiency, spec.miningEfficiency);
    }
  }
  for (const material of Object.keys(ARMOR_MATERIALS)) {
    for (const slot of Object.keys(ARMOR_MATERIALS[material].armorPoints)) {
      assert.ok(ARMOR_SLOTS.includes(slot));
      const id = armorItemId(material, slot);
      armorIds.push(id);
      checkSpec(id, getArmorSpec(material, slot), material);
      assert.equal(getItem(id).equipmentSlot, slot);
    }
  }
  assert.equal(toolIds.length, 35);
  assert.equal(armorIds.length, 29);
  assert.equal(new Set([...toolIds, ...armorIds]).size, 64);
  assert.equal(armorItemId("iron", "chest"), 298, "The shipped IRON_ARMOR is the chestplate");
  assert.equal(armorItemId("turtle", "chest"), undefined);
  assert.equal(realItem("SHEARS").durability, 238);
});

test("canonical resource references and repair tags identify the true materials without aliases", () => {
  for (const [symbol, id] of Object.entries(ITEM_IDS)) {
    const item = realItem(symbol);
    assert.equal(item.resourceLocation, ORDINARY_ITEM_RESOURCE_LOCATIONS[id], symbol);
    assert.match(item.resourceLocation, /^minecraft:[a-z0-9_]+$/);
  }
  for (const family of WOOD_FAMILIES) {
    assert.equal(getItem(family.planks).resourceLocation, `minecraft:${family.key}_planks`);
    assert.deepEqual(getItem(family.planks).tags, ["minecraft:planks"]);
    assert.equal(matchesRepairIngredient({ id: family.planks, count: 1 }, ["#minecraft:planks"]), true);
    assert.equal(matchesRepairIngredient({ id: family.source, count: 1 }, ["#minecraft:planks"]), false);
  }
  assert.equal(realItem("SCUTE").resourceLocation, "minecraft:turtle_scute");
  assert.equal(realItem("NETHERITE_UPGRADE_TEMPLATE").resourceLocation, "minecraft:netherite_upgrade_smithing_template");
  assert.equal(realItem("NETHERITE_UPGRADE_TEMPLATE").smithingTemplate, "netherite_upgrade");
  assert.equal(realItem("CARROT").plantBlock, BLOCK.CARROT_CROP);
  assert.equal(BLOCKS[BLOCK.CARROT_CROP].resourceLocation, "minecraft:carrots");
  assert.equal(realItem("NETHER_WART").plantBlock, BLOCK.NETHER_WART_CROP);
});

test("station and harvesting declarations expose real resources while leaving transactions to their owners", () => {
  assert.deepEqual(ENCHANTING_RESOURCES, { lapis: ITEM.LAPIS, enchantedBook: ITEM.ENCHANTED_BOOK });
  assert.equal(realItem("LAPIS").enchantingReagent, "lapis");
  assert.equal(BLOCKS[BLOCK.BOOKSHELF].enchantingPower, 1);
  for (const [id, station] of [
    [BLOCK.ENCHANTING_TABLE, "enchanting"],
    [BLOCK.SMITHING_TABLE, "smithing"],
    [BLOCK.BREWING_STAND, "brewing"],
    [BLOCK.ANVIL, "anvil"],
    [BLOCK.CHIPPED_ANVIL, "anvil"],
    [BLOCK.DAMAGED_ANVIL, "anvil"],
  ]) {
    assert.equal(BLOCKS[id].station, station);
    assert.equal(progressionStationKind(id), station);
  }
  assert.equal(BLOCKS[BLOCK.BARREL].containerSlots, 27);
  assert.equal(BLOCKS[BLOCK.CONDUIT].waterDevice, "conduit");
  for (const [index, id] of [BLOCK.ANVIL, BLOCK.CHIPPED_ANVIL, BLOCK.DAMAGED_ANVIL].entries()) {
    assert.equal(BLOCKS[id].station, "anvil");
    assert.equal(BLOCKS[id].anvilStage, index);
    assert.equal(BLOCKS[id].nextDamagedBlock, [BLOCK.CHIPPED_ANVIL, BLOCK.DAMAGED_ANVIL, null][index]);
  }
  for (const [block, drop, counts] of [
    [BLOCK.GLOWSTONE, ITEM.GLOWSTONE_DUST, [2, 4]],
    [BLOCK.MELON, ITEM.MELON_SLICE, [3, 7]],
  ]) {
    assert.equal(BLOCKS[block].drop, drop);
    assert.deepEqual(BLOCKS[block].dropCount, counts);
    assert.equal(BLOCKS[block].silkDrop, block);
  }
});
