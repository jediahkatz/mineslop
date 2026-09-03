import assert from "node:assert/strict";
import test from "node:test";
import {
  ExplorationState,
  normalizeExplorationSnapshot,
} from "../src/exploration-state.js";
import {
  explorationMarkerFromStructure,
  explorationMarkersFromStructure,
  lootRoleForStructureMarker,
  mapResolutionFromStructure,
  memberIdentity,
  normalizeExplorationMarker,
  selectTreasureMapTarget,
  STRUCTURE_LOOT_ROLES,
  structureIdentity,
} from "../src/exploration-markers.js";
import { isValidStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import {
  getLootTable,
  LOOT_ACQUISITION,
  lootNeedsMap,
  MAX_LOOT_STACKS,
  rollStructureLoot,
} from "../src/loot-tables.js";
import {
  MAX_STRUCTURE_ID_LENGTH,
  MAX_STRUCTURE_MEMBER_ID_LENGTH,
  progressId,
  progressStructureId,
} from "../src/progression-common.js";
import { requireProgressionItems } from "../src/progression-items.js";
import { getStructureMarkers } from "../src/structure-catalog.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  catalogDescriptor,
  catalogFixture,
  catalogMapSearch,
  catalogRoleFixtures,
  emptyClaimFixture,
} from "./progression-marker-fixture.js";

for (const [label, seed] of [
  ["ordinary quoted seed", "ordinary-seed"],
  ["URI punctuation", "seed:\"/:% !'()*[]?"],
  ["mixed Unicode", "海底の宝藏 🐠 é"],
  ["maximum ASCII seed", "a".repeat(80)],
  ["maximum BMP URI expansion", "雪".repeat(80)],
  ["maximum astral seed", "🐠".repeat(40)],
]) {
  test(`actual catalog identities survive projection and claims: ${label}`, () => {
    const f = catalogFixture("shipwreck", {
      seed,
      matches: (d) => d.plan.damage === "whole",
    });
    const raw = getStructureMarkers(f.descriptor, { type: "container" });
    const markers = explorationMarkersFromStructure(f.descriptor, f.context);
    assert.ok(
      f.descriptor.id.includes(encodeURIComponent(JSON.stringify(seed)))
    );
    assert.ok(f.descriptor.id.length <= MAX_STRUCTURE_ID_LENGTH);
    assert.equal(
      JSON.parse(structureIdentity(f.descriptor, f.context)).at(-1),
      f.descriptor.id
    );
    assert.equal(
      new Set(markers.map((m) => memberIdentity(m, f.context))).size,
      raw.length
    );
    for (const marker of markers) {
      assert.equal(marker.id, raw.find((m) => m.key === marker.key).id);
      assert.equal(marker.structureId, f.descriptor.id);
      assert.ok(marker.id.length <= MAX_STRUCTURE_MEMBER_ID_LENGTH);
      assert.deepEqual(
        normalizeExplorationMarker(structuredClone(marker), f.context),
        marker
      );
      assert.equal(
        JSON.parse(memberIdentity(marker, f.context)).at(-1),
        marker.id
      );
    }
    const marker = markers.find((m) => m.key === "supply");
    const claim = emptyClaimFixture(f.context);
    assert.equal(
      claim.ledger.commit(claim.ledger.prepareFirstOpen(marker, claim.options))
        .ok,
      true
    );
    const saved = claim.ledger.serialize();
    assert.equal(saved.containers[0].marker.id, marker.id);
    const restored = new ExplorationState({
      context: f.context,
      rollLoot() {
        assert.fail("An imported canonical claim must never reroll");
      },
    });
    assert.equal(restored.load(saved), true);
    assert.deepEqual(restored.container(marker), saved.containers[0]);
    assert.equal(restored.prepareFirstOpen(marker, claim.options), null);
  });
}

