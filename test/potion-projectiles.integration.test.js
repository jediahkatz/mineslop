import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { Player, PLAYER_WIDTH } from "../src/player.js";
import {
  MAX_SPLASH_PROJECTILES, normalizePotionProjectilesSnapshot,
  SPLASH_HEADER_BYTES, SPLASH_MOTION_BYTES,
} from "../src/potion-projectile-state.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { addStatusEffects, StatusEffects } from "../src/status-effects.js";
import { potionStack } from "./brewing-fixture.js";
import { progressionLiveFixture, progressionStack } from "./progression-live-fixture.js";

const snapshot = (f) => ({
  player: f.gameplay.serialize(), progression: f.services.serialize(),
  world: f.world.serialize(), bytes: f.coordinator.budget.totalBytes,
});

function hold(f, id = "healing", { hand = "main", ...options } = {}) {
  const stack = potionStack(f.services.catalog, id, { form: "splash", ...options });
  f.editInventory((owned) => {
    if (hand === "main") owned.slots[f.gameplay.selected] = stack;
    else owned.offhand = stack;
    return true;
  });
  return { hand, stack: f.gameplay.getHandStack(hand), handRevision: f.gameplay.getHandRevision(hand) };
}

function targetFixture(t, f, { health = 5 } = {}) {
  const gameplay = new Gameplay({ context: f.context, coordinator: f.coordinator });
  const effects = new StatusEffects({ coordinator: f.coordinator });
  const document = Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  const player = new Player(new THREE.PerspectiveCamera(), f.world, { ownerDocument: document, dataset: {} });
  player.setPosition({ x: 8.5, y: 65, z: 9.5 });
  const initialized = gameplay._prepareState((draft) => {
    draft.health = health;
    draft.owned.slots.fill(null);
    return true;
  });
  assert.ok(initialized);
  assert.equal(f.coordinator.commit([initialized]).ok, true);
  const target = {
    id: "local-test-target", ref: player, dimension: f.world.dimension,
    position: player.position, radius: PLAYER_WIDTH / 2, height: player.height,
    gameplay, effects, available: true,
  };
  t.after(() => { player.dispose(); effects.dispose(); gameplay.dispose(); });
  return { player, gameplay, effects, target };
}

function flight(t, id = "healing", options = {}) {
  const f = progressionLiveFixture(t, { activate: false, ...options });
  const victim = targetFixture(t, f);
  assert.equal(f.activate({ readPotionTargets: () => [victim.target] }).ok, true);
  // The physical player looks down 20 degrees: the bottle's +20-degree launch
  // offset yields a horizontal throw through the real target collision box.
  f.player.pitch = -Math.PI / 9;
  f.player.setPosition(f.player.position.clone());
  const use = hold(f, id, { strong: id === "healing" });
  assert.equal(f.services.throwPotion(use.hand).ok, true);
  return Object.assign(f, { victim });
}

function nextImpact(f) {
  const id = f.services.potions.projectiles[0].id;
  for (let i = 0; i < 12; i++) {
    const plan = f.services.potions.prepareStep(id);
    assert.ok(plan?.participants);
    if (plan.result.type === "impact") return plan;
    assert.equal(plan.result.type, "flight", "the loaded authored corridor must contain a real impact");
    assert.equal(f.services.commit(plan).ok, true);
  }
  assert.fail("No swept splash impact in the authored corridor");
}

test("throw retains one exact payload and consumes the held copy without granting a remote effect", (t) => {
  const f = progressionLiveFixture(t);
  const use = hold(f, "swiftness", { hand: "offhand", name: "Thrown once" });
  const before = snapshot(f);
  const plan = f.services.potions.prepareThrow(f.gameplay, use, { validate: () => f.game.active });
  assert.ok(plan?.participants);
  assert.equal(plan.participants.length, 2);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.gameplay.offhand, null);
  assert.equal(f.services.effects.hasActiveEffects, false);
  assert.equal(f.services.potions.size, 1);
  assert.deepEqual(f.services.potions.projectiles[0].stack, use.stack);
  assert.equal(f.services.potions.reservedBytes,
    SPLASH_HEADER_BYTES + SPLASH_MOTION_BYTES + encodedBytes(use.stack));
  const paid = snapshot(f);
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), paid);
  assert.equal(f.calls.projectiles.filter((event) => event.type === "throw").length, 1);
});

