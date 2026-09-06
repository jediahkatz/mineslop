import assert from "node:assert/strict";
import test from "node:test";
import { archiveReload, countItem } from "./brewing-acquisition-fixture.js";
import { nativeEarnedIngredient } from "./game-earned-ingredient-fixture.js";

for (const kind of ["spider", "ghast"])
  test(`actual native ${kind} cohort → paid combat → earned inventory → exact save`, async (t) => {
    const { f, mob, ingredient } = await nativeEarnedIngredient(t, kind);
    const restored = await archiveReload(t, f, `${kind}-earned-native-cohort`);
    assert.equal(countItem(restored, ingredient), 1);
    assert.equal(restored.wildlife.byId.has(mob.id), false);
    assert.equal(restored.wildlife.killed.has(mob.id), true);
  });