test("canonical seed spelling remains lossless and short NPC/trading IDs are not relaxed", () => {
  const seeds = [
    "é",
    "e\u0301",
    "雪".repeat(79) + "甲",
    "雪".repeat(79) + "乙",
  ];
  const ids = seeds.map((seed) => {
    const f = catalogFixture("buried_treasure", { seed });
    assert.equal(
      progressStructureId(f.descriptor.id, "overworld", f.context),
      f.descriptor.id
    );
    assert.throws(() => progressId(f.descriptor.id), RangeError);
    return f.descriptor.id;
  });
  assert.equal(new Set(ids).size, seeds.length);
  assert.equal(progressId("npc:village/resident-1"), "npc:village/resident-1");
  assert.throws(() => progressId("npc:%22resident%22"), RangeError);
  assert.throws(() => progressId("n".repeat(193)), RangeError);
  assert.throws(
    () =>
      progressStructureId(
        ids[0],
        "overworld",
        createWorldContext({
          seed: "x".repeat(81),
          generatorVersion: 4,
        })
      ),
    RangeError
  );
});

test("actual marker normalization rejects URI aliases, foreign contexts and malformed owner IDs", () => {
  const f = catalogFixture("buried_treasure", { seed: "雪".repeat(80) });
  const [marker] = explorationMarkersFromStructure(f.descriptor, f.context);
  const prefix = f.descriptor.id.split(":").slice(0, -2).join(":");
  for (const id of [
    f.descriptor.id.replace("%22", "%2522"),
    f.descriptor.id.replace("%E9", "%e9"),
    f.descriptor.id.replace("structure:v1:", "structure:v2:"),
    f.descriptor.id.replace(":buried_treasure:", ":unknown_kind:"),
    `${prefix}:00:${f.descriptor.gz}`,
    `${prefix}:156250:${f.descriptor.gz}`,
    `${f.descriptor.id}:0`,
    `${f.descriptor.id}${"x".repeat(MAX_STRUCTURE_ID_LENGTH)}`,
  ]) {
    assert.throws(
      () =>
        normalizeExplorationMarker(
          {
            ...marker,
            structureId: id,
            id: `${id}/${marker.type}/${marker.key}`,
          },
          f.context
        ),
      RangeError
    );
  }
  assert.throws(
    () =>
      memberIdentity(
        marker,
        createWorldContext({
          seed: "foreign",
          generatorVersion: 4,
        })
      ),
    RangeError
  );
  assert.throws(
    () =>
      memberIdentity(
        marker,
        createWorldContext({
          seed: f.context.seed,
          generatorVersion: 3,
        })
      ),
    RangeError
  );
  assert.throws(
    () =>
      normalizeExplorationMarker(
        {
          ...marker,
          dimension: "nether",
        },
        f.context
      ),
    RangeError
  );
  assert.throws(
    () =>
      normalizeExplorationMarker(
        {
          ...marker,
          key: "x".repeat(49),
          id: `${marker.structureId}/container/${"x".repeat(49)}`,
        },
        f.context
      ),
    RangeError
  );
  let invoked = false;
  const invalid = { ...marker };
  Object.defineProperty(invalid, "id", {
    enumerable: true,
    get() {
      invoked = true;
      return marker.id;
    },
  });
  assert.throws(
    () => normalizeExplorationMarker(invalid, f.context),
    RangeError
  );
  assert.equal(invoked, false);
});

