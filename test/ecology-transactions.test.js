import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import {
  ecologyDeathReward,
  ecologyVisualScale,
  normalizeEcologySnapshot,
} from "../src/expansion-ecology.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  ecologyFixture,
  ecologyMob,
  ecologyState,
  ecologyStore,
  ecologyWorld,
  feedHook,
  monumentFixture,
} from "./ecology-fixtures.js";

function spawnHook(f, store) {
  return (proposal) => {
    const entity = ecologyMob(proposal.kind, proposal.id, proposal.position);
    const part = store.prepare((draft) => {
      if (draft.ids.includes(entity.id)) return false;
      draft.ids.push(entity.id);
    });
    if (!part) return null;
    return {
      ...part,
      validate: () => part.validate() && !f.mobs.has(entity.id),
      publish: () => { part.publish(); f.mobs.set(entity.id, entity); },
    };
  };
}
function removalHook(f, store) {
  return (mob) => {
    const part = store.prepare((draft) => {
      if (!draft.ids.includes(mob.id)) return false;
      draft.ids = draft.ids.filter((id) => id !== mob.id);
    });
    return part && {
      ...part,
      publish: () => { part.publish(); mob.dead = true; mob.health = 0; f.mobs.delete(mob.id); },
    };
  };
}
function dropHook(store, limit = 64) {
  return (drops) => store.prepare((draft) => {
    if (draft.drops.length + drops.length > limit) return false;
    draft.drops.push(...drops);
  });
}

test("domain feeding atomically debits a symbolic food sink and enables assistance/guidance, not taming", () => {
  const world = ecologyWorld();
  const state = ecologyState(world, "dolphin", "fed-dolphin", { x: 0, y: 2, z: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  const fish = ecologyStore(f.coordinator, { RAW_COD: 2 });
  const wreck = { id: "wreck-1", kind: "shipwreck", dimension: "overworld", origin: { x: 14, y: 1, z: 0 } };
  f.structures.set(wreck.id, wreck);
  const plan = f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: feedHook(fish) });
  assert.ok(plan);
  assert.equal(fish.value.RAW_COD, 2);
  assert.equal(f.owner.state(mob.id).assistTime, 0);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(fish.value.RAW_COD, 1);
  assert.equal(f.owner.state(mob.id).guide.id, wreck.id);
  f.owner.update(mob, 0.1, f.ctx);
  assert.equal(f.effects[0].id, "dolphins_grace");
  assert.ok(f.effects[0].swimSpeedMultiplier > 1);
  assert.ok(mob.position.x > 0);
  assert.notEqual(mob.tamed, true);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(fish.value.RAW_COD, 1);
  assert.equal(f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: feedHook(fish) }), null);
});

test("feeding rejects stale hand, mob, descriptor, world epoch and capacity without partial publication", () => {
  for (const invalidate of [
    (f, mob) => { mob.position.x += 0.01; },
    (f, mob) => { f.mobs.set(mob.id, ecologyMob(mob.kind, mob.id, mob.position)); },
    (f) => { f.world.epoch++; },
    (f) => { f.world._editRevision++; },
    (f) => { f.structures.clear(); },
    (f, mob, fish) => { fish.revision++; },
  ]) {
    const world = ecologyWorld();
    const state = ecologyState(world, "dolphin", "stale-dolphin", { x: 0, y: 2, z: 0 });
    const f = ecologyFixture({ world, entries: [state] });
    const mob = f.mobs.get(state.id);
    const fish = ecologyStore(f.coordinator, { RAW_COD: 1 });
    const wreck = { id: "wreck", kind: "shipwreck", dimension: "overworld", origin: { x: 12, y: 1, z: 0 } };
    f.structures.set(wreck.id, wreck);
    const before = f.owner.serialize();
    const plan = f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: feedHook(fish) });
    assert.ok(plan);
    invalidate(f, mob, fish);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.equal(fish.value.RAW_COD, 1);
    assert.deepEqual(f.owner.serialize(), before);
  }
  const world = ecologyWorld();
  const state = ecologyState(world, "dolphin", "refusal-dolphin", { x: 0, y: 2, z: 0 });
  const f = ecologyFixture({ world, entries: [state] });
  const mob = f.mobs.get(state.id);
  assert.equal(f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: () => null }), null);
  assert.equal(f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: async () => ({}) }), null);
  f.ctx.applyEffect = undefined;
  f.ctx.nearbyStructures = () => [{ id: "invented", kind: "shipwreck", dimension: "overworld", origin: { x: 8, y: 1, z: 0 } }];
  assert.equal(f.owner.prepareFeed(mob, "RAW_COD", f.ctx, { prepareConsume: () => { throw new Error("must not consume"); } }), null);
});

