import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { ENDERMAN_LIMITS } from "../src/enderman.js";
import { mobEye } from "../src/mob-ai.js";
import { canOccupy } from "../src/mob-navigation.js";
import { ecosystem, flatWorld, wall } from "./mob-fixtures.js";

const player = new THREE.Vector3(0.5, 9, 0.5);
const eye = new THREE.Vector3(0.5, 10.62, 0.5);
const away = new THREE.Vector3(-1, 0, 0);

function fixture(t, options = {}, position = { x: 8.5, y: 9, z: 0.5 }) {
  const world = flatWorld(options);
  const attacks = [], drops = [];
  const wildlife = ecosystem(world, {
    onDamage: (...args) => { attacks.push(args); return { health: 20 }; },
    onDrop: (...args) => drops.push(args),
  });
  t.after(() => wildlife.dispose());
  const mob = wildlife.spawn("enderman", position);
  assert.ok(mob);
  mob.walking = false;
  mob.wanderTimer = 100;
  return { world, wildlife, mob, attacks, drops };
}

function steps(f, count, { gaze = true, ...environment } = {}) {
  for (let i = 0; i < count; i++) {
    const physicalEye = environment.playerEye ?? eye;
    const forward = gaze ? new THREE.Vector3().copy(mobEye(f.mob)).sub(physicalEye) : away;
    f.wildlife.update(0.05, f.wildlife.clock + 0.05, player, {
      mode: "survival", health: 20, timeOfDay: 0.5,
      playerEye: physicalEye, playerForward: forward, ...environment,
    });
  }
}

test("Enderman provokes at .25s, freezes throughout tracking, chases on break, freezes on restare", (t) => {
  const f = fixture(t);
  const start = f.mob.position.clone();
  steps(f, 4);
  assert.equal(f.mob.angry, 0);
  steps(f, 1);
  assert.equal(f.mob.angry, ENDERMAN_LIMITS.angerTime);
  steps(f, 35);
  assert.deepEqual(f.mob.position, start);
  assert.equal(f.mob.moving, false);
  assert.equal(f.mob.attacking, true);
  assert.equal(f.attacks.length, 0);
  steps(f, 10, { gaze: false });
  assert.ok(f.mob.position.x < start.x);
  assert.equal(f.mob.moving, true);
  const restare = f.mob.position.clone();
  steps(f, 10);
  assert.deepEqual(f.mob.position, restare);
  assert.equal(f.mob.moving, false);
});

test("Enderman .25s provocation requires continuous eye contact", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    steps(f, 4);
    assert.equal(f.mob.angry, 0);
    steps(f, 1, { gaze: false });
    assert.equal(f.mob.lookTimer, 0);
  }
  steps(f, 5);
  assert.ok(f.mob.angry > 0);
});

test("Enderman physical eye gaze reaches 64, ignores mesh and render displacement, rejects cover", (t) => {
  for (const distance of [12, 24, 48, 64]) {
    const f = fixture(t, {}, { x: player.x + distance, y: 9, z: player.z });
    f.mob.model.head.position.x += 50;
    steps(f, 5, {
      renderEye: { x: 900, y: 50, z: -900 }, renderForward: away,
    });
    assert.ok(f.mob.angry > 0, `gaze provokes at ${distance}`);
    assert.equal(f.mob.dead, false, "64-block gaze is not preempted by 58-block culling");
    assert.equal(f.world.unloadedReads, 0);
  }
  const covered = fixture(t);
  wall(covered.world, 4);
  steps(covered, 10);
  assert.equal(covered.mob.angry, 0);
  const outside = fixture(t, {}, { x: 65.5, y: 9, z: 0.5 });
  outside.wildlife.context.playerEye = { ...eye, y: mobEye(outside.mob).y };
  outside.wildlife.context.playerForward = { x: 1, y: 0, z: 0 };
  assert.equal(outside.wildlife.isLookingAt(outside.mob), false);
});

test("Enderman freeze boundary is 16 blocks, while close angry gaze escapes without melee", (t) => {
  for (const distance of [16, 16.2]) {
    const f = fixture(t, {}, { x: player.x + distance, y: 9, z: player.z });
    f.mob.angry = 20;
    steps(f, 1);
    assert.equal(f.mob.moving, distance > 16);
  }
  const close = fixture(t, {}, { x: 2, y: 9, z: 0.5 });
  close.mob.angry = 20;
  close.mob.attackCooldown = 0;
  steps(close, 1);
  assert.ok(close.mob.position.distanceTo(player) >= 8);
  assert.ok(close.mob.teleportCooldown > 0);
  assert.equal(close.mob.moving, false);
  assert.equal(close.attacks.length, 0);
  assert.ok(canOccupy(close.world, ...close.mob.position.toArray(), close.mob.spec));
});

