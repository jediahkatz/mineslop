import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneStack, normalizeStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  preparePotionConsumption,
  prepareSplashThrow,
  prepareStatusAdvance,
  prepareStatusApplication,
} from "../src/status-effect-actions.js";
import { addStatusEffects, createStatusEffects, StatusEffects } from "../src/status-effects.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { brewingCatalog, potionStack } from "./brewing-fixture.js";

const potion = (id, flags = {}) => ({ id, form: "drinkable", ...flags });
const effect = (id, durationTicks = 3600, amplifier = 0) => ({ id, durationTicks, amplifier });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8);

function fixture(t, { coordinator = new TransactionCoordinator(), health = 10, state, onDeath } = {}) {
  const game = new Gameplay({ coordinator, ...(onDeath ? { onDeath } : {}) });
  const effects = new StatusEffects({ coordinator, state });
  t.after(() => { effects.dispose(); game.dispose(); });
  const initial = game._prepareState((draft) => {
    draft.owned.slots.fill(null);
    draft.health = health;
    return true;
  }, { notify: false });
  assert.equal(coordinator.commit([initial]).ok, true);
  return { coordinator, game, effects };
}

function hold(game, stack, hand = "main") {
  assert.equal(game.inventoryTransaction((owned) => {
    if (hand === "main") owned.slots[game.selected] = cloneStack(stack);
    else owned.offhand = cloneStack(stack);
    return true;
  }, { notify: false }), true);
  return { hand, stack: game.getHandStack(hand), handRevision: game.getHandRevision(hand) };
}

function veto(coordinator) {
  const owner = {};
  coordinator.register(owner, 0);
  return { owner, beforeBytes: 0, afterBytes: 0, validate: () => false, publish: () => assert.fail("veto published") };
}

function projectileFixture(coordinator) {
  const owner = { coordinator, stack: null, revision: 0 };
  coordinator.register(owner, 0);
  owner.prepare = (value) => {
    const next = value === null ? null : normalizeStack(value);
    const revision = owner.revision;
    const beforeBytes = coordinator.usage(owner);
    let used = false;
    return {
      owner, beforeBytes, afterBytes: next ? encodedBytes(next) : 0,
      validate: () => !used && owner.revision === revision,
      publish: () => {
        used = true;
        owner.stack = next;
        owner.revision++;
      },
    };
  };
  return owner;
}

test("healing preview is silent; exact potion debit, bottle return and health are a single atomic plan", (t) => {
  const catalog = brewingCatalog();
  const { coordinator, game, effects } = fixture(t, { health: 5 });
  const use = hold(game, potionStack(catalog, "healing", { strong: true, name: "Rescue" }));
  const beforePlayer = game.serialize();
  const beforeEffects = effects.serialize();
  let noticed = 0;
  game.onChange = () => {
    noticed++;
    assert.equal(game.health, 13);
    assert.equal(game.getHandStack().id, catalog.emptyBottle);
  };
  const plan = preparePotionConsumption(game, effects, use, { catalog });
  assert.ok(plan);
  assert.equal(new Set(plan.participants.map(({ owner }) => owner)).size, 2);
  assert.equal(plan.result.gameplayPlan.health[0].amount, 8);
  assert.equal(plan.result.health.health, 13);
  assert.deepEqual(game.serialize(), beforePlayer);
  assert.deepEqual(effects.serialize(), beforeEffects);
  assert.equal(noticed, 0);
  assert.equal(coordinator.commit([...plan.participants, veto(coordinator)]).ok, false);
  assert.deepEqual(game.serialize(), beforePlayer);
  assert.deepEqual(effects.serialize(), beforeEffects);
  assert.equal(coordinator.commit(plan.participants).ok, true);
  assert.equal(noticed, 1);
  assert.deepEqual(game.getHandStack(), { id: catalog.emptyBottle, count: 1 });
  assert.equal(game.health, 13);
  assert.deepEqual(effects.serialize(), beforeEffects, "instant effects are not saved timers");
  assert.equal(coordinator.commit(plan.participants).ok, false);
  assert.equal(game.health, 13);
  const savedGame = game.serialize();
  assert.equal(game.load(savedGame, { notify: false }), true);
  assert.equal(effects.load(effects.serialize()), true);
  assert.equal(game.health, 13, "reload does not replay the health plan");
});

