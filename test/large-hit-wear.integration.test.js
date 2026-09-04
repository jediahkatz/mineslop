import assert from "node:assert/strict";
import test from "node:test";
import { boundedDurabilityWear } from "../src/bounded-durability-wear.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { durabilityLoss, durabilityUseChance } from "../src/enchantment-effects.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { liveArmorFixture } from "./live-armor-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

function equip(f, pieces, unbreaking) {
  f.armor("iron", unbreaking ? { unbreaking: 3 } : {});
  f.editInventory((owned) => {
    for (const slot of ["head", "chest", "legs", "feet"].slice(pieces))
      owned.equipment[slot] = null;
    return true;
  });
}

function projectedWear(f, amount) {
  let seed = f.services.stations.randomState, draws = 0;
  const equipment = f.gameplay.equipment, uses = Math.max(1, Math.floor(amount / 4));
  const counted = Object.values(equipment).filter(Boolean).length * uses > 256;
  const roll = () => { draws++; seed = nextEnchantingSeed(seed); return seed / 2 ** 32; };
  const expected = Object.fromEntries(Object.entries(equipment).map(([slot, stack]) => {
    if (!stack) return [slot, null];
    const chance = durabilityUseChance(stack, f.context);
    const loss = counted
      ? boundedDurabilityWear(uses, chance, stack.durability, chance < 1 ? roll() : 0)
      : durabilityLoss(stack, Array.from({ length: uses }, roll), f.context);
    return [slot, loss >= stack.durability ? null : { ...stack, durability: stack.durability - loss }];
  }));
  return { seed, draws, expected };
}

for (const unbreaking of [false, true]) {
  for (const [pieces, amount] of [[0, 1000], [1, 1000], [4, 259], [4, 260],
    [2, 1000], [4, Number.MAX_VALUE]]) {
    test(`live host: ${pieces} armor, raw ${amount}, Unbreaking=${unbreaking} is lethal`, (t) => {
      const f = liveArmorFixture(t);
      equip(f, pieces, unbreaking);
      const expected = projectedWear(f, amount);
      const drawCounts = [], prepareRandom = f.services.stations.prepareRandom.bind(f.services.stations);
      f.services.stations.prepareRandom = (draws, options) => {
        drawCounts.push(draws); return prepareRandom(draws, options);
      };
      const result = f.hit(amount, "large hit", "melee");
      assert.equal(result.damage, 20);
      assert.equal(f.gameplay.health, 0);
      assert.equal(f.gameplay.dead, true);
      assert.deepEqual(f.gameplay.equipment, expected.expected);
      assert.equal(f.services.stations.randomState, expected.seed);
      assert.equal(drawCounts.reduce((a, b) => a + b, 0), expected.draws);
      if (pieces * Math.floor(amount / 4) > 256)
        assert.ok(expected.draws <= pieces);
      assert.equal(f.events.length, 1);
      const loaded = liveArmorFixture(t, { saved: f.snapshot() });
      assert.deepEqual(loaded.gameplay.serialize(), f.gameplay.serialize());
      assert.equal(loaded.services.stations.randomState, expected.seed);
    });
  }
}

test("large bypass damage preserves armor/RNG; fire immunity still precedes wear", (t) => {
  for (const kind of ["fall", "drowning", "void", "kill"]) {
    const f = liveArmorFixture(t);
    equip(f, 4, true);
    const gear = f.gameplay.equipment, seed = f.services.stations.randomState;
    assert.equal(f.hit(Number.MAX_VALUE, kind, kind).damage, 20);
    assert.deepEqual(f.gameplay.equipment, gear);
    assert.equal(f.services.stations.randomState, seed);
  }
  const f = liveArmorFixture(t);
  equip(f, 4, true);
  f.status("fire_resistance");
  const before = f.snapshot();
  assert.equal(f.hit(Number.MAX_VALUE, "lava", "lava").damage, 0);
  assert.deepEqual(f.snapshot(), before);
});