test("Enderman creative, dead-player, grace and Peaceful gates prevent provocation", (t) => {
  for (const mode of ["creative", "dead", "grace", "peaceful"]) {
    const f = fixture(t);
    if (mode === "grace") f.wildlife.protectSpawn(player);
    if (mode === "peaceful") f.wildlife.context.difficulty = "peaceful";
    steps(f, 20, mode === "creative" ? { mode } : mode === "dead" ? { health: 0 } : {});
    assert.equal(f.mob.angry, 0, mode);
    assert.equal(f.mob.lookTimer, 0, mode);
    assert.equal(f.attacks.length, 0, mode);
  }
});

test("Enderman water damages before escape, remains neutral, and lands dry", (t) => {
  const f = fixture(t);
  const before = f.mob.position.clone();
  f.world.edits.set("8,9,0", BLOCK.WATER);
  steps(f, 1, { gaze: false });
  assert.equal(f.mob.health, 39);
  assert.equal(f.mob.angry, 0);
  assert.notDeepEqual(f.mob.position, before);
  assert.ok(f.mob.teleportCooldown > 0);
  assert.ok(canOccupy(f.world, ...f.mob.position.toArray(), f.mob.spec));
  steps(f, 19, { gaze: false });
  assert.equal(f.mob.health, 39);
  assert.equal(f.drops.length, 0);
});

test("Enderman trapped in water takes bounded damage and retries, never silently culls", (t) => {
  const f = fixture(t);
  for (let x = -10; x <= 28; x++)
    for (let z = -18; z <= 18; z++) f.world.edits.set(`${x},9,${z}`, BLOCK.WATER);
  let attempts = 0;
  const relocate = f.wildlife.relocate.bind(f.wildlife);
  f.wildlife.relocate = (...args) => { attempts++; return relocate(...args); };
  steps(f, 21, { gaze: false });
  assert.equal(f.mob.health, 37);
  assert.equal(f.mob.dead, false);
  assert.equal(f.wildlife.byId.get(f.mob.id), f.mob);
  assert.equal(attempts, 2);
  assert.equal(f.drops.length, 0);
  assert.equal(f.world.unloadedReads, 0);
  f.mob.health = 1;
  steps(f, 10, { gaze: false });
  assert.equal(f.mob.dead, true);
  assert.equal(f.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.wildlife.killed.has(f.mob.id), true);
  const dropped = f.drops.length;
  assert.ok(dropped > 0);
  steps(f, 20, { gaze: false });
  assert.equal(f.drops.length, dropped, "water death is committed exactly once");
});

test("Enderman teleport rejects magma, fluids, headroom obstruction and unloaded destinations", (t) => {
  for (const hazard of ["magma", "lava", "ceiling", "unloaded"]) {
    const options = hazard === "unloaded" ? { loaded: (x, z) => x === 8 && z === 0 } : {};
    const f = fixture(t, options);
    if (hazard !== "unloaded") {
      for (let x = -12; x <= 28; x++)
        for (let z = -20; z <= 20; z++)
          f.world.edits.set(`${x},${hazard === "magma" ? 8 : hazard === "lava" ? 9 : 11},${z}`,
            hazard === "magma" ? BLOCK.MAGMA_BLOCK : hazard === "lava" ? BLOCK.LAVA : BLOCK.STONE);
    }
    const before = f.mob.position.clone();
    assert.equal(f.wildlife.relocate(f.mob, f.mob.position, 4, 12), false, hazard);
    assert.deepEqual(f.mob.position, before);
    assert.equal(f.world.unloadedReads, 0);
  }
});

test("Enderman projectile contact is immune with or without a safe dodge; melee still damages", (t) => {
  for (const trapped of [false, true]) {
    const f = fixture(t, trapped ? { loaded: (x, z) => x === 8 && z === 0 } : {});
    const before = f.mob.position.clone();
    assert.equal(f.wildlife.dodgeProjectile(f.mob), true);
    assert.equal(f.mob.health, 40);
    assert.equal(f.mob.angry, 0);
    assert.equal(f.mob.hitFlash, 0);
    assert.equal(f.mob.dead, false);
    assert.equal(f.drops.length, 0);
    assert.equal(f.mob.position.equals(before), trapped);
    const randomState = f.wildlife.randomState;
    const after = f.mob.position.clone();
    assert.equal(f.wildlife.dodgeProjectile(f.mob.id), true);
    assert.deepEqual(f.mob.position, after);
    assert.equal(f.wildlife.randomState, randomState, "cooldown prevents repeated destination searches");
    const hit = f.wildlife.damage(f.mob, 6);
    assert.equal(hit.damage, 6);
    assert.equal(f.mob.health, 34);
    assert.ok(f.mob.angry > 0);
    assert.equal(f.world.unloadedReads, 0);
  }
});

