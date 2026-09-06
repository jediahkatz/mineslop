import assert from "node:assert/strict";
import test from "node:test";
import {
  acquisitionIngredients,
  constrainLootRetention,
  equipLootWeapon,
  lootAcquisitionFixture,
  observeLootAttempt,
} from "./game-mob-loot-acquisition-fixture.js";

// Authored transaction victims; native population/acquisition is tested separately.
for (const kind of ["spider", "ghast"])
  for (const weapon of ["melee", "bow"])
    for (const denial of ["records", "budget", "partial-records", "partial-budget"])
      test(`${kind} ${weapon}: ${denial} refusal preserves every resource and victim`, async (t) => {
        const { f, mob } = await lootAcquisitionFixture(t, kind, { ingredient: true });
        equipLootWeapon(f, weapon);
        constrainLootRetention(t, f, mob, denial);
        const { before, after, calls, batches, result } =
          observeLootAttempt(t, f, mob, weapon).run();
        assert.equal(before.present, true);
        assert.equal(before.killed, false);
        assert.equal(calls.length, 0, "no eager per-stack callback may run");
        assert.equal(batches.length, 1, "one whole batch even with room for only its base stack");
        assert.equal(batches[0].drops.length, 2);
        assert.ok(acquisitionIngredients.includes(batches[0].drops[1].id));
        assert.deepEqual(after, before, "victim/cost/loot/XP/RNG/tombstone must all roll back");
        if (weapon === "bow") assert.equal(result, false);
        t.diagnostic(JSON.stringify({
          kind, weapon, denial, wholeBatch: batches[0].drops, unchangedOwnership: true,
        }));
      });
