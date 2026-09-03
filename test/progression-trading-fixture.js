import assert from "node:assert/strict";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { createEcologyState, ECOLOGY_SPECIES, ExpansionEcology } from "../src/expansion-ecology.js";
import { insertStack, splitStackPayload } from "../src/inventory-slots.js";
import { normalizeVillagerAssignment } from "../src/npc-ai.js";
import { TRADING_JOBSITES } from "../src/trading-offers.js";
import { progressionLiveFixture } from "./progression-live-fixture.js";

/** Authored NPC base pose with real ecology AI/availability and real World jobsites. */
export function progressionTradingFixture(t, { profession = "farmer", ...options } = {}) {
  const f = progressionLiveFixture(t, options);
  const id = `fixture:${profession}/villager`, site = { x: 10, y: 65, z: 8 };
  const siteKind = TRADING_JOBSITES[profession];
  assert.ok(BLOCK[siteKind], `Missing registered ${profession} jobsite`);
  f.put(site.x, site.y, site.z, BLOCK[siteKind]);
  const root = new THREE.Group();
  root.position.set(9, 65, 8.5);
  const mob = {
    id, kind: "villager", spec: ECOLOGY_SPECIES.villager, root, position: root.position,
    health: 20, dead: false, dormant: false, fleeTime: 0, velocity: new THREE.Vector3(),
  };
  const state = createEcologyState("villager", id, mob.position, f.context, {
    memberId: `fixture:village/member/${profession}`,
  });
  assert.ok(state);
  const ecology = new ExpansionEcology({
    context: f.context, coordinator: f.coordinator,
    snapshot: { version: 1, seed: f.world.seed, generatorVersion: f.world.generatorVersion,
      entries: [state], eggs: [], elders: [] },
  });
  assert.equal(f.coordinator.register(ecology, ecology.reservedBytes), true);
  const mobs = new Map([[id, mob]]);
  f.assignment = normalizeVillagerAssignment({
    id, structureId: "fixture:village", dimension: "overworld", profession, revision: 1,
    home: null, jobSite: { id: `fixture:village/job_site/${profession}`,
      position: { x: site.x + 0.5, y: site.y, z: site.z + 0.5 } },
  }, f.context);
  assert.ok(f.assignment);
  const observations = [];
  const ctx = {
    world: f.world, worldContext: f.context,
    get player() { return f.game.player.position; },
    get playerEye() { return f.game.player.eyePosition; },
    get health() { return f.gameplay.health; },
    get mode() { return f.gameplay.mode; },
    get playerDimension() { return f.world.dimension; },
    get timeOfDay() { return f.building.worldClock.time; },
    playerTargetKey: "local-player", threats: [],
    getMob: (entityId) => mobs.get(entityId),
    getVillagerAssignment: (entityId) => entityId === id ? f.assignment : null,
    isTrading: (entityId) => f.services.session?.npcId === entityId,
    jobsitePresent: (assignment) => {
      const at = assignment.jobSite?.position;
      return !!at && f.world.getCell(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))?.id ===
        BLOCK[TRADING_JOBSITES[assignment.profession]];
    },
    onVillagerIntent: (entity, observation) => observations.push({ entity, observation }),
  };
  Object.assign(f, { ecology, ecologyContext: ctx, mob, mobs, npcId: id, site, observations });
  ecology.update(mob, 0.05, ctx);
  assert.equal(mob.availableForTrade, true, "Production ecology must admit actual interaction");
  f.openTrader = () => {
    f.services.close();
    return f.services.openTrader(id);
  };
  f.stock = (offer, count = 1) => f.editInventory((owned) => {
    owned.slots.fill(null);
    for (const input of offer.inputs) {
      const stacks = splitStackPayload({ ...input, count: input.count * count }, 36, f.context);
      assert.ok(stacks);
      for (const stack of stacks) assert.equal(insertStack(owned.slots, stack), null);
    }
    return true;
  });
  f.work = () => {
    f.services.close();
    ecology.update(mob, 0.05, ctx);
    const latest = observations.at(-1);
    assert.equal(latest.entity, mob);
    return f.services.onVillagerIntent(mob, latest.observation);
  };
  return f;
}
