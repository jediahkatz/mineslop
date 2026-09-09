import assert from "node:assert/strict";
import test from "node:test";
import {
  ecologyCanOccupy, ecologyCanTarget, ecologyDistance, ecologyEye,
  ecologyLineOfSight,
} from "../src/aquatic-ai.js";
import { VoxelGame } from "../src/game.js";
import { raycast } from "../src/world.js";
import { uniqueAttackOwners } from "./combat-effects-fixture.js";
import { point } from "./game-mob-integration-fixture.js";
import { nativeGameMobs } from "./game-mob-native-fixture.js";

function facts(f, mob) {
  const ctx = f.ecology.readRuntimeContext();
  return {
    guardian: { id: mob.id, life: mob.life, health: mob.health,
      canonical: f.wildlife.byId.get(mob.id) === mob, dead: mob.dead,
      dormant: mob.dormant, spikes: mob.spikesExtended, position: point(mob.position) },
    player: { health: f.gameplay.health, revision: f.gameplay.revision,
      handRevision: f.gameplay.getHandRevision(), hand: f.gameplay.getHandStack(),
      exhaustion: f.gameplay.exhaustion, life: ctx?.playerTargetKey,
      position: point(f.player.position), eye: point(f.player.eyePosition),
      mode: ctx?.mode, spawnProtected: ctx?.spawnProtected,
      damageHostRunning: f.gameplay.damageHost?.running },
    eligible: !!ctx && ecologyCanTarget(mob, ctx),
    distance: ctx && ecologyDistance(ecologyEye(mob), ctx.playerEye),
    lineOfSight: !!ctx && ecologyLineOfSight(f.world, ecologyEye(mob), ctx.playerEye),
    target: f.game.meleeTarget?.entity.id ?? null,
    hostActive: f.ecology.active, epoch: f.world.epoch, dimension: f.world.dimension,
  };
}

async function nativeGuardian(t) {
  const f = await nativeGameMobs(t, "ocean_monument");
  // Native descriptors and the real bounded population owner supply the victim.
  // Only the close approach, iron sword and extended-spikes instant are authored.
  f.ecology.populate();
  f.ecology.populate();
  const mob = f.wildlife.entities.find((entry) => entry.kind === "guardian");
  assert.ok(mob, "the native monument population must supply an ordinary guardian");
  assert.equal(f.ecology.ecology.state(mob.id).structureId, f.descriptor.id);
  assert.equal(mob.health, 30);
  let approached = false;
  for (const radius of [1.5, 2])
    for (let direction = 0; direction < 8 && !approached; direction++) {
      const angle = direction * Math.PI / 4;
      const at = {
        x: mob.position.x + Math.sin(angle) * radius, y: mob.position.y,
        z: mob.position.z + Math.cos(angle) * radius,
      };
      if (!ecologyCanOccupy(f.world, at, { radius: 0.3, height: f.player.height })) continue;
      f.player.setPosition(at);
      f.aim(mob);
      f.game.updateTarget();
      const ctx = f.ecology.readRuntimeContext();
      approached = f.game.meleeTarget?.entity === mob &&
        !!f.game.mobActions.capture(mob, { melee: true }) &&
        ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 3 &&
        ecologyLineOfSight(f.world, ecologyEye(mob), ctx.playerEye);
    }
  assert.equal(approached, true, "one of sixteen bounded authored approaches must acquire the native guardian");
  f.hold("IRON_SWORD");
  mob.spikesExtended = 1;
  const precise = f.wildlife.raycast(f.player.eyePosition, f.player.forward, 3);
  const block = raycast(f.world, f.player.eyePosition, f.player.forward, 3);
  assert.equal(precise?.entity, mob, "real physical eye ray, not an injected melee target");
  assert.ok(!block || precise.distance < block.distance);
  assert.equal(f.game.primary, VoxelGame.prototype.primary);
  assert.equal(f.player.flying, false);
  assert.equal(f.world.edits.size, 0, "the native approach must not author any terrain");
  assert.equal(facts(f, mob).eligible, true);
  return { f, mob };
}

function observePrimary(t, f) {
  const observations = {
    notifications: 0,
    commit: t.mock.method(f.game.mobActions, "commit"),
    reflections: t.mock.method(f.ecology.ecology, "retaliate"),
    damage: t.mock.method(f.game.useActions, "damage"),
  };
  const prepareParts = f.ecology._prepareHitParts;
  t.mock.method(f.ecology, "_prepareHitParts", function (id, amount, direction, options, add) {
    return prepareParts.call(this, id, amount, direction, options, (domain, edit) => add(domain, {
      ...edit,
      notify() {
        observations.notifications++;
        return edit.notify?.call(edit);
      },
    }));
  });
  return observations;
}

test("native guardian: normal Game primary reflects an accepted iron sword hit exactly once", async (t) => {
  const { f, mob } = await nativeGuardian(t);
  const observations = observePrimary(t, f);
  const before = facts(f, mob), world = f.world.serialize();
  const generations = f.world.generator.counters.chunkGenerations;
  assert.equal(before.guardian.health, 30);
  assert.equal(before.player.health, 20);
  assert.equal(before.player.hand.durability, 250);
  assert.equal(before.player.exhaustion, 0);
  f.game.primary(0.05, true);
  const after = facts(f, mob);
  assert.equal(observations.commit.mock.callCount(), 1);
  const { arguments: [plan], result } = observations.commit.mock.calls[0];
  assert.ok(plan, "normal primary must prepare and commit through GameMobActions");
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  uniqueAttackOwners(f, plan.participants);
  const replay = f.game.mobActions.commit(plan);
  assert.equal(replay.ok, false);
  assert.deepEqual(facts(f, mob), after, "replaying the paid action must not publish or reflect");
  assert.equal(mob.health, 24);
  assert.equal(f.gameplay.getHandStack().durability, 249);
  assert.equal(f.gameplay.exhaustion, 0.1);
  assert.equal(observations.notifications, 1);
  assert.equal(f.world.generator.counters.chunkGenerations, generations);
  assert.deepEqual(f.world.serialize(), world);
  assert.equal(f.gameplay.health, 18, "accepted direct-player melee must reflect two spike damage");
  assert.equal(observations.reflections.mock.callCount(), 1);
  assert.equal(observations.damage.mock.callCount(), 1);
  assert.deepEqual(observations.damage.mock.calls.map(({ arguments: [amount, , , kind] }) =>
    ({ amount, kind })), [{ amount: 2, kind: "thorns" }]);
  t.diagnostic(JSON.stringify({
    nativeGuardianPrimary: "PASS",
    guardianHealth: [before.guardian.health, after.guardian.health],
    playerHealth: [before.player.health, after.player.health],
    swordDurability: [before.player.hand.durability, after.player.hand.durability],
    reflections: observations.reflections.mock.callCount(),
    replayAccepted: replay.ok,
    generatedDuringInteraction: f.world.generator.counters.chunkGenerations - generations,
    worldEdits: f.world.edits.size,
    authoredPrerequisites: ["close approach", "plain iron sword", "extended-spikes instant"],
    scope: "CPU Game/input/owner proof, not GUI or naturally elapsed encounter",
  }));
});
