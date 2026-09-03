import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { isHostileSpecies } from "../src/mob-species.js";
import { advance, ecosystem, flatWorld } from "./mob-fixtures.js";

const player = new THREE.Vector3(0.5, 9, 0.5);
const still = (mob) => {
  assert.ok(mob);
  mob.walking = false;
  mob.wanderTimer = 100;
  return mob;
};

test("natural hostile births respect the 24-block radius after cell jitter in every dimension", (t) => {
  // Regression: actual births previously appeared just 13 blocks away.
  for (const [dimension, biome] of [
    ["overworld", "plains"],
    ["nether", "nether_wastes"],
    ["end", "the_end"],
  ]) {
    for (const [x, z] of [
      [0.5, 0.5],
      [-159.75, -160.25],
    ]) {
      const wildlife = ecosystem(flatWorld({ dimension, biome }));
      t.after(() => wildlife.dispose());
      const position = new THREE.Vector3(x, 9, z);
      wildlife.update(0, 0, position, { mode: "survival", timeOfDay: 0 });
      for (let i = 0; i < 24; i++) wildlife.populate();
      const hostiles = wildlife.entities.filter((mob) =>
        isHostileSpecies(mob.spec)
      );
      assert.ok(hostiles.length > 0, `${dimension}: encounters still spawn`);
      for (const mob of hostiles) {
        assert.ok(
          mob.position.distanceTo(position) >= 24,
          `${dimension} ${mob.kind}: actual birth ${mob.position.toArray()}`
        );
      }
      if (dimension === "overworld") {
        assert.ok(
          wildlife.entities.some(
            (mob) =>
              !isHostileSpecies(mob.spec) &&
              mob.position.distanceTo(position) < 24
          ),
          "the hostile exclusion does not push friendly animals away"
        );
      }
    }
  }
});

test("spawn cleanup is local, calms neutral mobs, and conserves pets, owned blocks, and loot", (t) => {
  const drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (...drop) => drops.push(drop),
  });
  t.after(() => wildlife.dispose());
  const spawn = (kind, dx, dz = 0) =>
    still(wildlife.spawn(kind, { x: player.x + dx, y: 9, z: player.z + dz }));
  const nearby = spawn("zombie", 1.2);
  const inside = spawn("zombie", 23.9);
  const boundary = spawn("zombie", 24);
  const distant = spawn("enderman", 30);
  distant.angry = 17;
  distant.lookTimer = 0.5;
  distant.attackCooldown = 0;
  const enderman = spawn("enderman", -1.2);
  enderman.angry = 20;
  enderman.lookTimer = 0.6;
  enderman.attacking = true;
  enderman.attackCooldown = 0;
  const wolf = spawn("wolf", 5);
  wolf.angry = 20;
  const pet = spawn("wolf", 7, 3);
  pet.tamed = true;
  pet.health = 11;
  pet.followTime = 10;
  const sheep = spawn("sheep", 10, -3);
  const cube = spawn("sulfur_cube", -5, -3);
  assert.equal(wildlife.interact(cube, BLOCK.STONE), true);
  const creeper = spawn("creeper", 6, 6);
  creeper.fuse = 1.6;
  const skeleton = spawn("skeleton", 10, 5);
  wildlife.update(0, 0, player, { mode: "survival", timeOfDay: 0 });
  wildlife.shoot(skeleton);
  assert.equal(wildlife.projectiles.length, 1);
  wildlife.defendTarget = nearby.id;
  wildlife.defendUntil = 8;
  wildlife.rememberKilled("previously-killed");
  const before = wildlife.serialize();

  assert.equal(wildlife.protectSpawn(player), true);
  for (const mob of [nearby, inside, creeper, skeleton]) {
    assert.equal(wildlife.byId.has(mob.id), false);
    assert.equal(wildlife.killed.has(mob.id), false);
    assert.equal(wildlife.damage(mob, 100).hit, false);
  }
  for (const mob of [boundary, distant, pet, sheep, cube]) {
    assert.equal(wildlife.byId.get(mob.id), mob);
    assert.deepEqual(
      wildlife.serialize().entities.find(({ id }) => id === mob.id),
      before.entities.find(({ id }) => id === mob.id)
    );
  }
  for (const mob of [enderman, wolf]) {
    assert.equal(wildlife.byId.get(mob.id), mob);
    assert.equal(mob.angry, 0);
    assert.equal(mob.lookTimer, 0);
    assert.equal(mob.attacking, false);
    assert.ok(mob.attackCooldown > 0);
  }
  assert.equal(pet.followTime, 10);
  assert.equal(distant.lookTimer, 0.5);
  assert.equal(wildlife.projectiles.length, 0);
  assert.equal(wildlife.defendTarget, null);
  assert.equal(wildlife.defendUntil, 0);
  assert.deepEqual([...wildlife.killed], ["previously-killed"]);
  assert.deepEqual(drops, [], "safety cleanup cannot be farmed for death loot");
  const restored = ecosystem(flatWorld());
  t.after(() => restored.dispose());
  assert.equal(restored.load(wildlife.serialize()), true);
  assert.equal(restored.byId.get(enderman.id).angry, 0);
  assert.equal(restored.byId.get(pet.id).tamed, true);
  assert.equal(restored.byId.get(cube.id).absorbedBlock, BLOCK.STONE);
  wildlife.damage(cube, 100);
  wildlife.damage(cube, 100);
  assert.deepEqual(
    drops.map(([id, count]) => ({ id, count })),
    [{ id: BLOCK.STONE, count: 1 }],
    "the retained, player-fed block is returned exactly once"
  );
});

