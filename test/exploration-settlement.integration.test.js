import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { explorationMarkersFromStructure } from "../src/exploration-markers.js";
import { createFurnace } from "../src/furnace.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { harvestDrops } from "../src/gameplay-harvest.js";
import { ITEM } from "../src/items.js";
import { MAX_PREPARED_CONTAINERS } from "../src/settlement-transactions.js";
import {
  chestBlockDrops,
  expectedExplorationSlots,
  explorationServicesFixture,
  itemTotals,
  retainedStacks,
} from "./exploration-services-fixture.js";

test("public Settlement batch first-fill/adoption pins live records and owns detached canonical slots", async (t) => {
  const f = await explorationServicesFixture(t);
  const entries = f.entries();
  assert.equal(entries.length, 3);
  const hits = entries.map(({ marker }) => f.hit(marker));
  const stacks = [
    {
      id: ITEM.IRON_AXE,
      count: 1,
      durability: 7,
      data: { version: 1, name: "Authoritative 海" },
    },
  ];
  const requests = hits.map((hit) => ({
    hit,
    action: "initialize",
    expectedInitialized: false,
    stacks,
  }));
  const before = f.snapshot();
  const first = f.settlement.prepareContainers(f.world, requests);
  const raced = f.settlement.prepareContainers(f.world, requests);
  assert.ok(first && raced);
  assert.equal(first.participants.length, 1);
  assert.equal(first.participants[0].owner, f.settlement);
  assert.deepEqual(f.snapshot(), before);
  first.result.records[0].slots[0].data.name = "Detached receipt";
  assert.equal(f.coordinator.commit(first.participants).ok, true);
  assert.equal(f.coordinator.commit(raced.participants).ok, false);
  assert.equal(f.coordinator.commit(first.participants).ok, false);
  for (const hit of hits)
    assert.deepEqual(
      f.settlement.inspectContainer(f.world, hit).slots.filter(Boolean),
      stacks
    );
  const adopted = f.settlement.prepareContainers(
    f.world,
    hits.map((hit) => ({
      hit,
      action: "adopt",
      expectedInitialized: true,
    }))
  );
  assert.ok(adopted);
  assert.equal(
    adopted.participants[0].beforeBytes,
    adopted.participants[0].afterBytes
  );
  assert.equal(f.coordinator.commit(adopted.participants).ok, true);
  assert.equal(f.settlement.prepareContainers(f.world, requests), null);
  assert.equal(
    f.settlement.prepareContainers(f.world, [
      { hit: hits[0], action: "observe" },
      { hit: hits[0], action: "remove" },
    ]),
    null
  );
  assert.equal(
    f.settlement.prepareContainers(
      f.world,
      Array(MAX_PREPARED_CONTAINERS + 1).fill({
        hit: hits[0],
        action: "observe",
      })
    ),
    null
  );
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("adopted slots must not reroll")
  );
  for (const hit of hits) assert.equal(f.service.openContainer(hit).ok, true);
  assert.ok(
    f.service
      .serialize()
      .exploration.containers.every((record) => record.claim === "adopted")
  );
});

test("a mixed native chest/furnace explosion owns one Settlement, World, overflow and real XP participant", async (t) => {
  const f = await explorationServicesFixture(t, { stage: false });
  const marker = explorationMarkersFromStructure(f.descriptor, f.context).find(
    ({ type }) => type === "container"
  );
  const hit = f.hit(marker);
  const at = {
    dimension: f.world.dimension,
    x: hit.x + 1,
    y: hit.y + 8,
    z: hit.z,
  };
  assert.equal(f.world.set(at.x, at.y, at.z, BLOCK.FURNACE), true);
  const furnace = f.hit(at);
  assert.equal(
    f.settlement.load(
      {
        version: 3,
        chests: [],
        crops: [],
        furnaces: [
          {
            ...at,
            ...createFurnace(),
            slots: [null, null, { id: ITEM.IRON_INGOT, count: 2 }],
            experience: 2,
          },
        ],
      },
      { context: f.context, world: f.world }
    ),
    true
  );
  f.service = f.create();
  assert.equal(f.service.activate(f.game).ok, true);
  const orbs = new ExperienceOrbs(new THREE.Scene(), f.world, {
    coordinator: f.coordinator,
    context: f.context,
  });
  t.after(() => orbs.dispose());
  f.game.experienceOrbs = orbs;
  const harvest = new GameHarvestActions(f.game);
  const furnaceDrops = harvestDrops(BLOCK.FURNACE, {
    mode: f.gameplay.mode,
    explosion: true,
    context: f.context,
  });
  const requests = [
    { hit, drops: chestBlockDrops(f) },
    { hit: furnace, drops: furnaceDrops },
  ];
  const before = { ...f.snapshot(), orbs: orbs.serialize() };
  assert.equal(
    f.service.prepareBreakBatch(requests, {
      explosion: true,
      prepareExperience: () => null,
    }).ok,
    false,
    "explicit XP refusal never becomes a second Gameplay credit"
  );
  assert.deepEqual({ ...f.snapshot(), orbs: orbs.serialize() }, before);
  let rewardPreparations = 0;
  const plan = f.service.prepareBreakBatch(requests, {
    explosion: true,
    prepareExperience(amount, rewards) {
      rewardPreparations++;
      assert.equal(amount, 2);
      assert.equal(rewards.length, 1);
      return harvest.prepareExperience(amount, rewards[0].position);
    },
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(rewardPreparations, 1);
  assert.equal(plan.participants.length, 5);
  assert.deepEqual(
    new Set(plan.participants.map(({ owner }) => owner)),
    new Set([f.service.exploration, f.settlement, f.world, f.overflow, orbs])
  );
  assert.deepEqual({ ...f.snapshot(), orbs: orbs.serialize() }, before);
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
  assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR);
  assert.equal(f.service.exploration.container(marker).state, "destroyed");
  assert.equal(
    orbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0),
    2
  );
  assert.deepEqual(f.gameplay.serialize(), before.gameplay);
  assert.deepEqual(
    itemTotals(retainedStacks(f)),
    itemTotals([
      ...chestBlockDrops(f),
      ...furnaceDrops,
      ...expectedExplorationSlots({ marker }, f.context).filter(Boolean),
      { id: ITEM.IRON_INGOT, count: 2 },
    ])
  );
});
