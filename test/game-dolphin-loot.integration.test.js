import assert from "node:assert/strict";
import test from "node:test";
import { currentDolphinGuide, findDolphinGuide } from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { explorationAdmission } from "../src/exploration-host-state.js";
import { ITEM } from "../src/items.js";
import { installLegacyChest } from "./exploration-services-fixture.js";
import { nativeDolphinLootGame } from "./game-dolphin-loot-fixture.js";

const savedGuide = (f) => f.ecology.ecology.state(f.mob.id).guide;
const goalFor = (entry) => ({
  x: entry.marker.position.x + 0.5, y: entry.marker.position.y + 1,
  z: entry.marker.position.z + 0.5,
});
const terrainWork = (f) => ({
  chunks: f.world.generator.counters.chunkGenerations,
  regions: f.world.generator.counters.regionGenerations,
  searches: f.exploration.diagnostics().mapSearches,
});
const observeGuide = (f) => currentDolphinGuide(
  f.mob.position, f.world.dimension, savedGuide(f), f.descriptor, f.observe()
);
const stacks = (f) => f.gameplay.getState().slots.filter(Boolean);
const count = (f, id) => stacks(f).filter((stack) => stack.id === id)
  .reduce((sum, stack) => sum + stack.count, 0);

function prohibitScouting(t, f) {
  const spies = [];
  for (const [owner, methods] of [
    [f.world, ["ensureArea", "_generateSync"]],
    [f.world.generator, ["sampleColumn", "generateChunk"]],
    [f.exploration.index, ["ensure", "admit", "list"]],
    [f.exploration.exploration, ["_rollLoot"]],
    [f.settlement, ["getChest", "getContainerState"]],
  ])
    for (const method of methods)
      spies.push(t.mock.method(owner, method, () =>
        assert.fail(`dolphin scouting cannot call ${method}`)));
  return () => spies.forEach((spy) => spy.mock.restore());
}

