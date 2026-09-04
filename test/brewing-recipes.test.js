import assert from "node:assert/strict";
import test from "node:test";
import { normalizePotionData } from "../src/item-stack-data.js";
import {
  BREWABLE_POTIONS,
  BREWING_CONTENT_REQUIREMENTS,
  BREWING_CRAFTING_REQUIREMENTS,
  BREWING_INGREDIENTS,
  brewPotionData,
  normalizeSupportedPotion,
  POTION_DRINK_SECONDS,
  potionEffect,
} from "../src/potion-rules.js";

const potion = (id, flags = {}) =>
  normalizePotionData({ id, form: "drinkable", ...flags });

test("water progresses through awkward to effect, then extension or enhancement but never both", () => {
  const water = potion("water");
  const awkward = brewPotionData(water, "nether_wart");
  const speed = brewPotionData(awkward, "sugar");
  const long = brewPotionData(speed, "redstone");
  const strong = brewPotionData(speed, "glowstone_dust");
  assert.deepEqual(water, potion("water"), "matching is pure");
  assert.deepEqual(awkward, potion("awkward"));
  assert.deepEqual(speed, potion("swiftness"));
  assert.equal(potionEffect(long).durationTicks, 9600);
  assert.deepEqual(potionEffect(strong), {
    id: "speed", amplifier: 1, durationTicks: 1800,
  });
  assert.equal(brewPotionData(long, "glowstone_dust"), null);
  assert.equal(brewPotionData(strong, "redstone"), null);
  assert.equal(brewPotionData(long, "redstone"), null);
  assert.equal(brewPotionData(strong, "glowstone_dust"), null);
});

test("every supported awkward-potion ingredient produces its declared Java effect and duration", () => {
  for (const [ingredient, id, effect, durationTicks] of [
    ["pufferfish", "water_breathing", "water_breathing", 3600],
    ["golden_carrot", "night_vision", "night_vision", 3600],
    ["magma_cream", "fire_resistance", "fire_resistance", 3600],
    ["sugar", "swiftness", "speed", 3600],
    ["blaze_powder", "strength", "strength", 3600],
    ["glistering_melon_slice", "healing", "instant_health", 0],
    ["ghast_tear", "regeneration", "regeneration", 900],
    ["spider_eye", "poison", "poison", 900],
  ]) {
    const result = brewPotionData(potion("awkward"), ingredient);
    assert.deepEqual(result, potion(id));
    assert.deepEqual(potionEffect(result), { id: effect, amplifier: 0, durationTicks });
  }
});

test("lead content and crafting requirements stay symbolic with explicit bottle/use/fuel capabilities", () => {
  assert.equal(POTION_DRINK_SECONDS, 1.6);
  assert.equal(BREWING_CONTENT_REQUIREMENTS.stand.inventoryOwner, "ProgressionStations");
  assert.equal(BREWING_CONTENT_REQUIREMENTS.fuel.brewingFuelOperations, 20);
  assert.equal(BREWING_CONTENT_REQUIREMENTS.use.drinkable.alwaysConsumable, true);
  assert.equal(BREWING_CONTENT_REQUIREMENTS.use.drinkable.survivalRemainder, "GLASS_BOTTLE");
  assert.equal(BREWING_CONTENT_REQUIREMENTS.use.splash.survivalRemainder, null);
  assert.deepEqual(BREWING_CONTENT_REQUIREMENTS.bottles.map(({ symbol, stackSize }) => [symbol, stackSize]), [
    ["GLASS_BOTTLE", 64], ["POTION", 1], ["SPLASH_POTION", 1],
  ]);
  assert.deepEqual(BREWING_CRAFTING_REQUIREMENTS.map(({ output, count }) => [output, count]), [
    ["BREWING_STAND", 1], ["GLASS_BOTTLE", 3], ["BLAZE_POWDER", 2], ["SUGAR", 1],
    ["FERMENTED_SPIDER_EYE", 1], ["MAGMA_CREAM", 1], ["GOLDEN_CARROT", 1],
    ["GLISTERING_MELON_SLICE", 1],
  ]);
});