test("eight seconds of simulated mob grace suppress attacks, shots, fuses, and wolf retaliation", (t) => {
  const attacks = [];
  const explosions = [];
  const wildlife = ecosystem(flatWorld(), {
    onDamage: (...attack) => attacks.push(attack),
    onExplode: (...explosion) => explosions.push(explosion),
  });
  t.after(() => wildlife.dispose());
  wildlife.update(0, 0, player, { mode: "survival", timeOfDay: 0 });
  wildlife.protectSpawn(player);
  // Authored arrivals bypass the natural birth rule, proving grace itself works.
  const zombie = still(wildlife.spawn("zombie", { x: 1.7, y: 9, z: 0.5 }));
  const skeleton = still(wildlife.spawn("skeleton", { x: 8.5, y: 9, z: 0.5 }));
  const creeper = still(wildlife.spawn("creeper", { x: 0.5, y: 9, z: 2.5 }));
  const pet = still(wildlife.spawn("wolf", { x: 3.5, y: 9, z: 0.5 }));
  pet.tamed = true;
  zombie.angry = 20;
  zombie.attackCooldown = skeleton.attackCooldown = 0;
  creeper.fuse = 1.6;
  wildlife.defendTarget = zombie.id;
  wildlife.defendUntil = 20;

  wildlife.damagePlayer(10, "Zombie", zombie);
  wildlife.shoot(skeleton);
  wildlife.explodeMob(creeper, 3.2);
  assert.equal(wildlife.wolfTarget(pet), null);
  assert.equal(creeper.dead, false);
  advance(wildlife, 7.9, player);
  assert.ok(wildlife.spawnGrace > 0 && wildlife.spawnGrace < 0.11);
  assert.equal(zombie.health, 20, "the pet has not restarted the old fight");
  assert.equal(zombie.attacking, false);
  assert.equal(creeper.fuse, 0);
  assert.equal(wildlife.projectiles.length, 0);
  assert.deepEqual(attacks, []);
  assert.deepEqual(explosions, []);
  for (let i = 0; i < 300; i++)
    wildlife.update(0, 1000 + i, player, { mode: "survival", timeOfDay: 0 });
  assert.ok(wildlife.spawnGrace > 0, "wall-clock time on menus is irrelevant");

  advance(wildlife, 0.1, player);
  assert.equal(wildlife.spawnGrace, 0);
  assert.ok(attacks.some(([, cause]) => cause === "Zombie"));
  assert.ok(creeper.fuse > 0);
  assert.ok(wildlife.projectiles.length > 0);
  assert.ok(wildlife.wolfTarget(pet));
  advance(wildlife, 1.7, player);
  assert.equal(explosions.length, 1, "ordinary creeper combat resumes");
});

test("Nether fireballs are discarded during grace without terrain or loot side effects", (t) => {
  const attacks = [];
  const explosions = [];
  const drops = [];
  const wildlife = ecosystem(
    flatWorld({ dimension: "nether", biome: "nether_wastes" }),
    {
      onDamage: (...args) => attacks.push(args),
      onExplode: (...args) => explosions.push(args),
      onDrop: (...args) => drops.push(args),
    }
  );
  t.after(() => wildlife.dispose());
  const ghast = still(wildlife.spawn("ghast", { x: 30.5, y: 14, z: 0.5 }));
  wildlife.update(0, 0, player, { mode: "survival" });
  wildlife.shoot(ghast);
  const inFlight = wildlife.projectiles[0];
  assert.ok(inFlight);
  wildlife.protectSpawn(player);
  assert.equal(
    wildlife.byId.get(ghast.id),
    ghast,
    "distant encounters survive"
  );
  // Even an in-flight shot injected after the transition must not hit/explode.
  wildlife.projectiles.push(inFlight);
  wildlife.updateProjectiles(0.1);
  wildlife.explosion(player, 3, ghast);
  wildlife.shoot(ghast);
  assert.equal(wildlife.projectiles.length, 0);
  assert.deepEqual([attacks, explosions, drops], [[], [], []]);
  wildlife.endSpawnProtection();
  wildlife.shoot(ghast);
  assert.equal(wildlife.projectiles.length, 1, "ranged combat is not disabled");
});
