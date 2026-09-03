import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  chestBlockDrops,
  expectedExplorationSlots,
  explorationServicesFixture,
  holdExplorationTool,
  installLegacyChest,
  itemTotals,
  retainedStacks,
} from "./exploration-services-fixture.js";

const first = (f) => f.entries()[0];
const uniqueOwners = (plan) => {
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(
    new Set(plan.participants.map(({ owner }) => owner)).size,
    plan.participants.length
  );
};

test("native admission owns no loot; first-open atomically installs real Settlement slots and a claim", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  assert.equal(f.settlement.inspectContainer(f.world, hit).initialized, false);
  assert.deepEqual(f.service.serialize().exploration.containers, []);
  assert.equal(f.service.diagnostics().mapSearches, 0);
  assert.equal(
    f.settlement.getContainerState(f.world, hit, f.gameplay),
    null,
    "lazy reads cannot steal unresolved native ownership"
  );
  const before = f.snapshot();
  const plan = f.service.prepareOpen(hit);
  uniqueOwners(plan);
  assert.deepEqual(
    plan.participants.map(({ owner }) => owner),
    [f.service.exploration, f.settlement]
  );
  assert.deepEqual(f.snapshot(), before);
  let observed = 0;
  f.settlement.onChange = () => {
    observed++;
    assert.equal(
      f.service.exploration.container(entry.marker).state,
      "materialized"
    );
    assert.deepEqual(
      f.settlement.inspectContainer(f.world, hit).slots,
      expectedExplorationSlots(entry, f.context)
    );
  };
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(observed, 1);
  assert.equal(f.service.commit(plan).ok, false);
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.deepEqual(
    f.settlement.getContainerState(f.world, hit, f.gameplay).slots,
    expectedExplorationSlots(entry, f.context)
  );
  const saved = f.service.serialize().exploration;
  assert.equal(
    f.service.exploration.reservedBytes,
    encodedBytes(saved.containers) - 2 + encodedBytes(saved.encounters) - 2
  );
});

test("first-break beats a prepared open with one real tool cost, removal and retained loot destination", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  const tool = holdExplorationTool(f, 1);
  const opened = f.service.prepareOpen(hit);
  const broken = f.prepareBreak(hit);
  uniqueOwners(broken);
  assert.deepEqual(
    new Set(broken.participants.map(({ owner }) => owner)),
    new Set([
      f.world,
      f.gameplay,
      f.settlement,
      f.overflow,
      f.service.exploration,
    ])
  );
  let observed = 0;
  f.gameplay.onChange = () => {
    observed++;
    assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
    assert.equal(f.gameplay.getHandStack(), null);
    assert.equal(
      f.service.exploration.container(entry.marker).state,
      "destroyed"
    );
    assert.ok(f.overflow.size > 0);
  };
  assert.equal(f.service.commit(broken).ok, true);
  assert.equal(observed, 1);
  assert.equal(f.service.commit(opened).ok, false);
  assert.equal(f.service.commit(broken).ok, false);
  assert.deepEqual(
    itemTotals(retainedStacks(f)),
    itemTotals([
      { id: BLOCK.CHEST, count: 1 },
      ...expectedExplorationSlots(entry, f.context).filter(Boolean),
    ])
  );
  assert.equal(tool.durability, 1, "detached held metadata is not edited");
  assert.equal(f.service.exploration.container(entry.marker).claim, "break");
});

test("open beats break; the next break drains actual changed slots without rerolling", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  holdExplorationTool(f);
  const opened = f.service.prepareOpen(hit);
  const broken = f.prepareBreak(hit);
  assert.equal(f.service.commit(opened).ok, true);
  assert.equal(f.service.commit(broken).ok, false);
  const original = f.settlement
    .inspectContainer(f.world, hit)
    .slots.filter(Boolean);
  assert.equal(
    f.settlement.containerAction(f.world, hit, f.gameplay, {
      type: "quickMove",
      area: "container",
      index: 0,
    }).ok,
    true
  );
  const contents = f.settlement
    .inspectContainer(f.world, hit)
    .slots.filter(Boolean);
  assert.ok(
    contents.reduce((n, s) => n + s.count, 0) <
      original.reduce((n, s) => n + s.count, 0)
  );
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("claimed chest rerolled")
  );
  const next = f.prepareBreak(hit);
  assert.equal(f.service.commit(next).ok, true);
  assert.deepEqual(
    itemTotals(retainedStacks(f)),
    itemTotals([{ id: BLOCK.CHEST, count: 1 }, ...contents])
  );
  assert.equal(f.settlement.inspectContainer(f.world, hit), null);
  assert.equal(f.gameplay.getHandStack().durability, 8);
});

