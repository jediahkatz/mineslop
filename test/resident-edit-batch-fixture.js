import assert from "node:assert/strict";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseFixture, horseRecord } from "./horse-fixture.js";

/** Authored source identity only. No fixture source is proof of launch/reach. */
export function residentSource(f, {
  id = "resident-batch:source", kind = "skeleton", position = { x: 2.5, y: 1, z: 2.5 },
} = {}) {
  const mob = f.wildlife.spawn(kind, position, { id, restoring: true });
  assert.ok(mob);
  return mob;
}

export function finishResidentBatch(wildlife, batch, contributions, extra = []) {
  assert.ok(contributions.every((value) => value?.complete === false));
  const plan = wildlife.finalizeResidentEditBatch(batch, {
    contributions, participants: [...contributions.flatMap((value) => value.peers), ...extra],
  });
  assert.ok(plan);
  assert.equal(plan.complete, true);
  assert.equal(plan.participants.filter((part) => part.owner === wildlife).length, 1);
  assert.equal(plan.participants.at(-1).owner, wildlife);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
  return plan;
}

export function residentState(f) {
  return {
    ...f.ownership(),
    baseRevision: f.wildlife._ecologyRevision,
    defendTarget: f.wildlife.defendTarget,
    defendUntil: f.wildlife.defendUntil,
    horseRevision: f.horses?.revision,
    ecology: f.host?.ecology.serialize(),
    ecologyRevision: f.host?.ecology.revision,
    ecologyDirty: f.host?._dirty,
    events: f.events && structuredClone(f.events),
    player: { ...f.wildlife.player },
    playerEye: { ...f.wildlife.context.playerEye },
    active: f.wildlife.entities.map((mob) => ({
      id: mob.id, dead: mob.dead, dormant: mob.dormant, health: mob.health,
      hitFlash: mob.hitFlash, fleeTime: mob.fleeTime, angry: mob.angry,
      velocityY: mob.velocityY, targetYaw: mob.targetYaw, groundY: mob.groundY,
      home: { ...mob.home }, knockback: { ...mob.knockback }, threat: { ...mob.threat },
      horseView: mob.horseView,
    })),
  };
}

export function residentRiderFixture(t, { x = 8.5, y = 8, ...options } = {}) {
  const f = horseFixture(t, { ...options, bind: false });
  const id = "resident-batch:mounted-horse";
  const horses = { ...emptyHorseSnapshot(f.context), entries: [horseRecord(id, {
    tamed: true, temper: 100, tamingTicksLeft: 0, rider: "player",
    motion: { vx: 1, vy: -2, vz: 0.5, grounded: false, fallDistance: 2 },
    saddle: { id: ITEM.SADDLE, count: 1, data: { version: 1, name: "Batch trail saddle" } },
  })] };
  const mobs = mobSnapshot(f.context, "overworld", [mobRecord(f.context, "overworld", {
    id, kind: "horse", health: 24, yaw: 0, position: { x, y, z: 8.5 },
  })]);
  assert.equal(f.horses.load(horses), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.horse = f.wildlife.byId.get(id);
  f.actor.position = { ...f.horses.riderPose().position };
  return f;
}

/** Actual World, Wildlife, Horses and Ecology sharing one coordinator. */
export function residentBorrowersFixture(t, options = {}) {
  const f = horseFixture(t, { ...options, bind: false });
  const host = new GameEcologyServices({
    world: f.world, context: f.context, coordinator: f.coordinator,
    gameplay: f.gameplay, overflow: f.overflow, experienceOrbs: f.experience,
    readHorses: () => f.horses.serialize(),
    readPlayer: () => ({ ...f.readOwner(), health: f.gameplay.health,
      mode: f.gameplay.mode, swimming: false, invulnerable: false }),
    readHabitat: () => ({ biomeId: "beach", blockLight: 0, skyLight: 0 }),
  });
  f.host = host;
  assert.equal(host.restoreWildlife(f.wildlife), true);
  assert.equal(host.activate(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.admitTurtle = (position = { x: 13.5, y: 1, z: 8.5 }) => {
    const plan = host.prepareAdmission("turtle", position);
    assert.ok(plan);
    assert.equal(host.commit(plan).ok, true);
    return f.wildlife.byId.get(plan.result.id);
  };
  t.after(() => host.dispose());
  return f;
}

export function residentWear(f) {
  const stack = f.gameplay.getHandStack();
  const cost = f.gameplay.prepareHandCost("main", {
    stack, handRevision: f.gameplay.getHandRevision(), wear: 1, notify: false,
  });
  assert.ok(cost);
  return cost;
}
