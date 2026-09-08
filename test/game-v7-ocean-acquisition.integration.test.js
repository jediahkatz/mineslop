import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { nativeExplorationContext } from "../src/exploration-host-state.js";
import { ITEM } from "../src/items.js";
import { resolveStructureMapTarget } from "../src/structure-catalog.js";
import { describeV7Structure } from "../src/terrain-v7-manifest.js";
import {
  nativeExplorationHost,
} from "./game-exploration-host-fixture.js";

const SEED = "beached-map-640";

const stacks = (gameplay) =>
  [
    ...gameplay.getState().slots,
    gameplay.getState().cursor,
    gameplay.getState().offhand,
    ...Object.values(gameplay.getState().equipment),
    ...gameplay.getState().craftingGrid,
  ].filter(Boolean);

const count = (values, id) =>
  values
    .filter((stack) => stack.id === id)
    .reduce((total, stack) => total + stack.count, 0);

function transferAll(host, hit) {
  const before = host.settlement.inspectContainer(host.world, hit).slots;
  assert.ok(before.some(Boolean), "natural first-open loot must be useful");
  for (let index = 0; index < before.length; index++) {
    if (!host.settlement.inspectContainer(host.world, hit).slots[index]) continue;
    const moved = host.settlement.containerAction(
      host.world,
      hit,
      host.gameplay,
      { type: "quickMove", area: "container", index }
    );
    assert.equal(moved.ok, true, moved.message);
  }
  assert.ok(
    host.settlement
      .inspectContainer(host.world, hit)
      .slots.every((stack) => stack === null)
  );
  return before.filter(Boolean);
}

