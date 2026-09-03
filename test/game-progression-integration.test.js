import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { spendExperienceLevels } from "../src/enchantment-domain.js";
import { experienceForLevel, MAX_EXPERIENCE } from "../src/experience.js";
import { GameProgressionIntegration } from "../src/game-progression-integration.js";
import { normalizeProgressionArchive } from "../src/game-progression-state.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { createWorldContext } from "../src/world-spec.js";
import { potionStack } from "./brewing-fixture.js";
import { integratedProgressionFixture } from "./game-progression-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

test("staging is silent, requires the actual pearl host and never shadows visual Effects", (t) => {
  const f = integratedProgressionFixture(t, { activate: false });
  const before = f.snapshot(), effects = f.game.effects, bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.integration.active, false);
  assert.equal(f.integration.prepareExperience(7), null);
  assert.equal(f.integration.frame(0.1).ok, false);
  assert.equal(f.game.progressionServices, undefined);
  assert.throws(() => new GameProgressionIntegration({
    world: f.world, gameplay: f.gameplay, context: f.context,
    projectileServices: {}, saved: before,
  }), /Invalid staged progression/);
  assert.throws(() => new GameProgressionIntegration({
    world: f.world, gameplay: f.gameplay, context: f.context,
    projectileServices: f.projectileServices, saved: { ...before, progression: null },
  }), /Invalid staged progression/);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.activate({ headless: false }).reason, "missing_progression_ui");
  assert.equal(f.game.progressionServices, undefined);
  assert.equal(f.activate().ok, true);
  const notifications = structuredClone(f.calls);
  assert.equal(f.integration.activate(f.game).ok, true);
  assert.deepEqual(f.calls, notifications);
  assert.equal(f.game.effects, effects);
  assert.notEqual(f.game.effects, f.services.effects);
  assert.equal(f.services._bridges.getOwner, f.pearls.getOwner);
  assert.deepEqual(f.integration.serialize(), { progression: before.progression });
  assert.deepEqual(f.calls.sounds, []);
  assert.deepEqual(f.calls.feedback, []);
});

test("legacy archive absence migrates deterministically; explicit corruption and accessors fail closed", () => {
  for (const seed of ["", " ", "\u0000".repeat(80), "雪".repeat(80)]) {
    const context = createWorldContext({ seed, generatorVersion: 4 });
    const clean = normalizeProgressionArchive({}, context);
    assert.ok(clean);
    assert.equal(clean.progression.stations.seed, seed);
    assert.deepEqual(normalizeProgressionArchive(clean, context), clean);
    for (const progression of [undefined, null, {}, { ...clean.progression, version: 99 }])
      assert.equal(normalizeProgressionArchive({ progression }, context), null);
    const accessor = Object.defineProperty({}, "progression", {
      enumerable: true, get() { assert.fail("preflight must not invoke a sidecar getter"); },
    });
    assert.equal(normalizeProgressionArchive(accessor, context), null);
  }
});

test("real orb collection credits one finite reward and one level-up receipt, even with full bags", (t) => {
  const f = integratedProgressionFixture(t);
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.experienceTotal = experienceForLevel(5) - 1;
    return true;
  });
  const slots = f.gameplay.slots;
  assert.deepEqual(f.calls.sounds, [], "authored/loading inventory snapshots are not earned XP");
  f.collect(1);
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(5));
  assert.deepEqual(f.gameplay.slots, slots);
  assert.deepEqual(f.calls.collected, [1]);
  assert.deepEqual(f.calls.sounds, [["levelup", 5]]);
  assert.equal(f.calls.feedback.at(-1).levelUp, true);
  assert.equal(f.calls.feedback.at(-1).level, 5);
  f.orbs.update(0.1, 0.2, f.player.position, f.gameplay);
  f.integration.frame(0.1);
  assert.deepEqual(f.calls.sounds, [["levelup", 5]]);
  const restored = integratedProgressionFixture(t, { saved: f.snapshot() });
  assert.equal(restored.gameplay.getState().experience.level, 5);
  assert.equal(restored.integration.feedback.view().visible, false);
  assert.deepEqual(restored.calls.sounds, []);
  restored.integration.frame(0.1);
  assert.deepEqual(restored.calls.feedback, []);
});