test("clearing retains every actual stack and an empty claim; a replacement never refills it", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  assert.equal(f.service.openContainer(hit).ok, true);
  const contents = f.settlement
    .inspectContainer(f.world, hit)
    .slots.filter(Boolean);
  const clear = f.service.prepareClear(hit);
  uniqueOwners(clear);
  assert.equal(f.service.commit(clear).ok, true);
  assert.equal(f.service.exploration.container(entry.marker).state, "cleared");
  assert.ok(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.every((slot) => slot === null)
  );
  assert.deepEqual(itemTotals(retainedStacks(f)), itemTotals(contents));
  t.mock.method(f.service.exploration, "_rollLoot", () =>
    assert.fail("empty claim rerolled")
  );
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.equal(
    f.service.commit(f.prepareBreak(hit, { explosion: true })).ok,
    true
  );
  assert.equal(f.world.set(hit.x, hit.y, hit.z, BLOCK.CHEST), true);
  assert.equal(f.service.openContainer(f.hit(entry.marker)).ok, true);
  assert.ok(
    f.settlement
      .inspectContainer(f.world, hit)
      .slots.every((slot) => slot === null)
  );
  assert.equal(
    f.service.exploration.container(entry.marker).state,
    "destroyed"
  );
});

for (const empty of [false, true]) {
  test(`initialized ${empty ? "empty" : "populated"} legacy native chest adopts without rolling`, async (t) => {
    const f = await explorationServicesFixture(t);
    const entry = first(f),
      hit = f.hit(entry.marker);
    const stacks = empty
      ? []
      : [
          {
            id: ITEM.IRON_AXE,
            count: 1,
            durability: 7,
            data: { version: 1, name: "Legacy 海" },
          },
        ];
    installLegacyChest(f, hit, stacks);
    t.mock.method(f.service.exploration, "_rollLoot", () =>
      assert.fail("legacy ownership rerolled")
    );
    const before = f.snapshot();
    const adopted = f.service.prepareOpen(hit);
    assert.equal(adopted.result.adopted, true);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.service.commit(adopted).ok, true);
    assert.equal(
      f.service.exploration.container(entry.marker).claim,
      "adopted"
    );
    assert.equal(
      f.service.exploration.container(entry.marker).lootVersion,
      null
    );
    assert.deepEqual(
      itemTotals(f.settlement.inspectContainer(f.world, hit).slots),
      itemTotals(stacks)
    );
  });
}

test("a late legacy initialization invalidates the prepared roll instead of overwriting owned slots", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  const firstOpen = f.service.prepareOpen(hit);
  const legacy = [{ id: ITEM.DIAMOND, count: 2 }];
  installLegacyChest(f, hit, legacy);
  const before = f.snapshot();
  assert.equal(f.service.commit(firstOpen).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.openContainer(hit).ok, true);
  assert.deepEqual(
    itemTotals(f.settlement.inspectContainer(f.world, hit).slots),
    itemTotals(legacy)
  );
});

for (const stale of ["hand", "world", "station", "ledger", "host"]) {
  test(`stale real ${stale} refuses the entire first-break plan`, async (t) => {
    const f = await explorationServicesFixture(t);
    const entry = first(f),
      hit = f.hit(entry.marker);
    holdExplorationTool(f);
    const plan = f.prepareBreak(hit);
    uniqueOwners(plan);
    if (stale === "hand") f.gameplay.select(1);
    if (stale === "world") {
      const before = f.world.getCell(hit.x, hit.y + 1, hit.z);
      assert.equal(
        f.world.applyCells([
          {
            x: hit.x,
            y: hit.y + 1,
            z: hit.z,
            before,
            after: { id: before.id === BLOCK.STONE ? BLOCK.DIRT : BLOCK.STONE },
          },
        ]),
        true
      );
    }
    if (stale === "station") {
      const read = f.settlement.prepareContainers(f.world, [
        { hit, action: "observe" },
      ]);
      assert.equal(f.coordinator.commit(read.participants).ok, true);
    }
    if (stale === "ledger")
      assert.equal(
        f.service.exploration.load(f.service.serialize().exploration),
        true
      );
    if (stale === "host") f.game.explorationServices = null;
    const before = {
      world: f.world.serialize(),
      settlement: f.settlement.serialize(),
      overflow: f.overflow.serialize(),
      gameplay: f.gameplay.serialize(),
      ledger: f.service.exploration.serialize(),
      bytes: f.coordinator.budget.totalBytes,
    };
    assert.equal(f.service.commit(plan).ok, false);
    assert.deepEqual(
      {
        world: f.world.serialize(),
        settlement: f.settlement.serialize(),
        overflow: f.overflow.serialize(),
        gameplay: f.gameplay.serialize(),
        ledger: f.service.exploration.serialize(),
        bytes: f.coordinator.budget.totalBytes,
      },
      before
    );
  });
}

