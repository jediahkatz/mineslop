import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { ITEM } from "../src/items.js";
import { Wildlife } from "../src/wildlife.js";
import { ecologyMarkerIndex } from "./ecology-host-fixture.js";
import { integratedProgressionFixture } from "./game-progression-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

function farmer(t) {
  const f = integratedProgressionFixture(t);
  const markers = ecologyMarkerIndex(f.world);
  const structure = {
    id: "fixture:progression-village", kind: "village", dimension: "overworld",
    origin: { x: 8, y: 65, z: 8 },
    bounds: { minX: 4, minY: 65, minZ: 4, maxX: 12, maxY: 72, maxZ: 12 },
  };
  const member = {
    id: `${structure.id}/member/grower`, structureId: structure.id, dimension: "overworld",
    type: "member", entity: "villager", unique: true, profession: "farmer",
    position: { x: 9, y: 65, z: 8 },
    homeId: `${structure.id}/home/farm`, jobSiteId: `${structure.id}/job_site/composter`,
  };
  const home = { id: member.homeId, structureId: structure.id, dimension: "overworld",
    type: "home", position: { x: 8, y: 65, z: 11 } };
  const site = { id: member.jobSiteId, structureId: structure.id, dimension: "overworld",
    type: "job_site", memberId: member.id, profession: "farmer",
    block: "COMPOSTER", position: { x: 10, y: 65, z: 8 } };
  markers.add(structure, [member, home, site]);
  f.put(10, 65, 8, BLOCK.COMPOSTER);
  const ecology = new GameEcologyServices({
    world: f.world, gameplay: f.gameplay, overflow: f.overflow, experienceOrbs: f.orbs,
    trading: f.services.trading, context: f.context, markers: markers.api,
    readPlayer: () => ({
      position: f.player.position, eye: f.player.eyePosition,
      dimension: f.world.dimension, targetKey: `${f.pearls.ownerId}:${f.pearls.life}`,
      health: f.gameplay.health, mode: f.gameplay.mode, swimming: false, invulnerable: false,
    }),
    onVillagerIntent: (id, observation) => f.integration.onVillagerIntent(id, observation),
  });
  const wildlife = new Wildlife(f.game.graphics.scene, f.world, {
    autoSpawn: false, context: f.context,
  });
  f.game.ecologyServices = ecology;
  f.game.wildlife = wildlife;
  assert.equal(ecology.restoreWildlife(wildlife), true);
  assert.equal(ecology.activate(wildlife), true);
  const admission = ecology.prepareAdmission("villager", { x: 9.5, y: 65, z: 8.5 }, {
    structure, marker: member,
  });
  assert.ok(admission, "the real Ecology and Wildlife owners must admit the authored member");
  assert.equal(ecology.commit(admission).ok, true);
  wildlife.update(0.05, 0.05, f.player.position, {
    timeOfDay: f.building.worldClock.time, mode: f.gameplay.mode, health: f.gameplay.health,
    playerEye: f.player.eyePosition, playerDimension: f.world.dimension,
    playerTargetKey: `${f.pearls.ownerId}:${f.pearls.life}`,
  });
  const id = admission.result.id;
  assert.equal(wildlife.byId.get(id).availableForTrade, true);
  assert.equal(f.integration.openTrader(id).opened, true);
  const offer = f.integration.view().offers.find((entry) => entry.id === "farmer/wheat");
  assert.ok(offer);
  assert.equal(offer.inputs[0].count, 20);
  f.editInventory((owned) => {
    owned.slots.fill(null);
    owned.slots[0] = progressionStack(ITEM.WHEAT, 20);
    owned.experienceTotal = 4;
    return true;
  });
  return { ...f, ecology, wildlife, id, offer };
}

test("a real ecology-backed paid trade credits exact player XP and finite stock once", (t) => {
  const f = farmer(t);
  const plan = f.prepare({ type: "trade", offerId: f.offer.id });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.length, 2);
  assert.equal(f.integration.commit(plan).ok, true);
  assert.equal(f.gameplay.slots.some((stack) => stack?.id === ITEM.WHEAT), false);
  assert.equal(f.gameplay.slots.find((stack) => stack?.id === ITEM.EMERALD).count, 1);
  assert.equal(f.gameplay.getState().experience.total, 4 + f.offer.playerXp);
  assert.equal(f.services.trading.get(f.id).offers.find((offer) => offer.id === f.offer.id).uses, 1);
  assert.deepEqual(f.calls.sounds, [["xp", f.offer.playerXp]]);
  const paid = f.snapshot();
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), paid);
  assert.deepEqual(f.calls.sounds, [["xp", f.offer.playerXp]]);
});

test("ecology suspension invalidates prepared trade payment and closes its menu without fake availability", (t) => {
  const f = farmer(t);
  const plan = f.prepare({ type: "trade", offerId: f.offer.id });
  assert.equal(plan.ok, true);
  assert.equal(f.ecology.suspend(), true);
  const before = f.snapshot();
  assert.equal(f.integration.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.calls.sounds, []);
  assert.equal(f.integration.view(), null);
  assert.equal(f.integration.frame(0.05).ok, true);
  assert.equal(f.integration.isOpen, false);
  assert.equal(f.integration.openTrader(f.id).ok, false);
});