test("new ecology admission respects the joint byte budget and never creates half a mob", () => {
  const f = ecologyFixture();
  const base = ecologyStore(f.coordinator, { ids: [] });
  const blocker = {};
  f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes);
  const plan = f.owner.prepareAdmission({
    id: "budget-drowned", kind: "drowned", position: { x: 0, y: 2, z: 0 },
  }, f.ctx, { prepareSpawn: spawnHook(f, base) });
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.owner.state("budget-drowned"), null);
  assert.equal(f.mobs.size, 0);
  assert.deepEqual(base.value.ids, []);
});

test("structure-backed admission pins cached descriptors and refuses stale ownership", () => {
  const f = ecologyFixture();
  const { structure } = monumentFixture();
  f.structures.set(structure.id, structure);
  f.ctx.structure = structure;
  const base = ecologyStore(f.coordinator, { ids: [] });
  const proposal = { id: "cached-guardian", kind: "guardian", position: { x: 0, y: 2, z: 0 } };
  const plan = f.owner.prepareAdmission(proposal, f.ctx, { prepareSpawn: spawnHook(f, base) });
  assert.ok(plan);
  f.structures.set(structure.id, { ...structure });
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.owner.state(proposal.id), null);
  assert.deepEqual(base.value.ids, []);
  assert.equal(f.owner.prepareAdmission(proposal, f.ctx, { prepareSpawn: spawnHook(f, base) }), null);
});

test("two seagrass feeds prepare a single home-beach clutch; refused placement retains pregnancy", () => {
  const world = ecologyWorld({ water: () => -1 });
  const states = [
    ecologyState(world, "turtle", "turtle-a", { x: 0.5, y: 1, z: 0.5 }),
    ecologyState(world, "turtle", "turtle-b", { x: 1.9, y: 1, z: 0.5 }),
  ];
  const f = ecologyFixture({ world, entries: states });
  f.ctx.player = { x: 0, y: 1, z: 2 };
  f.ctx.playerEye = { x: 0, y: 2.62, z: 2 };
  const food = ecologyStore(f.coordinator, { SEAGRASS: 2 });
  const [first, second] = states.map((state) => f.mobs.get(state.id));
  for (const mob of [first, second]) {
    const plan = f.owner.prepareFeed(mob, "SEAGRASS", f.ctx, { prepareConsume: feedHook(food) });
    assert.ok(plan);
    assert.equal(f.coordinator.commit(plan.participants).ok, true);
  }
  const breed = f.owner.prepareBreeding(second, first, f.ctx);
  assert.equal(breed.result.motherId, first.id);
  assert.equal(f.coordinator.commit(breed.participants).ok, true);
  assert.equal(f.owner.state(first.id).gravid, true);
  assert.equal(f.owner.state(second.id).gravid, false);
  assert.equal(f.owner.prepareBreeding(first, second, f.ctx), null);
  const request = { eggId: "egg-a-1", childId: "baby-a-1", position: { x: 0.5, y: 1, z: 0.5 } };
  assert.equal(f.owner.prepareLayEgg(first, request, f.ctx, { preparePlaceEgg: () => null }), null);
  assert.equal(f.owner.state(first.id).gravid, true);
  const blocks = ecologyStore(f.coordinator, { eggs: [] });
  const lay = f.owner.prepareLayEgg(first, request, f.ctx, {
    preparePlaceEgg: (egg) => blocks.prepare((draft) => { draft.eggs.push(egg); }),
  });
  assert.ok(lay);
  assert.equal(f.coordinator.commit(lay.participants).ok, true);
  assert.equal(f.owner.state(first.id).gravid, false);
  assert.equal(f.owner.state(first.id).clutchSerial, 1);
  assert.equal(blocks.value.eggs.length, 1);
  assert.equal(f.owner.prepareLayEgg(first, request, f.ctx, {
    preparePlaceEgg: () => { throw new Error("duplicate egg"); },
  }), null);
  assert.ok(normalizeEcologySnapshot(f.owner.serialize(), world));
  first.position.x = 6;
  const altered = f.owner.serialize();
  altered.entries[0].gravid = true;
  const far = ecologyFixture({ world, entries: altered.entries, eggs: altered.eggs });
  far.mobs.get(first.id).position.x = 6;
  assert.equal(far.owner.prepareLayEgg(far.mobs.get(first.id), {
    eggId: "egg-a-2", childId: "baby-a-2", position: { x: 6, y: 1, z: 0.5 },
  }, far.ctx, { preparePlaceEgg: () => null }), null, "sand far from home is not the nesting beach");
});