test("XP receipts are post-publication and idempotent, including a failing Gameplay observer", (t) => {
  const f = integratedProgressionFixture(t, {
    onChange() { throw new Error("Authored failing HUD observer"); },
  });
  const participant = f.integration.prepareExperience(7);
  assert.ok(participant);
  participant.notify();
  assert.equal(f.gameplay.getState().experience.total, 0);
  assert.deepEqual(f.calls.sounds, []);
  const result = f.coordinator.commit([participant]);
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 1);
  assert.equal(f.gameplay.getState().experience.level, 1);
  assert.deepEqual(f.calls.sounds, [["xp", 7]]);
  participant.notify();
  assert.equal(f.coordinator.commit([participant]).ok, false);
  assert.deepEqual(f.calls.sounds, [["xp", 7]]);
});

test("XP at the integer cap stays in its physical orb and a direct fallback reports refusal", (t) => {
  const f = integratedProgressionFixture(t);
  f.editInventory((owned) => { owned.experienceTotal = MAX_EXPERIENCE; return true; });
  f.collect(1);
  assert.equal(f.orbs.size, 1);
  assert.equal(f.orbs.serialize().orbs[0].amount, 1);
  assert.equal(f.gameplay.getState().experience.total, MAX_EXPERIENCE);
  assert.equal(f.integration.earnExperience(1).ok, false);
  assert.deepEqual(f.calls.sounds, []);
  assert.deepEqual(f.calls.collected, []);
});

test("prepared XP refuses stale Player, Gameplay, world epoch, shared life and missing owner bridge", (t) => {
  for (const invalidate of [
    (f) => { f.game.player = { world: f.world }; },
    (f) => {
      const replacement = new Gameplay({ context: f.context, coordinator: f.coordinator });
      t.after(() => replacement.dispose());
      f.game.gameplay = replacement;
    },
    (f) => { f.world.setDimension("nether").generate(0); },
    (f) => { assert.equal(f.projectileServices.cancel("respawn", { advanceLife: true }), true); },
    (f) => { f.pearls.getOwner = undefined; },
    (f) => { f.game.paused = true; },
  ]) {
    const f = integratedProgressionFixture(t);
    const participant = f.integration.prepareExperience(7);
    assert.ok(participant);
    invalidate(f);
    assert.equal(f.coordinator.commit([participant]).ok, false);
    assert.equal(f.gameplay.getState().experience.total, 0);
    assert.deepEqual(f.calls.sounds, []);
    assert.equal(f.integration.feedback.view().visible, false);
  }
});

test("earned XP unlocks a paid enchant; seed, lapis and exact levels commit once with no spending celebration", (t) => {
  const f = integratedProgressionFixture(t);
  f.place("enchanting");
  f.shelves();
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { name: "Earned pick" }, 1400);
    owned.slots[1] = progressionStack(ITEM.LAPIS, 8);
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0); f.transfer(1, 1);
  const offer = f.integration.view().offers[2];
  assert.equal(offer.requiredLevel, 30);
  assert.equal(offer.affordable, false);
  const action = { type: "enchant", index: 2, offerKey: offer.key };
  const poor = f.snapshot();
  assert.equal(f.action(action).reason, "required_level");
  assert.deepEqual(f.snapshot(), poor);
  f.integration.close();
  const earned = experienceForLevel(30) + 10;
  f.collect(earned);
  assert.equal(f.orbs.size, 0);
  assert.equal(f.open().opened, true);
  assert.equal(f.integration.view().offers[2].key, offer.key, "earning XP does not reroll offers");
  assert.equal(f.integration.view().offers[2].affordable, true);
  const seed = f.services.stations.playerState.seed, sounds = structuredClone(f.calls.sounds);
  const plan = f.prepare(action);
  assert.equal(plan.ok, true);
  assert.equal(f.integration.commit(plan).ok, true);
  const record = f.services.stations.get(f.at).record;
  assert.equal(record.lapis.count, 5);
  assert.ok(Object.keys(record.input.data.enchantments).length > 0);
  assert.equal(record.input.data.name, "Earned pick");
  assert.notEqual(f.services.stations.playerState.seed, seed);
  assert.equal(f.gameplay.getState().experience.total, spendExperienceLevels(earned, 3));
  assert.equal(f.integration.feedback.view().visible, false, "the old earned level notice hides after payment");
  assert.deepEqual(f.calls.sounds, sounds);
  const paid = f.snapshot();
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), paid);
});

