import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import {
  archiveReload, authoredBench, brewBatch, closeBench, countItem, insert,
  looseItem, nativeIngredientMob, openBench, paidKill, standRecord,
  starterKit, stationAction,
} from "./brewing-acquisition-fixture.js";

// Explicit authored seed selection for known rewarding native encounters.
// Random drop odds still apply: the first cedar-valley spider has no eye.
for (const [kind, ingredient, potion, seed] of [
  ["spider", ITEM.SPIDER_EYE, "poison", "tidal-archive"],
  ["ghast", ITEM.GHAST_TEAR, "regeneration", "cedar-valley"],
]) {
  test(`native ${kind} admission (unaltered terrain, real Game autoSpawn)`, async (t) => {
    const { f, mob } = await nativeIngredientMob(t, kind);
    assert.equal(countItem(f, ingredient), 0);
    assert.deepEqual(looseItem(f, ingredient), []);
    const restored = await archiveReload(t, f, `${kind}-admitted`);
    assert.equal(restored.wildlife.byId.get(mob.id)?.kind, kind);
  });

  test(`native ${kind} → paid kill → saved pickup → inventory → 20s awkward/20s ${potion} → drink/reload`, async (t) => {
    t.diagnostic(`authored rewarding encounter seed: ${seed}; no mob/drop injection or RNG override`);
    const admitted = await nativeIngredientMob(t, kind, { seed });
    let { f } = admitted;
    const { mob } = admitted;
    assert.equal(f.world.seed, seed);
    starterKit(f);
    assert.equal(countItem(f, ingredient), 0, "no injected brewing reward");
    assert.deepEqual(looseItem(f, ingredient), []);
    const combat = paidKill(f, mob, kind);
    t.diagnostic(`paid kill ${JSON.stringify({ kind, id: mob.id, ...combat })}`);
    assert.deepEqual(f.world.serialize().edits, [], "native combat cannot silently alter terrain");
    // Snapshot immediately after the killing input, before any pickup frame.
    assert.equal(countItem(f, ingredient), 0);
    const dropped = looseItem(f, ingredient);
    assert.ok(dropped.length > 0, `${kind} must naturally reward a retained ${potion} ingredient; do not seed it`);
    const earned = dropped.reduce((sum, stack) => sum + stack.count, 0);
    assert.ok(earned > 0);
    const killedId = mob.id;
    f = await archiveReload(t, f, `${kind}-before-pickup`);
    assert.deepEqual(looseItem(f, ingredient), dropped, "same dropped resource and motion survive export");
    assert.equal(countItem(f, ingredient), 0);
    assert.equal(f.wildlife.byId.has(killedId), false);
    assert.equal(f.wildlife.killed.has(killedId), true);

    // Authored player approach, never a credit/copy of the ingredient stack.
    // The real loose-entity pickup clock and Game receiver own collection.
    const drop = dropped[0];
    f.player.setPosition({ x: drop.x, y: drop.y, z: drop.z });
    for (let frame = 0; frame < 40 && countItem(f, ingredient) < earned; frame++) f.frame();
    assert.equal(countItem(f, ingredient), earned);
    assert.deepEqual(looseItem(f, ingredient), []);
    f = await archiveReload(t, f, `${kind}-in-inventory`);
    f.frame(8);
    assert.equal(countItem(f, ingredient), earned, "pickup cannot replay after reload");
    assert.deepEqual(looseItem(f, ingredient), []);
    assert.equal(f.wildlife.byId.has(killedId), false);

    // A finite supplied workshop, not a claim of acquiring all prerequisites.
    const at = await authoredBench(f);
    const authoredWorld = f.world.serialize();
    f = await archiveReload(t, f, `${kind}-workshop`);
    openBench(f, at);
    insert(f, 5, 0); // One authored water bottle.
    insert(f, 3, 3); // One authored wart.
    insert(f, 4, 4); // One fuel item, twenty operations total.
    assert.equal(countItem(f, ITEM.POTION), 0);
    assert.equal(countItem(f, ITEM.NETHER_WART), 0);
    assert.equal(countItem(f, ITEM.BLAZE_POWDER), 0);
    assert.equal(countItem(f, ingredient), earned, "reward waits in inventory during awkward brewing");
    await closeBench(f);
    f = await archiveReload(t, f, `${kind}-water-loaded`);
    f = await brewBatch(t, f, at, ITEM.NETHER_WART, "awkward", 19);
    openBench(f, at);
    const resourceIndex = f.gameplay.slots.findIndex((stack) => stack?.id === ingredient);
    assert.ok(resourceIndex >= 0);
    insert(f, resourceIndex, 3);
    assert.equal(countItem(f, ingredient), 0, "the actual collected stack moves into the station");
    assert.equal(standRecord(f, at).slots[3].count, earned);
    await closeBench(f);
    f = await archiveReload(t, f, `${kind}-ingredient-in-stand`);
    f = await brewBatch(t, f, at, ingredient, potion, 18);
    assert.deepEqual(f.world.serialize(), authoredWorld, "brewing preserves generator and all workshop edits");
    openBench(f, at);
    stationAction(f, { type: "click", area: "container", index: 0, button: 0 });
    stationAction(f, { type: "click", area: "inventory", index: 5, button: 0 });
    assert.equal(f.gameplay.cursor, null);
    await closeBench(f);
    f = await archiveReload(t, f, `${kind}-potion-in-inventory`);
    assert.equal(f.gameplay.slots[5].data.potion.id, potion);
    assert.equal(standRecord(f, at).slots[0], null);
    assert.equal(standRecord(f, at).slots[3]?.count ?? 0, earned - 1);
    assert.equal(standRecord(f, at).fuelOperations, 18);

    f.gameplay.select(5);
    // Face away from the station so held use resolves the actual potion.
    f.player.yaw = Math.PI;
    f.player.pitch = 0;
    f.player._syncCamera(0);
    if (potion === "regeneration") {
      // Authored injury for an observable regeneration pulse, not a healed-health mock.
      assert.ok(f.gameplay.damage(6, "fall") > 0);
    }
    const health = f.gameplay.health;
    assert.equal(f.game.useActions.begin("brewing-acquisition-drink"), true);
    f.frame(31);
    assert.equal(countItem(f, ITEM.POTION), 1, "held drink cannot consume early");
    assert.equal(f.progression.services.effects.serialize().effects.length, 0);
    f.frame();
    assert.equal(countItem(f, ITEM.POTION), 0);
    assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 1, "one consumed potion returns one empty bottle");
    f.game.useActions.end("brewing-acquisition-drink", true);
    const effect = f.progression.services.effects.serialize().effects.find((entry) => entry.id === potion);
    assert.ok(effect, "real timed status effect must be active");
    const remainingTicks = effect.remainingTicks;
    f = await archiveReload(t, f, `${kind}-consumed-effect`);
    assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 1);
    assert.equal(countItem(f, ITEM.POTION), 0);
    const healthAfterReload = f.gameplay.health;
    assert.equal(f.progression.services.effects.serialize().effects.find((entry) => entry.id === potion).remainingTicks, remainingTicks);
    f.frame(60);
    assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 1);
    assert.equal(countItem(f, ITEM.POTION), 0);
    assert.equal(standRecord(f, at).fuelOperations, 18);
    assert.equal(standRecord(f, at).slots[3]?.count ?? 0, earned - 1);
    assert.equal(f.progression.services.effects.serialize().effects.find((entry) => entry.id === potion).remainingTicks, remainingTicks - 60);
    if (potion === "poison") assert.ok(f.gameplay.health < health);
    else assert.ok(f.gameplay.health > health && f.gameplay.health >= healthAfterReload);
    assert.deepEqual(f.world.serialize(), authoredWorld);
    f = await archiveReload(t, f, `${kind}-effect-progressed-no-replay`);
    assert.equal(countItem(f, ingredient) + (standRecord(f, at).slots[3]?.count ?? 0), earned - 1);
    assert.deepEqual(looseItem(f, ingredient), []);
  });
}