test("native v7 Game input guides to real remaining wreck loot, not emptied materialized claims", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  assert.deepEqual(Object.values(f.statuses()), ["untouched", "untouched"]);
  const before = f.ownership(), work = terrainWork(f);
  const observation = f.observe();
  assert.equal(observation.validate(), true);
  assert.equal(Object.isFrozen(observation.structures[0].containers[0].position), true);
  assert.deepEqual(f.ownership(), before, "the observation has no save or inventory side effects");

  const allowScouting = prohibitScouting(t, f);
  const preparation = t.mock.method(f.ecology, "prepareInteraction");
  f.feed();
  assert.equal(preparation.mock.callCount(), 1, "KeyV reaches the real Ecology interaction owner");
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.equal(savedGuide(f)?.id, f.descriptor.id);
  assert.deepEqual(Object.keys(savedGuide(f)).sort(), ["id", "kind", "position", "remaining"]);
  f.stepGuide();
  assert.deepEqual(f.mob.lookTarget, observeGuide(f).goal);
  assert.equal(f.ecology.modifiers().swimSpeedMultiplier, 1.6, "existing Grace still reaches the effect owner");
  assert.deepEqual(terrainWork(f), work);
  assert.deepEqual(f.settlement.serialize(), before.archive.settlement);
  assert.deepEqual(f.exploration.exploration.serialize(), before.archive.exploration);
  allowScouting();

  const first = f.entries.find((entry) =>
    JSON.stringify(goalFor(entry)) === JSON.stringify(f.mob.lookTarget));
  const second = f.entries.find((entry) => entry !== first);
  assert.ok(first && second);
  const firstLoot = f.open(first).filter(Boolean);
  assert.ok(firstLoot.length > 1, "fixture needs partially lootable real native stock");
  f.drain(first, 1);
  assert.equal(f.statuses()[first.marker.id], "nonempty");
  f.approach();
  f.stepGuide();
  assert.deepEqual(f.mob.lookTarget, goalFor(first));
  f.drain(first);
  assert.equal(f.exploration.exploration.container(first.marker).state, "materialized");
  assert.equal(f.statuses()[first.marker.id], "empty");
  f.stepGuide();
  assert.equal(savedGuide(f).id, f.descriptor.id, "the same saved structure can still contain useful loot");
  assert.deepEqual(f.mob.lookTarget, goalFor(second), "live chest goal moves to the untouched sibling");
  const secondLoot = f.open(second).filter(Boolean);
  f.drain(second);
  assert.equal(f.exploration.exploration.container(second.marker).state, "materialized");
  assert.deepEqual(Object.values(f.statuses()), ["empty", "empty"]);
  f.approach();
  f.stepGuide();
  assert.equal(savedGuide(f), null, "known depletion clears guidance immediately");
  assert.equal(f.mob.lookTarget, null);
  assert.ok(f.ecology.ecology.state(f.mob.id).assistTime > 0);
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.equal(count(f, ITEM.TREASURE_MAP), 1);
  const acquired = f.gameplay.serialize(), searches = terrainWork(f).searches;
  for (const entry of f.entries)
    assert.ok(f.open(entry).every((stack) => stack === null));
  assert.deepEqual(f.gameplay.serialize(), acquired);
  assert.equal(terrainWork(f).searches, searches, "reopening cannot repeat map searches");
  const saved = f.snapshot();
  const restored = await nativeDolphinLootGame(t, { saved: structuredClone(saved) });
  assert.deepEqual(restored.ecology.ecology.serialize(), f.ecology.ecology.serialize());
  assert.deepEqual(restored.gameplay.serialize(), acquired);
  assert.deepEqual(restored.settlement.serialize(), f.settlement.serialize());
  const rolls = t.mock.method(restored.exploration.exploration, "_rollLoot", () =>
    assert.fail("cold empty native chests must never roll again"));
  for (const entry of restored.entries)
    assert.ok(restored.open(entry).every((stack) => stack === null));
  restored.stepGuide();
  assert.equal(savedGuide(restored), null);
  assert.equal(count(restored, ITEM.TREASURE_MAP), 1);
  assert.equal(restored.gameplay.getHandStack().count, 1);
  assert.equal(rolls.mock.callCount(), 0);
  assert.equal(terrainWork(restored).searches, 0);
  t.diagnostic(JSON.stringify({
    ...f.nativeProof, firstGoal: first.marker.id, nextGoal: second.marker.id,
    firstLoot, secondLoot, finalStatuses: f.statuses(),
    finalGuide: savedGuide(f), fishRemaining: f.gameplay.getHandStack().count,
    mapCount: count(restored, ITEM.TREASURE_MAP), coldReloadRerolls: rolls.mock.callCount(),
  }));
});

test("native legacy initialized contents guide without adopting, rolling or losing cold-save data", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  installLegacyChest(f, f.hit(f.entries[0]), []);
  const legacy = { id: ITEM.DIAMOND, count: 3, data: { version: 1, name: "Legacy wreck stash" } };
  installLegacyChest(f, f.hit(f.entries[1]), [legacy]);
  assert.deepEqual(Object.values(f.statuses()), ["empty", "nonempty"]);
  assert.equal(f.exploration.exploration.serialize().containers.length, 0);
  const allowScouting = prohibitScouting(t, f);
  f.feed();
  f.stepGuide();
  assert.deepEqual(f.mob.lookTarget, goalFor(f.entries[1]));
  assert.equal(f.exploration.exploration.serialize().containers.length, 0);
  allowScouting();
  const saved = f.snapshot();
  const restored = await nativeDolphinLootGame(t, { saved: structuredClone(saved) });
  assert.deepEqual(restored.ecology.ecology.serialize(), f.ecology.ecology.serialize());
  assert.deepEqual(restored.settlement.serialize(), f.settlement.serialize());
  assert.deepEqual(restored.gameplay.serialize(), f.gameplay.serialize());
  assert.deepEqual(Object.values(restored.statuses()), ["empty", "nonempty"]);
  assert.deepEqual(savedGuide(restored), savedGuide(f), "legacy structure guide fields round-trip unchanged");
  assert.equal(terrainWork(restored).searches, 0);
  const rolls = t.mock.method(restored.exploration.exploration, "_rollLoot", () =>
    assert.fail("legacy initialized contents must never roll new loot"));
  const stock = restored.open(restored.entries[1]).filter(Boolean);
  assert.deepEqual(stock, [legacy]);
  assert.equal(restored.exploration.exploration.container(restored.entries[1].marker).claim, "adopted");
  restored.drain(restored.entries[1]);
  restored.approach();
  restored.stepGuide();
  assert.equal(savedGuide(restored), null);
  assert.equal(count(restored, ITEM.DIAMOND), 3);
  assert.ok(restored.open(restored.entries[1]).every((stack) => stack === null));
  assert.equal(rolls.mock.callCount(), 0);
  assert.equal(count(restored, ITEM.DIAMOND), 3);
});