test("Enderman public dodge rejects stale, dormant, dead, unloaded, wrong-dimension and disposed owners", (t) => {
  const f = fixture(t);
  const pig = f.wildlife.spawn("pig", { x: 3, y: 9, z: 0 });
  assert.equal(f.wildlife.dodgeProjectile(pig), false);
  assert.equal(f.wildlife.dodgeProjectile({ ...f.mob }), false);
  assert.equal(f.wildlife.dodgeProjectile("missing"), false);
  for (const flag of ["dormant", "dead"]) {
    f.mob[flag] = true;
    assert.equal(f.wildlife.dodgeProjectile(f.mob), false);
    f.mob[flag] = false;
  }
  f.world.isLoaded = () => false;
  assert.equal(f.wildlife.dodgeProjectile(f.mob), false);
  f.world.isLoaded = () => true;
  f.world.dimension = "nether";
  assert.equal(f.wildlife.dodgeProjectile(f.mob), false);
  f.world.dimension = "overworld";
  f.wildlife.dispose();
  assert.equal(f.wildlife.dodgeProjectile(f.mob), false);
  assert.equal(f.world.unloadedReads, 0);
});

function relocations(f) {
  const events = [];
  const relocate = f.wildlife.relocate.bind(f.wildlife);
  f.wildlife.relocate = (...args) => {
    const from = f.mob.position.clone();
    const result = relocate(...args);
    events.push({
      from, to: f.mob.position.clone(), result, at: f.wildlife.clock,
      cooldown: f.mob.teleportCooldown, recovery: f.mob.attackCooldown,
    });
    return result;
  };
  return events;
}

test("moving distant Endermen pursue with a closer bounded hop after 1.5s, not only when stuck", (t) => {
  for (const distance of [40, 64]) {
    const f = fixture(t, {}, { x: player.x + distance, y: 9, z: player.z });
    f.mob.angry = 20;
    f.mob.attackCooldown = 0;
    const events = relocations(f);
    steps(f, 29, { gaze: false });
    assert.equal(events.length, 0);
    assert.ok(f.mob.position.x < player.x + distance, "ordinary pursuit also moves");
    steps(f, 1, { gaze: false });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.result, true);
    assert.ok(Math.abs(event.at - 1.5) < 1e-9);
    assert.ok(event.to.distanceTo(player) < event.from.distanceTo(player) - 0.5);
    assert.ok(event.from.distanceTo(event.to) <= 32);
    assert.deepEqual(f.mob.position, event.to, "no stale-heading movement after teleport");
    assert.equal(f.mob.moving, false);
    assert.equal(f.mob.attackCooldown, ENDERMAN_LIMITS.recovery);
    assert.equal(f.mob.pursuitTime, 0);
    assert.equal(f.mob.blockedTime, 0);
    assert.equal(f.attacks.length, 0);
    steps(f, 10, { gaze: false });
    assert.equal(events.length, 1, "no immediate second search");
    assert.equal(f.world.unloadedReads, 0);
  }
});

test("prolonged blocked pursuit spends a cooldown even when every safe destination is unloaded", (t) => {
  const f = fixture(t, { loaded: (x, z) => x === 8 && z === 0 },
    { x: 8.3601, y: 9, z: 0.5 });
  f.mob.angry = 20;
  const events = relocations(f);
  steps(f, 29, { gaze: false });
  assert.equal(events.length, 0, "a blocked frame is not an immediate teleport");
  steps(f, 1, { gaze: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].result, false);
  assert.equal(events[0].cooldown, ENDERMAN_LIMITS.teleportCooldown);
  steps(f, 10, { gaze: false });
  assert.equal(events.length, 1);
  steps(f, 20, { gaze: false });
  assert.equal(events.length, 2);
  assert.equal(events[1].result, false);
  assert.ok(events[1].at - events[0].at >= 1.49);
  assert.equal(f.mob.dead, false);
  assert.equal(f.mob.health, 40);
  assert.equal(f.world.unloadedReads, 0);
});

