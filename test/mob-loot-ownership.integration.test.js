import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameIngredientMobActions } from "../src/game-ingredient-mob-actions.js";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import { MAX_KILLED_MOBS } from "../src/mob-species.js";
import { MAX_PICKUPS } from "../src/pickups.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import {
  attackLootMob, constrainLootRetention, equipLootWeapon, lootAcquisitionFixture, lootOwnership,
} from "./game-mob-loot-acquisition-fixture.js";

const actions = (f) => (f.game.ingredientMobActions ??= new GameIngredientMobActions(f.game));
const total = (f, id) => f.gameplay.countPlain(id);
const snapshot = (f, mob) => ({ ownership: lootOwnership(f, mob), archive: f.snapshot() });

test("retry quotes are immutable, context-specific and probabilistic; no environmental spider credit", () => {
  const world = { seed: "loot-odds", dimension: "overworld", generatorVersion: 4 };
  let eyes = 0, tears = 0;
  for (let index = 0; index < 1200; index++) {
    const spider = { kind: "spider", id: `site:${index}` };
    const ghast = { kind: "ghast", id: `site:${index}` };
    const quote = ingredientMobLoot(world, spider, true);
    assert.deepEqual(ingredientMobLoot(world, spider, true), quote);
    assert.equal(Object.isFrozen(quote.drops[0]), true);
    assert.equal(ingredientMobLoot(world, spider, false).drops.length, 1);
    assert.deepEqual(ingredientMobLoot(world, spider, false).drops[0], quote.drops[0]);
    assert.ok(quote.drops[0].count >= 1 && quote.drops[0].count <= 3);
    eyes += quote.drops.length === 2;
    tears += ingredientMobLoot({ ...world, dimension: "nether" }, ghast, false).drops.length === 2;
  }
  assert.ok(eyes > 330 && eyes < 470, `1/3 eye frequency: ${eyes}/1200`);
  assert.ok(tears > 530 && tears < 670, `1/2 tear frequency: ${tears}/1200`);
});

for (const kind of ["spider", "ghast"]) {
  for (const weapon of ["melee", "bow"])
    test(`${kind} paid ${weapon} commits real costs, whole loot, XP and death once`, async (t) => {
      const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
      equipLootWeapon(f, weapon);
      assert.equal(f.game.mobActions.owns(mob), false, "horse/ecology owner remains narrow");
      const before = lootOwnership(f, mob);
      attackLootMob(f, mob, weapon);
      assert.equal(mob.dead, true);
      assert.equal(f.wildlife.byId.has(mob.id), false);
      assert.equal(f.wildlife.killed.has(mob.id), true);
      assert.equal(f.gameplay.getHandStack().durability, before.hand.durability - 1);
      if (weapon === "bow")
        assert.equal(f.gameplay.getHandStack("offhand").count, before.offhand.count - 1);
      assert.equal(f.wildlife.randomState, before.rng);
      const drops = f.game.pickups.serialize().items;
      assert.deepEqual(drops.map(({ id, count }) => ({ id, count })),
        ingredientMobLoot(f.world, mob, true).drops);
      assert.equal(f.game.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0), 5);
      const after = snapshot(f, mob);
      assert.equal(f.game.hitMob(mob, 100).hit, false);
      assert.equal(f.wildlife.damage(mob, 100).hit, false);
      assert.deepEqual(snapshot(f, mob), after);
    });

  test(`${kind} generic Wildlife damage is environmental even with anger and nearby player`, async (t) => {
    const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
    equipLootWeapon(f, "melee");
    mob.angry = 20;
    const before = lootOwnership(f, mob);
    const result = f.wildlife.damage(mob, 1, f.player.forward, true);
    assert.equal(result.killed, true);
    assert.equal(result.provenance, "environment");
    assert.deepEqual(f.gameplay.getHandStack(), before.hand);
    assert.deepEqual(f.game.experienceOrbs.serialize(), before.xp);
    assert.equal(f.wildlife.randomState, before.rng);
    assert.deepEqual(f.game.pickups.serialize().items.map(({ id, count }) => ({ id, count })),
      ingredientMobLoot(f.world, mob, false).drops);
    if (kind === "spider")
      assert.equal(f.game.pickups.serialize().items.some((drop) => drop.id === ITEM.SPIDER_EYE), false);
  });

  for (const owner of ["gameplay", "overflow", "experienceOrbs", "wildlife"])
    test(`${kind} ${owner} validation veto preserves the whole prepared melee and retry quote`, async (t) => {
      const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
      equipLootWeapon(f, "melee");
      const adapter = actions(f);
      const before = snapshot(f, mob);
      const plan = adapter.prepareMelee(mob);
      assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
        new Set([f.gameplay, f.overflow, f.game.experienceOrbs, f.wildlife]));
      const vetoed = { ...plan, participants: plan.participants.map((part) =>
        part.owner === f.game[owner] ? { ...part, validate: () => false } : part) };
      assert.equal(adapter.commit(vetoed).ok, false);
      assert.deepEqual(snapshot(f, mob), before);
      const retry = adapter.prepareMelee(mob);
      assert.deepEqual(retry.result.drops, plan.result.drops);
      assert.equal(adapter.commit(retry).ok, true);
      const after = snapshot(f, mob);
      assert.equal(adapter.commit(retry).ok, false);
      assert.deepEqual(snapshot(f, mob), after);
    });

  for (const [owner, method] of [
    ["gameplay", "prepareBowShot"], ["overflow", "prepareEnqueue"],
    ["experienceOrbs", "prepareSpawn"], ["wildlife", "_prepareResidentEdit"],
  ])
    test(`${kind} real bow release retains arrow/wear on ${owner} veto`, async (t) => {
      const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
      equipLootWeapon(f, "bow");
      const resource = f.game[owner], prepare = resource[method];
      const veto = t.mock.method(resource, method, function (...args) {
        const part = prepare.apply(this, args);
        assert.ok(part);
        return { ...part, validate: () => false };
      });
      const before = snapshot(f, mob);
      assert.equal(attackLootMob(f, mob, "bow"), false);
      assert.deepEqual(snapshot(f, mob), before);
      veto.mock.restore();
      f.game.elapsed += 0.21; // A second real use input must respect the existing cooldown.
      assert.equal(attackLootMob(f, mob, "bow"), true);
      assert.equal(mob.dead, true);
      assert.equal(f.gameplay.getHandStack("offhand").count, before.ownership.offhand.count - 1);
    });

  for (const denial of ["records", "budget"])
    test(`${kind} environmental death also refuses atomically on ${denial}`, async (t) => {
      const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
      constrainLootRetention(t, f, mob, denial);
      const before = snapshot(f, mob);
      assert.equal(f.wildlife.damage(mob, 100, null, false).hit, false);
      assert.deepEqual(snapshot(f, mob), before);
    });
}

