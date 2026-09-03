import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  explorationMarkersFromStructure,
  mapResolutionFromStructure,
  selectTreasureMapTarget,
} from "../src/exploration-markers.js";
import { nativeExplorationContext } from "../src/exploration-host-state.js";
import { normalizeExplorationServicesSnapshot } from "../src/game-exploration-services.js";
import { isValidStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { LOOT_ACQUISITION, lootNeedsMap } from "../src/loot-tables.js";
import { requireProgressionItems } from "../src/progression-items.js";
import {
  describeStructure,
  resolveStructureMapTarget,
} from "../src/structure-catalog.js";
import {
  expectedExplorationSlots,
  explorationServicesFixture,
  installLegacyChest,
  reloadExplorationOwners,
  retainedStacks,
} from "./exploration-services-fixture.js";

// Every approved family and every canonical chest-role path, including both
// ruin climates, annexes, both fortress stores and all three bastion stores.
const cases = [
  [
    "shipwreck",
    "whole",
    ["shipwreck/supply", "shipwreck/treasure", "shipwreck/map"],
  ],
  [
    "ocean_ruin",
    "warm_courtyard",
    ["ocean_ruin/warm_shrine", "ocean_ruin/annex"],
  ],
  [
    "ocean_ruin",
    "cold_courtyard",
    ["ocean_ruin/cold_crypt", "ocean_ruin/annex"],
  ],
  ["ocean_monument", "", []],
  ["buried_treasure", "", ["buried_treasure/heart_of_sea"]],
  ["village", "", ["village/farmstead", "village/library", "village/smithy"]],
  [
    "nether_fortress",
    "",
    ["nether_fortress/garden", "nether_fortress/crossing"],
  ],
  [
    "bastion_remnant",
    "bridge_keep",
    ["bastion/treasure", "bastion/armory", "bastion/bridge"],
  ],
  ["dungeon", "", ["dungeon/cache", "dungeon/cache"]],
];

for (const [kind, variant, tables] of cases) {
  test(`native ${kind}/${variant}: canonical live roles materialize useful persistent registered loot`, async (t) => {
    requireProgressionItems(Object.keys(LOOT_ACQUISITION));
    const f = await explorationServicesFixture(t, { kind, variant });
    const markers = explorationMarkersFromStructure(f.descriptor, f.context);
    const containers = markers.filter(({ type }) => type === "container");
    assert.deepEqual(
      f
        .entries()
        .map(({ marker }) => marker.id)
        .sort(),
      containers.map(({ id }) => id).sort()
    );
    assert.deepEqual(
      f
        .entries()
        .map(({ declaration }) => declaration.table)
        .sort(),
      [...tables].sort(),
      "every approved role must have a real emitted native anchor"
    );
    for (const entry of f.entries()) {
      const hit = f.hit(entry.marker);
      assert.equal(hit.id, BLOCK.CHEST);
      const result = f.service.openContainer(hit);
      assert.equal(result.ok, true, result.reason);
      const record = f.service.exploration.container(entry.marker);
      const slots = f.settlement.inspectContainer(f.world, hit).slots;
      assert.deepEqual(
        slots,
        expectedExplorationSlots(entry, f.context, record.mapTarget)
      );
      assert.ok(
        slots.some(Boolean),
        "finite real tables must provide useful ownership"
      );
      assert.ok(
        slots.filter(Boolean).every((stack) => isValidStack(stack, f.context))
      );
      assert.equal(record.marker.id, entry.declaration.id);
      if (entry.marker.role === "buried_treasure")
        assert.equal(
          slots
            .filter((s) => s?.id === ITEM.HEART_OF_THE_SEA)
            .reduce((n, s) => n + s.count, 0),
          1
        );
      if (entry.marker.role === "bastion_treasure")
        assert.equal(
          slots
            .filter((s) => s?.id === ITEM.NETHERITE_UPGRADE_TEMPLATE)
            .reduce((n, s) => n + s.count, 0),
          1
        );
      if (lootNeedsMap(entry.marker.role))
        assert.ok(Object.hasOwn(record, "mapTarget"));
    }
    assert.equal(
      f.service.serialize().exploration.containers.length,
      containers.length
    );
    const encounters = f.service.encounterMarkers();
    assert.deepEqual(
      encounters.map(({ marker }) => marker.id).sort(),
      markers
        .filter(({ type }) => type === "encounter")
        .map(({ id }) => id)
        .sort()
    );
    assert.deepEqual(
      f.service.serialize().exploration.encounters,
      [],
      "admission exposes encounter declarations; it never fakes their completion or spawning"
    );
    if (kind === "ocean_monument") {
      assert.equal(containers.length, 0);
      assert.equal(new Set(encounters.map(({ marker }) => marker.id)).size, 3);
      assert.ok(
        encounters.every(
          ({ declaration }) => declaration.entity === "elder_guardian"
        )
      );
    }
    assert.ok(
      normalizeExplorationServicesSnapshot(f.service.serialize(), f.context)
    );
    t.diagnostic(
      JSON.stringify({
        nativeStructure: f.descriptor.id,
        roles: containers.map(({ role }) => role),
        claims: containers.length,
        encounters: encounters.length,
        mapSearches: f.service.diagnostics().mapSearches,
      })
    );
  });
}

for (const seed of [undefined, "雪".repeat(80)]) {
  test(`native map resolution persists the actual buried target through slots, inventory, drops and destruction (${seed ? "maximum Unicode" : "default seeds"})`, async (t) => {
    const f = await explorationServicesFixture(t, {
      kind: "shipwreck",
      variant: "mapped",
      seed,
    });
    const entry = f
      .entries()
      .find(({ marker }) => marker.role === "shipwreck_map");
    assert.ok(entry);
    const hit = f.hit(entry.marker),
      generator = f.world.generator;
    const before = generator.counters;
    const plan = f.service.prepareOpen(hit);
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(f.service.exploration.container(entry.marker), null);
    const after = generator.counters;
    assert.equal(after.chunkGenerations, before.chunkGenerations);
    assert.equal(after.regionGenerations, before.regionGenerations);
    assert.ok(
      after.surfaceQueries - before.surfaceQueries <=
        entry.declaration.mapTarget.search.maxSamples
    );
    assert.equal(f.service.diagnostics().mapSearches, 1);
    const raw = resolveStructureMapTarget(
      entry.declaration.mapTarget,
      nativeExplorationContext(f.world)
    );
    const resolution = mapResolutionFromStructure(raw, f.context);
    assert.ok(
      resolution.target,
      "scenario search selected the first real map-bearing native wreck"
    );
    const target = selectTreasureMapTarget(
      entry.marker,
      [resolution.target],
      f.context
    );
    assert.deepEqual(plan.result.mapTarget, target);
    assert.equal(f.service.commit(plan).ok, true);
    assert.deepEqual(
      f.service.exploration.container(entry.marker).mapTarget,
      target
    );
    const slots = f.settlement.inspectContainer(f.world, hit).slots;
    const mapIndex = slots.findIndex(
      (stack) => stack?.id === ITEM.TREASURE_MAP
    );
    assert.ok(mapIndex >= 0 && getItem(ITEM.TREASURE_MAP).map);
    assert.deepEqual(slots[mapIndex].data.mapTarget, target);
    assert.equal(
      f.settlement.containerAction(f.world, hit, f.gameplay, {
        type: "quickMove",
        area: "container",
        index: mapIndex,
      }).ok,
      true
    );
    const move = f.gameplay.prepareInventory((owned) => {
      const index = owned.slots.findIndex(
        (stack) => stack?.id === ITEM.TREASURE_MAP
      );
      assert.ok(index >= 0);
      [owned.slots[0], owned.slots[index]] = [
        owned.slots[index],
        owned.slots[0],
      ];
      return true;
    });
    assert.equal(f.coordinator.commit([move]).ok, true);
    f.gameplay.select(0);
    assert.deepEqual(f.gameplay.getHandStack().data.mapTarget, target);
    assert.equal(
      f.gameplay.dropSelected({
        wholeStack: true,
        prepareDrops: (stacks) =>
          f.game.prepareDropItems(stacks, {
            x: hit.x + 0.5,
            y: hit.y + 0.5,
            z: hit.z + 0.5,
          }),
      }),
      true
    );
    assert.deepEqual(
      retainedStacks(f).find(({ id }) => id === ITEM.TREASURE_MAP).data
        .mapTarget,
      target
    );
    assert.equal(f.service.commit(f.service.prepareClear(hit)).ok, true);
    assert.equal(
      f.service.commit(f.prepareBreak(hit, { explosion: true })).ok,
      true
    );
    assert.deepEqual(
      f.service.exploration.container(entry.marker).mapTarget,
      target
    );
    assert.ok(
      normalizeExplorationServicesSnapshot(f.service.serialize(), f.context)
    );
    assert.equal(f.service.diagnostics().mapSearches, 1);

    // Inspect the exact persisted target, never a replacement passing site.
    const described = describeStructure(
      "buried_treasure",
      nativeExplorationContext(f.world),
      raw.target.gx,
      raw.target.gz
    );
    assert.equal(described.id, target.structureId);
    assert.deepEqual(described.origin, {
      x: target.x,
      y: target.y,
      z: target.z,
    });
    await f.world.ensureArea(target, 0);
    assert.equal(f.world.get(target.x, target.y, target.z), BLOCK.CHEST);
    const treasure = f.service.index
      .list("container")
      .find(({ marker }) => marker.structureId === target.structureId);
    assert.ok(treasure);
    assert.equal(f.service.openContainer(f.hit(treasure.marker)).ok, true);
    assert.ok(
      f.settlement
        .inspectContainer(f.world, f.hit(treasure.marker))
        .slots.some((stack) => stack?.id === ITEM.HEART_OF_THE_SEA)
    );
  });
}

test("a real native null map result suppresses the chart permanently, not another search", async (t) => {
  const f = await explorationServicesFixture(t, {
    kind: "shipwreck",
    variant: "unmapped",
  });
  const entry = f
    .entries()
    .find(({ marker }) => marker.role === "shipwreck_map");
  assert.ok(entry);
  const hit = f.hit(entry.marker);
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.equal(f.service.exploration.container(entry.marker).mapTarget, null);
  assert.equal(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.some((stack) => stack?.id === ITEM.TREASURE_MAP),
    false
  );
  const searches = f.service.diagnostics().mapSearches;
  assert.equal(searches, 1);
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.equal(f.service.commit(f.service.prepareClear(hit)).ok, true);
  const saved = f.service.serialize();
  assert.equal(saved.exploration.containers[0].mapTarget, null);
  await f.world.ensureArea({ x: hit.x + 1024, z: hit.z + 1024 }, 0);
  await f.world.ensureArea(hit, 0);
  assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
  assert.equal(
    f.service.commit(f.prepareBreak(f.hit(entry.marker), { explosion: true }))
      .ok,
    true
  );
  assert.equal(f.service.exploration.container(entry.marker).mapTarget, null);
  assert.equal(f.service.diagnostics().mapSearches, searches);
  assert.ok(normalizeExplorationServicesSnapshot(saved, f.context));
});

test("legacy map-bearing ownership adopts without searching or inventing a target", async (t) => {
  const f = await explorationServicesFixture(t, {
    kind: "shipwreck",
    variant: "whole",
  });
  const entry = f
    .entries()
    .find(({ marker }) => marker.role === "shipwreck_map");
  const hit = f.hit(entry.marker);
  installLegacyChest(f, hit);
  const before = f.world.generator.counters;
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("legacy map rerolled")
  );
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.equal(f.service.diagnostics().mapSearches, 0);
  assert.equal(
    f.world.generator.counters.surfaceQueries,
    before.surfaceQueries
  );
  assert.equal(f.service.exploration.container(entry.marker).claim, "adopted");
  assert.equal(
    f.service.exploration.container(entry.marker).mapTarget,
    undefined
  );
});

