import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { mobEye } from "../src/mob-ai.js";
import { MAX_PROJECTILES } from "../src/mob-species.js";
import { advance, ecosystem, flatWorld, wall } from "./mob-fixtures.js";

const player = new THREE.Vector3(0, 9, 0);

test("hostiles really chase and melee attacks obey their cooldown", () => {
  const attacks = [];
  const wildlife = ecosystem(flatWorld(), {
    onDamage: (...event) => attacks.push(event),
  });
  const zombie = wildlife.spawn("zombie", { x: 7, y: 9, z: 0 });
  advance(wildlife, 3, player);
  assert.ok(zombie.position.x < 3, "chase changes world-space position");
  assert.equal(attacks.length, 0);
  advance(wildlife, 2, player);
  assert.ok(attacks.length > 0);
  assert.equal(attacks[0][1], "Zombie");
  const before = attacks.length;
  zombie.attackCooldown = zombie.spec.cooldown;
  advance(wildlife, zombie.spec.cooldown - 0.2, player);
  assert.equal(attacks.length, before);
  advance(wildlife, 0.3, player);
  assert.equal(attacks.length, before + 1);
  wildlife.dispose();
});

test("solid cover and vertical separation prevent melee damage", () => {
  const world = flatWorld();
  const attacks = [];
  const wildlife = ecosystem(world, {
    onDamage: (...event) => attacks.push(event),
  });
  wildlife.spawn("zombie", { x: 4, y: 9, z: 0 });
  wall(world, 2);
  advance(wildlife, 2, player);
  assert.equal(attacks.length, 0);
  world.edits.clear();
  advance(wildlife, 2, new THREE.Vector3(4, 20, 0));
  assert.equal(attacks.length, 0);
  wildlife.dispose();
});

test("a creeper beneath an elevated player chases without incorrectly lighting its fuse", () => {
  const explosions = [];
  const wildlife = ecosystem(flatWorld(), {
    onExplode: (...args) => explosions.push(args),
  });
  const creeper = wildlife.spawn("creeper", { x: 1, y: 9, z: 0 });
  advance(wildlife, 3, new THREE.Vector3(0, 15, 0));
  assert.equal(creeper.fuse, 0);
  assert.equal(explosions.length, 0);
  wildlife.dispose();
});

test("creative players and dead players cannot be attacked, shot, or exploded", () => {
  for (const environment of [
    { mode: "creative" },
    { mode: "survival", health: 0 },
  ]) {
    const attacks = [],
      explosions = [];
    const wildlife = ecosystem(flatWorld(), {
      onDamage: (...event) => attacks.push(event),
      onExplode: (...event) => explosions.push(event),
    });
    wildlife.spawn("zombie", { x: 1, y: 9, z: 0 });
    wildlife.spawn("skeleton", { x: 4, y: 9, z: 0 });
    const creeper = wildlife.spawn("creeper", { x: 2, y: 9, z: 0 });
    creeper.fuse = 1.6;
    advance(wildlife, 4, player, environment);
    assert.equal(attacks.length, 0);
    assert.equal(explosions.length, 0);
    assert.equal(wildlife.projectiles.length, 0);
    assert.equal(creeper.fuse, 0);
    wildlife.dispose();
  }
});

test("hits flash the batched model, knock the mob back, and make passive mobs flee", () => {
  const wildlife = ecosystem();
  const pig = wildlife.spawn("pig", { x: 2, y: 9, z: 0 });
  wildlife.update(0, 0, player);
  const oldColor = new THREE.Color();
  wildlife.mesh.getColorAt(0, oldColor);
  const start = pig.position.clone();
  wildlife.damage(pig, 2, { x: 1, y: 0, z: 0 });
  advance(wildlife, 0.1, player);
  assert.ok(pig.position.x > start.x);
  assert.ok(pig.position.y > start.y);
  assert.ok(pig.fleeTime > 0 && pig.hitFlash > 0 && pig.knockback.x > 0);
  const newColor = new THREE.Color();
  wildlife.mesh.getColorAt(0, newColor);
  assert.notDeepEqual(newColor.toArray(), oldColor.toArray());
  advance(wildlife, 1, player);
  assert.ok(pig.position.x > start.x + 1);
  assert.equal(pig.position.y, pig.groundY);
  assert.equal(pig.hitFlash, 0);
  wildlife.dispose();
});

