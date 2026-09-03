import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { explorationAdmission } from "../src/exploration-host-state.js";
import { normalizeExplorationServicesSnapshot } from "../src/game-exploration-services.js";
import { explorationMarkersFromStructure } from "../src/exploration-markers.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  admitNativeStructure,
  explorationServicesFixture,
  nativeExplorationSite,
} from "./exploration-services-fixture.js";

test("reverse, anchor-free and duplicate native admissions never erase or consume real anchors", async (t) => {
  const f = await explorationServicesFixture(t, { stage: false });
  f.service = f.create();
  assert.equal(f.service.activate(f.game).ok, true);
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("admission must not roll loot")
  );
  const expected = explorationMarkersFromStructure(f.descriptor, f.context);
  const events = [...f.world.chunks.values()].map((chunk) =>
    explorationAdmission(f.world, chunk)
  );
  const anchorKeys = new Set(
    expected.map(
      ({ position: p }) => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
    )
  );
  const empty = events.find(
    (event) =>
      !anchorKeys.has(event.key) &&
      event.chunk.structures?.some(({ id }) => id === f.descriptor.id)
  );
  assert.ok(
    empty,
    "native layout must provide an intersecting anchor-free column"
  );
  assert.equal(f.service.onChunkAdmitted(f.world, empty), true);
  assert.equal(f.service.index.members.size, 0);
  for (const event of events.reverse()) {
    assert.equal(f.service.onChunkAdmitted(f.world, event), true);
    assert.equal(f.service.onChunkAdmitted(f.world, event), true);
  }
  assert.deepEqual(
    f
      .entries()
      .map(({ marker }) => marker.id)
      .sort(),
    expected
      .filter(({ type }) => type === "container")
      .map(({ id }) => id)
      .sort()
  );
  assert.deepEqual(f.service.serialize().exploration.containers, []);
  assert.equal(f.settlement.serialize().chests.length, 0);
  assert.equal(f.service.diagnostics().mapSearches, 0);
});

test("stale World/epoch/incarnation envelopes are rejected before affecting resident markers", async (t) => {
  const f = await explorationServicesFixture(t);
  const [entry] = f.entries();
  const admitted = f.admission(entry.marker);
  const before = f.service.index.list();
  for (const altered of [
    { epoch: admitted.epoch + 1 },
    { incarnation: admitted.incarnation + 1 },
    { revision: admitted.chunk.revision + 1 },
    { chunk: { ...admitted.chunk } },
    { dimension: "nether" },
    { seed: "foreign" },
    { key: "0,0", cx: 0, cz: 0 },
  ]) {
    assert.equal(
      f.service.onChunkAdmitted(
        f.world,
        Object.freeze({ ...admitted, ...altered })
      ),
      false
    );
    assert.deepEqual(f.service.index.list(), before);
  }
  assert.equal(f.service.onChunkAdmitted({}, admitted), false);
});

test("canonical membership rejects forged roles, coordinates and omitted anchors without erasing an admitted column", async (t) => {
  const f = await explorationServicesFixture(t, { stage: false });
  const descriptor = f.descriptor;
  const marker = explorationMarkersFromStructure(descriptor, f.context)[0];
  const chunk = f.admission(marker).chunk;
  const original = chunk.structures;
  f.service = f.create();
  assert.equal(f.service.activate(f.game).ok, true);
  const before = f.snapshot();
  const packets = [
    [],
    ...["table", "position", "missing"].map((change) => {
      const packet = structuredClone(original);
      const declaration = packet.find(({ id }) => id === descriptor.id);
      const member = declaration.markers.find(({ id }) => id === marker.id);
      if (change === "table") member.table = "shipwreck/supply";
      if (change === "position") member.position.x++;
      if (change === "missing")
        declaration.markers = declaration.markers.filter(
          ({ id }) => id !== marker.id
        );
      return packet;
    }),
  ];
  for (const packet of packets) {
    // Only the adversarial packet changes; native generated cells remain intact.
    chunk.structures = packet;
    assert.equal(
      f.service.onChunkAdmitted(f.world, f.admission(marker)),
      false
    );
    assert.equal(f.service.openContainer(f.hit(marker)).ok, false);
    assert.equal(
      f.settlement.getContainerState(f.world, f.hit(marker), f.gameplay),
      null
    );
    assert.deepEqual(f.snapshot(), before);
  }
  chunk.structures = original;
  assert.equal(f.service.onChunkAdmitted(f.world, f.admission(marker)), true);
  const owned = f.service.index.list();
  chunk.structures = [];
  assert.equal(f.service.onChunkAdmitted(f.world, f.admission(marker)), true);
  assert.deepEqual(
    f.service.index.list(),
    owned,
    "a duplicate envelope cannot erase previously validated anchors"
  );
  chunk.structures = original;
});

