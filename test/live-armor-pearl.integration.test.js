import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { liveArmorFixture } from "./live-armor-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const point = ({ x, y, z }) => ({ x, y, z });

function pearl(t, { health = 20 } = {}) {
  const f = liveArmorFixture(t);
  for (let x = 7; x <= 9; x++)
    for (let y = 65; y <= 69; y++) f.put(x, y, 8, BLOCK.STONE);
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.ENDER_PEARL, 3);
    owned.equipment.feet = progressionStack(ITEM.DIAMOND_BOOTS, 1, {
      name: "Gentle landing", repairCost: 4,
      enchantments: { feather_falling: 4, protection: 4, unbreaking: 3 },
    });
    return true;
  });
  assert.equal(f.coordinator.commit([f.gameplay._prepareState((draft) => {
    draft.health = health; return true;
  })]).ok, true);
  f.player.yaw = f.player.pitch = 0;
  f.player._syncCamera(0);
  assert.equal(f.game.useActions.useHand("main", f.gameplay.getHandStack(), false), true);
  assert.equal(f.pearls.size, 1);
  assert.equal(f.gameplay.getHandStack().count, 2);
  f.impact = () => {
    const id = f.pearls.projectiles[0]?.id;
    assert.ok(id);
    for (let i = 0; i < 20; i++) {
      const plan = f.pearls.prepareImpactTransaction(id);
      if (plan) return plan;
      assert.equal(f.projectileServices.frame(0.05, { simulating: true }), true);
      assert.equal(f.pearls.size, 1, "wait for a prepared impact, not an already committed landing");
    }
    assert.fail("authored resident wall was not reached");
  };
  return f;
}

test("actual Game pearl impact reduces with Feather Falling/resistance, retains one Gameplay participant and no wear RNG", (t) => {
  const f = pearl(t);
  f.status("resistance");
  const gear = f.gameplay.equipment, rng = f.services.stations.randomState;
  const plan = f.impact();
  assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
  assert.equal(plan.participants.some((part) => part.owner === f.services.stations), false);
  const before = f.gameplay.health;
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.ok(Math.abs(f.gameplay.health - (before - 5 * 0.8 * 0.36)) < 1e-8);
  assert.deepEqual(point(f.player.position), plan.request.position);
  assert.equal(f.pearls.size, 0);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.gameplay.equipment, gear);
  assert.equal(f.services.stations.randomState, rng);
  const saved = f.snapshot();
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(f.snapshot(), saved);
  const loaded = liveArmorFixture(t, { saved });
  assert.equal(loaded.gameplay.health, f.gameplay.health);
  assert.deepEqual(loaded.gameplay.equipment, gear);
  assert.deepEqual(point(loaded.player.position), plan.request.position);
  assert.equal(loaded.services.stations.randomState, rng);
});

test("lethal pearl clears effects in its existing atomic pose/health/removal before notifications", (t) => {
  const f = pearl(t, { health: 1 });
  f.status("speed");
  const plan = f.impact();
  const gear = f.gameplay.equipment, rng = f.services.stations.randomState;
  assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
  assert.equal(plan.participants.filter((part) => part.owner === f.services.effects).length, 1);
  let hurts = 0, deaths = 0;
  f.gameplay.onHurt = () => {
    hurts++;
    assert.equal(f.services.effects.hasActiveEffects, false);
    assert.equal(f.pearls.size, 0);
    assert.deepEqual(point(f.player.position), plan.request.position);
    throw new Error("unavailable hurt presentation");
  };
  const death = f.gameplay.onDeath;
  f.gameplay.onDeath = (cause) => {
    deaths++;
    assert.equal(cause, "ender-pearl");
    assert.equal(f.services.effects.hasActiveEffects, false);
    death(cause);
  };
  const life = f.pearls.life;
  const result = f.coordinator.commit(plan.participants);
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(f.gameplay.health, 0);
  assert.equal(f.gameplay.deathCause, "ender-pearl");
  assert.equal(f.pearls.life, life + 1);
  assert.equal(hurts, 1);
  assert.equal(deaths, 1);
  assert.deepEqual(f.gameplay.equipment, gear);
  assert.equal(f.services.stations.randomState, rng);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(deaths, 1);
});

test("pearl plans pin effects, Player, world, Gameplay and progression host; refusals retain pose/health/flight", (t) => {
  for (const invalidate of [
    (f) => f.status("resistance"),
    (f) => { f.game.player = { world: f.world }; },
    (f) => { f.game.progressionIntegration = null; },
    (f) => { f.gameplay.damageHost = null; },
    (f) => { f.gameplay.select(1); },
    (f) => { f.world.setDimension("nether").generate(0); },
  ]) {
    const f = pearl(t), plan = f.impact();
    invalidate(f);
    const pose = point(f.player.position), gameplay = f.gameplay.serialize();
    const flights = f.pearls.serialize(), rng = f.services.stations.randomState;
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.deepEqual(point(f.player.position), pose);
    assert.deepEqual(f.gameplay.serialize(), gameplay);
    assert.deepEqual(f.pearls.serialize(), flights);
    assert.equal(f.services.stations.randomState, rng);
    assert.equal(f.events.length, 0);
    f.game.player = f.player;
    f.game.progressionIntegration = f.integration;
    f.gameplay.damageHost = f.integration;
  }
});

test("pearl cooldown rejects a second right-click without consuming another pearl or armor RNG", (t) => {
  const f = pearl(t);
  const before = f.snapshot();
  assert.equal(f.game.useActions.useHand("main", f.gameplay.getHandStack(), false), false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.events.length, 0);
});