test("unknown resident anchors pause the runtime goal without inventing treasure or rewriting the saved guide", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  f.feed();
  const guide = savedGuide(f), ownership = f.ownership();
  f.exploration.index.reset();
  const unadmitted = f.observe();
  assert.deepEqual(Object.values(f.statuses()), ["unknown", "unknown"]);
  assert.equal(findDolphinGuide(f.mob.position, "overworld", [f.descriptor], unadmitted), null);
  assert.equal(unadmitted.validate(), true);
  const allowScouting = prohibitScouting(t, f);
  f.stepGuide();
  assert.equal(f.mob.lookTarget, null);
  assert.deepEqual(savedGuide(f), { ...guide, remaining: guide.remaining - 0.05 });
  assert.deepEqual(f.settlement.serialize(), ownership.archive.settlement);
  assert.deepEqual(f.exploration.exploration.serialize(), ownership.archive.exploration);
  allowScouting();
  for (const chunk of f.world.chunks.values())
    assert.equal(f.exploration.onChunkAdmitted(f.world, explorationAdmission(f.world, chunk)), true);
  assert.equal(unadmitted.validate(), false, "new admission invalidates the observed unknown identity");
  f.stepGuide();
  assert.ok(f.mob.lookTarget);
  const entry = f.entries[0], key =
    `${Math.floor(entry.marker.position.x / 16)},${Math.floor(entry.marker.position.z / 16)}`;
  const old = f.world.chunks.get(key), known = f.observe();
  f.world._removeChunk(key, old);
  assert.equal(known.validate(), false);
  assert.equal(f.statuses()[entry.marker.id], "unknown");
  const currentGuide = savedGuide(f);
  const saved = f.snapshot();
  const restored = await nativeDolphinLootGame(t, { saved });
  assert.deepEqual(savedGuide(restored), currentGuide);
  assert.equal(restored.gameplay.getHandStack().count, 1);
  assert.deepEqual(Object.values(restored.statuses()), ["untouched", "untouched"]);
  restored.stepGuide();
  assert.ok(restored.mob.lookTarget, "cold residency resolves the chest without another payment");
  assert.equal(restored.exploration.exploration.serialize().containers.length, 0);
});

test("destroyed or replaced native chests are never advertised as fresh entitlements", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  const [destroyed, replaced] = f.entries;
  const broken = f.exploration.prepareBreak(f.hit(destroyed), { explosion: true, drops: [] });
  assert.ok(broken.participants);
  assert.equal(f.exploration.commit(broken).ok, true);
  assert.equal(f.exploration.exploration.container(destroyed.marker).state, "destroyed");
  for (const entry of f.entries) {
    const { x, y, z } = entry.marker.position;
    if (entry === replaced) f.put(x, y, z, BLOCK.STONE);
    f.put(x, y, z, BLOCK.CHEST);
  }
  assert.equal(f.exploration.exploration.container(replaced.marker), null);
  assert.deepEqual(Object.values(f.statuses()), ["destroyed", "destroyed"]);
  const before = f.ownership(), work = terrainWork(f);
  const allowScouting = prohibitScouting(t, f);
  f.feed();
  assert.equal(savedGuide(f), null);
  assert.equal(f.gameplay.getHandStack().count, 1, "the fish still pays for existing Assistance");
  assert.equal(f.ecology.ecology.state(f.mob.id).assistTime, ECOLOGY_LIMITS.assistance);
  assert.deepEqual(f.settlement.serialize(), before.archive.settlement);
  assert.deepEqual(f.exploration.exploration.serialize(), before.archive.exploration);
  assert.deepEqual(terrainWork(f), work);
  allowScouting();
});