test("saved edits are applied before admission; removed/replaced legacy cells never receive a fresh roll", async (t) => {
  const f = await explorationServicesFixture(t);
  const [entry] = f.entries(),
    hit = f.hit(entry.marker);
  const save = f.world.serialize();
  save.edits.push([f.world.dimension, hit.x, hit.y, hit.z, BLOCK.STONE, 0, 0]);
  assert.equal(f.world.loadEdits(save), true);
  assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.STONE);
  assert.equal(f.service.openContainer(hit).ok, false);
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("edited anchor rerolled")
  );
  assert.equal(f.world.set(hit.x, hit.y, hit.z, BLOCK.CHEST), true);
  assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
  assert.equal(f.service.exploration.container(entry.marker).claim, "adopted");
  assert.equal(f.service.exploration.container(entry.marker).state, "cleared");
  assert.ok(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.every((stack) => stack === null)
  );
});

test("evicted/stale columns cannot open; re-admission restores markers but never rerolls owned or empty loot", async (t) => {
  const f = await explorationServicesFixture(t);
  const [entry] = f.entries(),
    hit = f.hit(entry.marker);
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.equal(f.service.commit(f.service.prepareClear(hit)).ok, true);
  const old = f.admission(entry.marker);
  const prepared = f.service.prepareOpen(hit);
  await f.world.ensureArea({ x: hit.x + 1024, z: hit.z + 1024 }, 0);
  f.service.frame();
  assert.equal(f.world.isLoaded(hit.x, hit.z), false);
  assert.equal(f.service.commit(prepared).ok, false);
  assert.equal(f.service.onChunkAdmitted(f.world, old), false);
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("eviction rerolled claimed loot")
  );
  await f.world.ensureArea(hit, 0);
  assert.notEqual(f.admission(entry.marker).incarnation, old.incarnation);
  assert.equal(f.service.onChunkAdmitted(f.world, old), false);
  assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
  assert.ok(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.every((stack) => stack === null)
  );
  assert.equal(f.service.exploration.container(entry.marker).state, "cleared");
});

test("bounded resident-cache pressure recovers real anchors on demand, independently of permanent claims", async (t) => {
  const f = await explorationServicesFixture(t, {
    limits: { columns: 1, markers: 64 },
  });
  const markers = explorationMarkersFromStructure(
    f.descriptor,
    f.context
  ).filter(({ type }) => type === "container");
  for (const marker of markers) {
    assert.equal(f.service.openContainer(f.hit(marker)).ok, true);
    assert.ok(f.service.index.columns.size <= 1);
    assert.ok(f.service.index.members.size <= 64);
  }
  assert.equal(
    f.service.serialize().exploration.containers.length,
    markers.length
  );
  for (const marker of markers)
    assert.equal(f.service.openContainer(f.hit(marker)).ok, true);
  assert.equal(
    f.service.serialize().exploration.containers.length,
    markers.length
  );
});

test("one ledger survives dimension travel and retains inactive-dimension claims", async (t) => {
  const f = await explorationServicesFixture(t);
  const [home] = f.entries();
  const old = f.admission(home.marker);
  assert.equal(f.service.openContainer(f.hit(home.marker)).ok, true);
  const ledger = f.service.exploration;
  f.world.setDimension("nether");
  assert.equal(f.service.onChunkAdmitted(f.world, old), false);
  const fortress = nativeExplorationSite(f.world, "nether_fortress");
  await admitNativeStructure(f.world, fortress);
  const [cache] = f.service.index.list("container");
  assert.ok(cache && cache.marker.dimension === "nether");
  assert.equal(f.service.openContainer(f.hit(cache.marker)).ok, true);
  assert.equal(f.service.exploration, ledger);
  assert.equal(ledger.serialize().containers.length, 2);
  const saved = f.service.serialize();
  assert.ok(normalizeExplorationServicesSnapshot(saved, f.context));
  const invalid = structuredClone(saved);
  invalid.exploration.containers.find(
    ({ marker }) => marker.dimension === "nether"
  ).marker.position.y = -1;
  assert.equal(normalizeExplorationServicesSnapshot(invalid, f.context), null);
  f.world.setDimension("overworld");
  await f.world.ensureArea(home.marker.position, 0);
  t.mock.method(ledger, "_rollLoot", () =>
    assert.fail("travel rerolled old claims")
  );
  assert.equal(f.service.openContainer(f.hit(home.marker)).ok, true);
  assert.equal(ledger.serialize().containers.length, 2);
  assert.equal(ledger.container(cache.marker).marker.dimension, "nether");
});