test("hatching and one-time growth/scute ownership survive save/reload and sink refusal", () => {
  const world = ecologyWorld({ water: () => -1 });
  const parent = ecologyState(world, "turtle", "parent", { x: 0.5, y: 1, z: 0.5 }, { clutchSerial: 1 });
  const egg = {
    id: "egg", parentId: parent.id, childId: "baby", serial: 1, dimension: "overworld",
    position: { x: 0.5, y: 1, z: 0.5 }, remaining: 0.05, status: "incubating",
  };
  const f = ecologyFixture({ world, entries: [parent], eggs: [egg] });
  const blocks = ecologyStore(f.coordinator, { eggs: [egg.id] });
  const base = ecologyStore(f.coordinator, { ids: [parent.id] });
  f.ctx.eggPresent = (egg) => blocks.value.eggs.includes(egg.id);
  const progress = f.owner.prepareEggProgress(egg.id, 0.1, f.ctx);
  assert.equal(f.coordinator.commit([progress]).ok, true);
  const removeEgg = (egg) => blocks.prepare((draft) => { draft.eggs = draft.eggs.filter((id) => id !== egg.id); });
  world.setCell(2, 1, 0, { id: BLOCK.LAVA, state: 0, fluid: FLUID.LAVA_SOURCE });
  assert.equal(f.owner.prepareHatch(egg.id, { x: 2.3, y: 1, z: 0.5 }, f.ctx, {
    prepareRemoveEgg: removeEgg, prepareSpawn: spawnHook(f, base),
  }), null, "supported lava is not a valid hatch location");
  world.setCell(2, 1, 0, { id: BLOCK.AIR, state: 0, fluid: FLUID.NONE });
  const at = { x: 1.5, y: 1, z: 0.5 };
  assert.equal(f.owner.prepareHatch(egg.id, at, f.ctx, { prepareRemoveEgg: removeEgg, prepareSpawn: () => null }), null);
  assert.equal(f.owner.egg(egg.id).status, "incubating");
  const hatch = f.owner.prepareHatch(egg.id, at, f.ctx, {
    prepareRemoveEgg: removeEgg, prepareSpawn: spawnHook(f, base),
  });
  assert.equal(f.coordinator.commit(hatch.participants).ok, true);
  assert.equal(f.owner.egg(egg.id).status, "hatched");
  assert.equal(blocks.value.eggs.length, 0);
  assert.equal(ecologyVisualScale(f.owner.state("baby")), 0.5);
  assert.equal(f.owner.prepareHatch(egg.id, at, f.ctx, {}), null);
  // A contextual checkpoint just before growth avoids 1200s of pointless
  // fixture simulation. It is not a claim that natural growth was played out.
  const saved = f.owner.serialize();
  saved.entries.find((state) => state.id === "baby").growthRemaining = 0.05;
  const restored = ecologyFixture({ world, entries: saved.entries, eggs: saved.eggs });
  const baby = restored.mobs.get("baby");
  restored.owner.update(baby, 0.1, restored.ctx);
  const loot = ecologyStore(restored.coordinator, { drops: [] });
  assert.equal(restored.owner.prepareGrowth(baby, restored.ctx, { prepareDrops: dropHook(loot, 0) }), null);
  assert.equal(restored.owner.state("baby").scuteClaimed, false);
  const growth = restored.owner.prepareGrowth(baby, restored.ctx, { prepareDrops: dropHook(loot) });
  assert.equal(restored.coordinator.commit(growth.participants).ok, true);
  assert.deepEqual(loot.value.drops, [{ name: "SCUTE", count: 1 }]);
  assert.equal(ecologyVisualScale(restored.owner.state("baby")), 1);
  assert.equal(restored.coordinator.commit(growth.participants).ok, false);
  const secondSave = restored.owner.serialize();
  const again = ecologyFixture({ world, entries: secondSave.entries, eggs: secondSave.eggs });
  assert.equal(again.owner.prepareGrowth(again.mobs.get("baby"), again.ctx, { prepareDrops: () => null }), null);
  assert.deepEqual(ecologyDeathReward("turtle", true).drops, []);
});

