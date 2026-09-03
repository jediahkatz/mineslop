import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  applyGravity,
  canOccupy,
  groundAt,
  moveMob,
  waterHome,
} from "../src/mob-navigation.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { advance, ecosystem, flatWorld } from "./mob-fixtures.js";

test("movement crosses real positive and negative chunk seams, but never enters missing chunks", () => {
  for (const [boundary, start] of [
    [16, 15],
    [0, -1],
  ]) {
    let open = false;
    const world = flatWorld({ loaded: (x) => open || x < boundary });
    const wildlife = ecosystem(world);
    const rabbit = wildlife.spawn("rabbit", { x: start, y: 9, z: 0.5 });
    assert.ok(rabbit);
    moveMob(world, rabbit, 2, 0);
    assert.ok(rabbit.position.x + rabbit.spec.radius < boundary);
    assert.equal(world.unloadedReads, 0);
    open = true;
    assert.equal(moveMob(world, rabbit, 2, 0), true);
    assert.ok(rabbit.position.x > boundary);
    assert.equal(rabbit.position.y, 9);
    wildlife.dispose();
  }
});

test("a one-block rise is navigable while a cliff and overhead obstruction are rejected", () => {
  const rising = flatWorld({ terrain: (x) => (x >= 2 ? 9 : 8) });
  const wildlife = ecosystem(rising);
  const rabbit = wildlife.spawn("rabbit", { x: 1.5, y: 9, z: 0.5 });
  assert.equal(moveMob(rising, rabbit, 1.2, 0), true);
  assert.ok(rabbit.position.x > 2);
  assert.equal(rabbit.position.y, 10);
  assert.ok(
    canOccupy(
      rising,
      rabbit.position.x,
      rabbit.position.y,
      rabbit.position.z,
      rabbit.spec
    )
  );
  wildlife.dispose();

  const cliff = flatWorld({ terrain: (x) => (x >= 2 ? 2 : 8) });
  const animals = ecosystem(cliff);
  const sheep = animals.spawn("rabbit", { x: 1.5, y: 9, z: 0.5 });
  moveMob(cliff, sheep, 1.2, 0);
  assert.ok(sheep.position.x + sheep.spec.radius < 2);
  assert.equal(sheep.position.y, 9);
  cliff.edits.set("0,10,0", BLOCK.STONE);
  assert.equal(groundAt(cliff, 0.5, 0.5, MOB_SPECIES.rabbit), null);
  animals.dispose();
});

test("mining away support produces gravity onto loaded lower ground, not levitation", () => {
  const world = flatWorld();
  const wildlife = ecosystem(world);
  const rabbit = wildlife.spawn("rabbit", { x: 0.5, y: 9, z: 0.5 });
  world.edits.set("0,8,0", BLOCK.AIR);
  world.edits.set("0,7,0", BLOCK.AIR);
  for (let i = 0; i < 20; i++)
    assert.equal(applyGravity(world, rabbit, 0.05), true);
  assert.equal(rabbit.position.y, 7);
  assert.equal(rabbit.velocityY, 0);
  wildlife.dispose();
});

test("deep water supports swimming models; shallow puddles and dry land do not", () => {
  const deep = flatWorld({ biome: "river", water: (x) => (x < 0 ? 14 : -1) });
  const shallow = flatWorld({ biome: "river", water: () => 9 });
  const y = waterHome(deep, -3, 0, MOB_SPECIES.squid);
  assert.ok(y > 9);
  assert.equal(waterHome(shallow, 0, 0, MOB_SPECIES.squid), null);
  assert.equal(waterHome(flatWorld(), 0, 0, MOB_SPECIES.cod), null);
  const wildlife = ecosystem(deep);
  const squid = wildlife.spawn("squid", { x: -3, y, z: 0 });
  assert.ok(squid);
  for (let i = 0; i < 8; i++) moveMob(deep, squid, 0.7, 0);
  assert.ok(squid.position.x + squid.spec.radius < 0);
  assert.ok(
    canOccupy(
      deep,
      squid.position.x,
      squid.position.y,
      squid.position.z,
      squid.spec,
      true
    )
  );
  advance(wildlife, 4, new THREE.Vector3(0, 14, 0), { mode: "creative" });
  assert.ok(
    canOccupy(
      deep,
      squid.position.x,
      squid.position.y,
      squid.position.z,
      squid.spec,
      true
    )
  );
  wildlife.dispose();
});

test("flying mobs cannot drift into unloaded columns even above open space", () => {
  const world = flatWorld({
    dimension: "nether",
    biome: "nether_wastes",
    loaded: (x) => x < 16,
  });
  const wildlife = ecosystem(world);
  const ghast = wildlife.spawn("ghast", { x: 13, y: 16, z: 0 });
  assert.ok(ghast);
  moveMob(world, ghast, 3, 0, 1);
  assert.ok(ghast.position.x + ghast.spec.radius < 16);
  assert.equal(world.unloadedReads, 0);
  assert.ok(ghast.position.y >= 16);
  wildlife.dispose();
});