test("corruption preserves valid modifiers, drops unsupported duration, and rejects removed/Bedrock paths", () => {
  assert.deepEqual(
    brewPotionData(potion("swiftness", { extended: true }), "fermented_spider_eye"),
    potion("slowness", { extended: true })
  );
  assert.deepEqual(
    brewPotionData(potion("poison", { extended: true }), "fermented_spider_eye"),
    potion("harming")
  );
  for (const id of ["healing", "poison"])
    assert.deepEqual(
      brewPotionData(potion(id, { strong: true }), "fermented_spider_eye"),
      potion("harming", { strong: true })
    );
  for (const input of [
    potion("swiftness", { strong: true }),
    potion("strength", { strong: true }),
    potion("mundane"), potion("thick"), potion("awkward"),
    potion("regeneration"), potion("fire_resistance"), potion("water_breathing"),
    potion("night_vision"),
  ])
    assert.equal(brewPotionData(input, "fermented_spider_eye"), null);
  assert.deepEqual(
    brewPotionData(potion("water"), "fermented_spider_eye"),
    potion("weakness")
  );
  const strongSlow = brewPotionData(potion("slowness"), "glowstone_dust");
  assert.equal(potionEffect(strongSlow).amplifier, 3, "Slowness is IV, not II");
});

test("splash conversion preserves payload flags and brewing order, without a Bedrock duration penalty", () => {
  const speed = potion("swiftness");
  const extendThenSplash = brewPotionData(brewPotionData(speed, "redstone"), "gunpowder");
  const splashThenExtend = brewPotionData(brewPotionData(speed, "gunpowder"), "redstone");
  assert.deepEqual(extendThenSplash, splashThenExtend);
  assert.equal(potionEffect(splashThenExtend).durationTicks, 9600);
  assert.equal(brewPotionData(splashThenExtend, "gunpowder"), null);
  assert.deepEqual(
    brewPotionData(potion("water", { form: "splash" }), "nether_wart"),
    potion("awkward", { form: "splash" })
  );
  assert.equal(brewPotionData(splashThenExtend, "dragons_breath"), null);
});

test("water base dead ends and incompatible effect ingredients never imply a useful recipe", () => {
  assert.deepEqual(brewPotionData(potion("water"), "redstone"), potion("mundane"));
  assert.deepEqual(brewPotionData(potion("water"), "glowstone_dust"), potion("thick"));
  assert.deepEqual(brewPotionData(potion("water"), "spider_eye"), potion("mundane"));
  for (const ingredient of ["golden_carrot", "pufferfish"])
    assert.equal(brewPotionData(potion("water"), ingredient), null);
  assert.equal(brewPotionData(potion("mundane"), "nether_wart"), null);
  assert.equal(brewPotionData(potion("thick"), "sugar"), null);
  assert.equal(brewPotionData(potion("healing"), "redstone"), null);
  assert.equal(brewPotionData(potion("night_vision"), "glowstone_dust"), null);
  assert.equal(brewPotionData(potion("fire_resistance"), "sugar"), null);
});

test("all produced recipe payloads use the canonical schema; malformed/unsupported forms cannot be transformed", () => {
  for (const id of Object.keys(BREWABLE_POTIONS)) {
    for (const ingredient of Object.values(BREWING_INGREDIENTS)) {
      const output = brewPotionData(potion(id), ingredient);
      if (output) assert.deepEqual(output, normalizePotionData(output));
    }
  }
  for (const invalid of [
    { id: "strength", form: "drinkable", strong: true, extended: true },
    { id: "healing", form: "drinkable", extended: true },
    { id: "water_breathing", form: "drinkable", strong: true },
    { id: "speed", form: "drinkable" },
    { id: "strength", form: "drinkable", duration: 9999 },
    { id: "strength", form: "drinkable", strong: 1 },
    { id: "strength", form: "lingering" },
    { id: "luck", form: "drinkable" },
    { id: "turtle_master", form: "drinkable" },
    null,
  ]) {
    assert.equal(brewPotionData(invalid, "gunpowder"), null);
    assert.throws(() => normalizeSupportedPotion(invalid), RangeError);
  }
  assert.equal(brewPotionData(potion("awkward"), { toString: () => "sugar" }), null);
  const accessor = { form: "drinkable" };
  Object.defineProperty(accessor, "id", { enumerable: true, get() { throw new Error("must not evaluate"); } });
  assert.equal(brewPotionData(accessor, "sugar"), null);
});

test("Java poison and regeneration enhanced durations feed distinct periodic plans", () => {
  // Regression guard against rounded tooltips and Bedrock's 450-tick Poison II.
  assert.equal(potionEffect(potion("poison", { strong: true })).durationTicks, 432);
  assert.equal(potionEffect(potion("regeneration", { strong: true })).durationTicks, 450);
  assert.equal(potionEffect(potion("poison", { extended: true })).durationTicks, 1800);
  assert.equal(potionEffect(potion("healing", { strong: true })).durationTicks, 0);
});