test("Enderman arrival recovery prevents melee for .35s even at a legal close destination", (t) => {
  const f = fixture(t);
  f.wildlife.update(0, 0, player);
  f.mob.angry = 20;
  f.mob.attackCooldown = 0;
  assert.equal(f.wildlife.relocate(f.mob, { x: 2, y: 9, z: 0.5 }, 0, 0), true);
  assert.equal(f.mob.attackCooldown, ENDERMAN_LIMITS.recovery);
  steps(f, 6, { gaze: false });
  assert.equal(f.attacks.length, 0);
  steps(f, 2, { gaze: false });
  assert.equal(f.attacks.length, 1, "melee resumes reliably after recovery");
});

test("an Enderman recovers prolonged blocked navigation into a safe closer loaded site", (t) => {
  const f = fixture(t);
  for (const x of [7, 9]) wall(f.world, x);
  for (const z of [-1, 1])
    for (let y = 9; y <= 13; y++) f.world.edits.set(`8,${y},${z}`, BLOCK.STONE);
  f.mob.angry = 20;
  const events = relocations(f);
  steps(f, 40, { gaze: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].result, true);
  assert.ok(events[0].at >= ENDERMAN_LIMITS.blockedDelay);
  assert.ok(events[0].to.distanceTo(player) < events[0].from.distanceTo(player));
  assert.ok(events[0].to.distanceTo(events[0].from) <= ENDERMAN_LIMITS.maxHop);
  assert.ok(canOccupy(f.world, ...events[0].to.toArray(), f.mob.spec));
  assert.equal(f.attacks.length, 0);
  assert.equal(f.world.unloadedReads, 0);
});

test("Enderman hurt delays counterattack without immunity or random melee dodging", (t) => {
  const f = fixture(t, {}, { x: 2, y: 9, z: 0.5 });
  f.mob.attackCooldown = 0;
  const events = relocations(f);
  const before = f.mob.position.clone();
  assert.equal(f.wildlife.damage(f.mob, 6).damage, 6);
  assert.equal(f.wildlife.damage(f.mob, 6).damage, 6);
  assert.equal(f.mob.health, 28, "general hurt immunity is deliberately unchanged");
  steps(f, 1, { gaze: false });
  assert.equal(f.attacks.length, 0);
  assert.ok(f.mob.hitFlash > 0);
  steps(f, 5, { gaze: false });
  assert.equal(f.attacks.length, 0);
  steps(f, 2, { gaze: false });
  assert.equal(f.attacks.length, 1);
  assert.equal(events.length, 0);
  assert.deepEqual(f.mob.position, before);
});

test("every Enderman relocation is capped at 32 blocks and rejects the physical player body", (t) => {
  for (const destination of [
    { x: 41.5, y: 9, z: 0.5 },
    { x: 0.5, y: 9, z: 0.5 },
    { x: 1.1, y: 9, z: 1.1 },
  ]) {
    const f = fixture(t);
    f.wildlife.update(0, 0, player);
    const before = f.mob.position.clone();
    assert.equal(f.wildlife.relocate(f.mob, destination, 0, 0), false);
    assert.deepEqual(f.mob.position, before);
    assert.equal(f.mob.teleportCooldown, ENDERMAN_LIMITS.teleportCooldown);
    const randomState = f.wildlife.randomState;
    assert.equal(f.wildlife.relocate(f.mob, destination, 0, 0), false);
    assert.equal(f.wildlife.randomState, randomState, "raw relocation cannot bypass a failed-search cooldown");
  }
  const exact = fixture(t);
  exact.wildlife.update(0, 0, player);
  const before = exact.mob.position.clone();
  assert.equal(exact.wildlife.relocate(exact.mob, { x: 40.5, y: 9, z: 0.5 }, 0, 0), true);
  assert.equal(exact.mob.position.distanceTo(before), 32);
  assert.ok(canOccupy(exact.world, ...exact.mob.position.toArray(), exact.mob.spec));
});

test("close gaze owns the whole teleport step even with a fully charged pursuit timer", (t) => {
  const f = fixture(t, {}, { x: 2, y: 9, z: 0.5 });
  Object.assign(f.mob, { angry: 20, attackCooldown: 0, pursuitTime: 1.5, blockedTime: 1.5 });
  const events = relocations(f);
  steps(f, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, true);
  assert.deepEqual(f.mob.position, events[0].to);
  assert.equal(f.mob.pursuitTime, 0);
  assert.equal(f.mob.blockedTime, 0);
  assert.equal(f.mob.moving, false);
  assert.equal(f.attacks.length, 0);
});

