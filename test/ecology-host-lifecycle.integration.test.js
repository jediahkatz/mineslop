import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ecologyEncounterProjection } from "../src/ecology-save.js";
import { ECOLOGY_SPECIES } from "../src/expansion-ecology.js";
import { insertStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  ecologyFortress, ecologyHostFixture, ecologyTotals, ecologyVeto, ecologyVillage,
} from "./ecology-host-fixture.js";
import { monumentFixture } from "./ecology-fixtures.js";

test("three long canonical elder identities survive eviction/reload; death and completion publish once", (t) => {
  const seed = "界".repeat(80);
  const f = ecologyHostFixture(t, { seed });
  const authored = monumentFixture();
  const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:ocean_monument:0:0`;
  const structure = { ...authored.structure, id, origin: { x: 14, y: 1, z: 16 },
    bounds: { minX: 0, minY: 1, minZ: 0, maxX: 31, maxY: 10, maxZ: 31 } };
  const markers = authored.markers.map((marker, i) => ({
    ...marker, structureId: id, id: `${id}/encounter/${marker.key}`,
    position: { x: [4, 24, 14][i], y: i === 2 ? 4 : 2, z: i === 2 ? 16 : 8 },
    bounds: structure.bounds,
  }));
  f.markerIndex.add(structure, markers);
  assert.equal(f.host.prepareAdmission("elder_guardian", { x: 30, y: 2, z: 30 },
    { structure, marker: markers[0] }), null, "host admission pins the actual unique marker birth position");
  const mobs = markers.map((marker) => f.admit("elder_guardian", {
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  }, { structure, marker }));
  assert.equal(new Set(mobs.map((mob) => mob.id)).size, 3);
  for (let i = 0; i < mobs.length; i++) {
    assert.ok(mobs[i].id.length <= 100);
    assert.ok(markers[i].id.length > 700);
    assert.equal(f.host.ecology.state(mobs[i].id).markerId, markers[i].id);
    assert.equal(f.host.ecology.entityIdForMarker(markers[i].id), mobs[i].id);
  }
  assert.equal(f.host.hurt(mobs[0], 7, null).ok, true);
  const ecology = f.host.ecology.serialize(), base = f.wildlife.serialize();
  for (const key of ["0,0", "1,0", "0,1"])
    f.world._removeChunk(key, f.world.chunks.get(key));
  f.tick();
  assert.equal(f.wildlife.entities.length, 0);
  assert.equal(f.wildlife.dormantEcology.size, 3);
  assert.deepEqual(f.host.ecology.serialize(), ecology);
  assert.deepEqual(f.wildlife.serialize(), base);
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1]]) f.world._generateSync(cx, cz);
  f.tick();
  assert.equal(f.wildlife.byId.get(mobs[0].id).health, 73, "waking is not healing");
  assert.equal(f.wildlife.entities.length, 3);
  const victim = mobs[0];
  const death = f.host.prepareHit(victim.id, 1000, null, { playerKill: true, validate: () => true });
  assert.ok(death);
  assert.ok(death.participants.some((part) => part.owner === f.exploration));
  const before = f.ownership();
  const rejected = f.coordinator.commit([...death.participants, ecologyVeto(f.coordinator)]);
  assert.equal(rejected.ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.host.commit(death).ok, true);
  assert.equal(f.host.ecology.elder(markers[0].id).status, "defeated");
  assert.equal(f.exploration.completed(ecologyEncounterProjection(markers[0])), true);
  assert.deepEqual(ecologyTotals(f), {
    drops: { [BLOCK.WET_SPONGE]: 1, [ITEM.PRISMARINE_SHARD]: 3, [ITEM.PRISMARINE_CRYSTALS]: 2 }, xp: 10,
  });
  assert.equal(f.host.commit(death).ok, false);
  const saved = f.snapshot();
  const restored = ecologyHostFixture(t, { seed, saved });
  restored.markerIndex.add(structure, markers);
  restored.tick();
  assert.equal(restored.wildlife.byId.has(victim.id), false);
  assert.equal(restored.wildlife.byId.size, 2);
  assert.equal(restored.host.prepareAdmission("elder_guardian", victim.home, { structure, marker: markers[0] }), null);
  assert.equal(restored.exploration.serialize().encounters[0].marker.id, markers[0].id);
  assert.deepEqual(ecologyTotals(restored), ecologyTotals(f));
});

test("elder death requires the bound Exploration completion owner, not an unrelated accepted participant", (t) => {
  const f = ecologyHostFixture(t), { structure, markers } = monumentFixture();
  f.markerIndex.add(structure, markers);
  const marker = markers[0];
  const mob = f.admit("elder_guardian", {
    x: marker.position.x + 0.5, y: marker.position.y, z: marker.position.z + 0.5,
  }, { structure, marker });
  const unrelated = ecologyVeto(f.coordinator, () => true);
  t.mock.method(f.exploration, "prepareEncounterComplete", () => ({
    participants: [unrelated], result: { ok: true },
  }));
  const before = f.ownership();
  assert.equal(f.host.prepareHit(mob.id, 1000, null, {
    playerKill: true, validate: () => true,
  }), null);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.host.ecology.elder(marker.id).status, "alive");
  assert.equal(mob.health, ECOLOGY_SPECIES.elder_guardian.health);
});

test("one ecology host retains complete inactive-dimension poses and replaces only the Wildlife renderer", (t) => {
  const f = ecologyHostFixture(t, { water: -1, biomeId: "beach" });
  const turtle = f.admit("turtle", { x: 8.5, y: 1, z: 8.5 });
  assert.equal(f.host.hurt(turtle, 4, null).ok, true);
  const turtleBase = f.wildlife.serialize().entities[0];
  const travel = (dimension) => {
    const previous = f.wildlife;
    const ecologyBytes = f.coordinator.usage(f.host.ecology);
    assert.equal(previous._ownsRegistration, true);
    assert.equal(f.host.suspend(), true);
    assert.equal(f.coordinator.usage(previous), 0, "borrower suspension leaves Wildlife self-owned");
    assert.equal(previous.ecologyServices, null);
    assert.equal(previous.dispose(), true);
    assert.equal(f.coordinator.usage(previous), undefined, "only Wildlife disposal releases its registration");
    assert.equal(previous._ownsRegistration, false);
    assert.equal(f.coordinator.usage(f.host.ecology), ecologyBytes, "disposing a base does not release Ecology");
    f.world.setDimension(dimension).generate(1);
    f.wildlife = f.createWildlife();
    assert.equal(f.coordinator.usage(f.wildlife), 0, "a fresh Wildlife owns its registration before activation");
    assert.equal(f.host.restoreWildlife(f.wildlife), true);
    assert.equal(f.host.activate(f.wildlife), true);
    f.tick(1, 0);
  };
  travel("nether");
  const site = ecologyFortress(f);
  const blaze = f.admit("blaze", { x: 8.5, y: 2, z: 8.5 }, site);
  assert.deepEqual(f.host.serialize().mobsByDimension.overworld.entities, [turtleBase]);
  assert.equal(f.host.serialize().mobsByDimension.nether.entities[0].id, blaze.id);
  travel("overworld");
  assert.equal(f.wildlife.byId.get(turtle.id).health, 26);
  assert.equal(f.wildlife.byId.get(turtle.id).dormant, true);
  f.tick();
  assert.equal(f.wildlife.byId.get(turtle.id).dormant, false);
  assert.equal(f.host.serialize().mobsByDimension.nether.entities[0].id, blaze.id);
  assert.equal(f.host.effects.size, 0);
});

function nestingFixture(t) {
  const f = ecologyHostFixture(t, { floor: 63, water: -1, biomeId: "beach" });
  f.player.position = { x: 8.5, y: 64, z: 11 };
  const first = f.admit("turtle", { x: 8.5, y: 64, z: 8.5 });
  const second = f.admit("turtle", { x: 9.9, y: 64, z: 8.5 });
  f.hold("SEAGRASS", { count: 2 });
  for (const mob of [first, second]) {
    const feed = f.host.prepareInteraction(mob.id);
    assert.ok(feed);
    assert.equal(f.host.commit(feed).ok, true);
  }
  assert.equal(f.gameplay.getHandStack(), null);
  const breed = f.host.ecology.prepareBreeding(first, second, f.wildlife.context);
  assert.ok(breed);
  assert.equal(f.host.commit(breed).ok, true);
  return { ...f, mother: first };
}

test("two real feeds yield a World-owned egg, one retained hatchling and one growth scute across checkpoints", (t) => {
  const f = nestingFixture(t);
  const blocker = {};
  assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  const before = f.ownership();
  const refused = f.host.prepareLayEgg(f.mother.id);
  assert.ok(refused);
  assert.equal(f.host.commit(refused).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.host.ecology.state(f.mother.id).gravid, true);
  assert.equal(f.coordinator.release(blocker), true);
  const lay = f.host.prepareLayEgg(f.mother.id);
  assert.ok(lay);
  assert.deepEqual(new Set(lay.participants.map((part) => part.owner)), new Set([
    f.host.ecology, f.world, f.wildlife,
  ]));
  assert.equal(f.host.commit(lay).ok, true);
  const egg = f.host.ecology.egg(lay.result.eggId);
  assert.equal(f.world.get(egg.position.x, egg.position.y, egg.position.z), BLOCK.TURTLE_EGG);
  assert.equal(f.host.ecology.state(f.mother.id).gravid, false);
  assert.equal(f.host.ecology.identityReserved(egg.childId), true);
  // Explicit save-window fixtures, not a claim that 300/1200 seconds were played.
  const hatchWindow = f.snapshot();
  hatchWindow.ecology.ecology.eggs[0].remaining = 0.05;
  const hatched = ecologyHostFixture(t, { floor: 63, water: -1, biomeId: "beach", saved: hatchWindow });
  hatched.player.position = { x: 8.5, y: 64, z: 11 };
  hatched.tick();
  assert.equal(hatched.host.ecology.egg(egg.id).status, "hatched");
  assert.equal(hatched.world.get(8, 64, 8), BLOCK.AIR);
  const baby = hatched.wildlife.byId.get(egg.childId);
  assert.ok(baby);
  assert.equal(baby.root.scale.x, 0.5);
  assert.equal(hatched.host.ecology.state(baby.id).scuteClaimed, false);
  assert.equal(hatched.host.ecology.prepareHatch(egg.id, baby.position, hatched.wildlife.context, {}), null);
  const growthWindow = hatched.snapshot();
  growthWindow.ecology.ecology.entries.find((entry) => entry.id === baby.id).growthRemaining = 0.05;
  let acceptDrops = false;
  const grown = ecologyHostFixture(t, {
    floor: 63, water: -1, biomeId: "beach", saved: growthWindow,
    hooks: { prepareDrops: ({ stacks, position, dimension }) =>
      acceptDrops ? grown.overflow.prepareEnqueue(stacks, position, dimension) : null },
  });
  grown.player.position = { x: 8.5, y: 64, z: 11 };
  grown.tick();
  assert.equal(grown.host.ecology.state(baby.id).growthRemaining, 0);
  assert.equal(grown.host.ecology.state(baby.id).scuteClaimed, false);
  assert.deepEqual(ecologyTotals(grown), { drops: {}, xp: 0 });
  acceptDrops = true;
  grown.tick();
  assert.equal(grown.host.ecology.state(baby.id).scuteClaimed, true);
  assert.equal(grown.wildlife.byId.get(baby.id).root.scale.x, 1);
  assert.deepEqual(ecologyTotals(grown), { drops: { [ITEM.SCUTE]: 1 }, xp: 0 });
  const again = ecologyHostFixture(t, { floor: 63, water: -1, biomeId: "beach", saved: grown.snapshot() });
  again.player.position = { x: 8.5, y: 64, z: 11 };
  again.tick(3);
  const death = again.host.prepareHit(baby.id, 1000, null, { playerKill: true, validate: () => true });
  assert.ok(death);
  assert.equal(again.host.commit(death).ok, true);
  assert.deepEqual(ecologyTotals(again), { drops: { [ITEM.SCUTE]: 1 }, xp: 0 }, "no turtle death scute or XP");
});

test("egg destruction batches share one World participant and keep broken child identities reserved", (t) => {
  const f = nestingFixture(t);
  const lay = f.host.prepareLayEgg(f.mother.id);
  assert.equal(f.host.commit(lay).ok, true);
  const egg = f.host.ecology.egg(lay.result.eggId);
  f.put(11, 64, 8, BLOCK.TURTLE_EGG);
  // Authored two-clutch checkpoint isolates the batch protocol.
  const saved = f.snapshot();
  const second = { ...structuredClone(egg), id: "second-egg", childId: "second-child",
    serial: 2, position: { x: 11, y: 64, z: 8 } };
  saved.ecology.ecology.eggs.push(second);
  saved.ecology.ecology.entries.find((entry) => entry.id === f.mother.id).clutchSerial = 2;
  const restored = ecologyHostFixture(t, { floor: 63, water: -1, biomeId: "beach", saved });
  const positions = [egg.position, second.position];
  const prepareRemoveEggs = ({ eggs, changes, reads, dimension }) => {
    assert.equal(eggs.length, 2);
    assert.equal(dimension, "overworld");
    return restored.world.prepareMutation([...changes, {
      x: 13, y: 64, z: 8, before: restored.world.getCell(13, 64, 8),
      after: { id: BLOCK.STONE },
    }], { reads });
  };
  const refused = restored.host.prepareBreakEggs(positions, {
    prepareRemoveEggs, participants: [ecologyVeto(restored.coordinator)],
  });
  assert.ok(refused);
  const before = restored.ownership();
  assert.equal(restored.host.commit(refused).ok, false);
  assert.deepEqual(restored.ownership(), before);
  const broken = restored.host.prepareBreakEggs(positions, { prepareRemoveEggs });
  assert.ok(broken);
  assert.equal(broken.participants.filter((part) => part.owner === restored.world).length, 1);
  assert.equal(broken.participants.filter((part) => part.owner === restored.host.ecology).length, 1);
  assert.equal(restored.host.commit(broken).ok, true);
  for (const entry of [egg, second]) {
    assert.equal(restored.host.ecology.egg(entry.id).status, "broken");
    assert.equal(restored.host.ecology.identityReserved(entry.childId), true);
    assert.equal(restored.world.get(entry.position.x, entry.position.y, entry.position.z), BLOCK.AIR);
  }
  assert.equal(restored.world.get(13, 64, 8), BLOCK.STONE);
  assert.equal(restored.host.commit(broken).ok, false);
  assert.equal(restored.host.prepareBreakEggs(positions), null);
});

function tradingFixture(t, options = {}) {
  const f = ecologyHostFixture(t, { water: -1, biomeId: "plains", ...options });
  const village = ecologyVillage(f);
  f.player.position = { x: 8.5, y: 1, z: 11.5 };
  const mob = f.admit("villager", { x: 8.5, y: 1, z: 8.5 }, {
    structure: village.structure, marker: village.member,
  });
  const readAvailability = (id) => f.host.readAvailability(id, { interaction: false });
  const jobsiteUsable = (id, site) => f.host.jobsiteUsable(id, site);
  return Object.assign(f, { ...village, mob, readAvailability, jobsiteUsable });
}
function registerTrader(f) {
  const jobsite = { id: f.site.id, kind: f.site.block, dimension: "overworld", position: f.site.position };
  const plan = f.trading.prepareRegister({ id: f.mob.id, profession: "farmer", jobsite }, {
    clock: { day: 0, time: 2000 }, validate: () => true,
    readAvailability: f.readAvailability, jobsiteUsable: f.jobsiteUsable,
  });
  assert.ok(plan);
  assert.equal(f.trading.commit(plan).ok, true);
  return jobsite;
}
function prepareTrade(f) {
  const offer = f.trading.offers(f.mob.id)[0];
  const supply = f.gameplay.prepareInventory((draft) => {
    draft.slots.fill(null);
    for (const stack of offer.inputs) assert.equal(insertStack(draft.slots, structuredClone(stack)), null);
    return true;
  });
  assert.equal(f.coordinator.commit([supply]).ok, true);
  const captured = f.host.captureTrade(f.mob.id);
  assert.ok(captured);
  return f.trading.prepareTrade(f.mob.id, offer.id, {
    inventory: f.gameplay, clock: { day: 0, time: 2000 },
    readAvailability: (id) => f.host.readAvailability(id), validate: captured.validate,
  });
}

test("live villagers expose real jobsite availability; only Trading creates/offers/restocks stock", (t) => {
  const f = tradingFixture(t);
  f.tick(3);
  assert.equal(f.trading.get(f.mob.id), null, "AI never generates offers or stock");
  const jobsite = registerTrader(f);
  assert.equal(f.host.jobsiteUsable(f.mob.id, jobsite), true);
  assert.equal(f.host.readAvailability(f.mob.id).available, true);
  assert.equal(f.mob.npcIntent, "work");
  const trade = prepareTrade(f);
  assert.ok(trade);
  const stock = f.trading.serialize();
  f.tick();
  assert.deepEqual(f.trading.serialize(), stock, "AI work observation does not restock");
  assert.equal(f.trading.commit(trade).ok, false, "moving/revisioned availability invalidates prepared trades");
  const current = prepareTrade(f);
  assert.equal(f.trading.commit(current).ok, true);
  const used = f.trading.offers(f.mob.id)[0].uses;
  assert.equal(used, 1);
  const restock = f.trading.prepareRestock(f.mob.id, {
    clock: { day: 0, time: 3000 }, validate: () => true,
    readAvailability: f.readAvailability, jobsiteUsable: f.jobsiteUsable,
  });
  assert.ok(restock);
  const world = f.world.prepareMutation([{
    ...f.site.position, before: f.world.getCell(10, 1, 8), after: { id: BLOCK.AIR },
  }]);
  const release = f.trading.prepareReleaseJobsite(f.mob.id, {
    clock: { day: 0, time: 2500 }, validate: () => true, participants: [world],
  });
  assert.ok(release);
  assert.equal(f.trading.commit(release).ok, true);
  assert.equal(f.trading.commit(restock).ok, false);
  assert.equal(f.trading.get(f.mob.id).jobsite, null);
  assert.equal(f.trading.get(f.mob.id).locked, true);
  assert.equal(f.trading.offers(f.mob.id)[0].uses, used);
  assert.equal(f.host.readAvailability(f.mob.id).available, true, "remaining stock needs no bed or jobsite");
  assert.equal(f.host.jobsiteUsable(f.mob.id, jobsite), false, "the removed block is not a work site");
});

test("villager death atomically releases its Trading jobsite; unload never releases it", (t) => {
  const f = tradingFixture(t);
  f.tick();
  registerTrader(f);
  const stock = f.trading.serialize();
  const revision = f.host.readAvailability(f.mob.id).revision;
  f.wildlife.suspendEcology(f.mob);
  assert.equal(f.host.readAvailability(f.mob.id).available, false);
  assert.ok(f.host.readAvailability(f.mob.id).revision > revision);
  assert.deepEqual(f.trading.serialize(), stock);
  f.tick();
  const death = f.host.prepareHit(f.mob.id, ECOLOGY_SPECIES.villager.health, null, {
    playerKill: true, validate: () => true,
  });
  assert.ok(death);
  assert.equal(death.participants.filter((part) => part.owner === f.trading).length, 1);
  assert.equal(f.host.commit(death).ok, true);
  assert.equal(f.trading.get(f.mob.id).jobsite, null);
  assert.equal(f.host.readAvailability(f.mob.id).alive, false);
  assert.deepEqual(ecologyTotals(f), { drops: {}, xp: 0 });
});

test("villager intent observers are bounded notifications, not permission to stop AI or mint stock", (t) => {
  const failure = new Error("fixture intent observer");
  const f = tradingFixture(t, { hooks: { onVillagerIntent: () => { throw failure; } } });
  const stock = f.trading.serialize();
  f.tick(40);
  assert.equal(f.mob.npcIntent, "work");
  assert.equal(f.host.readAvailability(f.mob.id).alive, true);
  assert.equal(f.host.observerErrors.length, 16);
  assert.ok(f.host.observerErrors.every((error) => error === failure));
  assert.deepEqual(f.trading.serialize(), stock);
  assert.equal(f.trading.get(f.mob.id), null);
});

test("live NPC availability uses Trading's small runtime projection, never per-frame offer clones", (t) => {
  const f = tradingFixture(t);
  f.tick();
  const jobsite = registerTrader(f), stock = f.trading.serialize();
  t.mock.method(f.trading, "get", () => assert.fail("AI must not clone persistent offers"));
  f.tick(40);
  assert.equal(f.host.readAvailability(f.mob.id).available, true);
  assert.equal(f.host.jobsiteUsable(f.mob.id, jobsite), true);
  assert.equal(f.mob.npcIntent, "work");
  assert.deepEqual(f.trading.serialize(), stock);
});

test("public Progression runtime reads current physical player state without updating or archiving owners", (t) => {
  const f = tradingFixture(t);
  f.tick();
  registerTrader(f);
  const before = f.ownership();
  const initial = f.host.readRuntimeContext();
  assert.equal(initial.world, f.world);
  assert.equal(initial.getMob(f.mob.id), f.mob);
  assert.equal(initial.getVillagerAssignment(f.mob.id).profession, "farmer");
  assert.deepEqual(f.ownership(), before);
  f.player.position.z += 0.1;
  f.player.targetKey = "player:life:2";
  const current = f.host.readRuntimeContext();
  assert.equal(current.player.z, f.player.position.z);
  assert.equal(current.playerEye.y, f.player.position.y + 1.62);
  assert.equal(current.playerTargetKey, "player:life:2");
  assert.ok(current.threats.length <= 8);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.host.suspend(), true);
  assert.equal(f.host.readRuntimeContext(), null);
});