for (const change of ["inventory-aba", "victim-aba", "pose", "world", "xp", "tombstone"])
  test(`prepared ingredient death rejects stale ${change}`, async (t) => {
    const { f, mob } = await lootAcquisitionFixture(t, "spider", { ingredient: true });
    equipLootWeapon(f, "melee");
    const plan = actions(f).prepareMelee(mob);
    assert.ok(plan.participants);
    if (change === "inventory-aba") { f.hold("STICK"); f.hold("DIAMOND_SWORD"); }
    if (change === "victim-aba") {
      f.wildlife.remove(mob);
      assert.ok(f.wildlife.spawn(mob.kind, mob.position, { id: mob.id }));
      assert.notEqual(f.wildlife.byId.get(mob.id), mob);
    }
    if (change === "pose") f.player.setPosition({ x: 9.5, y: 65, z: 11.5 });
    if (change === "world") assert.equal(f.world.loadEdits(f.world.serialize()), true);
    if (change === "xp") assert.equal(f.game.experienceOrbs.spawn(1, mob.position), true);
    if (change === "tombstone") assert.equal(f.wildlife.rememberKilled("unrelated-site"), true);
    const before = lootOwnership(f, mob);
    assert.equal(actions(f).commit(plan).ok, false);
    assert.deepEqual(lootOwnership(f, mob), before);
  });

test("nonlethal hits pay once, do not roll/award loot, and cannot bypass via raw player attribution", async (t) => {
  const { f, mob } = await lootAcquisitionFixture(t, "spider");
  mob.health = mob.spec.health;
  equipLootWeapon(f, "melee");
  const before = lootOwnership(f, mob);
  assert.equal(f.game.hitMob(mob, 100).reason, "prepared-player-cost-required");
  assert.deepEqual(lootOwnership(f, mob), before, "unpriced direct calls cannot mint kill credit");
  attackLootMob(f, mob);
  assert.ok(mob.health < before.health && mob.health > 0);
  assert.equal(f.gameplay.getHandStack().durability, before.hand.durability - 1);
  assert.equal(f.wildlife.randomState, before.rng);
  assert.deepEqual(f.game.experienceOrbs.serialize(), before.xp);
  assert.deepEqual(f.game.pickups.serialize(), before.pickups);
  // Generic standalone contexts have no retained reward owner or player receipt.
  f.wildlife.onIngredientDamage = null;
  const state = snapshot(f, mob);
  assert.equal(f.wildlife.damage(mob, 100, f.player.forward, true).hit, false);
  assert.deepEqual(snapshot(f, mob), state);
});

