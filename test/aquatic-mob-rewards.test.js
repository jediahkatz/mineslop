import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ecologyDeathReward } from "../src/expansion-ecology.js";
import { ingredientMobLoot, isIngredientMob } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";

const world = Object.freeze({
  seed: "aquatic-loot-regression", dimension: "overworld", generatorVersion: 7,
});

test("3,584 existing spider/ghast quotes keep their pre-change v1 fingerprint", () => {
  const quotes = [];
  for (let generatorVersion = 1; generatorVersion <= 7; generatorVersion++)
    for (const kind of ["spider", "ghast"])
      for (let index = 0; index < 128; index++)
        for (const direct of [false, true])
          quotes.push(ingredientMobLoot({
            seed: "loot-compatibility", dimension: kind === "ghast" ? "nether" : "overworld",
            generatorVersion,
          }, { kind, id: `legacy:${index}` }, direct));
  assert.equal(quotes.length, 3584);
  assert.equal(createHash("sha256").update(JSON.stringify(quotes)).digest("hex"),
    "ca35b7c7328dd35fc82b32bf939cc7201b69be55609a7a94f533039d1ac5de9d");
});

for (const [kind, resource] of [["cod", ITEM.RAW_COD], ["squid", ITEM.INK_SAC]])
  test(`${kind} quotes retain its real resource and 1–3 direct-player XP without AI rolls`, () => {
    const counts = new Set(), experience = new Set();
    for (let index = 0; index < 600; index++) {
      const mob = Object.freeze({ kind, id: `aquatic:${index}` });
      assert.equal(isIngredientMob(mob), true);
      const quote = ingredientMobLoot(world, mob, true);
      const environment = ingredientMobLoot(world, mob, false);
      assert.deepEqual(ingredientMobLoot(world, mob, true), quote);
      assert.deepEqual(environment.drops, quote.drops);
      assert.equal(environment.experience, 0);
      assert.equal(quote.drops.length, 1);
      assert.equal(quote.drops[0].id, resource);
      assert.ok(Number.isInteger(quote.drops[0].count));
      assert.ok(quote.drops[0].count >= 1 && quote.drops[0].count <= (kind === "cod" ? 1 : 3));
      assert.ok(quote.experience >= 1 && quote.experience <= 3);
      assert.equal(Object.isFrozen(quote), true);
      assert.equal(Object.isFrozen(quote.drops), true);
      assert.equal(Object.isFrozen(quote.drops[0]), true);
      counts.add(quote.drops[0].count);
      experience.add(quote.experience);
    }
    assert.deepEqual(counts, new Set(kind === "cod" ? [1] : [1, 2, 3]));
    assert.deepEqual(experience, new Set([1, 2, 3]));
  });

test("aquatic ownership remains separate from the ecology-sidecar species", () => {
  for (const kind of ["dolphin", "turtle", "drowned", "guardian", "elder_guardian", "villager"])
    assert.equal(isIngredientMob({ kind }), false);
  for (const invalid of [null, {}, { kind: "__proto__" }, { kind: "constructor" }])
    assert.equal(isIngredientMob(invalid), false);
});

test("drowned quotes retain flesh on any death and a stable 11% player-only copper chance", () => {
  const fleshCounts = new Set();
  let copper = 0;
  for (let index = 0; index < 1600; index++) {
    const identity = Object.freeze({ ...world, id: `aquatic:${index}` });
    const quote = ecologyDeathReward("drowned", true, identity);
    const environment = ecologyDeathReward("drowned", false, identity);
    assert.deepEqual(ecologyDeathReward("drowned", true, identity), quote);
    assert.equal(quote.experience, 5);
    assert.equal(environment.experience, 0);
    assert.deepEqual(environment.drops, quote.drops.filter((drop) => drop.name !== "COPPER_INGOT"));
    const flesh = quote.drops.find((drop) => drop.name === "ROTTEN_FLESH")?.count ?? 0;
    assert.ok(Number.isInteger(flesh) && flesh >= 0 && flesh <= 2);
    fleshCounts.add(flesh);
    for (const drop of quote.drops) {
      assert.ok(["ROTTEN_FLESH", "COPPER_INGOT"].includes(drop.name));
      assert.ok(drop.count > 0, "zero-count quotes must not enter a retained reward sink");
      assert.equal(Object.isFrozen(drop), true);
      if (drop.name === "COPPER_INGOT") {
        assert.equal(drop.count, 1);
        copper++;
      }
    }
    assert.equal(Object.isFrozen(quote.drops), true);
  }
  assert.deepEqual(fleshCounts, new Set([0, 1, 2]));
  assert.ok(copper > 130 && copper < 220, `11% copper frequency: ${copper}/1600`);
});

for (const [kind, name, maximum] of [["dolphin", "RAW_COD", 1], ["turtle", "SEAGRASS", 2]])
  test(`${kind} adult death keeps ordinary resources distinct from turtle growth scutes`, () => {
    const counts = new Set(), experience = new Set();
    for (let index = 0; index < 600; index++) {
      const identity = Object.freeze({ ...world, id: `aquatic:${index}`, baby: false });
      const quote = ecologyDeathReward(kind, true, identity);
      const environment = ecologyDeathReward(kind, false, identity);
      assert.deepEqual(ecologyDeathReward(kind, true, identity), quote);
      assert.deepEqual(environment.drops, quote.drops);
      assert.equal(environment.experience, 0);
      assert.ok(quote.drops.length <= 1);
      assert.ok(quote.experience >= 1 && quote.experience <= 3);
      const count = quote.drops[0]?.count ?? 0;
      assert.ok(Number.isInteger(count) && count >= 0 && count <= maximum);
      if (count) assert.equal(quote.drops[0].name, name);
      counts.add(count);
      experience.add(quote.experience);
    }
    assert.deepEqual(counts, new Set(Array.from({ length: maximum + 1 }, (_, index) => index)));
    assert.deepEqual(experience, new Set([1, 2, 3]));
  });

test("baby turtle deaths cannot pay scutes, seagrass or experience", () => {
  for (let index = 0; index < 100; index++)
    assert.deepEqual(ecologyDeathReward("turtle", true, {
      ...world, id: `aquatic:${index}`, baby: true,
    }), { drops: [], experience: 0 });
});

test("guardian, elder and blaze reward tables remain unchanged", () => {
  assert.deepEqual(ecologyDeathReward("guardian", true), {
    drops: [{ name: "PRISMARINE_SHARD", count: 2 }, { name: "PRISMARINE_CRYSTALS", count: 1 }],
    experience: 5,
  });
  assert.deepEqual(ecologyDeathReward("elder_guardian", true), {
    drops: [
      { name: "WET_SPONGE", count: 1 }, { name: "PRISMARINE_SHARD", count: 3 },
      { name: "PRISMARINE_CRYSTALS", count: 2 },
    ],
    experience: 10,
  });
  assert.deepEqual(ecologyDeathReward("blaze", false), { drops: [], experience: 0 });
  assert.deepEqual(ecologyDeathReward("blaze", true), {
    drops: [{ name: "BLAZE_ROD", count: 1 }], experience: 10,
  });
});
