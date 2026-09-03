import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BOATS } from "../src/boat-definitions.js";
import { normalizeBoatSnapshot } from "../src/boat-save.js";
import { MAX_FISHING_CASTS } from "../src/fishing-physics.js";
import { normalizeFishingSnapshot } from "../src/fishing-save.js";
import { encodedBytes } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import { aquaticOwners, savedHookFixture } from "./vehicle-fishing-fixture.js";

test("boat normalization is detached, bounded and preserves negative-Y/contextual ownership", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT", { data: { version: 1, name: "河口" } });
  const boats = fixture.boats();
  assert.equal(boats.place(fixture.placement()).ok, true);
  const snapshot = boats.serialize();
  snapshot.boats[0].y = -64;
  const bytes = fixture.coordinator.budget.totalBytes;
  const parsed = normalizeBoatSnapshot(snapshot, fixture.world.context);
  assert.ok(parsed);
  assert.equal(parsed.boats[0].y, -64);
  parsed.boats[0].stack.data.name = "detached";
  assert.equal(snapshot.boats[0].stack.data.name, "河口");
  assert.equal(fixture.coordinator.budget.totalBytes, bytes);
  assert.ok(encodedBytes(boats.serialize()) <= boats.reservedBytes);
  assert.equal(
    normalizeBoatSnapshot(
      snapshot,
      createWorldContext({ seed: "another-world", generatorVersion: 4 })
    ),
    null
  );
  assert.equal(
    normalizeBoatSnapshot(
      { ...snapshot, generatorVersion: 3 },
      createWorldContext({ seed: fixture.world.seed, generatorVersion: 3 })
    ),
    null
  );
});

test("duplicate boat/passenger IDs, unsupported wood, and oversized snapshots reject atomically", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("OAK_BOAT");
  const boats = fixture.boats();
  const placed = boats.place(fixture.placement());
  assert.equal(placed.ok, true);
  assert.equal(boats.mount(placed.id).ok, true);
  const original = boats.serialize();
  const cases = [
    { ...original, version: 99 },
    { ...original, nextId: original.boats[0].id },
    {
      ...original,
      boats: [original.boats[0], structuredClone(original.boats[0])],
    },
    {
      ...original,
      nextId: 3,
      boats: [
        original.boats[0],
        { ...structuredClone(original.boats[0]), id: 2 },
      ],
    },
    { ...original, boats: [{ ...original.boats[0], wood: "crimson" }] },
    {
      ...original,
      nextId: MAX_BOATS + 2,
      boats: Array.from({ length: MAX_BOATS + 1 }, (_, index) => ({
        ...structuredClone(original.boats[0]),
        id: index + 1,
        passengers: [null, null],
      })),
    },
  ];
  for (const snapshot of cases) {
    assert.equal(boats.load(snapshot), false);
    assert.deepEqual(boats.serialize(), original);
  }
});

test("fishing reload explicitly rebinds slot identity without rerolling bite windows", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD", {
    data: {
      version: 1,
      name: "Tidal line",
      enchantments: { lure: 1, luck_of_the_sea: 1 },
    },
  });
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const snapshot = fishing.serialize();
  const progress = () => {
    const result = [];
    for (let tick = 0; tick < 10; tick++) {
      fishing.update(0.05);
      const cast = fishing.getCast();
      result.push([
        cast.phase,
        cast.remaining,
        cast.randomState,
        cast.x,
        cast.y,
        cast.z,
      ]);
    }
    return result;
  };
  const expected = progress();
  assert.equal(fixture.gameplay.load(fixture.gameplay.serialize()), true);
  assert.equal(fishing.load(snapshot), true);
  const unbound = fishing.serialize();
  assert.equal(fishing.update(10).ticks, 0);
  assert.equal(fishing.reel().reason, "needs-owner-binding");
  assert.deepEqual(fishing.serialize(), unbound);
  assert.equal(fishing.bindLoadedOwner().ok, true);
  assert.deepEqual(progress(), expected);
  assert.ok(encodedBytes(fishing.serialize()) <= fishing.reservedBytes);
});

test("a different saved slot/rod cannot be rebound to inherit an old catch", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const snapshot = fishing.serialize();
  fixture.setHand("FISHING_ROD", { durability: 12 });
  assert.equal(fishing.load(snapshot), true);
  const before = fishing.serialize();
  assert.equal(fishing.bindLoadedOwner().reason, "saved-rod-mismatch");
  assert.deepEqual(fishing.serialize(), before);
  assert.equal(fixture.overflow.size, 0);
});

test("invalid fishing phases, RNG, metadata and owner-count overflows reject without truncation", (t) => {
  const fixture = aquaticOwners(t);
  fixture.setHand("FISHING_ROD");
  const fishing = fixture.fishing();
  savedHookFixture(fishing, fixture.world);
  const original = fishing.serialize();
  const change = (fields) => ({
    ...original,
    casts: [{ ...structuredClone(original.casts[0]), ...fields }],
  });
  const cases = [
    { ...original, randomState: -1 },
    { ...original, version: 2 },
    change({ phase: "hook", total: 200, remaining: 200 }),
    change({ remaining: 0 }),
    change({ randomState: NaN }),
    change({ dimension: "nether", y: -80 }),
    change({
      rod: {
        ...original.casts[0].rod,
        data: { version: 1, enchantments: { lure: 4 } },
      },
    }),
    {
      ...original,
      nextId: 3,
      casts: [
        original.casts[0],
        { ...structuredClone(original.casts[0]), id: 2 },
      ],
    },
    {
      ...original,
      nextId: MAX_FISHING_CASTS + 2,
      casts: Array.from({ length: MAX_FISHING_CASTS + 1 }, (_, index) => ({
        ...structuredClone(original.casts[0]),
        id: index + 1,
        ownerId: `player${index}`,
      })),
    },
  ];
  for (const snapshot of cases) {
    assert.equal(
      normalizeFishingSnapshot(snapshot, fixture.world.context),
      null
    );
    assert.equal(fishing.load(snapshot), false);
    assert.deepEqual(fishing.serialize(), original);
  }
});
