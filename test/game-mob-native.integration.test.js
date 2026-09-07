import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_HOST_LIMITS } from "../src/ecology-population.js";
import { createTravelPreviewWorld } from "../src/game-travel-stage.js";
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

async function naturalOceanGame(t, { autoSpawn = true } = {}) {
  const world = new World("cedar-valley", { generatorVersion: 4, useWorker: false });
  const column = findNaturalColumn(world.generator, (candidate) =>
    /(^|_)ocean$/.test(candidate.id) && !candidate.frozen && !/frozen/.test(candidate.id) &&
    candidate.waterLevel !== null && candidate.waterLevel - candidate.top >= 8,
  "deep non-frozen Game drowned habitat");
  const at = { x: column.x + 0.5, y: world.spec.seaLevel - 3, z: column.z + 0.5 };
  return {
    world, column, at,
    f: await gameMobFixture(t, {
      world, generatorFactory: null, spawnPosition: { ...at, z: at.z - 26 },
      autoSpawn, admissionRadius: 3,
    }),
  };
}

function naturalEcologyPoint(player, serial) {
  const angle = serial * 2.399963229728653;
  const radius = 26 + (serial % 3) * 7;
  return {
    x: Math.floor(player.x + Math.sin(angle) * radius) + 0.5,
    z: Math.floor(player.z + Math.cos(angle) * radius) + 0.5,
  };
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
  const { world, column, at, f } = await naturalOceanGame(t);
  const terrain = terrainWork(world), edits = world.serialize();
  const population = t.mock.method(f.ecology, "populate");
  const admissions = t.mock.method(f.ecology, "prepareAdmission");
  const stepping = t.mock.method(f.ecology, "stepMob");
  t.mock.method(world, "ensureArea", () => assert.fail("live Game mob frames cannot admit new terrain"));
  const lightWork = { ...f.mobs.habitatLightWork };
  f.frame(2);
  const lightCellReads = f.mobs.habitatLightWork.cellReads - lightWork.cellReads;
  const lightQueries = f.mobs.habitatLightWork.queries - lightWork.queries;
  assert.ok(lightQueries <= 8 && lightCellReads <= 5_000,
    `one actual Game population pulse exceeded its light-work contract: ${lightCellReads}`);
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
  const drowned = f.wildlife.entities.find((mob) => mob.kind === "drowned");
  assert.ok(drowned, "actual Game autoSpawn admits a naturally dark underwater drowned");
  assert.equal(f.ecology.habitat(drowned.position, "drowned").blockLight, 0);
  assert.ok(f.ecology.habitat(drowned.position, "drowned").skyLight <= 7);
  const drownedAttempts = admissions.mock.calls.filter((call) => call.arguments[0] === "drowned");
  assert.ok(drownedAttempts.some((call) =>
    f.ecology.habitat(call.arguments[1], "drowned").skyLight > 7 && call.result === null));
  assert.ok(drownedAttempts.some((call) => call.result !== null));
  assert.ok(f.wildlife.mesh.count > 0);
  assert.deepEqual(terrainWork(world), terrain);
  assert.deepEqual(world.serialize(), edits);
});

test("actual Game autoSpawn refuses lit, unknown-frontier, unloaded and incorrect drowned habitats", async (t) => {
  await t.test("block light", async (t) => {
    const { f } = await naturalOceanGame(t);
    for (const serial of [2, 5]) {
      const site = naturalEcologyPoint(f.player.position, serial);
      for (const y of [49, 53, 57, 61]) f.put(Math.floor(site.x) + 1, y, Math.floor(site.z), BLOCK.GLOWSTONE);
    }
    const darkDepth = { ...naturalEcologyPoint(f.player.position, 2), y: 56 };
    assert.ok(f.ecology.habitat(darkDepth, "drowned").blockLight > 0);
    f.frame(2);
    assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false);
  });

  await t.test("unloaded target and unknown dependency frontier", async (t) => {
    const { f } = await naturalOceanGame(t);
    const unloaded = naturalEcologyPoint(f.player.position, 2);
    const unloadedKey = `${Math.floor(unloaded.x / 16)},${Math.floor(unloaded.z / 16)}`;
    f.world._removeChunk(unloadedKey, f.world.chunks.get(unloadedKey));
    assert.equal(f.ecology.habitat({ ...unloaded, y: 56 }), null);
    const frontier = naturalEcologyPoint(f.player.position, 5);
    const cx = Math.floor(frontier.x / 16), cz = Math.floor(frontier.z / 16);
    const localX = Math.floor(frontier.x) - cx * 16;
    const dependencyKey = `${cx + (localX < 8 ? -1 : 1)},${cz}`;
    f.world._removeChunk(dependencyKey, f.world.chunks.get(dependencyKey));
    assert.equal(f.world.isLoaded(frontier.x, frontier.z), true);
    assert.equal(f.ecology.habitat({ ...frontier, y: 56 }, "drowned"), null,
      "missing propagation dependencies are unknown, not zero light");
    f.frame(2);
    assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false);
  });

  await t.test("incorrect biome and water body", async (t) => {
    const f = await gameMobFixture(t, { autoSpawn: true, admissionRadius: 3 });
    f.frame(2);
    assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false);
  });
});