for (const variant of ["mapped", "unmapped"]) {
  test(`native ${variant} chart claims survive real owner reloads while opened, cleared and destroyed`, async (t) => {
    const source = await explorationServicesFixture(t, {
      kind: "shipwreck",
      variant,
    });
    const entry = source
      .entries()
      .find(({ marker }) => marker.role === "shipwreck_map");
    assert.ok(entry);
    assert.equal(
      source.service.openContainer(source.hit(entry.marker)).ok,
      true
    );
    const target = source.service.exploration.container(entry.marker).mapTarget;
    assert.equal(target === null, variant === "unmapped");
    const f = await explorationServicesFixture(t, {
      seed: source.world.seed,
      kind: "shipwreck",
      variant,
      stage: false,
    });
    let saved = JSON.parse(JSON.stringify(source.snapshot()));
    for (const state of ["materialized", "cleared", "destroyed"]) {
      if (f.service) {
        const hit = f.hit(entry.marker);
        if (state === "cleared")
          assert.equal(f.service.commit(f.service.prepareClear(hit)).ok, true);
        else
          assert.equal(
            f.service.commit(f.prepareBreak(hit, { explosion: true })).ok,
            true
          );
        saved = JSON.parse(JSON.stringify(f.snapshot()));
        assert.equal(f.service.dispose(), true);
        f.service = null;
      }
      reloadExplorationOwners(f, saved);
      t.mock.method(f.service.exploration, "_rollLoot", () =>
        assert.fail("reload rerolled a claim")
      );
      assert.equal(f.service.exploration.container(entry.marker).state, state);
      assert.deepEqual(
        f.service.exploration.container(entry.marker).mapTarget,
        target
      );
      assert.deepEqual(f.settlement.serialize(), saved.settlement);
      assert.deepEqual(f.overflow.serialize(), saved.overflow);
      assert.deepEqual(f.gameplay.serialize(), saved.gameplay);
      if (state === "destroyed")
        assert.equal(
          f.world.set(
            entry.marker.position.x,
            entry.marker.position.y,
            entry.marker.position.z,
            BLOCK.CHEST
          ),
          true
        );
      assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
      assert.equal(
        f.service.diagnostics().mapSearches,
        0,
        "target AND null are final after import"
      );
      const slots = f.settlement.inspectContainer(
        f.world,
        f.hit(entry.marker)
      ).slots;
      if (state === "materialized" && target !== null)
        assert.deepEqual(
          slots.find((stack) => stack?.id === ITEM.TREASURE_MAP).data.mapTarget,
          target
        );
      else
        assert.equal(
          slots.some((stack) => stack?.id === ITEM.TREASURE_MAP),
          false
        );
      if (state !== "materialized")
        assert.ok(slots.every((stack) => stack === null));
    }
  });
}

test("encounter completion composes a real reward participant and rejects duplicate/stale claims without spawning", async (t) => {
  const f = await explorationServicesFixture(t, { kind: "ocean_monument" });
  const [entry] = f.service.encounterMarkers();
  assert.ok(entry.declaration.entity === "elder_guardian");
  assert.equal(f.service.prepareEncounterComplete(entry.marker.id).ok, false);
  const reward = f.gameplay.prepareExperience(3);
  const plan = f.service.prepareEncounterComplete(entry.marker.id, {
    participants: [reward],
    validate: () => true,
  });
  assert.equal(plan.ok, true);
  assert.equal(f.service.exploration.completed(entry.marker), false);
  // This tests claim/reward ownership only. No ecology entity is fabricated.
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(f.service.exploration.completed(entry.marker), true);
  assert.equal(f.service.encounterMarkers().length, 2);
  assert.equal(
    f.service.encounterMarkers({ includeCompleted: true }).length,
    3
  );
  assert.equal(f.service.commit(plan).ok, false);
  assert.equal(
    f.service.prepareEncounterComplete(entry.marker.id, {
      participants: [f.gameplay.prepareExperience(3)],
      validate: () => true,
    }).ok,
    false
  );
});
