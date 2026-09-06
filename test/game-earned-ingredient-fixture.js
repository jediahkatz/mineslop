import assert from "node:assert/strict";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import { World } from "../src/world.js";
import { countItem, paidKill, starterKit } from "./brewing-acquisition-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

/**
 * Bounded, known-reward selection FROM real native population. Quotes only
 * select a test encounter; they do not insert, alter, or award any item/mob.
 * Returns the real gameMobFixture with the actually earned ingredient inventory.
 */
export async function nativeEarnedIngredient(t, kind) {
  const dimension = kind === "ghast" ? "nether" : "overworld";
  const ingredient = kind === "ghast" ? ITEM.GHAST_TEAR : ITEM.SPIDER_EYE;
  const seen = [];
  for (const seed of ["cedar-valley", "tidal-archive", "basalt-crossing"]) {
    const world = new World(seed, { dimension, generatorVersion: 4, useWorker: false });
    const f = await gameMobFixture(t, {
      world, generatorFactory: null, autoSpawn: true, admissionRadius: 3,
    });
    assert.equal(f.building.setTime(0).ok, true, "authored night prerequisite");
    starterKit(f);
    for (let batch = 0; batch < 6; batch++) {
      f.frame(batch === 0 ? 1 : 31);
      for (const mob of f.wildlife.entities.filter((mob) => mob.kind === kind)) {
        if (seen.some((entry) => entry.seed === seed && entry.id === mob.id)) continue;
        const quote = ingredientMobLoot(world, mob, true);
        seen.push({ seed, id: mob.id, reward: quote.drops.some((drop) => drop.id === ingredient) });
        if (!quote.drops.some((drop) => drop.id === ingredient)) continue;
        assert.match(mob.id, new RegExp(`^${dimension}:-?\\d+,-?\\d+:h$`));
        assert.equal(mob.health, mob.spec.health);
        assert.equal(countItem(f, ingredient), 0);
        const combat = paidKill(f, mob, kind);
        assert.equal(mob.dead, true);
        const drop = f.game.pickups.serialize().items.find((entry) => entry.id === ingredient);
        assert.ok(drop, "actual paid kill must retain the quoted reward");
        assert.deepEqual(world.serialize().edits, [], "native admission/combat has no authored terrain");
        f.player.setPosition(drop);
        for (let frame = 0; frame < 40 && countItem(f, ingredient) === 0; frame++) f.frame();
        assert.equal(countItem(f, ingredient), 1, "real pickup must deliver the earned ingredient");
        t.diagnostic(JSON.stringify({
          kind, seed, id: mob.id, combat, seen, inventory: countItem(f, ingredient),
          admission: "real Game frame → Wildlife.update/populate/spawn",
        }));
        return { f, mob, ingredient, combat, seen };
      }
    }
    f.game.paused = true;
  }
  assert.fail(`No rewarding native ${kind} in three seeds × 156 frames: ${JSON.stringify(seen)}`);
}