test("sunlight burns exposed undead but not sheltered undead or desert husks", () => {
  const exposed = ecosystem();
  const zombie = exposed.spawn("zombie", { x: 2, y: 9, z: 0 });
  const husk = exposed.spawn("husk", { x: 7, y: 9, z: 0 });
  advance(exposed, 2.2, player, { timeOfDay: 0.5, mode: "creative" });
  assert.ok(zombie.burning && zombie.health < zombie.spec.health);
  assert.equal(husk.health, husk.spec.health);
  const roof = flatWorld();
  for (let x = -5; x < 10; x++)
    for (let z = -5; z < 5; z++) roof.edits.set(`${x},14,${z}`, BLOCK.STONE);
  const sheltered = ecosystem(roof);
  const skeleton = sheltered.spawn("skeleton", { x: 2, y: 9, z: 0 });
  advance(sheltered, 3, player, { timeOfDay: 0.5, mode: "creative" });
  assert.equal(skeleton.burning, false);
  assert.equal(skeleton.health, skeleton.spec.health);
  exposed.dispose();
  sheltered.dispose();
});

test("skeleton arrows have travel time, hit the player, and obey a bounded projectile budget", () => {
  const attacks = [];
  const wildlife = ecosystem(flatWorld(), {
    onDamage: (...event) => attacks.push(event),
  });
  wildlife.spawn("skeleton", { x: 8, y: 9, z: 0 });
  advance(wildlife, 0.7, player);
  assert.ok(wildlife.projectiles.length > 0);
  assert.equal(attacks.length, 0, "ranged damage is not a hitscan shortcut");
  advance(wildlife, 1, player);
  assert.equal(attacks.length, 1);
  assert.match(attacks[0][1], /arrow/);
  const archer = wildlife.entities[0];
  for (let i = 0; i < 50; i++) wildlife.shoot(archer);
  assert.equal(wildlife.projectiles.length, MAX_PROJECTILES);
  advance(wildlife, 0.1, player, { mode: "creative" });
  assert.equal(wildlife.projectiles.length, 0);
  wildlife.dispose();
});

test("arrows collide with newly built cover before reaching the player", () => {
  const world = flatWorld();
  const attacks = [];
  const wildlife = ecosystem(world, {
    onDamage: (...event) => attacks.push(event),
  });
  wildlife.spawn("skeleton", { x: 8, y: 9, z: 0 });
  advance(wildlife, 0.7, player);
  assert.ok(wildlife.projectiles.length > 0);
  wall(world, 4);
  advance(wildlife, 1, player);
  assert.equal(attacks.length, 0);
  assert.equal(wildlife.projectiles.length, 0);
  wildlife.dispose();
});

test("creeper fuse cancels on escape and detonates once, with bounded radius and no death loot", () => {
  const explosions = [],
    attacks = [],
    drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onExplode: (...event) => explosions.push(event),
    onDamage: (...event) => attacks.push(event),
    onDrop: (...event) => drops.push(event),
  });
  const creeper = wildlife.spawn("creeper", { x: 2.2, y: 9, z: 0 });
  advance(wildlife, 0.8, player);
  assert.ok(creeper.fuse > 0.5);
  advance(wildlife, 0.6, new THREE.Vector3(-6, 9, 0));
  assert.equal(creeper.fuse, 0);
  assert.equal(explosions.length, 0);
  const nearby = new THREE.Vector3(
    creeper.position.x - 2,
    9,
    creeper.position.z
  );
  advance(wildlife, 2, nearby);
  assert.equal(explosions.length, 1);
  assert.ok(explosions[0][1] > 0 && explosions[0][1] < 4);
  assert.ok(attacks.length > 0);
  assert.equal(drops.length, 0);
  assert.equal(creeper.dead, true);
  advance(wildlife, 3, nearby);
  assert.equal(explosions.length, 1);
  wildlife.dispose();
});

test("killing a fusing creeper disarms it and yields gunpowder instead of a delayed explosion", () => {
  const explosions = [],
    drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onExplode: (...event) => explosions.push(event),
    onDrop: (...event) => drops.push(event),
  });
  const creeper = wildlife.spawn("creeper", { x: 2, y: 9, z: 0 });
  advance(wildlife, 0.7, player);
  assert.ok(creeper.fuse > 0);
  wildlife.damage(creeper, 100);
  advance(wildlife, 3, player);
  assert.equal(explosions.length, 0);
  assert.ok(drops.some(([id]) => id === ITEM.GUNPOWDER));
  wildlife.dispose();
});