test("Game habitat light invalidates prepared admission on mutation and follows archive/travel lifetime", async (t) => {
  const { f } = await naturalOceanGame(t, { autoSpawn: false });
  const site = { ...naturalEcologyPoint(f.player.position, 2), y: 56 };
  const habitat = f.ecology.habitat(site, "drowned");
  assert.deepEqual({ blockLight: habitat.blockLight, skyLight: habitat.skyLight },
    { blockLight: 0, skyLight: 7 });
  const stale = f.ecology.prepareAdmission("drowned", site);
  assert.ok(stale);
  f.put(Math.floor(site.x) + 1, Math.floor(site.y), Math.floor(site.z), BLOCK.GLOWSTONE);
  assert.equal(f.ecology.commit(stale).ok, false);
  assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false);

  const replaced = await naturalOceanGame(t, { autoSpawn: false });
  const replacementSite = { ...naturalEcologyPoint(replaced.f.player.position, 2), y: 56 };
  const replacementPlan = replaced.f.ecology.prepareAdmission("drowned", replacementSite);
  assert.ok(replacementPlan);
  const replacementKey =
    `${Math.floor(replacementSite.x / 16)},${Math.floor(replacementSite.z / 16)}`;
  const oldChunk = replaced.f.world.chunks.get(replacementKey);
  replaced.f.world._removeChunk(replacementKey, oldChunk);
  const [replacementX, replacementZ] = replacementKey.split(",").map(Number);
  replaced.f.world._generateSync(replacementX, replacementZ);
  assert.notEqual(replaced.f.world.chunks.get(replacementKey), oldChunk);
  assert.equal(replaced.f.ecology.commit(replacementPlan).ok, false);

  // Restore an unmodified naturally admitted archive through the complete Game owner graph.
  const admitted = await naturalOceanGame(t);
  admitted.f.frame(2);
  const drowned = admitted.f.wildlife.entities.find((mob) => mob.kind === "drowned");
  assert.ok(drowned);
  const saved = admitted.f.snapshot(), savedWorld = structuredClone(saved.world);
  const restored = await gameMobFixture(t, {
    saved, generatorFactory: null, autoSpawn: false, admissionRadius: 3,
  });
  assert.deepEqual(restored.world.serialize(), savedWorld);
  assert.equal(restored.wildlife.byId.get(drowned.id)?.kind, "drowned");
  const sourceHabitat = admitted.f.ecology.habitat(drowned.position);
  assert.deepEqual(restored.ecology.habitat(drowned.position), sourceHabitat);

  const oldEpoch = restored.world.epoch, oldWildlife = restored.wildlife;
  const preview = createTravelPreviewWorld(restored.world, "nether");
  const destination = { ...preview.getSpawn(), dimension: "nether" };
  preview.dispose();
  const travelled = await restored.game.travel.teleport(destination);
  assert.equal(travelled.ok, true, travelled.message);
  assert.ok(restored.world.epoch > oldEpoch);
  assert.equal(restored.world.dimension, "nether");
  assert.equal(oldWildlife.disposed, true);
  assert.notDeepEqual(restored.ecology.habitat(drowned.position), sourceHabitat);
  assert.equal(restored.wildlife.byId.has(drowned.id), false);
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
  assert.equal(trading.jobsiteOwnerAt(f.world.dimension, f.site.position), null);
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
