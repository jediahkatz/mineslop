import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_HOST_LIMITS } from "../src/ecology-population.js";
import { ITEM } from "../src/items.js";
import { World } from "../src/world.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";
import { approachGameMob, nativeGameMobs } from "./game-mob-native-fixture.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

// Real native terrain and the actual Game frame, resident index, Wildlife
// scheduler, Ecology and Progression. Inventory/approach are finite authored
// prerequisites, not a claim of Survival acquisition or browser acceptance.
function terrainWork(world) {
  const { chunkGenerations, regionGenerations } = world.generator.counters;
  return { chunkGenerations, regionGenerations };
}

async function workingLibrarian(t) {
  const f = await nativeGameMobs(t);
  const work = t.mock.method(f.progression, "onVillagerIntent");
  const terrain = terrainWork(f.world);
  const originalWorld = f.world.serialize();
  f.frame(80);
  const member = f.descriptor.markers.find((marker) =>
    marker.type === "member" && marker.profession === "librarian");
  assert.ok(member);
  const id = f.ecology.ecology.entityIdForMarker(member.id);
  const mob = f.wildlife.byId.get(id);
  assert.ok(mob, "the live Wildlife scheduler must admit the canonical village member");
  const site = f.mobs.markers.getMarker(member.jobSiteId);
  const jobsite = { id: site.id, kind: site.block, dimension: site.dimension, position: site.position };
  assert.equal(mob.npcIntent, "work");
  assert.equal(f.ecology.jobsiteUsable(id, jobsite), true);
  assert.ok(work.mock.calls.some(({ arguments: [entityId, observation] }) =>
    entityId === id && observation.intent === "work" && observation.atJobsite === true));
  const trader = f.progression.services.trading.get(id);
  assert.ok(trader, "actual work must register with the shared Trading owner before opening a UI");
  assert.equal(trader.jobsite.id, member.jobSiteId);
  assert.equal(f.ecology.assignment(id).home.id, member.homeId);
  assert.deepEqual(terrainWork(f.world), terrain);
  assert.deepEqual(f.world.serialize(), originalWorld);
  return { ...f, id, mob, member, site, jobsite };
}

test("natural ocean population reaches the actual Game frame without fabricated light or a second Ecology owner", async (t) => {
  const world = new World("cedar-valley", { generatorVersion: 4, useWorker: false });
  t.after(() => world.dispose());
  const column = findNaturalColumn(world.generator, (candidate) =>
    /(^|_)ocean$/.test(candidate.id) && !candidate.frozen && !/frozen/.test(candidate.id) &&
    candidate.waterLevel !== null && candidate.waterLevel - candidate.top >= 8,
  "deep non-frozen Game dolphin habitat");
  const at = { x: column.x + 0.5, y: world.spec.seaLevel - 3, z: column.z + 0.5 };
  const f = await gameMobFixture(t, {
    world, generatorFactory: null, spawnPosition: { ...at, z: at.z - 26 },
    autoSpawn: true, admissionRadius: 3,
  });
  const terrain = terrainWork(world), edits = world.serialize();
  const population = t.mock.method(f.ecology, "populate");
  const stepping = t.mock.method(f.ecology, "stepMob");
  t.mock.method(world, "ensureArea", () => assert.fail("live Game mob frames cannot admit new terrain"));
  f.frame(2);
  assert.equal(population.mock.callCount(), 1);
  const work = population.mock.calls[0].result;
  assert.ok(work.admitted > 0 && work.admitted <= ECOLOGY_HOST_LIMITS.admissions);
  const dolphin = f.wildlife.entities.find((mob) => mob.kind === "dolphin" &&
    JSON.stringify(f.ecology.ecology.state(mob.id).home) === JSON.stringify(at));
  assert.ok(dolphin, "the first scheduler candidate uses the actual native ocean body");
  assert.ok(stepping.mock.calls.some(({ arguments: args }) => args[0] === dolphin && args[1] === 0.05));
  assert.equal(f.ecology.ecology.state(dolphin.id).alive, true);
  assert.equal(f.wildlife.ecologyServices, f.ecology);
  assert.equal(f.wildlife.horseServices, f.horses);
  assert.equal(f.ecology.habitat(at).biomeId, column.id);
  assert.equal(f.ecology.habitat(at).blockLight, undefined);
  assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false);
  assert.ok(f.wildlife.mesh.count > 0);
  assert.deepEqual(terrainWork(world), terrain);
  assert.deepEqual(world.serialize(), edits);
});