test("full save budget refuses open and break without lazy empty ownership or hand wear", async (t) => {
  const f = await explorationServicesFixture(t);
  const entry = first(f),
    hit = f.hit(entry.marker);
  holdExplorationTool(f);
  assert.equal(
    f.coordinator.register(
      {},
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.snapshot();
  for (const plan of [f.service.prepareOpen(hit), f.prepareBreak(hit)]) {
    assert.equal(f.service.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(
      f.settlement.getContainerState(f.world, hit, f.gameplay),
      null
    );
  }
});

test("full retained overflow refuses the whole unopened container batch", async (t) => {
  const f = await explorationServicesFixture(t, { maxEntries: 1 });
  const hit = f.hit(first(f).marker);
  assert.equal(
    f.overflow.enqueue(
      [{ id: BLOCK.DIRT, count: 1 }],
      { x: hit.x + 4.5, y: hit.y + 0.5, z: hit.z + 0.5 },
      f.world.dimension
    ),
    true
  );
  holdExplorationTool(f);
  const before = f.snapshot();
  assert.equal(f.service.commit(f.prepareBreak(hit)).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.settlement.getContainerState(f.world, hit, f.gameplay), null);
});

test("async and wrong-owner retained destinations refuse without calling or publishing a fallback", async (t) => {
  const f = await explorationServicesFixture(t);
  const hit = f.hit(first(f).marker);
  holdExplorationTool(f);
  const before = f.snapshot();
  let called = false;
  const asynchronous = async () => {
    called = true;
    return null;
  };
  assert.equal(f.prepareBreak(hit, { prepareDrops: asynchronous }).ok, false);
  assert.equal(
    f.service.prepareBreakBatch([{ hit, drops: chestBlockDrops(f) }], {
      explosion: true,
      prepareDrops: asynchronous,
    }).ok,
    false
  );
  assert.equal(called, false);
  assert.equal(
    f.prepareBreak(hit, {
      prepareDrops: () => f.gameplay.prepareInventory(() => true),
    }).ok,
    false,
    "only the authoritative overflow owner may retain this batch"
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.settlement.getContainerState(f.world, hit, f.gameplay), null);
});

test("one explosion batch conserves first-time, opened and legacy containers with one participant per owner", async (t) => {
  const f = await explorationServicesFixture(t);
  const entries = f.entries();
  assert.equal(entries.length, 3);
  const hits = entries.map(({ marker }) => f.hit(marker));
  assert.equal(f.service.openContainer(hits[1]).ok, true);
  const legacy = [
    {
      id: ITEM.IRON_AXE,
      count: 1,
      durability: 5,
      data: { version: 1, name: "Explosion keeps this ⚒" },
    },
  ];
  installLegacyChest(f, hits[2], legacy);
  const expected = [
    ...expectedExplorationSlots(entries[0], f.context),
    ...f.settlement.inspectContainer(f.world, hits[1]).slots,
    ...legacy,
    { id: BLOCK.CHEST, count: hits.length },
  ].filter(Boolean);
  const request = hits.map((hit) => ({ hit, drops: chestBlockDrops(f) }));
  const before = f.snapshot();
  const plan = f.service.prepareBreakBatch(request, { explosion: true });
  uniqueOwners(plan);
  assert.equal(plan.participants.length, 4);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.commit(plan).ok, true);
  assert.deepEqual(itemTotals(retainedStacks(f)), itemTotals(expected));
  for (const hit of hits)
    assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
  for (const entry of entries)
    assert.equal(
      f.service.exploration.container(entry.marker).state,
      "destroyed"
    );
  assert.equal(
    f.service.exploration.container(entries[2].marker).claim,
    "adopted"
  );
  assert.equal(f.service.commit(plan).ok, false);
  assert.equal(
    f.service.prepareBreakBatch([request[0], request[0]], { explosion: true })
      .ok,
    false
  );
});

test("aggregate capacity can be funded in the same first-break transaction; duplicate owner plans reject", async (t) => {
  const f = await explorationServicesFixture(t);
  const hit = f.hit(first(f).marker);
  const blocker = {};
  const reserved = MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes;
  assert.equal(f.coordinator.register(blocker, reserved), true);
  let released = false;
  const freeing = {
    owner: blocker,
    beforeBytes: reserved,
    afterBytes: 0,
    validate: () => !released,
    publish() {
      released = true;
    },
  };
  const duplicate = f.service.prepareBreakBatch(
    [{ hit, drops: chestBlockDrops(f) }],
    {
      explosion: true,
      participants: [freeing, freeing],
    }
  );
  assert.equal(duplicate.ok, false);
  const plan = f.service.prepareBreakBatch(
    [{ hit, drops: chestBlockDrops(f) }],
    {
      explosion: true,
      participants: [freeing],
    }
  );
  uniqueOwners(plan);
  assert.equal(f.service.commit(plan).ok, true);
  assert.equal(released, true);
  assert.ok(f.overflow.size > 0);
});
