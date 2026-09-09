import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { harvestDrops } from "../src/gameplay-harvest.js";
import { getItem, ITEM } from "../src/items.js";

const tool = (fortune = 0, id = ITEM.DIAMOND_PICKAXE, enchantments = {}) => ({
  id, count: 1, durability: getItem(id).durability,
  ...(fortune || Object.keys(enchantments).length ? {
    data: { version: 1, enchantments: { ...(fortune ? { fortune } : {}), ...enchantments } },
  } : {}),
});
const rolls = (values) => {
  let used = 0;
  return {
    random() {
      assert.ok(used < values.length, "harvesting cannot draw beyond its declared samples");
      return values[used++];
    },
    get used() { return used; },
  };
};

for (const [name, item, base] of [
  ["COAL", ITEM.COAL, 1], ["IRON", ITEM.RAW_IRON, 1],
  ["COPPER", ITEM.RAW_COPPER, 2], ["GOLD", ITEM.RAW_GOLD, 1],
  ["DIAMOND", ITEM.DIAMOND, 1], ["EMERALD", ITEM.EMERALD, 1],
  ["LAPIS", ITEM.LAPIS, 4],
]) {
  for (const host of ["", "DEEPSLATE_"]) {
    test(`${host}${name}: Fortune changes the real ore yield without changing its base`, () => {
      const block = BLOCK[`${host}${name}_ORE`];
      for (const fortune of [0, 1, 2, 3]) {
        const random = rolls(fortune ? [0.999] : []);
        assert.deepEqual(harvestDrops(block, { stack: tool(fortune), random: random.random }), [
          { id: item, count: base * (fortune ? fortune + 1 : 1) },
        ]);
        assert.equal(random.used, Number(fortune > 0));
      }
    });
  }
}

test("Fortune ore outcomes retain both multiplier-one intervals", () => {
  const expected = [1, 1, 2, 3, 4];
  for (const [index, sample] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
    assert.deepEqual(harvestDrops(BLOCK.DIAMOND_ORE, {
      stack: tool(3), random: () => sample,
    }), [{ id: ITEM.DIAMOND, count: expected[index] }]);
  }
});

for (const block of [BLOCK.REDSTONE_ORE, BLOCK.DEEPSLATE_REDSTONE_ORE]) {
  test(`redstone ${block} uses an additive bonus, not an ore multiplier`, () => {
    for (const fortune of [0, 1, 2, 3]) {
      const random = rolls(fortune ? [0.999] : []);
      assert.deepEqual(harvestDrops(block, { stack: tool(fortune), random: random.random }), [
        { id: ITEM.REDSTONE, count: 4 + fortune },
      ]);
      assert.equal(random.used, Number(fortune > 0));
    }
  });
}

test("Nether gold and quartz use their registered resources and bounded ore bonuses", () => {
  const gold = rolls([0.999, 0.999]);
  assert.deepEqual(harvestDrops(BLOCK.NETHER_GOLD_ORE, {
    stack: tool(3), random: gold.random,
  }), [{ id: ITEM.GOLD_NUGGET, count: 24 }]);
  assert.equal(gold.used, 2);
  const quartz = rolls([0.999]);
  assert.deepEqual(harvestDrops(BLOCK.NETHER_QUARTZ_ORE, {
    stack: tool(3), random: quartz.random,
  }), [{ id: ITEM.QUARTZ, count: 4 }]);
  assert.equal(quartz.used, 1);
});

for (const [block, item, maximum] of [
  [BLOCK.GLOWSTONE, ITEM.GLOWSTONE_DUST, 4],
  [BLOCK.SEA_LANTERN, ITEM.PRISMARINE_CRYSTALS, 5],
  [BLOCK.MELON, ITEM.MELON_SLICE, 9],
]) {
  test(`Fortune material ${block} preserves its own cap after the base-count roll`, () => {
    const random = rolls([0.999, 0.999]);
    assert.deepEqual(harvestDrops(block, { stack: tool(3), random: random.random }), [
      { id: item, count: maximum },
    ]);
    assert.equal(random.used, 2);
    const base = rolls([0]);
    const baseCount = harvestDrops(block, { stack: tool(), random: base.random })[0].count;
    const bonus = rolls([0, 0.999]);
    assert.equal(harvestDrops(block, { stack: tool(3), random: bonus.random })[0].count,
      Math.min(maximum, baseCount + 3));
    assert.equal(base.used, 1);
    assert.equal(bonus.used, 2);
  });
}

test("Fortune gravel probabilities include guaranteed flint at level three", () => {
  for (const [fortune, chance] of [[0, 0.1], [1, 1 / 7], [2, 0.25], [3, 1]]) {
    const stack = tool(fortune, ITEM.DIAMOND_SHOVEL);
    assert.deepEqual(harvestDrops(BLOCK.GRAVEL, { stack, random: () => chance - 1e-8 }),
      [{ id: ITEM.FLINT, count: 1 }]);
    if (chance < 1)
      assert.deepEqual(harvestDrops(BLOCK.GRAVEL, { stack, random: () => chance }),
        [{ id: BLOCK.GRAVEL, count: 1 }]);
  }
});

test("Silk Touch, insufficient tiers, Creative and explosions cannot borrow Fortune", () => {
  const untouched = () => assert.fail("this branch must not sample a Fortune bonus");
  assert.deepEqual(harvestDrops(BLOCK.DIAMOND_ORE, {
    stack: tool(0, ITEM.DIAMOND_PICKAXE, { silk_touch: 1 }), random: untouched,
  }), [{ id: BLOCK.DIAMOND_ORE, count: 1 }]);
  assert.deepEqual(harvestDrops(BLOCK.DIAMOND_ORE, {
    stack: tool(3, ITEM.WOOD_PICKAXE), random: untouched,
  }), []);
  assert.deepEqual(harvestDrops(BLOCK.DIAMOND_ORE, {
    stack: tool(3), mode: "creative", random: untouched,
  }), []);
  assert.deepEqual(harvestDrops(BLOCK.DIAMOND_ORE, {
    stack: tool(3), explosion: true, random: untouched,
  }), [{ id: ITEM.DIAMOND, count: 1 }]);
  assert.deepEqual(harvestDrops(BLOCK.OAK_SLAB, {
    stack: tool(3), dropCount: 2, random: untouched,
  }), [{ id: BLOCK.OAK_SLAB, count: 2 }]);
  assert.deepEqual(harvestDrops(BLOCK.ANCIENT_DEBRIS, {
    stack: tool(3), random: untouched,
  }), [{ id: BLOCK.ANCIENT_DEBRIS, count: 1 }]);
});