test("every actual catalog container role has an explicit compatible finite loot binding", () => {
  const seen = new Set();
  for (const f of catalogRoleFixtures()) {
    for (const raw of getStructureMarkers(f.descriptor, {
      type: "container",
    })) {
      const binding = STRUCTURE_LOOT_ROLES[raw.table];
      assert.ok(binding, `Unmapped actual catalog table ${raw.table}`);
      seen.add(raw.table);
      const marker = explorationMarkerFromStructure(
        f.descriptor,
        raw,
        f.context
      );
      assert.equal(marker.role, binding.loot);
      assert.equal(lootRoleForStructureMarker(f.descriptor, raw), binding.loot);
      assert.equal(marker.id, raw.id);
      assert.equal(getLootTable(marker.role).dimension, raw.dimension);
      assert.equal(lootNeedsMap(marker.role), Boolean(raw.mapTarget));
      assert.throws(
        () => normalizeExplorationMarker(raw, f.context),
        RangeError
      );
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(STRUCTURE_LOOT_ROLES).sort());
  assert.equal(seen.size, 16);
  assert.deepEqual(LOOT_ACQUISITION.HEART_OF_THE_SEA.guaranteed, [
    "buried_treasure",
  ]);
  assert.deepEqual(LOOT_ACQUISITION.NETHERITE_UPGRADE_TEMPLATE.guaranteed, [
    "bastion_treasure",
  ]);
  assert.equal(getLootTable("ocean_monument"), null);
});

test("catalog projections reject unknown tables, false roles, undeclared members and guarantees", () => {
  const f = catalogFixture("shipwreck", {
    matches: (d) => d.plan.damage === "whole",
  });
  const raw = getStructureMarkers(f.descriptor, { type: "container" }).find(
    (m) => m.key === "supply"
  );
  for (const changed of [
    { ...raw, table: "shipwreck/unknown" },
    { ...raw, role: "treasure" },
    { ...raw, table: "shipwreck_supply" },
    { ...raw, block: "STONE" },
    { ...raw, tableGuarantees: ["invented_reward"] },
    { ...raw, key: "unlisted", id: `${raw.structureId}/container/unlisted` },
    { ...raw, position: { ...raw.position, x: raw.position.x + 1 } },
  ]) {
    assert.throws(
      () => explorationMarkerFromStructure(f.descriptor, changed, f.context),
      RangeError
    );
  }
  assert.throws(
    () =>
      lootRoleForStructureMarker(
        { ...f.descriptor, kind: "ocean_monument" },
        raw
      ),
    RangeError
  );
});

test("actual catalog tables roll real canonical stacks without skipping missing registration", () => {
  // Parent must complete real item registration AND canonical map-ID admission.
  // This is intentionally unconditional: no skip, placeholder or empty fallback.
  requireProgressionItems(Object.keys(LOOT_ACQUISITION));
  for (const f of catalogRoleFixtures()) {
    for (const raw of getStructureMarkers(f.descriptor, {
      type: "container",
    })) {
      const marker = explorationMarkerFromStructure(
        f.descriptor,
        raw,
        f.context
      );
      const options = {};
      if (lootNeedsMap(marker.role)) {
        const { result } = catalogMapSearch(f, raw);
        const projected = mapResolutionFromStructure(result, f.context);
        assert.ok(projected.target);
        options.mapTarget = selectTreasureMapTarget(
          marker,
          [projected.target],
          f.context
        );
      }
      const stacks = rollStructureLoot(marker, f.context, options);
      assert.deepEqual(rollStructureLoot(marker, f.context, options), stacks);
      assert.ok(stacks.length > 0 && stacks.length <= MAX_LOOT_STACKS);
      assert.ok(stacks.every((stack) => isValidStack(stack, f.context)));
      for (const stack of stacks.filter(
        (value) => value.id === ITEM.TREASURE_MAP
      ))
        assert.deepEqual(stack.data.mapTarget, options.mapTarget);
      if (marker.role === "buried_treasure") {
        assert.equal(
          stacks
            .filter((s) => s.id === ITEM.HEART_OF_THE_SEA)
            .reduce((sum, s) => sum + s.count, 0),
          1
        );
      }
      if (marker.role === "bastion_treasure") {
        assert.equal(
          stacks
            .filter((s) => s.id === ITEM.NETHERITE_UPGRADE_TEMPLATE)
            .reduce((sum, s) => sum + s.count, 0),
          1
        );
      }
      if (lootNeedsMap(marker.role)) {
        assert.deepEqual(
          rollStructureLoot(marker, f.context, { mapTarget: null }),
          stacks.filter((s) => s.id !== ITEM.TREASURE_MAP),
          "absent destinations omit only map draws, without rerolling other rewards"
        );
      }
    }
  }
});

test("repeated descriptors partition by anchors before permanent full-ID claims, even when empty", () => {
  const f = catalogFixture("village", { seed: "anchor-partition-雪" });
  const all = explorationMarkersFromStructure(f.descriptor, f.context);
  const { bounds } = f.descriptor;
  const emptyBounds = { ...bounds, maxY: bounds.minY + 1 };
  assert.deepEqual(
    getStructureMarkers(f.descriptor, { bounds: emptyBounds }),
    []
  );
  assert.deepEqual(
    explorationMarkersFromStructure(f.descriptor, f.context, {
      bounds: emptyBounds,
    }),
    []
  );
  const claim = emptyClaimFixture(f.context);
  const seen = [];
  for (
    let cz = Math.floor(bounds.minZ / 16);
    cz <= Math.floor((bounds.maxZ - 1) / 16);
    cz++
  ) {
    for (
      let cx = Math.floor(bounds.minX / 16);
      cx <= Math.floor((bounds.maxX - 1) / 16);
      cx++
    ) {
      const packet = {
        minX: cx * 16,
        maxX: (cx + 1) * 16,
        minZ: cz * 16,
        maxZ: (cz + 1) * 16,
        minY: f.context.specForDimension("overworld").minY,
        maxY: f.context.specForDimension("overworld").maxY,
      };
      const markers = explorationMarkersFromStructure(
        structuredClone(f.descriptor),
        f.context,
        { bounds: packet }
      );
      assert.deepEqual(
        markers.map((m) => m.id),
        getStructureMarkers(f.descriptor, {
          bounds: packet,
          type: "container",
        }).map((m) => m.id)
      );
      if (!markers.length) continue;
      seen.push(...markers.map((m) => m.id));
      const plan = claim.ledger.prepareContainers(
        markers.map((marker) => ({ marker, action: "open", firstClaim: true })),
        claim.options
      );
      assert.equal(claim.ledger.commit(plan).ok, true);
    }
  }
  assert.deepEqual(seen.sort(), all.map((m) => m.id).sort());
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(claim.ledger.serialize().containers.length, all.length);
  assert.equal(claim.rolls.length, all.length);
  const again = explorationMarkersFromStructure(f.descriptor, f.context);
  assert.deepEqual(
    again,
    all,
    "projection itself must not consume a descriptor"
  );
  for (const marker of again)
    assert.equal(claim.ledger.prepareFirstOpen(marker, claim.options), null);
  assert.equal(claim.rolls.length, all.length);
});

test("actual marker anchors use half-open bounds, not encounter AABB overlap", () => {
  const f = catalogFixture("ocean_monument");
  const raw = getStructureMarkers(f.descriptor, { type: "encounter" })[0];
  const { x, y, z } = raw.position;
  const beforeAnchor = {
    minX: x - 1,
    maxX: x,
    minY: y,
    maxY: y + 1,
    minZ: z,
    maxZ: z + 1,
  };
  const atAnchor = { ...beforeAnchor, minX: x, maxX: x + 1 };
  assert.ok(raw.bounds.minX <= x - 1 && raw.bounds.maxX > x - 1);
  assert.deepEqual(
    explorationMarkersFromStructure(f.descriptor, f.context, {
      bounds: beforeAnchor,
    }),
    []
  );
  assert.deepEqual(
    explorationMarkersFromStructure(f.descriptor, f.context, {
      bounds: atAnchor,
    }).map((m) => m.id),
    [raw.id]
  );
});

test("full canonical claims retain cleared/destroyed/replacement tombstones and reject stale races", () => {
  const f = catalogFixture("village", { seed: "permanent-claim-雪" });
  const [first, second, replacement] = explorationMarkersFromStructure(
    f.descriptor,
    f.context
  );
  const claim = emptyClaimFixture(f.context);
  assert.equal(
    claim.ledger.commit(claim.ledger.prepareFirstOpen(first, claim.options)).ok,
    true
  );
  assert.equal(
    claim.ledger.commit(
      claim.ledger.prepareContainerState(first, "cleared", claim.options)
    ).ok,
    true
  );
  const cleared = claim.ledger.serialize();
  assert.equal(
    claim.ledger.commit(
      claim.ledger.prepareContainerState(first, "destroyed", claim.options)
    ).ok,
    true
  );
  const opened = claim.ledger.prepareFirstOpen(second, claim.options);
  const broken = claim.ledger.prepareFirstBreak(second, claim.options);
  assert.equal(claim.ledger.commit(broken).ok, true);
  assert.equal(claim.ledger.commit(opened).ok, false);
  const rolls = claim.rolls.length;
  assert.equal(claim.ledger.prepareFirstOpen(first, claim.options), null);
  assert.equal(claim.ledger.prepareFirstBreak(second, claim.options), null);
  assert.equal(
    claim.ledger.prepareFirstOpen(
      {
        ...replacement,
        position: { ...first.position },
      },
      claim.options
    ),
    null
  );
  assert.equal(claim.rolls.length, rolls);
  const restored = new ExplorationState({
    context: f.context,
    rollLoot() {
      assert.fail("Retained or replaced markers must not reroll");
    },
  });
  assert.equal(restored.load(cleared), true);
  assert.equal(restored.container(first).state, "cleared");
  assert.equal(restored.load(claim.ledger.serialize()), true);
  assert.equal(
    restored.containerAt(first.dimension, first.position).state,
    "destroyed"
  );
  assert.equal(restored.prepareFirstOpen(first, claim.options), null);
  const duplicate = claim.ledger.serialize();
  duplicate.containers.push(structuredClone(duplicate.containers[0]));
  assert.equal(normalizeExplorationSnapshot(duplicate, f.context), null);
});

test("actual monument elders retain distinct complete marker IDs across import and neighboring sites", () => {
  const f = catalogFixture("ocean_monument", { seed: "elder-identities-雪" });
  assert.deepEqual(
    getStructureMarkers(f.descriptor, { type: "container" }),
    []
  );
  const markers = explorationMarkersFromStructure(f.descriptor, f.context);
  assert.equal(markers.length, 3);
  const claim = emptyClaimFixture(f.context);
  for (const marker of markers) {
    assert.equal(marker.type, "encounter");
    assert.equal(
      claim.ledger.commit(
        claim.ledger.prepareEncounterComplete(marker, { validate: () => true })
      ).ok,
      true
    );
    assert.equal(
      claim.ledger.prepareEncounterComplete(marker, { validate: () => true }),
      null
    );
  }
  const neighbor = catalogDescriptor(
    "ocean_monument",
    f.terrainContext,
    (d) => d.id !== f.descriptor.id
  );
  const neighborMarker = explorationMarkersFromStructure(
    neighbor,
    f.context
  )[0];
  assert.equal(neighborMarker.key, markers[0].key);
  assert.notEqual(neighborMarker.id, markers[0].id);
  assert.equal(claim.ledger.completed(neighborMarker), false);
  const restored = new ExplorationState({ context: f.context });
  assert.equal(restored.load(claim.ledger.serialize()), true);
  assert.ok(markers.every((marker) => restored.completed(marker)));
  assert.equal(claim.rolls.length, 0);
});

test("actual Overworld and Nether catalog claims share one persistent world ledger", () => {
  const seed = "shared-dimensions-雪";
  const overworld = catalogFixture("village", { seed });
  const nether = catalogFixture("nether_fortress", { seed });
  const [home] = explorationMarkersFromStructure(
    overworld.descriptor,
    overworld.context
  );
  const [fortress] = explorationMarkersFromStructure(
    nether.descriptor,
    overworld.context
  );
  const claim = emptyClaimFixture(overworld.context);
  const plan = claim.ledger.prepareContainers(
    [
      { marker: home, action: "open", firstClaim: true },
      { marker: fortress, action: "break", firstClaim: true },
    ],
    claim.options
  );
  assert.equal(claim.ledger.commit(plan).ok, true);
  const saved = claim.ledger.serialize();
  const restored = new ExplorationState({ context: nether.context });
  assert.equal(restored.load(saved), true);
  assert.equal(restored.container(home).marker.id, home.id);
  assert.equal(restored.container(fortress).marker.id, fortress.id);
  assert.equal(restored.container(fortress).state, "destroyed");
  const invalid = structuredClone(saved);
  invalid.containers.find(
    (entry) => entry.marker.dimension === "nether"
  ).marker.position.y = -1;
  assert.equal(normalizeExplorationSnapshot(invalid, nether.context), null);
});
