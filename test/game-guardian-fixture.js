import assert from "node:assert/strict";
import {
  ecologyCanOccupy, ecologyCanTarget, ecologyDistance, ecologyEye, ecologyLineOfSight,
} from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { combatState } from "./combat-effects-fixture.js";
import { point } from "./game-mob-integration-fixture.js";
import { nativeGameMobs } from "./game-mob-native-fixture.js";

// CPU owner/input regression fixture, not resource acquisition or rendering proof.
export async function guardianFixture(t, kind = "guardian") {
  const f = await nativeGameMobs(t, "ocean_monument");
  f.ecology.populate();
  f.ecology.populate();
  f.mob = f.wildlife.entities.find((mob) => mob.kind === kind);
  assert.ok(f.mob, `native monument population supplies ${kind}`);
  assert.equal(f.mob.health, f.mob.spec.health);
  assert.equal(f.ecology.ecology.state(f.mob.id).structureId, f.descriptor.id);
  f.actions = f.game.mobActions;
  approachGuardian(f);
  f.hold("IRON_SWORD");
  f.mob.spikesExtended = 1;
  assert.equal(ecologyCanTarget(f.mob, f.ecology.readRuntimeContext()), true);
  assert.equal(f.world.edits.size, 0);
  return f;
}

export function approachGuardian(f) {
  const mob = f.mob;
  for (const radius of [1.5, 2])
    for (let direction = 0; direction < 8; direction++) {
      const angle = direction * Math.PI / 4;
      const position = {
        x: mob.position.x + Math.sin(angle) * radius, y: mob.position.y,
        z: mob.position.z + Math.cos(angle) * radius,
      };
      if (!ecologyCanOccupy(f.world, position, { radius: 0.3, height: f.player.height })) continue;
      f.player.setPosition(position);
      f.aim(mob);
      f.game.updateTarget();
      const ctx = f.ecology.readRuntimeContext();
      if (f.game.meleeTarget?.entity === mob && f.actions.capture(mob, { melee: true }) &&
          ecologyDistance(ecologyEye(mob), ctx.playerEye) <= 3 &&
          ecologyLineOfSight(f.world, ecologyEye(mob), ctx.playerEye)) return;
    }
  assert.fail("sixteen bounded physical approaches did not acquire the native guardian");
}

export function guardianState(f) {
  return {
    ...combatState(f),
    world: f.world.serialize(),
    player: { position: point(f.player.position), life: f.projectiles.projectiles.life },
    mob: { id: f.mob.id, life: f.mob.life, health: f.mob.health,
      dead: f.mob.dead, dormant: f.mob.dormant, position: point(f.mob.position),
      spikes: f.mob.spikesExtended, canonical: f.wildlife.byId.get(f.mob.id) === f.mob },
  };
}

export function observeGuardian(t, f) {
  return {
    parts: t.mock.method(f.ecology, "_prepareHitParts"),
    prepare: t.mock.method(f.actions, "prepareMelee"),
    reflect: t.mock.method(f.ecology.ecology, "retaliate"),
    damage: t.mock.method(f.game.useActions, "damage"),
  };
}

/** A real final-durability payment notifies BEFORE Wildlife's afterHit. */
export function afterGuardianPayment(t, f, change) {
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[f.gameplay.selected].durability = 1;
    return true;
  }), true);
  const original = f.gameplay.onToast;
  let calls = 0;
  t.mock.method(f.gameplay, "onToast", function (text) {
    original.call(this, text);
    if (!text.endsWith(" broke")) return;
    calls++;
    assert.equal(f.gameplay.getHandStack(), null, "tool payment is already published");
    assert.equal(f.mob.health, f.mob.spec.health - 6, "victim damage is already published");
    change(f);
  });
  return () => assert.equal(calls, 1, "the actual broken-tool observer must run exactly once");
}

export function guardianWall(f) {
  const eye = ecologyEye(f.mob), target = f.player.eyePosition;
  const x = Math.floor((eye.x + target.x) / 2);
  const z = Math.floor((eye.z + target.z) / 2);
  for (let y = Math.floor(Math.min(eye.y, target.y)); y <= Math.ceil(Math.max(eye.y, target.y)); y++)
    f.put(x, y, z, BLOCK.STONE);
  assert.equal(ecologyLineOfSight(f.world, eye, target), false);
}