test("broken eggs cannot hatch, and reserved child identities cannot be used by other admissions", () => {
  const world = ecologyWorld({ water: () => -1 });
  const parent = ecologyState(world, "turtle", "parent", { x: 0.5, y: 1, z: 0.5 }, { clutchSerial: 1 });
  const egg = { id: "egg", parentId: "parent", childId: "reserved-child", serial: 1, dimension: "overworld",
    position: { x: 0.5, y: 1, z: 0.5 }, remaining: 0, status: "incubating" };
  const f = ecologyFixture({ world, entries: [parent], eggs: [egg] });
  const blocks = ecologyStore(f.coordinator, { eggs: ["egg"] });
  f.ctx.eggPresent = (egg) => blocks.value.eggs.includes(egg.id);
  const broken = f.owner.prepareBreakEgg("egg", f.ctx, {
    prepareRemoveEgg: () => blocks.prepare((draft) => { draft.eggs = []; }),
  });
  assert.equal(f.coordinator.commit(broken.participants).ok, true);
  assert.equal(f.owner.egg("egg").status, "broken");
  assert.equal(f.owner.prepareHatch("egg", egg.position, f.ctx, {}), null);
  assert.equal(f.owner.prepareAdmission({
    id: "reserved-child", kind: "turtle", position: egg.position,
  }, { ...f.ctx, biomeId: "beach" }, { prepareSpawn: () => null }), null);
});