test("live v7 Expanded Survival naturally maps shipwreck loot to buried treasure and cold-reloads without duplication", {
  timeout: 120000,
}, async (t) => {
  const host = await nativeExplorationHost(t, {
    seed: SEED,
    generatorVersion: 7,
    kind: "shipwreck",
    variant: "mapped",
  });
  assert.equal(host.world.generatorVersion, 7);
  assert.equal(host.gameplay.mode, "survival");
  assert.equal(host.world.generator.generationManifest.generatorVersion, 7);

  const chart = host
    .entries()
    .find(({ marker }) => marker.role === "shipwreck_map");
  assert.ok(chart);
  const chartHit = host.hit(chart.marker);
  assert.equal(chartHit.id, BLOCK.CHEST);
  const nativeShipwreck = host.world.chunks
    .get(`${Math.floor(chartHit.x / 16)},${Math.floor(chartHit.z / 16)}`)
    .structures.find(({ id }) => id === chart.marker.structureId);
  assert.equal(nativeShipwreck?.generatorVersion, 7);
  assert.ok(
    nativeShipwreck,
    "the admitted anchor comes from real native v7 packet output"
  );

  const rolls = t.mock.method(host.service.exploration, "_rollLoot");
  host.approachContainer(chart.marker);
  assert.equal(host.game.inventoryActions.openStation(chartHit), true);
  assert.equal(rolls.mock.callCount(), 1);
  const claim = host.service.exploration.container(chart.marker);
  const map = host.settlement
    .inspectContainer(host.world, chartHit)
    .slots.find((stack) => stack?.id === ITEM.TREASURE_MAP);
  assert.ok(map);
  assert.deepEqual(map.data.mapTarget, claim.mapTarget);
  const chartLoot = transferAll(host, chartHit);
  assert.equal(count(stacks(host.gameplay), ITEM.TREASURE_MAP), 1);

  assert.equal(host.game.containerUI.close(), true);
  assert.equal(host.game.inventoryActions.openStation(chartHit), true);
  assert.equal(rolls.mock.callCount(), 1, "reopen cannot reroll finite loot");
  assert.ok(
    host.settlement
      .inspectContainer(host.world, chartHit)
      .slots.every((stack) => stack === null)
  );

  const target = claim.mapTarget;
  const locatedTreasure = resolveStructureMapTarget(
    chart.declaration.mapTarget,
    nativeExplorationContext(host.world)
  ).target;
  assert.ok(locatedTreasure);
  const treasureDescriptor = describeV7Structure(
    "buried_treasure",
    { ...nativeExplorationContext(host.world), generatorVersion: 7 },
    locatedTreasure.gx,
    locatedTreasure.gz
  );
  assert.equal(treasureDescriptor.id, target.structureId);
  assert.deepEqual(treasureDescriptor.origin, {
    x: target.x,
    y: target.y,
    z: target.z,
  });
  await host.world.ensureArea(target, 0);
  const treasure = host.service.index
    .list("container")
    .find(({ marker }) => marker.structureId === target.structureId);
  assert.ok(treasure, "travel admission discovers the mapped natural cache");
  const treasureHit = host.hit(treasure.marker);
  assert.equal(treasureHit.id, BLOCK.CHEST);
  host.approachContainer(treasure.marker);
  host.game.containerUI.close();
  assert.equal(host.game.inventoryActions.openStation(treasureHit), true);
  const treasureLoot = transferAll(host, treasureHit);
  assert.equal(count(treasureLoot, ITEM.HEART_OF_THE_SEA), 1);
  assert.equal(count(stacks(host.gameplay), ITEM.HEART_OF_THE_SEA), 1);
  assert.equal(host.game.containerUI.close(), true);

  const saved = host.snapshot();
  assert.equal(saved.world.generatorVersion, 7);
  assert.equal(saved.exploration.containers.length, 2);
  assert.deepEqual(await host.game.archive.save(), { ok: true });
  assert.deepEqual(host.calls.archives.at(-1), saved);
  const expectedInventory = host.gameplay.serialize();
  const expectedSettlement = host.settlement.serialize();

  const restored = await nativeExplorationHost(t, {
    saved: structuredClone(saved),
    generatorVersion: 7,
    kind: "shipwreck",
    variant: "mapped",
  });
  assert.deepEqual(restored.gameplay.serialize(), expectedInventory);
  assert.deepEqual(restored.settlement.serialize(), expectedSettlement);
  assert.equal(count(stacks(restored.gameplay), ITEM.TREASURE_MAP), 1);
  assert.equal(count(stacks(restored.gameplay), ITEM.HEART_OF_THE_SEA), 1);
  assert.equal(restored.service.diagnostics().mapSearches, 0);

  await restored.world.ensureArea(chart.marker.position, 0);
  const restoredChart = restored.service.index
    .list("container")
    .find(({ marker }) => marker.id === chart.marker.id);
  restored.approachContainer(restoredChart.marker);
  assert.equal(
    restored.game.inventoryActions.openStation(restored.hit(restoredChart.marker)),
    true
  );
  assert.ok(
    restored.settlement
      .inspectContainer(restored.world, restored.hit(restoredChart.marker))
      .slots.every((stack) => stack === null)
  );
  assert.deepEqual(
    restored.service.exploration.container(restoredChart.marker).mapTarget,
    target
  );
  assert.equal(
    count(stacks(restored.gameplay), ITEM.TREASURE_MAP),
    count(chartLoot, ITEM.TREASURE_MAP)
  );

  await restored.world.ensureArea(target, 0);
  const restoredTreasure = restored.service.index
    .list("container")
    .find(({ marker }) => marker.structureId === target.structureId);
  restored.approachContainer(restoredTreasure.marker);
  restored.game.containerUI.close();
  assert.equal(
    restored.game.inventoryActions.openStation(
      restored.hit(restoredTreasure.marker)
    ),
    true
  );
  assert.ok(
    restored.settlement
      .inspectContainer(restored.world, restored.hit(restoredTreasure.marker))
      .slots.every((stack) => stack === null)
  );
  assert.equal(count(stacks(restored.gameplay), ITEM.HEART_OF_THE_SEA), 1);
  assert.equal(
    count(treasureLoot, ITEM.HEART_OF_THE_SEA),
    1,
    "the only acquired heart came from the finite natural treasure roll"
  );

  t.diagnostic(
    JSON.stringify({
      seed: SEED,
      generatorVersion: 7,
      shipwreck: chart.marker.structureId,
      mapTarget: target,
      chartLoot,
      treasureLoot,
      claims: restored.service.serialize().exploration.containers.length,
    })
  );
});