test("full visible pool retains both rewards; save before/after actual pickup cannot replay death", async (t) => {
  const { f, mob } = await lootAcquisitionFixture(t, "spider", { ingredient: true });
  equipLootWeapon(f, "melee");
  assert.equal(f.game.pickups.spawn(BLOCK.COBBLESTONE, 64 * MAX_PICKUPS,
    { x: 4.5, y: 65, z: 4.5 }), true);
  const savedAlive = f.snapshot();
  const before = await gameMobFixture(t, { saved: savedAlive });
  assert.deepEqual(before.snapshot().mobs, savedAlive.mobs);
  attackLootMob(f, mob);
  assert.equal(f.overflow.size, 2);
  assert.equal(f.game.pickups.serialize().items.length, MAX_PICKUPS);
  const saved = f.snapshot();
  const restored = await gameMobFixture(t, { saved });
  for (const key of ["mobs", "mobStates", "mobsByDimension", "overflow", "pickups", "experienceOrbs"])
    assert.deepEqual(restored.snapshot()[key], saved[key], key);
  assert.equal(restored.wildlife.byId.has(mob.id), false);
  assert.equal(restored.wildlife.killed.has(mob.id), true);
  // Real receiver opens the visible pool by collecting authored filler.
  restored.game.pickups.update(0.05, 0, { x: 4.5, y: 65, z: 4.5 }, restored.gameplay);
  assert.ok(restored.game.pickups.serialize().items.length < MAX_PICKUPS);
  for (const slot of [1, 2]) {
    restored.gameplay.select(slot);
    assert.equal(restored.game.inventoryActions.dropSelected(true), true);
  }
  restored.overflow.flush(restored.world, restored.game.pickups);
  assert.equal(restored.overflow.size, 0);
  restored.game.pickups.update(0.05, 0, mob.position, restored.gameplay);
  assert.equal(total(restored, ITEM.SPIDER_EYE), 1);
  const afterPickup = restored.snapshot();
  const loaded = await gameMobFixture(t, { saved: afterPickup });
  assert.equal(total(loaded, ITEM.SPIDER_EYE), 1);
  assert.equal(loaded.wildlife.byId.has(mob.id), false);
  assert.equal(loaded.wildlife.killed.has(mob.id), true);
  assert.equal(loaded.overflow.size, 0);
  assert.deepEqual(loaded.game.pickups.serialize(), afterPickup.pickups);
});

test("ingredient death preserves the existing bounded tombstone cap", async (t) => {
  const { f, mob } = await lootAcquisitionFixture(t);
  for (let index = 0; index < MAX_KILLED_MOBS; index++)
    assert.equal(f.wildlife.rememberKilled(`old:${index}`), true);
  equipLootWeapon(f, "melee");
  attackLootMob(f, mob);
  assert.equal(f.wildlife.killed.size, MAX_KILLED_MOBS);
  assert.equal(f.wildlife.killed.has(mob.id), true);
  assert.equal(f.wildlife.killed.has("old:0"), false);
});

for (const generatorVersion of [1, 2, 3, 4, 5])
  test(`legacy mob schema and compatibility copies remain exact in generator ${generatorVersion}`, async (t) => {
    const { f, mob } = await lootAcquisitionFixture(t, "spider", { ingredient: true, generatorVersion });
    equipLootWeapon(f, "melee");
    const alive = f.snapshot();
    assert.equal(alive.mobs.version, 1);
    const restored = await gameMobFixture(t, { saved: alive });
    assert.deepEqual(restored.snapshot().mobs, alive.mobs);
    assert.equal(restored.wildlife.entities.filter((entry) => entry.id === mob.id).length, 1);
    const victim = restored.wildlife.byId.get(mob.id);
    attackLootMob(restored, victim);
    const dead = restored.snapshot();
    assert.equal(dead.mobs.version, alive.mobs.version);
    const loaded = await gameMobFixture(t, { saved: dead });
    for (const key of ["mobs", "mobStates", "mobsByDimension", "overflow", "pickups", "gameplay"])
      assert.deepEqual(loaded.snapshot()[key], dead[key], key);
    assert.equal(loaded.wildlife.byId.has(mob.id), false);
    assert.equal(loaded.game.pickups.serialize().items.filter((drop) => drop.id === ITEM.SPIDER_EYE).length, 1);
  });

test("real cross-dimension travel preserves the killed source identity and retained ingredient", async (t) => {
  const { f, mob } = await lootAcquisitionFixture(t, "spider", { ingredient: true });
  equipLootWeapon(f, "melee");
  attackLootMob(f, mob);
  const source = f.snapshot();
  assert.equal((await f.game.travel.teleport({ x: 40.5, y: 65, z: 40.5, dimension: "nether" })).ok, true);
  assert.equal(f.world.dimension, "nether");
  const away = f.snapshot();
  assert.deepEqual(away.mobStates.overworld, source.mobs);
  assert.deepEqual(away.pickups, source.pickups);
  const loaded = await gameMobFixture(t, { saved: away });
  assert.equal((await loaded.game.travel.teleport({
    x: 8.5, y: 65, z: 11.5, dimension: "overworld",
  })).ok, true);
  assert.equal(loaded.wildlife.byId.has(mob.id), false);
  assert.equal(loaded.wildlife.killed.has(mob.id), true);
  assert.equal(loaded.game.pickups.serialize().items.filter((drop) => drop.id === ITEM.SPIDER_EYE).length, 1);
});