test("commit-time slot depletion vetoes the real Game feed without fish cost or legacy fallthrough, then permits an Assistance-only retry", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  for (const entry of f.entries) f.open(entry);
  f.approach();
  const before = f.gameplay.serialize(), ledger = f.exploration.exploration.serialize();
  const legacy = t.mock.method(f.wildlife, "interact", () => assert.fail("owned refusal cannot fall through"));
  const original = f.game.mobActions.commit;
  const intercepted = t.mock.method(f.game.mobActions, "commit", function (plan) {
    assert.equal(plan.result.guide, f.descriptor.id);
    const clearing = f.settlement.prepareContainers(f.world, f.entries.map((entry) => ({
      hit: f.hit(entry), action: "clear", expectedInitialized: true,
    })));
    assert.ok(clearing);
    const drops = clearing.result.records.flatMap((record) => record.drops);
    const retention = f.overflow.prepareEnqueue(drops, f.mob.position, f.world.dimension);
    assert.ok(retention);
    assert.equal(f.coordinator.commit([...clearing.participants, retention]).ok, true);
    assert.deepEqual(f.gameplay.serialize(), before, "depletion changes Settlement, not the prepared hand");
    assert.deepEqual(f.exploration.exploration.serialize(), ledger,
      "materialized claims do not change when actual slots are emptied");
    const result = original.call(this, plan);
    assert.equal(result.handled, true);
    assert.equal(result.ok, false);
    return result;
  });
  f.feed();
  assert.equal(intercepted.mock.callCount(), 1);
  assert.equal(f.gameplay.getHandStack().count, 2);
  assert.equal(f.ecology.ecology.state(f.mob.id).assistTime, 0);
  assert.equal(savedGuide(f), null);
  assert.equal(legacy.mock.callCount(), 0);
  intercepted.mock.restore();
  f.feed();
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.equal(savedGuide(f), null);
  assert.equal(f.ecology.ecology.state(f.mob.id).assistTime, ECOLOGY_LIMITS.assistance);
  assert.equal(legacy.mock.callCount(), 0);
});

for (const owner of ["explorationServices", "exploration", "settlement"])
  test(`paid Game guidance pins the installed ${owner} owner through commit`, {
    timeout: 120000,
  }, async (t) => {
    const f = await nativeDolphinLootGame(t);
    const original = f.game.mobActions.commit, previous = f.game[owner];
    const legacy = t.mock.method(f.wildlife, "interact", () => assert.fail("owned refusal cannot fall through"));
    const intercepted = t.mock.method(f.game.mobActions, "commit", function (plan) {
      f.game[owner] = {};
      try {
        const result = original.call(this, plan);
        assert.equal(result.handled, true);
        assert.equal(result.ok, false);
        return result;
      } finally {
        f.game[owner] = previous;
      }
    });
    f.feed();
    assert.equal(intercepted.mock.callCount(), 1);
    assert.equal(f.gameplay.getHandStack().count, 2);
    assert.equal(f.ecology.ecology.state(f.mob.id).assistTime, 0);
    assert.equal(f.exploration.exploration.serialize().containers.length, 0);
    intercepted.mock.restore();
    f.feed();
    assert.equal(f.gameplay.getHandStack().count, 1);
    assert.equal(savedGuide(f).id, f.descriptor.id);
    assert.equal(legacy.mock.callCount(), 0);
  });

test("cleared claims can contain real refilled loot, but missing initialized ownership stays unknown", {
  timeout: 120000,
}, async (t) => {
  const f = await nativeDolphinLootGame(t);
  const [entry, empty] = f.entries;
  f.open(entry);
  installLegacyChest(f, f.hit(empty), []);
  assert.equal(f.exploration.commit(f.exploration.prepareClear(f.hit(entry))).ok, true);
  assert.equal(f.exploration.exploration.container(entry.marker).state, "cleared");
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots[0] = { id: ITEM.DIAMOND, count: 3 };
    return true;
  }), true);
  assert.equal(f.settlement.containerAction(f.world, f.hit(entry), f.gameplay, {
    type: "quickMove", area: "inventory", index: 0,
  }).ok, true);
  assert.equal(f.statuses()[entry.marker.id], "nonempty",
    "the ledger does not replace the slot owner, even for a cleared claim");
  assert.equal(findDolphinGuide(f.mob.position, "overworld", [f.descriptor], f.observe()).id,
    f.descriptor.id);
  const missing = f.settlement.prepareContainers(f.world, [{
    hit: f.hit(entry), action: "remove", expectedInitialized: true,
  }]);
  assert.ok(missing);
  const retained = f.overflow.prepareEnqueue(
    missing.result.records[0].drops, f.mob.position, f.world.dimension
  );
  assert.ok(retained);
  assert.equal(f.coordinator.commit([...missing.participants, retained]).ok, true);
  assert.equal(f.world.get(entry.marker.position.x, entry.marker.position.y, entry.marker.position.z),
    BLOCK.CHEST);
  const before = f.ownership(), work = terrainWork(f);
  assert.equal(f.statuses()[entry.marker.id], "unknown");
  assert.equal(f.exploration.observeLootAvailability(Array(5).fill(f.descriptor)), null,
    "the availability bridge cannot expand the four-descriptor host budget");
  const allowScouting = prohibitScouting(t, f);
  f.feed();
  assert.equal(savedGuide(f), null);
  assert.equal(f.gameplay.getHandStack().count, 1);
  assert.deepEqual(f.settlement.serialize(), before.archive.settlement);
  assert.deepEqual(f.exploration.exploration.serialize(), before.archive.exploration);
  assert.deepEqual(terrainWork(f), work);
  allowScouting();
});