test("ghasts hover and launch moving fireballs that reach the explosion callback", () => {
  const world = flatWorld({ dimension: "nether", biome: "nether_wastes" });
  const explosions = [],
    attacks = [];
  const wildlife = ecosystem(world, {
    onExplode: (...event) => explosions.push(event),
    onDamage: (...event) => attacks.push(event),
  });
  const ghast = wildlife.spawn("ghast", { x: 10, y: 13, z: 0 });
  advance(wildlife, 0.8, player);
  assert.ok(wildlife.projectiles.some((shot) => shot.kind === "fireball"));
  assert.ok(
    ghast.position.y > 13,
    "flight follows a safe altitude rather than ground gravity"
  );
  advance(wildlife, 2.5, player);
  assert.equal(explosions.length, 1);
  assert.ok(attacks.length > 0);
  assert.ok(wildlife.projectiles.length <= MAX_PROJECTILES);
  wildlife.dispose();
});

test("endermen stay neutral until a sustained visible stare; creative staring is harmless", () => {
  const wildlife = ecosystem();
  const enderman = wildlife.spawn("enderman", { x: 6, y: 9, z: 0 });
  enderman.walking = false;
  enderman.wanderTimer = 100;
  advance(wildlife, 0.8, player, { playerForward: { x: -1, y: 0, z: 0 } });
  assert.equal(enderman.angry, 0);
  const forward = { x: 6, y: mobEye(enderman).y - player.y - 1.45, z: 0 };
  advance(wildlife, 0.8, player, { playerForward: forward });
  assert.ok(enderman.angry > 0);
  assert.equal(enderman.position.x, 6, "an angry Enderman freezes while stared at");
  const attacks = [];
  wildlife.onDamage = (...event) => attacks.push(event);
  advance(wildlife, 4, player, { mode: "creative", playerForward: forward });
  assert.equal(attacks.length, 0);
  wildlife.dispose();
});

test("Enderman staring uses a distance-dependent physical eye tolerance", (t) => {
  const eye = player.clone().add(new THREE.Vector3(0, 1.62, 0));
  for (const distance of [4, 12, 18]) {
    for (const degrees of [0, 2, 8, 11, 14]) {
      const wildlife = ecosystem();
      t.after(() => wildlife.dispose());
      const enderman = wildlife.spawn("enderman", { x: 0, y: 9, z: distance });
      enderman.walking = false;
      enderman.wanderTimer = 100;
      const forward = new THREE.Vector3()
        .copy(mobEye(enderman))
        .sub(eye)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), (degrees * Math.PI) / 180);
      advance(wildlife, 0.7, player, {
        timeOfDay: 0.5,
        playerEye: eye,
        playerForward: forward,
      });
      // The eye-direction tolerance narrows with distance; wide glances miss.
      const hitsHead = degrees === 0 || degrees === 2;
      assert.equal(
        enderman.angry > 0,
        hitsHead,
        `${degrees} degrees off crosshair at ${distance} blocks`
      );
    }
  }
});

test("Enderman stare uses physical eyes, rejects the torso and cover, and requires continuous aim", (t) => {
  const world = flatWorld();
  const wildlife = ecosystem(world);
  t.after(() => wildlife.dispose());
  const enderman = wildlife.spawn("enderman", { x: 6, y: 9, z: 0 });
  enderman.walking = false;
  enderman.wanderTimer = 100;
  enderman.root.rotation.y = 0.7;
  enderman.model.head.rotation.y = 0.4;
  const eye = player.clone().add(new THREE.Vector3(0, 1.62, 0));
  const atHeight = (height) => new THREE.Vector3(6, height - 1.62, 0);
  const look = (forward, seconds) =>
    advance(wildlife, seconds, player, {
      timeOfDay: 0.5,
      playerEye: eye,
      playerForward: forward,
    });
  look(atHeight(2.1), 0.8);
  assert.equal(enderman.angry, 0, "looking at its torso is not a stare");
  const lowerHead = atHeight(2.64);
  look(lowerHead, 0.2);
  assert.ok(
    enderman.lookTimer > 0,
    "actual camera height matters near the head edge"
  );
  look({ x: -1, y: 0, z: 0 }, 0.1);
  assert.equal(enderman.lookTimer, 0);
  look(lowerHead, 0.2);
  assert.equal(enderman.angry, 0, "separate brief glances cannot accumulate");
  wall(world, 3);
  look(lowerHead, 0.8);
  assert.equal(enderman.angry, 0);
  assert.equal(enderman.lookTimer, 0);
  world.edits.clear();
  look(atHeight(2.855), 0.7);
  assert.ok(
    enderman.angry > 0,
    "a sustained visible head stare still provokes"
  );
});