test("offhand consumption works with a full bag because the empty bottle replaces the consumed copy", (t) => {
  const catalog = brewingCatalog();
  const { coordinator, game, effects } = fixture(t);
  assert.equal(game.inventoryTransaction((owned) => {
    owned.slots = Array.from({ length: 36 }, () => ({ id: BLOCK.DIRT, count: 64 }));
    return true;
  }), true);
  const slots = game.slots;
  const use = hold(game, potionStack(catalog, "water_breathing", { extended: true }), "offhand");
  const plan = preparePotionConsumption(game, effects, use, { catalog });
  assert.equal(coordinator.commit(plan.participants).ok, true);
  assert.deepEqual(game.slots, slots);
  assert.deepEqual(game.offhand, { id: catalog.emptyBottle, count: 1 });
  assert.equal(effects.modifiers.waterBreathing, true);
  assert.equal(effects.serialize().effects[0].remainingTicks, 9600);
});

test("Creative applies a held potion without spending or replacing its decorated bottle", (t) => {
  const catalog = brewingCatalog();
  const { coordinator, game, effects } = fixture(t);
  assert.equal(game.setMode("creative"), true);
  const stack = potionStack(catalog, "night_vision", { name: "Creative bottle" });
  const use = hold(game, stack, "offhand");
  const plan = preparePotionConsumption(game, effects, use, { catalog });
  assert.equal(plan.result.consumed, false);
  assert.equal(coordinator.commit(plan.participants).ok, true);
  assert.deepEqual(game.offhand, stack);
  assert.equal(game.health, 20);
  assert.equal(effects.modifiers.nightVision, 1);
});