test("Enderman save/load preserves anger and pose but safely resets pending runtime work", (t) => {
  for (const distance of [1.5, 40]) {
    const f = fixture(t, {}, { x: player.x + distance, y: 9, z: player.z });
    Object.assign(f.mob, {
      angry: 19, health: 28, attackCooldown: 0, lookTimer: 0.2, hitFlash: 0.2,
      pursuitTime: 1.45, blockedTime: 1.45, waterDamageCooldown: 0.4,
    });
    const original = f.mob;
    const saved = f.wildlife.serialize();
    for (const field of ["pursuitTime", "blockedTime", "lookTimer", "waterDamageCooldown", "teleportCooldown", "restoreAttackCooldown"])
      assert.equal(Object.hasOwn(saved.entities[0], field), false, "no save schema changes");
    assert.equal(f.wildlife.load(saved), true);
    f.mob = f.wildlife.byId.get(original.id);
    assert.notEqual(f.mob, original);
    assert.equal(original.dead, true);
    assert.equal(f.mob.angry, 19);
    assert.equal(f.mob.health, 28);
    assert.deepEqual(f.mob.position.toArray(), original.position.toArray());
    assert.equal(f.mob.root.rotation.y, original.root.rotation.y);
    assert.equal(f.mob.lookTimer, 0);
    assert.equal(f.mob.hitFlash, 0);
    assert.equal(f.mob.pursuitTime, 0);
    assert.equal(f.mob.blockedTime, 0);
    assert.equal(f.mob.waterDamageCooldown, 0);
    assert.equal(f.mob.teleportCooldown, ENDERMAN_LIMITS.teleportCooldown);
    assert.equal(f.mob.attackCooldown, 0);
    assert.equal(f.mob.restoreAttackCooldown, ENDERMAN_LIMITS.recovery);
    assert.deepEqual(f.wildlife.serialize(), saved);
    const events = relocations(f);
    steps(f, 6, { gaze: false });
    assert.equal(f.attacks.length, 0);
    assert.equal(events.length, 0);
    if (distance > 16) {
      steps(f, 23, { gaze: false });
      assert.equal(events.length, 0);
      steps(f, 1, { gaze: false });
      assert.equal(events.length, 1, "pursuit must earn a new 1.5s warmup after load");
    } else {
      steps(f, 2, { gaze: false });
      assert.equal(f.attacks.length, 1);
    }
  }
});

test("Peaceful, grace, creative and player death discard anger and pending attacks before resume", (t) => {
  for (const gate of ["peaceful", "grace", "creative", "dead"]) {
    const f = fixture(t, {}, { x: 2, y: 9, z: 0.5 });
    Object.assign(f.mob, {
      angry: 20, attackCooldown: 0, pursuitTime: 1.49, blockedTime: 1.49, lookTimer: 0.24,
    });
    const events = relocations(f);
    if (gate === "peaceful") f.wildlife.context.difficulty = "peaceful";
    if (gate === "grace") f.wildlife.protectSpawn(player);
    steps(f, 1, { gaze: false, ...(gate === "creative" ? { mode: "creative" } : gate === "dead" ? { health: 0 } : {}) });
    assert.equal(f.mob.angry, 0, gate);
    assert.equal(f.mob.lookTimer, 0, gate);
    assert.equal(f.mob.pursuitTime, 0, gate);
    assert.equal(f.mob.blockedTime, 0, gate);
    assert.equal(f.mob.attacking, false, gate);
    assert.equal(f.attacks.length, 0, gate);
    f.wildlife.context.difficulty = "normal";
    f.wildlife.endSpawnProtection();
    steps(f, 40, { gaze: false });
    assert.equal(f.attacks.length, 0, `no queued attack after ${gate}`);
    assert.equal(events.length, 0);
    f.wildlife.damage(f.mob, 1);
    steps(f, 8, { gaze: false });
    assert.equal(f.attacks.length, 1, `fresh retaliation remains reliable after ${gate}`);
  }
});

test("failed-support recovery uses the Enderman retry budget and retains the live identity", (t) => {
  const f = fixture(t);
  const get = f.world.get;
  f.world.get = () => BLOCK.AIR;
  const events = relocations(f);
  steps(f, 20, { gaze: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].result, false);
  assert.equal(events[0].cooldown, ENDERMAN_LIMITS.teleportCooldown);
  assert.equal(f.mob.dead, false);
  assert.equal(f.mob.health, 40);
  assert.equal(f.wildlife.byId.get(f.mob.id), f.mob);
  assert.equal(f.wildlife.killed.has(f.mob.id), false);
  steps(f, 1, { gaze: false });
  assert.equal(events.length, 2);
  assert.equal(f.drops.length, 0);
  f.world.get = get;
  steps(f, 1, { gaze: false });
  assert.equal(f.mob.dead, false);
  assert.equal(f.mob.position.y, 9);
  assert.equal(f.world.unloadedReads, 0);
});