test("native Game villagers work, open through physical entity use, pay finite trades and atomically release mined jobsites", async (t) => {
  const f = await workingLibrarian(t), trading = f.progression.services.trading;
  approachGameMob(f, f.mob);
  t.mock.method(f.wildlife, "interact", () => assert.fail("no legacy villager interaction"));
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.progression.isOpen, true);
  const view = f.progression.view();
  assert.equal(view.npcId, f.id);
  const offer = view.offers.find((entry) => entry.id === "librarian/paper");
  assert.ok(offer);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots.fill(null);
    offer.inputs.forEach((stack, index) => { draft.slots[index] = structuredClone(stack); });
    return true;
  }), true);
  const before = f.ownership(), xp = f.gameplay.getState().experience.total;
  const plan = f.progression.prepareAction({
    type: "trade", offerId: offer.id, sessionToken: view.sessionToken,
  });
  assert.ok(plan.participants);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)), new Set([trading, f.gameplay]));
  for (const owner of [trading, f.gameplay]) {
    assert.equal(f.coordinator.commit(plan.participants.map((part) =>
      part.owner === owner ? { ...part, validate: () => false } : part)).ok, false);
    assert.deepEqual(f.ownership(), before);
  }
  assert.equal(f.progression.commit(plan).ok, true);
  assert.equal(f.gameplay.countPlain(ITEM.PAPER), 0);
  assert.equal(f.gameplay.countPlain(offer.output.id), offer.output.count);
  assert.equal(f.gameplay.getState().experience.total, xp + offer.playerXp);
  assert.equal(trading.get(f.id).offers.find((entry) => entry.id === offer.id).uses, offer.uses + 1);
  const paid = f.ownership();
  assert.equal(f.progression.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), paid);
  assert.equal(f.progression.close("native-mining").ok, true);
  if (f.game.screenClose) await f.game.screenClose;
  await Promise.resolve();
  assert.equal(f.game.active, true);
  f.hold("IRON_AXE");
  const hit = { ...f.site.position, dimension: f.site.dimension,
    ...f.world.getCell(f.site.position.x, f.site.position.y, f.site.position.z) };
  const removal = f.game.harvestActions.prepareBreak(hit);
  assert.ok(removal);
  for (const owner of [f.world, trading, f.gameplay])
    assert.equal(removal.participants.filter((part) => part.owner === owner).length, 1);
  const retained = f.ownership();
  assert.equal(f.coordinator.commit(removal.participants.map((part) =>
    part.owner === trading ? { ...part, validate: () => false } : part)).ok, false);
  assert.deepEqual(f.ownership(), retained);
  assert.equal(f.game.harvestActions.commit(removal).ok, true);
  assert.equal(f.world.get(hit.x, hit.y, hit.z), BLOCK.AIR);
  assert.equal(trading.jobsiteOwnerAt(f.world.dimension, hit), null);
  assert.equal(trading.get(f.id).jobsite, null);
  assert.equal(f.mobs.markers.getMarker(f.site.id), null);
  assert.equal(f.wildlife.byId.get(f.id), f.mob);
});

test("native villager death composes the real jobsite claim release with base and Ecology retirement", async (t) => {
  const f = await workingLibrarian(t), trading = f.progression.services.trading;
  approachGameMob(f, f.mob);
  const plan = f.game.mobActions.prepareHit(f.mob, 999, { melee: true });
  assert.ok(plan.participants);
  assert.ok(plan.participants.some((part) => part.owner === trading));
  const before = f.ownership();
  assert.equal(f.coordinator.commit(plan.participants.map((part) =>
    part.owner === trading ? { ...part, validate: () => false } : part)).ok, false);
  assert.deepEqual(f.ownership(), before);
  const result = f.game.mobActions.commit(plan);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(result.dropsCommitted && result.experienceCommitted, true);
  assert.equal(f.wildlife.byId.has(f.id), false);
  assert.equal(f.ecology.ecology.state(f.id).alive, false);
  assert.equal(trading.jobsiteOwnerAt(f.world.dimension, f.site.position), null);
  assert.equal(f.world.get(f.site.position.x, f.site.position.y, f.site.position.z), BLOCK[f.site.block]);
  assert.deepEqual(point(f.mob.position), before.archive.ecology.mobsByDimension.overworld.entities
    .find((entry) => entry.id === f.id).position);
});

for (const generatorVersion of [4, 5]) {
  test(`v${generatorVersion} Game rich marker reads are current, bounded and non-materializing`, async (t) => {
    const f = await nativeGameMobs(t, "village", generatorVersion), markers = f.mobs.markers;
    const member = f.descriptor.markers.find((marker) => marker.type === "member");
    const home = markers.getMarker(member.homeId), site = markers.getMarker(member.jobSiteId);
    assert.ok(home && site);
    assert.equal(markers.getMarker(member.id), markers.getMarker(member.id));
    assert.equal(markers.getMarker(member.homeId), home);
    assert.equal(Object.isFrozen(home.position), true);
    assert.equal(site.memberId, member.id);
    const before = f.ownership(), work = terrainWork(f.world);
    const nearby = markers.nearbyMarkers(member.position, {
      dimension: "overworld", entities: ["villager"], limit: 1,
    });
    assert.equal(nearby.length, 1);
    assert.deepEqual(markers.nearbyMarkers(member.position, {
      dimension: "nether", entities: ["villager"], limit: 12,
    }), []);
    assert.deepEqual(markers.nearbyStructures(member.position, {
      dimension: "overworld", kinds: ["village"], limit: 0,
    }), []);
    assert.deepEqual(f.ownership(), before);
    f.exploration.index.reset();
    assert.equal(markers.getMarker(member.id), null);
    assert.equal(markers.getMarker(member.homeId), null);
    assert.equal(markers.getStructure(f.descriptor.id), null);
    assert.deepEqual(terrainWork(f.world), work);
    assert.deepEqual(f.ownership(), before, "cache eviction is not a permanent claim/resource mutation");
  });
}