test("anvil capacity refusal spends nothing; taking the complete repair pays exact levels and materials", (t) => {
  const f = integratedProgressionFixture(t);
  f.collect(experienceForLevel(8));
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, { name: "Old pick" }, 10);
    owned.slots[1] = progressionStack(ITEM.IRON_INGOT, 3);
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0); f.transfer(1, 1);
  const rename = "Repaired pick";
  const preview = f.integration.view({ rename }).preview;
  assert.equal(preview.levelCost, 4);
  f.editInventory((owned) => { owned.cursor = progressionStack(ITEM.APPLE); return true; });
  const full = f.snapshot(), sounds = structuredClone(f.calls.sounds);
  const action = { type: "takeResult", rename, previewKey: preview.key };
  assert.equal(f.action(action).reason, "output_capacity");
  assert.deepEqual(f.snapshot(), full);
  f.editInventory((owned) => { owned.cursor = null; return true; });
  assert.equal(f.action(action).ok, true);
  assert.deepEqual(f.gameplay.cursor, preview.output);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(4));
  assert.equal(f.services.stations.get(f.at).record.right, null);
  assert.deepEqual(f.calls.sounds, sounds);
  assert.equal(f.integration.feedback.view().visible, false);
});

test("close, reload, death and travel retain station/cursor escrow without replaying XP", (t) => {
  const f = integratedProgressionFixture(t, { seed: "" });
  f.place("enchanting"); f.shelves();
  f.collect(experienceForLevel(30));
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.DIAMOND_PICKAXE);
    owned.slots[1] = progressionStack(ITEM.LAPIS, 5);
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0); f.transfer(1, 1);
  const offers = f.integration.view().offers;
  const stale = f.prepare({ type: "enchant", index: 2, offerKey: offers[2].key });
  assert.equal(stale.ok, true);
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.cursor = progressionStack(ITEM.APPLE, 3, { name: "Kept cursor" });
    return true;
  });
  const escrow = f.services.stations.serialize(), cursor = f.gameplay.cursor;
  assert.equal(f.integration.close().escrowRetained, true);
  assert.equal(f.integration.commit(stale).ok, false);
  const saved = f.snapshot();
  const reloaded = integratedProgressionFixture(t, { saved });
  assert.deepEqual(reloaded.services.stations.serialize(), escrow);
  assert.deepEqual(reloaded.gameplay.cursor, cursor);
  assert.deepEqual(reloaded.calls.sounds, []);
  assert.equal(reloaded.open().opened, true);
  assert.deepEqual(reloaded.integration.view().offers, offers);
  const life = reloaded.pearls.life;
  assert.equal(reloaded.gameplay.damage(100, "fall"), 20);
  assert.equal(reloaded.pearls.life, life + 1, "only the parent's pearl death bridge advances life");
  assert.equal(reloaded.integration.isOpen, false);
  assert.deepEqual(reloaded.services.stations.serialize(), escrow);
  assert.deepEqual(reloaded.gameplay.cursor, cursor);
  assert.equal(reloaded.gameplay.respawn(), true);
  reloaded.integration.onRespawn();
  assert.equal(reloaded.integration.beforeTravel().ok, true);
  reloaded.world.setDimension("nether").generate(0);
  assert.deepEqual(reloaded.services.stations.serialize(), escrow);
  reloaded.world.setDimension("overworld").generate(0);
  assert.equal(reloaded.open().opened, true);
  assert.deepEqual(reloaded.integration.view().offers, offers);
  assert.deepEqual(reloaded.calls.sounds, []);
});