test("malformed-present preflight is pure; failed staging/activation leak no registrations or live bindings", async (t) => {
  const f = await explorationServicesFixture(t);
  const [entry] = f.entries();
  assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
  const valid = f.service.serialize(),
    before = f.snapshot();
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, "exploration", {
    enumerable: true,
    get() {
      invoked = true;
      return valid.exploration;
    },
  });
  for (const saved of [
    { exploration: null },
    { exploration: undefined },
    { exploration: { ...valid.exploration, version: 99 } },
    { exploration: { ...valid.exploration, seed: "other" } },
    {
      exploration: {
        ...valid.exploration,
        containers: [
          valid.exploration.containers[0],
          valid.exploration.containers[0],
        ],
      },
    },
    accessor,
  ]) {
    assert.equal(normalizeExplorationServicesSnapshot(saved, f.context), null);
    assert.throws(() => f.create({ saved }));
    assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(invoked, false);
  const candidate = f.create({ saved: valid });
  const bytes = f.coordinator.budget.totalBytes;
  assert.equal(candidate.activate(f.game).ok, false);
  assert.equal(candidate.dispose(), true);
  assert.ok(f.coordinator.budget.totalBytes < bytes);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.active, true);
});

test("staged load honors allowOverBudget and remains detached until activation/replay", async (t) => {
  const source = await explorationServicesFixture(t);
  const [entry] = source.entries();
  assert.equal(source.service.openContainer(source.hit(entry.marker)).ok, true);
  const saved = source.service.serialize();
  const f = await explorationServicesFixture(t, { stage: false });
  assert.equal(
    f.settlement.load(source.settlement.serialize(), {
      context: f.context,
      world: f.world,
    }),
    true
  );
  const blocker = {};
  assert.equal(
    f.coordinator.register(
      blocker,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.coordinator.budget.totalBytes;
  assert.throws(() => f.create({ saved }));
  assert.equal(f.coordinator.budget.totalBytes, before);
  f.service = f.create({ saved, allowOverBudget: true });
  assert.equal(f.service.index.members.size, 0);
  assert.deepEqual(f.service.serialize(), saved);
  assert.equal(
    f.service.load({ exploration: null }, { allowOverBudget: true }),
    false
  );
  assert.deepEqual(f.service.serialize(), saved);
  assert.equal(f.service.activate(f.game).ok, true);
  const hit = f.hit(entry.marker);
  assert.equal(
    f.service.openContainer(hit).ok,
    true,
    "a zero-growth read works over budget"
  );
  assert.equal(
    f.service.load(saved, { allowOverBudget: true }),
    false,
    "live hosts never reload"
  );
});

for (const seed of ["a".repeat(80), "雪".repeat(80), "海底の宝藏 🐠 é"]) {
  test(`real native marker identity and persistent slot ownership survive the seed ${JSON.stringify(seed)}`, async (t) => {
    const f = await explorationServicesFixture(t, { seed });
    const [entry] = f.entries();
    assert.ok(
      entry.marker.id.includes(encodeURIComponent(JSON.stringify(seed)))
    );
    assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
    const snapshot = f.service.serialize();
    assert.deepEqual(
      normalizeExplorationServicesSnapshot(
        snapshot,
        createWorldContext({
          seed,
          generatorVersion: 4,
        })
      ),
      snapshot
    );
    assert.equal(snapshot.exploration.containers[0].marker.id, entry.marker.id);
    assert.equal(
      f.service.exploration.container(entry.marker).marker.id,
      entry.marker.id
    );
  });
}
