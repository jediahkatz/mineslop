import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import {
  archiveReload, authoredBench, brewBatch, closeBench, countItem, insert,
  openBench, standRecord, starterKit, stationAction,
} from "./brewing-acquisition-fixture.js";

// Independent reachable prefix while natural ingredient rewards are absent.
// This is an explicitly authored prerequisite test, never acquisition proof.
test("authored water/wart/fuel: real Game stand takes exactly 400 frames across archive reload", async (t) => {
  let f = await gameMobFixture(t, {
    seed: "cedar-valley", generatorVersion: 4, generatorFactory: null,
    autoSpawn: false, admissionRadius: 3,
  });
  starterKit(f);
  assert.equal(countItem(f, ITEM.SPIDER_EYE), 0);
  assert.equal(countItem(f, ITEM.GHAST_TEAR), 0);
  const at = await authoredBench(f);
  const world = f.world.serialize();
  openBench(f, at);
  insert(f, 5, 0);
  insert(f, 3, 3);
  insert(f, 4, 4);
  await closeBench(f);
  f = await archiveReload(t, f, "authored-prerequisites-in-stand");
  f = await brewBatch(t, f, at, ITEM.NETHER_WART, "awkward", 19);
  openBench(f, at);
  stationAction(f, { type: "click", area: "container", index: 0, button: 0 });
  stationAction(f, { type: "click", area: "inventory", index: 5, button: 0 });
  await closeBench(f);
  f = await archiveReload(t, f, "authored-awkward-bottle-in-inventory");
  assert.equal(countItem(f, ITEM.POTION), 1);
  assert.equal(f.gameplay.slots[5].data.potion.id, "awkward");
  assert.equal(standRecord(f, at).slots[0], null);
  assert.equal(standRecord(f, at).slots[3], null);
  assert.equal(standRecord(f, at).slots[4], null);
  assert.equal(standRecord(f, at).fuelOperations, 19);
  assert.deepEqual(f.world.serialize(), world);
  assert.equal(countItem(f, ITEM.SPIDER_EYE), 0);
  assert.equal(countItem(f, ITEM.GHAST_TEAR), 0);
  f.gameplay.select(5);
  f.player.yaw = Math.PI;
  f.player.pitch = 0;
  f.player._syncCamera(0);
  assert.equal(f.game.useActions.begin("authored-awkward-drink"), true);
  f.frame(31);
  assert.equal(countItem(f, ITEM.POTION), 1);
  assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 0);
  f.frame();
  assert.equal(countItem(f, ITEM.POTION), 0);
  assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 1);
  f.game.useActions.end("authored-awkward-drink", true);
  f = await archiveReload(t, f, "authored-awkward-consumed");
  f.frame(40);
  assert.equal(countItem(f, ITEM.GLASS_BOTTLE), 1);
  assert.equal(countItem(f, ITEM.POTION), 0);
  assert.deepEqual(f.progression.services.effects.serialize().effects, [],
    "awkward has no effect; this does not substitute for naturally acquired poison/regeneration");
  assert.equal(standRecord(f, at).fuelOperations, 19);
  assert.deepEqual(f.world.serialize(), world);
});