test("large lethal plan publishes one Gameplay owner, RNG and effect clear before notifications", (t) => {
  const f = liveArmorFixture(t);
  equip(f, 4, true);
  f.status("speed");
  const expected = projectedWear(f, 260), table = f.services.stations.playerState;
  const plan = f.integration.prepareDamage(260, "huge arrow", "projectile");
  assert.deepEqual(plan.participants.map((p) => p.owner),
    [f.gameplay, f.services.stations, f.services.effects]);
  assert.equal(f.gameplay.health, 20, "preparation does not publish health");
  let hurts = 0, changes = 0, deaths = 0;
  const death = f.gameplay.onDeath, change = f.gameplay.onChange;
  const observe = () => {
    assert.equal(f.gameplay.health, 0);
    assert.deepEqual(f.gameplay.equipment, expected.expected);
    assert.equal(f.services.effects.hasActiveEffects, false);
    assert.equal(f.services.stations.randomState, expected.seed);
    for (const p of plan.participants) assert.equal(f.coordinator.usage(p.owner), p.afterBytes);
  };
  f.gameplay.onHurt = () => { hurts++; observe(); throw new Error("hurt presentation failed"); };
  f.gameplay.onChange = (state) => { changes++; observe(); change(state); };
  f.gameplay.onDeath = (cause) => { deaths++; observe(); death(cause); };
  const saves = f.calls.saves, life = f.pearls.life;
  assert.equal(f.integration.commit(plan).ok, true);
  assert.deepEqual([hurts, changes, deaths], [1, 1, 1]);
  assert.equal(f.pearls.life, life + 1);
  assert.ok(f.calls.saves > saves);
  assert.deepEqual(f.services.stations.playerState, table);
  const saved = f.snapshot(), afterSaves = f.calls.saves;
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), saved);
  assert.deepEqual([hurts, changes, deaths], [1, 1, 1]);
  assert.equal(f.calls.saves, afterSaves);
});

test("large wear refuses stale owners/revisions/reservations atomically, never advancing RNG", (t) => {
  for (const invalidate of [
    (f) => { f.game.paused = true; },
    (f) => { f.game.player = { world: f.world }; },
    (f) => { f.gameplay.select(1); },
    (f) => { f.status("resistance"); },
    ...["gameplay", "effects", "stations"].map((name) => (f) => {
      const owner = name === "gameplay" ? f.gameplay : f.services[name];
      assert.equal(f.coordinator.register(owner, f.coordinator.usage(owner) + 1,
        { allowOverBudget: true }), true);
    }),
  ]) {
    const f = liveArmorFixture(t);
    equip(f, 4, true);
    const plan = f.integration.prepareDamage(260, "large hit", "melee");
    assert.ok(plan?.participants);
    invalidate(f);
    const health = f.gameplay.health, equipment = f.gameplay.equipment;
    const seed = f.services.stations.randomState;
    assert.equal(f.integration.commit(plan).ok, false);
    assert.equal(f.gameplay.health, health);
    assert.deepEqual(f.gameplay.equipment, equipment);
    assert.equal(f.services.stations.randomState, seed);
    assert.equal(f.events.length, 0);
    f.game.player = f.player;
  }
});

test("large wear preserves real overflow and invalid-input refusal, and ordinary work limit", (t) => {
  const f = liveArmorFixture(t);
  equip(f, 4, true);
  const plan = f.integration.prepareDamage(260, "large hit", "melee"), before = f.snapshot();
  const owner = {};
  assert.equal(f.coordinator.register(owner, MAX_RESERVED_BYTES, { allowOverBudget: true }), true);
  t.after(() => f.coordinator.release(owner));
  assert.equal(f.coordinator.commit([...plan.participants, {
    owner, beforeBytes: MAX_RESERVED_BYTES, afterBytes: MAX_RESERVED_BYTES + 1000,
    validate: () => true, publish: () => assert.fail("overflow published"),
  }]).ok, false);
  for (const amount of [NaN, Infinity, -1, 0])
    assert.equal(f.integration.prepareDamage(amount, "invalid", "melee"), null);
  const use = { area: "equipment", index: 0, amount: 257 };
  assert.equal(f.services.gear.prepareWear([use], { validate: () => true }), null);
  assert.equal(f.services.stations.prepareRandom(257, { validate: () => true }), null);
  for (const uses of [[{ ...use, amount: Infinity }], [{ ...use, amount: 1.5 }],
    [{ ...use, index: 99 }], [use, use]])
    assert.equal(f.services.gear.prepareHitWear(uses, { validate: () => true }), null);
  assert.deepEqual(f.snapshot(), before);
});