test("selection, equal-byte slot replacement, reload and effect changes stale potion preparations", (t) => {
  const catalog = brewingCatalog();
  for (const mutate of [
    (game) => { game.select(1); game.select(0); },
    (game) => game.inventoryTransaction((owned) => {
      owned.slots[0] = cloneStack(owned.slots[0]);
      return true;
    }),
    (game) => game.load(game.serialize(), { notify: false }),
    (_game, effects) => effects.load(effects.serialize()),
  ]) {
    const { coordinator, game, effects } = fixture(t);
    const use = hold(game, potionStack(catalog, "strength", { name: "Same bytes" }));
    const plan = preparePotionConsumption(game, effects, use, { catalog });
    mutate(game, effects);
    const player = game.serialize();
    const status = effects.serialize();
    assert.equal(coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(game.serialize(), player);
    assert.deepEqual(effects.serialize(), status);
  }
  const { game, effects } = fixture(t);
  const use = hold(game, potionStack(catalog, "strength"));
  game.select(1);
  game.select(0);
  assert.equal(preparePotionConsumption(game, effects, use, { catalog }), null);
});

test("metadata identity and form mismatches refuse consumption, not just an ID comparison", (t) => {
  const catalog = brewingCatalog();
  const { game, effects } = fixture(t);
  const use = hold(game, potionStack(catalog, "healing", { name: "A" }));
  use.stack.data.name = "B";
  assert.equal(preparePotionConsumption(game, effects, use, { catalog }), null);
  const splash = hold(game, potionStack(catalog, "healing", { form: "splash" }));
  assert.equal(preparePotionConsumption(game, effects, splash, { catalog }), null);
  const unsupported = hold(game, potionStack(catalog, "luck"));
  assert.equal(preparePotionConsumption(game, effects, unsupported, { catalog }), null);
  const current = game.serialize();
  assert.equal(game.health, 10);
  assert.equal(effects.serialize().effects.length, 0);
  assert.equal(current.slots[0].data.potion.id, "luck");
});

test("joint capacity, duplicate-owner and foreign-coordinator rejection never pays item or health costs", (t) => {
  const catalog = brewingCatalog();
  const { coordinator, game, effects } = fixture(t, { health: 5 });
  const use = hold(game, potionStack(catalog, "healing", { strong: true }));
  const other = fixture(t);
  assert.equal(preparePotionConsumption(game, other.effects, use, { catalog }), null);
  assert.equal(preparePotionConsumption(game, effects, use, {
    catalog, participants: [game.prepareExperience(1)],
  }), null, "inventory and health must share one Gameplay participant");
  assert.equal(preparePotionConsumption(game, effects, use, {
    catalog, participants: [other.game.prepareExperience(1)],
  }), null);
  const sink = {};
  coordinator.register(sink, 0);
  const full = {};
  coordinator.register(full, MAX_RESERVED_BYTES - coordinator.budget.totalBytes);
  const beforeGame = game.serialize();
  const beforeEffects = effects.serialize();
  const total = coordinator.budget.totalBytes;
  const plan = preparePotionConsumption(game, effects, use, {
    catalog,
    participants: [{
      owner: sink, beforeBytes: 0, afterBytes: 4096,
      validate: () => true, publish: () => assert.fail("capacity-rejected publication"),
    }],
  });
  assert.ok(plan);
  assert.equal(coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(game.serialize(), beforeGame);
  assert.deepEqual(effects.serialize(), beforeEffects);
  assert.equal(coordinator.budget.totalBytes, total);
});

test("poison health and duration commit together; replay after reload cannot repeat a pulse", (t) => {
  const { coordinator, game, effects } = fixture(t, {
    health: 4,
    state: addStatusEffects(createStatusEffects(), [effect("poison", 100)]),
  });
  const beforeGame = game.serialize();
  const beforeEffects = effects.serialize();
  const tick = prepareStatusAdvance(game, effects, 0.05);
  assert.equal(tick.result.health.health, 3);
  assert.deepEqual(game.serialize(), beforeGame);
  assert.deepEqual(effects.serialize(), beforeEffects);
  assert.equal(coordinator.commit([...tick.participants, veto(coordinator)]).ok, false);
  assert.deepEqual(effects.serialize(), beforeEffects);
  assert.equal(game.health, 4);
  assert.equal(coordinator.commit(tick.participants).ok, true);
  assert.equal(game.health, 3);
  assert.equal(effects.serialize().effects[0].remainingTicks, 99);
  assert.equal(effects.load(effects.serialize()), true);
  const next = prepareStatusAdvance(game, effects, 0.05);
  assert.equal(next.result.gameplayPlan.health.length, 0);
  assert.equal(coordinator.commit(next.participants).ok, true);
  assert.equal(game.health, 3);
  assert.equal(effects.serialize().effects[0].remainingTicks, 98);
  const paused = prepareStatusAdvance(game, effects, 12000, { paused: true });
  assert.equal(paused.result.changed, false);
  assert.deepEqual(paused.participants, []);
});

test("non-pulse frames touch no inventory draft or full-domain serializer and stale target reload rejects", (t) => {
  const { coordinator, game, effects } = fixture(t, {
    state: addStatusEffects(createStatusEffects(), [effect("speed")]),
  });
  const stale = prepareStatusAdvance(game, effects, 0.05);
  assert.equal(game.load(game.serialize(), { notify: false }), true);
  assert.equal(coordinator.commit(stale.participants).ok, false);
  game._prepareState = () => assert.fail("no inventory draft on a movement-only effect tick");
  game.serialize = () => assert.fail("no full Gameplay serialization per effect frame");
  effects.serialize = () => assert.fail("no full effect serialization per effect frame");
  const tick = prepareStatusAdvance(game, effects, 0.05);
  assert.equal(tick.participants.length, 1);
  assert.equal(tick.participants[0].owner, effects);
  assert.equal(coordinator.commit(tick.participants).ok, true);
});

test("timer-only applications reject dead, disposed, released or rebound targets before publication", (t) => {
  for (const mutate of [
    (game) => game.damage(20),
    (game) => game.dispose(),
    (game) => game.coordinator.release(game),
    (game) => { game.context = {}; },
  ]) {
    const { coordinator, game, effects } = fixture(t);
    const plan = prepareStatusApplication(game, effects, potion("strength"));
    mutate(game);
    assert.equal(coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(effects.serialize(), createStatusEffects());
  }
});

test("lethal instant damage clears active effects in the same publication and notifies only afterward", (t) => {
  let deaths = 0;
  const { coordinator, game, effects } = fixture(t, {
    health: 5,
    state: addStatusEffects(createStatusEffects(), [effect("strength")]),
    onDeath: () => { deaths++; },
  });
  game.onDeath = (cause) => {
    deaths++;
    assert.equal(cause, "instant_damage");
    assert.equal(game.dead, true);
    assert.deepEqual(effects.serialize(), createStatusEffects());
  };
  const plan = prepareStatusApplication(game, effects, potion("harming"));
  assert.equal(game.dead, false);
  assert.equal(deaths, 0);
  assert.equal(coordinator.commit(plan.participants).ok, true);
  assert.equal(game.health, 0);
  assert.equal(deaths, 1);
  assert.deepEqual(effects.serialize(), createStatusEffects());
});

test("quiet periodic damage still emits exactly one post-publication death lifecycle notification", (t) => {
  let deaths = 0;
  const { coordinator, game, effects } = fixture(t, {
    health: 1,
    state: addStatusEffects(createStatusEffects(), [effect("wither", 80)]),
  });
  game.onDeath = (cause) => {
    deaths++;
    assert.equal(cause, "wither");
    assert.equal(game.dead, true);
    assert.deepEqual(effects.serialize(), createStatusEffects());
  };
  const plan = prepareStatusAdvance(game, effects, 0.05);
  assert.equal(coordinator.commit([...plan.participants, veto(coordinator)]).ok, false);
  assert.equal(deaths, 0);
  assert.equal(game.health, 1);
  assert.equal(coordinator.commit(plan.participants).ok, true);
  assert.equal(deaths, 1);
  assert.equal(game.health, 0);
  assert.equal(coordinator.commit(plan.participants).ok, false);
  assert.equal(deaths, 1);
});

test("magic bypasses ordinary armor wear but still respects actual Protection metadata and Resistance", (t) => {
  for (const enchanted of [false, true]) {
    const { coordinator, game, effects } = fixture(t, {
      health: 20,
      state: addStatusEffects(createStatusEffects(), [effect("resistance", 100, 1)]),
    });
    const armor = {
      id: ITEM.IRON_ARMOR, count: 1, durability: getItem(ITEM.IRON_ARMOR).durability,
      ...(enchanted ? { data: { version: 1, enchantments: { protection: 4 } } } : {}),
    };
    assert.equal(game.inventoryTransaction((owned) => {
      owned.equipment.chest = armor;
      return true;
    }), true);
    const plan = prepareStatusApplication(game, effects, potion("harming"));
    assert.equal(coordinator.commit(plan.participants).ok, true);
    close(game.health, 20 - 6 * 0.6 * (enchanted ? 0.84 : 1));
    assert.deepEqual(game.equipment.chest, armor);
  }
});

test("splash throw preserves projectile metadata, loses the bottle, and applies effects once at retirement", (t) => {
  const catalog = brewingCatalog();
  const coordinator = new TransactionCoordinator();
  const source = fixture(t, { coordinator });
  const target = fixture(t, { coordinator, health: 20 });
  const projectile = projectileFixture(coordinator);
  t.after(() => coordinator.release(projectile));
  const bottle = potionStack(catalog, "harming", { form: "splash", strong: true, name: "Thrown" });
  const use = hold(source.game, bottle);
  const throwPlan = prepareSplashThrow(source.game, use, {
    catalog, prepareProjectile: (stack) => projectile.prepare(stack),
  });
  assert.deepEqual(projectile.stack, null);
  assert.deepEqual(source.game.getHandStack(), bottle);
  assert.equal(coordinator.commit(throwPlan.participants).ok, true);
  assert.equal(source.game.getHandStack(), null, "splash bottles are lost, not returned");
  assert.deepEqual(projectile.stack, bottle);
  assert.equal(target.game.health, 20);
  const impact = prepareStatusApplication(
    target.game, target.effects, projectile.stack.data.potion,
    { splash: { distance: 0, directHit: true }, participants: [projectile.prepare(null)] }
  );
  assert.equal(coordinator.commit([...impact.participants, veto(coordinator)]).ok, false);
  assert.deepEqual(projectile.stack, bottle);
  assert.equal(target.game.health, 20);
  assert.equal(coordinator.commit(impact.participants).ok, true);
  assert.equal(projectile.stack, null);
  assert.equal(target.game.health, 8);
  assert.equal(coordinator.commit(impact.participants).ok, false);
  assert.equal(target.game.health, 8);
});

test("unavailable, stale, async and capacity-rejected projectile destinations never consume the splash item", (t) => {
  const catalog = brewingCatalog();
  const { coordinator, game } = fixture(t);
  const bottle = potionStack(catalog, "poison", { form: "splash", name: "Keep" });
  const use = hold(game, bottle);
  for (const prepareProjectile of [
    undefined, async () => true, () => null, () => { throw new Error("unavailable"); },
  ])
    assert.equal(prepareSplashThrow(game, use, { catalog, prepareProjectile }), null);
  assert.deepEqual(game.getHandStack(), bottle);
  const projectile = projectileFixture(coordinator);
  t.after(() => coordinator.release(projectile));
  const plan = prepareSplashThrow(game, use, {
    catalog, prepareProjectile: (stack) => projectile.prepare(stack),
  });
  assert.equal(coordinator.commit([projectile.prepare(null)]).ok, true);
  assert.equal(coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(game.getHandStack(), bottle);
  const full = {};
  coordinator.register(full, MAX_RESERVED_BYTES - coordinator.budget.totalBytes);
  const capacity = prepareSplashThrow(game, use, {
    catalog,
    prepareProjectile(stack) {
      const participant = projectile.prepare(stack);
      return { ...participant, afterBytes: participant.afterBytes + 4096 };
    },
  });
  assert.equal(coordinator.commit(capacity.participants).ok, false);
  assert.deepEqual(game.getHandStack(), bottle);
  assert.equal(projectile.stack, null);
});