test("saved splashes share the pearl owner/life bridge; cross-life imports fail and travel never refunds", (t) => {
  const f = integratedProgressionFixture(t);
  f.editInventory((owned) => {
    owned.offhand = potionStack(f.services.catalog, "swiftness", { form: "splash" });
    return true;
  });
  assert.equal(f.integration.throwPotion("offhand").ok, true);
  const saved = f.snapshot(), potion = saved.progression.potionProjectiles.projectiles[0];
  assert.equal(potion.life, saved.playerProjectiles.life);
  assert.equal(potion.ownerId, saved.playerProjectiles.ownerId);
  assert.equal(f.gameplay.offhand, null);
  const wrongLife = structuredClone(saved);
  wrongLife.progression.potionProjectiles.projectiles[0].life++;
  assert.equal(normalizeProgressionArchive(wrongLife, f.context), null);
  const restored = integratedProgressionFixture(t, { saved });
  assert.equal(restored.services._bridges.getOwner, restored.pearls.getOwner);
  assert.equal(restored.services.potions.size, 1);
  const life = restored.pearls.life;
  assert.equal(restored.integration.beforeTravel().ok, true);
  assert.equal(restored.services.potions.size, 0);
  assert.equal(restored.pearls.life, life);
  assert.equal(restored.gameplay.offhand, null);
});

test("missing ecology cannot admit offers and a closed idle adapter does no save, HUD or XP work", (t) => {
  const f = integratedProgressionFixture(t);
  assert.equal(f.integration.openTrader("missing-villager").ok, false);
  assert.equal(f.integration.action({ type: "trade", offerId: "farmer/wheat" }).ok, false);
  assert.equal(f.integration.onVillagerIntent("missing-villager", {
    intent: "work", atJobsite: true,
  }), null);
  assert.deepEqual(f.services.trading.serialize().npcs, []);
  const before = f.snapshot(), calls = structuredClone(f.calls);
  for (let i = 0; i < 30; i++) assert.equal(f.integration.frame(1 / 60).ok, true);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.calls, calls);
});

test("a detached progression stage cannot activate after its World's dimension changes", (t) => {
  const f = integratedProgressionFixture(t, { activate: false });
  assert.equal(f.projectileServices.activate(f.game).ok, true);
  f.world.setDimension("nether").generate(0);
  const bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.integration.activate(f.game, { headless: true }).reason, "stale_progression_stage");
  assert.equal(f.game.progressionServices, undefined);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.integration.active, false);
  assert.deepEqual(f.calls.sounds, []);
});

test("complete-plan Mending credits only remaining XP and keeps its RNG owner separate", (t) => {
  const f = integratedProgressionFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, { enchantments: { mending: 1 } }, 244);
    return true;
  });
  const tableSeed = f.services.stations.playerState;
  const plan = f.integration.prepareMending(5);
  assert.equal(plan.ok, true);
  assert.equal(plan.result.experienceRemaining, 2);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.gameplay, f.services.stations]));
  assert.equal(f.integration.commit(plan).ok, true);
  assert.equal(f.gameplay.getHandStack().durability, 250);
  assert.equal(f.gameplay.getState().experience.total, 2);
  assert.deepEqual(f.services.stations.playerState, tableSeed);
  assert.deepEqual(f.calls.sounds, [["xp", 2]]);
  assert.equal(f.integration.commit(plan).ok, false);
  assert.equal(f.gameplay.getState().experience.total, 2);
});