test("oversized shield hits block and wear once; break, replay and stale payment stay atomic", (t) => {
  for (const hand of ["main", "offhand"]) for (const unbreaking of [false, true]) {
    const f = liveArmorFixture(t);
    equip(f, 4, true);
    f.editInventory((owned) => {
      const stack = progressionStack(ITEM.SHIELD, 1, {
        enchantments: unbreaking ? { unbreaking: 3 } : {},
      });
      if (hand === "main") owned.slots[0] = stack;
      else owned.offhand = stack;
      return true;
    });
    const use = f.game.useActions.use;
    use.start("shield", hand, f.gameplay.getHandStack(hand), f.gameplay.getHandRevision(hand));
    use.advance(0.25);
    const armor = f.gameplay.equipment, seed = f.services.stations.randomState;
    assert.equal(f.hit(Number.MAX_VALUE, "huge arrow", "projectile").blocked, true);
    assert.equal(f.gameplay.getHandStack(hand), null);
    assert.equal(f.gameplay.health, 20);
    assert.deepEqual(f.gameplay.equipment, armor);
    assert.equal(f.services.stations.randomState, unbreaking ? nextEnchantingSeed(seed) : seed);
    assert.equal(f.events.length, 0);
  }
  const f = liveArmorFixture(t);
  f.editInventory((owned) => {
    owned.offhand = progressionStack(ITEM.SHIELD, 1, { enchantments: { unbreaking: 3 } });
    return true;
  });
  const plan = f.integration.prepareShieldBlock("offhand", 300, () => true);
  assert.equal(f.integration.commit(plan).ok, true);
  const before = f.snapshot();
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), before);
  const stale = f.integration.prepareShieldBlock("offhand", 300, () => true);
  f.gameplay.select(1);
  const afterSelection = f.snapshot();
  assert.equal(f.integration.commit(stale).ok, false);
  assert.deepEqual(f.snapshot(), afterSelection);
});

test("shield 256-point legacy boundary preserves rolls and ongoing hand identity", (t) => {
  for (const amount of [255, 256]) for (const unbreaking of [false, true]) {
    const f = liveArmorFixture(t);
    f.editInventory((owned) => {
      owned.offhand = progressionStack(ITEM.SHIELD, 1, {
        enchantments: unbreaking ? { unbreaking: 3 } : {},
      });
      return true;
    });
    const stack = f.gameplay.offhand, use = f.game.useActions.use;
    const revision = f.gameplay.getHandRevision("offhand");
    use.start("shield", "offhand", stack, revision);
    use.advance(0.25);
    let seed = f.services.stations.randomState;
    const roll = () => { seed = nextEnchantingSeed(seed); return seed / 2 ** 32; };
    const expected = amount === 255
      ? durabilityLoss(stack, Array.from({ length: 256 }, roll), f.context)
      : boundedDurabilityWear(257, unbreaking ? 0.25 : 1, stack.durability, unbreaking ? roll() : 0);
    assert.equal(f.hit(amount, "arrow", "projectile").blocked, true);
    assert.equal(f.gameplay.offhand.durability, stack.durability - expected);
    assert.equal(f.services.stations.randomState, seed);
    assert.equal(f.gameplay.getHandRevision("offhand"), revision);
    assert.equal(use.blocking, true);
  }
});

test("actual raised shield with stale RNG reservation refuses without a bypass or partial payment", (t) => {
  const f = liveArmorFixture(t);
  f.editInventory((owned) => {
    owned.offhand = progressionStack(ITEM.SHIELD, 1, { enchantments: { unbreaking: 3 } });
    return true;
  });
  const use = f.game.useActions.use;
  use.start("shield", "offhand", f.gameplay.offhand, f.gameplay.getHandRevision("offhand"));
  use.advance(0.25);
  const owner = f.services.stations, bytes = f.coordinator.usage(owner);
  const before = f.snapshot();
  assert.equal(f.coordinator.register(owner, bytes + 1, { allowOverBudget: true }), true);
  assert.deepEqual(f.hit(300, "arrow", "projectile"), { blocked: false, damage: 0, health: 20 });
  assert.equal(f.coordinator.register(owner, bytes, { allowOverBudget: true }), true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.hit(300, "arrow", "projectile").blocked, true);
});