for (const reason of ["hand", "session", "mob", "epoch", "chest-incarnation", "descriptor", "range", "line-of-sight"])
  test(`real Game feeding retains its ${reason} commit guard with loot observations`, {
    timeout: 120000,
  }, async (t) => {
    const f = await nativeDolphinLootGame(t);
    const original = f.game.mobActions.commit;
    const legacy = t.mock.method(f.wildlife, "interact", () => assert.fail("owned refusal cannot fall through"));
    const intercepted = t.mock.method(f.game.mobActions, "commit", function (plan) {
      let restore = () => {};
      if (reason === "hand") f.hold("RAW_COD", {
        count: 2, data: { version: 1, name: "A different finite fish stack" },
      });
      if (reason === "session") {
        f.game.overlayOpen = true;
        restore = () => { f.game.overlayOpen = false; };
      }
      if (reason === "mob") {
        const mob = f.mob;
        f.wildlife.byId.set(mob.id, { ...mob });
        restore = () => { f.wildlife.byId.set(mob.id, mob); };
      }
      if (reason === "epoch") {
        const epoch = f.world.epoch;
        assert.equal(f.world.loadEdits(f.world.serialize()), true);
        assert.ok(f.world.epoch > epoch);
      }
      if (reason === "chest-incarnation") {
        const { x, z } = f.entries[0].marker.position;
        const cx = Math.floor(x / 16), cz = Math.floor(z / 16), key = `${cx},${cz}`;
        const chunk = f.world.chunks.get(key);
        f.world._removeChunk(key, chunk);
        f.world._generateSync(cx, cz);
        assert.notEqual(f.world.chunks.get(key), chunk);
      }
      if (reason === "descriptor") {
        const reader = f.wildlife.context.getStructure;
        f.wildlife.context.getStructure = (id) => {
          const descriptor = reader(id);
          return descriptor && { ...descriptor };
        };
        restore = () => { f.wildlife.context.getStructure = reader; };
      }
      if (reason === "range") {
        f.player.setPosition({ ...f.mob.position, z: f.mob.position.z + 10 });
        f.aim(f.mob);
        assert.equal(f.game.mobActions.capture(f.mob), null);
      }
      if (reason === "line-of-sight") {
        const eye = f.player.eyePosition, target = f.mob.position;
        const x = Math.floor((eye.x + target.x) / 2);
        const z = Math.floor((eye.z + target.z) / 2);
        for (let y = Math.floor(target.y); y <= Math.floor(eye.y); y++)
          f.put(x, y, z, BLOCK.STONE);
        assert.equal(f.game.mobActions.capture(f.mob), null);
      }
      try {
        const result = original.call(this, plan);
        assert.equal(result.handled, true);
        assert.equal(result.ok, false);
        return result;
      } finally {
        restore();
      }
    });
    f.feed();
    assert.equal(intercepted.mock.callCount(), 1);
    assert.equal(f.gameplay.getHandStack().count, 2);
    assert.equal(f.ecology.ecology.state(f.mob.id).assistTime, 0);
    assert.equal(savedGuide(f), null);
    assert.equal(legacy.mock.callCount(), 0);
  });