test("three authored elder identities are one-shot and defeated ledgers never resurrect on reload", () => {
  const f = ecologyFixture();
  const { structure, markers } = monumentFixture();
  f.structures.set(structure.id, structure);
  for (const marker of markers) f.markers.set(marker.id, marker);
  const base = ecologyStore(f.coordinator, { ids: [] });
  for (const marker of markers) {
    const plan = f.owner.prepareElderAdmission(structure, marker, f.ctx, { prepareSpawn: spawnHook(f, base) });
    assert.ok(plan);
    assert.equal(f.coordinator.commit(plan.participants).ok, true);
    assert.equal(f.owner.prepareElderAdmission(structure, marker, f.ctx, { prepareSpawn: spawnHook(f, base) }), null);
  }
  const forged = { ...markers[0], key: "elder_four", id: `${structure.id}/encounter/elder_four` };
  f.markers.set(forged.id, forged);
  assert.equal(f.owner.prepareElderAdmission(structure, forged, f.ctx, { prepareSpawn: spawnHook(f, base) }), null);
  const mob = f.mobs.get(markers[0].id);
  const loot = ecologyStore(f.coordinator, { drops: [] });
  const xp = ecologyStore(f.coordinator, { total: 0 });
  const completion = ecologyStore(f.coordinator, { ids: [] });
  const hooks = {
    playerKill: true, prepareRemoval: removalHook(f, base),
    prepareDrops: dropHook(loot, 0),
    prepareExperience: (amount) => xp.prepare((draft) => { draft.total += amount; }),
    prepareUniqueCompletion: (elder) => completion.prepare((draft) => {
      if (draft.ids.includes(elder.id)) return false;
      draft.ids.push(elder.id);
    }),
  };
  assert.equal(f.owner.prepareDeath(mob, f.ctx, hooks), null);
  assert.equal(f.owner.elder(mob.id).status, "alive");
  assert.ok(mob.health > 0);
  const death = f.owner.prepareDeath(mob, f.ctx, { ...hooks, prepareDrops: dropHook(loot) });
  assert.equal(f.coordinator.commit(death.participants).ok, true);
  assert.equal(f.owner.elder(mob.id).status, "defeated");
  assert.deepEqual(completion.value.ids, [markers[0].id]);
  assert.ok(loot.value.drops.some((drop) => drop.name === "WET_SPONGE" && drop.count > 0));
  assert.ok(xp.value.total > 0);
  const saved = f.owner.serialize();
  const restored = ecologyFixture({ entries: saved.entries, elders: saved.elders });
  restored.structures.set(structure.id, structure);
  for (const marker of markers) restored.markers.set(marker.id, marker);
  assert.equal(restored.owner.canRestore(mob.id, mob.kind, "overworld"), false);
  assert.equal(restored.owner.prepareElderAdmission(structure, markers[0], restored.ctx, { prepareSpawn: () => null }), null);
  assert.equal(restored.owner.canRestore(markers[1].id, "elder_guardian", "overworld"), true);
  const active = restored.mobs.get(markers[1].id);
  restored.ctx.player = { x: 9, y: 2, z: 0 };
  restored.ctx.playerEye = { x: 9, y: 3.62, z: 0 };
  restored.owner.update(active, 0.1, restored.ctx);
  assert.equal(restored.effects[0].id, "mining_fatigue");
});

test("full structure marker identities remain separate from bounded base-mob IDs", () => {
  const f = ecologyFixture();
  const authored = monumentFixture();
  const structure = { ...authored.structure,
    id: `structure:v1:${"escaped-seed-".repeat(20)}:overworld:ocean_monument:0:0` };
  const marker = { ...authored.markers[0], structureId: structure.id,
    id: `${structure.id}/encounter/elder_west` };
  f.structures.set(structure.id, structure);
  f.markers.set(marker.id, marker);
  const base = ecologyStore(f.coordinator, { ids: [] });
  const entityId = "elder-resident-1";
  assert.ok(marker.id.length > 100);
  const plan = f.owner.prepareElderAdmission(structure, marker, f.ctx, {
    entityId, prepareSpawn: spawnHook(f, base),
  });
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.owner.state(entityId).markerId, marker.id);
  assert.equal(f.owner.elder(marker.id).entityId, entityId);
  assert.equal(f.owner.entityIdForMarker(marker.id), entityId);
  const saved = f.owner.serialize();
  const restored = ecologyFixture({ entries: saved.entries, elders: saved.elders });
  assert.equal(restored.owner.entityIdForMarker(marker.id), entityId);
  assert.equal(restored.owner.canRestore(entityId, "elder_guardian", "overworld"), true);
  assert.ok(normalizeEcologySnapshot(saved, f.world));
});