test("grace prevents Enderman stare buildup but leaves later stares and hit retaliation intact", (t) => {
  const wildlife = ecosystem();
  t.after(() => wildlife.dispose());
  wildlife.update(0, 0, player, { mode: "survival", timeOfDay: 0.5 });
  const enderman = wildlife.spawn("enderman", { x: 6, y: 9, z: 0 });
  enderman.walking = false;
  enderman.wanderTimer = 100;
  const forward = { x: 6, y: mobEye(enderman).y - player.y - 1.45, z: 0 };
  wildlife.protectSpawn(player);
  advance(wildlife, 7.9, player, { timeOfDay: 0.5, playerForward: forward });
  assert.equal(enderman.angry, 0);
  assert.equal(enderman.lookTimer, 0);
  advance(wildlife, 0.2, player, { timeOfDay: 0.5, playerForward: forward });
  assert.equal(enderman.angry, 0, "no deferred stare from the grace period");
  advance(wildlife, 0.2, player, { timeOfDay: 0.5, playerForward: forward });
  assert.ok(enderman.angry > 0);
  enderman.angry = 0;
  enderman.lookTimer = 0;
  wildlife.damage(enderman, 1);
  advance(wildlife, 0.1, player, {
    timeOfDay: 0.5,
    playerForward: { x: -1, y: 0, z: 0 },
  });
  assert.ok(
    enderman.angry > 0,
    "daylight does not erase ordinary hit retaliation"
  );
});

test("wolves accept bones, heal with meat, follow, defend, and catch up safely after travel", () => {
  const wildlife = ecosystem();
  const wolf = wildlife.spawn("wolf", { x: 7, y: 9, z: 0 });
  assert.equal(wildlife.interact(wolf, ITEM.STICK), false);
  assert.equal(wildlife.interact(wolf, ITEM.BONE), true);
  assert.ok(wolf.tamed);
  assert.equal(wildlife.interact(wolf, ITEM.BONE), false);
  wildlife.damage(wolf, 5);
  assert.equal(wildlife.interact(wolf, ITEM.RAW_BEEF), true);
  assert.equal(wolf.health, wolf.spec.health);
  assert.equal(wildlife.interact(wolf, ITEM.RAW_BEEF), false);
  advance(wildlife, 2, player, { mode: "creative" });
  assert.ok(wolf.position.distanceTo(player) < 5);
  const zombie = wildlife.spawn("zombie", {
    x: wolf.position.x + 2,
    y: 9,
    z: 0,
  });
  wildlife.damage(zombie, 1);
  const injured = zombie.health;
  advance(wildlife, 2, player);
  assert.ok(
    zombie.dead || zombie.health < injured,
    "a tamed wolf actively bites the player's attacker"
  );
  const destination = new THREE.Vector3(1000, 9, -1000);
  advance(wildlife, 0.1, destination, { mode: "creative" });
  assert.ok(!wolf.dead && wolf.position.distanceTo(destination) < 6);
  assert.equal(wolf.position.y, 9);
  wildlife.dispose();
});

test("daytime spiders remain neutral until attacked while slimes physically hop", () => {
  const attacks = [];
  const wildlife = ecosystem(flatWorld(), {
    onDamage: (...event) => attacks.push(event),
  });
  const spider = wildlife.spawn("spider", { x: 1.4, y: 9, z: 0 });
  spider.walking = false;
  spider.wanderTimer = 100;
  advance(wildlife, 1, player, { timeOfDay: 0.5 });
  assert.equal(attacks.length, 0);
  wildlife.damage(spider, 1);
  advance(wildlife, 0.2, player, { timeOfDay: 0.5 });
  assert.ok(attacks.length > 0);
  const slime = wildlife.spawn("slime", { x: 7, y: 9, z: 0 });
  advance(wildlife, 0.3, player);
  assert.ok(slime.position.x < 7 && slime.position.y > slime.groundY);
  wildlife.dispose();
});