test("throw prerequisites reject player-pose ABA, held replacement, World ABA and full save capacity", (t) => {
  const f = progressionLiveFixture(t);
  for (const invalidate of [
    () => {
      const at = f.player.position.clone();
      f.player.setPosition({ ...at, x: at.x + 0.25 });
      f.player.setPosition(at);
    },
    () => {
      const previous = f.gameplay.offhand;
      f.editInventory((owned) => { owned.offhand = null; return true; });
      f.editInventory((owned) => { owned.offhand = previous; return true; });
    },
    () => {
      f.put(8, 66, 10, BLOCK.STONE);
      f.put(8, 66, 10, BLOCK.AIR);
    },
  ]) {
    const use = hold(f, "healing", { hand: "offhand" });
    const plan = f.services.potions.prepareThrow(f.gameplay, use);
    assert.ok(plan);
    invalidate();
    const before = snapshot(f);
    assert.equal(f.services.commit(plan).ok, false);
    assert.deepEqual(snapshot(f), before);
  }
  const use = hold(f);
  const plan = f.services.potions.prepareThrow(f.gameplay, use);
  assert.ok(plan);
  const ballast = {};
  assert.equal(f.coordinator.register(ballast,
    MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  t.after(() => f.coordinator.release(ballast));
  const before = snapshot(f);
  assert.equal(f.services.commit(plan).reason, "budget-rejected");
  assert.deepEqual(snapshot(f), before);
});

test("real swept direct impact retires the bottle and applies instant health in the same commit", (t) => {
  const f = flight(t);
  assert.equal(f.victim.gameplay.health, 5);
  assert.equal(f.services.effects.hasActiveEffects, false);
  const plan = nextImpact(f);
  assert.equal(plan.participants.length, 3);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, 3);
  assert.equal(f.victim.gameplay.health, 5, "impact preview never grants healing");
  assert.equal(f.services.potions.size, 1);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.victim.gameplay.health, 13, "direct strong healing adds exactly eight health");
  assert.equal(f.victim.effects.hasActiveEffects, false, "instant health is not a saved timer");
  assert.equal(f.services.potions.size, 0);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(f.calls.projectiles.filter((event) => event.type === "impact").length, 1);
  assert.equal(f.services.commit(plan).ok, false);
  assert.equal(f.victim.gameplay.health, 13);
});

test("stale target pose/effects and the shared pearl life invalidate a prepared impact", (t) => {
  const f = flight(t, "swiftness");
  const stalePose = nextImpact(f);
  const at = f.victim.player.position.clone();
  f.victim.player.setPosition({ ...at, x: at.x + 0.1 });
  f.victim.player.setPosition(at);
  assert.equal(f.services.commit(stalePose).ok, false);
  assert.equal(f.services.potions.size, 1);
  assert.equal(f.victim.effects.hasActiveEffects, false);

  const staleEffects = nextImpact(f);
  const changed = f.victim.effects.prepare(addStatusEffects(f.victim.effects.serialize(), [
    { id: "strength", amplifier: 0, durationTicks: 200 },
  ]));
  assert.equal(f.coordinator.commit([changed]).ok, true);
  const before = f.victim.effects.serialize();
  assert.equal(f.services.commit(staleEffects).ok, false);
  assert.deepEqual(f.victim.effects.serialize(), before);

  const staleLife = nextImpact(f);
  assert.equal(f.pearls.cancelPending("death", { advanceLife: true }), true);
  assert.equal(f.services.commit(staleLife).ok, false);
  const cancelled = f.services.potions.prepareStep(f.services.potions.projectiles[0].id);
  assert.equal(cancelled.result.type, "cancel");
  assert.equal(f.services.commit(cancelled).ok, true);
  assert.equal(f.services.potions.size, 0);
  assert.equal(f.victim.effects.serialize().effects.some((entry) => entry.id === "speed"), false);
  assert.equal(f.gameplay.getHandStack(), null, "life retirement never refunds the spent bottle");
});

