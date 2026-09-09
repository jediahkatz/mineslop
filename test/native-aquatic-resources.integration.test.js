import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { MELEE_COOLDOWN_SECONDS } from "../src/combat-feedback.js";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { verifyAquaticExports } from "./aquatic-browser-verify.mjs";
import {
  approachNativeAquatic, checkedAquaticArchive, freezeAquaticResources,
  nativeAquaticResources, restoreAquaticArchive,
} from "./native-aquatic-resource-fixture.js";

function finishMeleeCooldown(f) {
  let frames = 0;
  while (f.game.elapsed - f.game.lastAction < MELEE_COOLDOWN_SECONDS) {
    assert.ok(++frames <= Math.ceil(MELEE_COOLDOWN_SECONDS / 0.05) + 1);
    f.frame();
  }
}

test("native scheduled cod and squid pay real Survival resources and persist through cold storage", async (t) => {
  const proof = await nativeAquaticResources(t), { f } = proof;
  const initial = f.snapshot();
  const startingWear = f.gameplay.getHandStack().durability;
  const deaths = [];
  let expectedXp = 0, strikes = 0;
  for (const kind of ["cod", "squid"]) {
    const { mob, pose } = await approachNativeAquatic(proof, kind);
    const quote = ingredientMobLoot(f.world, mob, true);
    const expectedHealth = kind === "cod" ? 3 : 10;
    assert.equal(mob.health, expectedHealth);
    const beforeHand = f.gameplay.getHandStack();
    let hits = 0;
    for (; !mob.dead && hits < 3; hits++) {
      finishMeleeCooldown(f);
      f.aim(mob);
      f.game.updateTarget();
      assert.equal(f.game.meleeTarget?.entity, mob, "the real physical ray must select this native victim");
      const rng = f.wildlife.randomState, health = mob.health;
      f.game.primary(0.05, true);
      assert.equal(mob.health, Math.max(0, health - 6));
      assert.equal(f.wildlife.randomState, rng, "the hit itself cannot spend AI randomness");
      strikes++;
      if (!mob.dead) {
        f.key("KeyW");
        finishMeleeCooldown(f);
        f.key("KeyW", false);
      }
    }
    assert.equal(mob.dead, true);
    assert.equal(hits, kind === "cod" ? 1 : 2);
    assert.equal(f.gameplay.getHandStack().durability, beforeHand.durability - hits);
    assert.equal(f.wildlife.killed.has(mob.id), true);
    assert.equal(f.wildlife.byId.has(mob.id), false);
    expectedXp += quote.experience;

    // Ordinary keyboard swimming + actual Game frames collect physical drops
    // and XP. No inventory grants, fake receivers or direct pickup callbacks.
    const item = kind === "cod" ? ITEM.RAW_COD : ITEM.INK_SAC;
    let collectionFrames = 0;
    try {
      f.key("KeyW");
      while ((f.gameplay.countPlain(item) !== quote.drops[0].count ||
          f.gameplay.getState().experience.total !== expectedXp) && collectionFrames < 24) {
        f.frame();
        collectionFrames++;
      }
    } finally {
      f.key("KeyW", false);
    }
    assert.equal(f.gameplay.countPlain(item), quote.drops[0].count, `${kind}: physical resource pickup`);
    assert.equal(f.gameplay.getState().experience.total, expectedXp, `${kind}: physical XP pickup`);
    assert.equal(f.gameplay.health, 20);
    deaths.push({
      kind, id: mob.id, life: mob.life, originalHealth: expectedHealth, hits,
      drops: quote.drops, experience: quote.experience, collectionFrames, authoredApproach: pose,
    });
  }
  assert.equal(strikes, 3);
  assert.equal(f.gameplay.getHandStack().durability, startingWear - 3);
  await freezeAquaticResources(proof);
  const { saved, text } = checkedAquaticArchive(proof);
  assert.deepEqual(saved.pickups.items, []);
  assert.deepEqual(saved.overflow.entries, []);
  assert.deepEqual(saved.experienceOrbs.orbs, []);
  const indexedDB = new IDBFactory();
  const writer = new WorldStorage({ indexedDB });
  t.after(() => writer.close());
  await writer.save(saved);
  await writer.close();
  const reader = new WorldStorage({ indexedDB });
  t.after(() => reader.close());
  const reopened = await reader.load();
  assert.deepEqual(reopened, saved, "reopened IndexedDB keeps every owner");
  assert.deepEqual(parseWorldFile(exportWorldFile(reopened)), saved, "file export/import is lossless");
  const restored = await restoreAquaticArchive(t, proof, reopened);
  assert.equal(restored.f.gameplay.getState().experience.total, expectedXp);
  assert.equal(restored.f.gameplay.getHandStack().durability, startingWear - 3);
  for (const death of deaths) {
    assert.equal(restored.f.wildlife.byId.has(death.id), false);
    assert.equal(restored.f.wildlife.killed.has(death.id), true);
    assert.equal(restored.f.gameplay.countPlain(death.drops[0].id), death.drops[0].count);
  }
  assert.equal(exportWorldFile(f.snapshot()), text, "cold reconstruction cannot mutate the frozen source");
  const targetIds = deaths.map((death) => death.id);
  assert.equal(verifyAquaticExports(initial, saved, {
    targetIds, restored: [restored.f.snapshot()],
  }).length, 2, "the exported-checkpoint verifier also covers real cold owners");
  for (const [label, change] of [
    ["missing XP", (copy) => { copy.gameplay.experience = { total: 0, level: 0, progress: 0 }; }],
    ["unpaid wear", (copy) => {
      copy.gameplay.slots[0].durability = 250;
      copy.gameplay.durability[ITEM.IRON_SWORD] = [250];
    }],
    ["extra offense RNG", (copy) => { copy.progression.stations.randomState++; }],
  ]) {
    await t.test(`export verification rejects ${label}`, () => {
      const altered = structuredClone(saved);
      change(altered);
      assert.throws(() => verifyAquaticExports(initial, altered, { targetIds }));
    });
  }
  await t.test("export verification rejects an altered restored clock", () => {
    const altered = structuredClone(restored.f.snapshot());
    altered.weather.elapsed++;
    assert.throws(() => verifyAquaticExports(initial, saved, { targetIds, restored: [altered] }),
      /cold\/restored owner and clock: weather/);
  });
  t.diagnostic(JSON.stringify({
    nativeAquaticResources: "PASS", seed: f.world.seed, generatorVersion: f.world.generatorVersion,
    mode: f.gameplay.mode, generatedColumns: proof.generated.chunks,
    deaths, strikes, swordDurability: f.gameplay.getHandStack().durability,
    totalExperience: expectedXp, playerHealth: f.gameplay.health,
    indexedDbReopened: true, fileRoundTrip: true, freshGameOwners: true,
    authoredPrerequisites: ["one plain iron sword", "bounded underwater starting and approach positions"],
    caveat: "CPU Game/input/ownership proof, not from-zero traversal, GUI or renderer acceptance",
  }));
});