test("direct timed splash installs its full timer only on impact, with no duplicate refresh", (t) => {
  const f = flight(t, "swiftness");
  const plan = nextImpact(f);
  assert.equal(plan.participants.length, 2, "timed impact needs no second target inventory projection");
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.victim.effects.serialize().effects[0].remainingTicks, 3600);
  assert.equal(f.victim.effects.modifyMovementSpeed(10), 12);
  const before = f.victim.effects.serialize();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.victim.effects.serialize(), before);
});

test("pause/reload keep fractional flight and payload; explicit round-trip travel and death retire without refunds", (t) => {
  const f = progressionLiveFixture(t, { seed: "" });
  hold(f, "night_vision", { name: "Saved flight" });
  assert.equal(f.services.throwPotion().ok, true);
  assert.equal(f.services.frame(0.0125).ok, true);
  const flight = f.services.potions.serialize();
  assert.equal(flight.accumulator, 0.0125);
  f.game.paused = true;
  assert.equal(f.services.frame(0.25).ok, true);
  assert.deepEqual(f.services.potions.serialize(), flight);
  const restored = progressionLiveFixture(t, { saved: f.snapshot() });
  assert.deepEqual(restored.services.potions.serialize(), flight);
  const life = restored.pearls.life, seed = restored.services.stations.playerState;
  assert.equal(restored.services.onDimensionChange().ok, true);
  restored.world.setDimension("nether").generate(0);
  restored.world.setDimension("overworld").generate(0);
  assert.equal(restored.services.potions.size, 0, "travel retires even without an intervening frame");
  assert.equal(restored.pearls.life, life, "progression never invents a second life counter");
  assert.deepEqual(restored.services.stations.playerState, seed);
  assert.equal(restored.gameplay.getHandStack(), null);
  hold(restored, "healing");
  assert.equal(restored.services.throwPotion().ok, true);
  restored.gameplay.damage(100, "fall");
  assert.equal(restored.services.potions.size, 0);
  assert.equal(restored.pearls.life, life + 1, "only the parent's death bridge advances life");
  assert.equal(restored.gameplay.slots.some((stack) => stack?.id === ITEM.GLASS_BOTTLE), false);
});

test("sixteen-bottle bound rejects the next throw without truncating saved flight or spending inventory", (t) => {
  const f = progressionLiveFixture(t);
  for (let i = 0; i < MAX_SPLASH_PROJECTILES; i++) {
    hold(f, "healing", { name: `Bottle ${i + 1}` });
    assert.equal(f.services.throwPotion().ok, true);
  }
  hold(f, "healing", { name: "Capacity control" });
  const before = snapshot(f);
  assert.equal(f.services.throwPotion().ok, false);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.services.potions.size, MAX_SPLASH_PROJECTILES);
  const restored = progressionLiveFixture(t, { saved: f.snapshot() });
  assert.deepEqual(restored.services.potions.serialize(), f.services.potions.serialize());
  assert.deepEqual(restored.gameplay.getHandStack(), f.gameplay.getHandStack());
});

test("splash sidecar rejects malformed timers/identities, unsupported forms and duplicate flight", (t) => {
  const f = progressionLiveFixture(t, { seed: "" });
  hold(f, "water_breathing");
  assert.equal(f.services.throwPotion().ok, true);
  const saved = f.services.potions.serialize(), record = saved.projectiles[0];
  const normalize = (value) => normalizePotionProjectilesSnapshot(value, f.context, "local-player");
  assert.deepEqual(normalize(saved), saved);
  for (const changed of [
    { wait: 1, age: 0 }, { wait: 2, age: 3 }, { age: 15 },
    { id: saved.nextId }, { life: -1 }, { ownerId: "another-player" },
    { stack: progressionStack(ITEM.GLASS_BOTTLE) },
    { stack: potionStack(f.services.catalog, "water_breathing") },
  ]) assert.throws(() => normalize({ ...saved, projectiles: [{ ...record, ...changed }] }));
  assert.throws(() => normalize({ ...saved, projectiles: [record, record] }));
  assert.throws(() => normalize({ ...saved, projectiles: [], accumulator: 0.01 }));
  assert.throws(() => normalize({ ...saved, seed: "different" }));
  assert.deepEqual(f.services.potions.serialize(), saved);
});
