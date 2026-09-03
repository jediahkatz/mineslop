import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { createMobModel, MAX_PARTS_PER_MOB } from "../src/mob-models.js";
import {
  isHostileSpecies,
  MAX_HOSTILES,
  MAX_KILLED_MOBS,
  MAX_MOBS,
  MOB_SPECIES,
  speciesForBiome,
} from "../src/mob-species.js";
import { WORLD_HEIGHT } from "../src/terrain.js";
import { Wildlife } from "../src/wildlife.js";
import { advance, ecosystem, flatWorld, wall } from "./mob-fixtures.js";

test("every species builds an original finite rig within a single-material instance budget", () => {
  const silhouettes = new Set();
  for (const [kind, spec] of Object.entries(MOB_SPECIES)) {
    const model = createMobModel(kind);
    assert.ok(
      model.parts.length > 5 && model.parts.length <= MAX_PARTS_PER_MOB,
      kind
    );
    model.root.updateMatrixWorld(true);
    for (const part of model.parts)
      assert.ok(part.node.matrixWorld.elements.every(Number.isFinite), kind);
    silhouettes.add(
      JSON.stringify(
        model.parts.map(({ node }) => [
          node.position.toArray(),
          node.scale.toArray(),
        ])
      )
    );
    for (const entry of spec.drops)
      assert.ok(getItem(entry.id), `${kind} drop is a catalog item`);
  }
  assert.ok(
    silhouettes.size >= 24,
    "anatomy changes, not 24 recolors of one rig"
  );
  assert.throws(() => createMobModel("missing"), /Unknown mob/);
});

test("habitats, night selection, and dimensions select different live spawn pools", () => {
  const daytime = speciesForBiome({ id: "desert" }, { timeOfDay: 0.5 });
  assert.ok(daytime.includes("camel"));
  assert.ok(!daytime.includes("cow"));
  assert.equal(
    speciesForBiome({ id: "desert" }, { timeOfDay: 0.5, hostile: true }).length,
    0
  );
  const night = speciesForBiome(
    { id: "desert" },
    { timeOfDay: 0, hostile: true }
  );
  assert.ok(night.includes("husk") && !night.includes("zombie"));
  assert.ok(
    speciesForBiome({ id: "swamp" }, { timeOfDay: 0, hostile: true }).includes(
      "slime"
    )
  );
  assert.ok(
    speciesForBiome(
      { id: "nether_wastes" },
      { dimension: "nether", hostile: true }
    ).includes("ghast")
  );
  assert.deepEqual(
    speciesForBiome({ id: "the_end" }, { dimension: "end", hostile: true }),
    ["enderman"]
  );
  assert.ok(
    speciesForBiome({ id: "ocean" }, { water: true }).every(
      (kind) => MOB_SPECIES[kind].aquatic
    )
  );
});

test("daytime populations actually spawn, use one mesh, stay bounded, and transition into night encounters", () => {
  const scene = new THREE.Scene();
  const wildlife = new Wildlife(scene, flatWorld());
  const player = new THREE.Vector3(640, 9, -320);
  advance(wildlife, 9, player, { timeOfDay: 0.5, mode: "creative" });
  assert.ok(wildlife.entities.length >= 8);
  assert.ok(wildlife.entities.every((mob) => !isHostileSpecies(mob.spec)));
  assert.ok(new Set(wildlife.entities.map((mob) => mob.kind)).size > 2);
  assert.equal(scene.children.length, 1);
  assert.equal(wildlife.group.children.length, 1);
  assert.ok(
    wildlife.mesh.isInstancedMesh &&
      wildlife.mesh.count > wildlife.entities.length * 10
  );
  for (let i = 0; i < 8; i++) {
    advance(wildlife, 1.6, player, { mode: "creative" });
    assert.ok(wildlife.entities.length <= MAX_MOBS);
    assert.ok(
      wildlife.entities.filter((mob) => isHostileSpecies(mob.spec)).length <=
        MAX_HOSTILES
    );
    for (const mob of wildlife.entities) {
      assert.ok(mob.position.x > 80, "no obsolete +/-80 world boundary");
      assert.ok(mob.position.toArray().every(Number.isFinite));
    }
  }
  assert.ok(wildlife.entities.some((mob) => isHostileSpecies(mob.spec)));
  assert.ok([...wildlife.mesh.instanceMatrix.array].every(Number.isFinite));
  wildlife.dispose();
});

test("spawning and culling follow streamed terrain through negative chunk seams and long teleports", () => {
  let center = { x: -160, z: -160 };
  const world = flatWorld({
    loaded: (x, z) =>
      Math.abs(x - center.x) < 40 && Math.abs(z - center.z) < 40,
  });
  const wildlife = ecosystem(world, { autoSpawn: true });
  advance(wildlife, 3, new THREE.Vector3(center.x, 9, center.z), {
    timeOfDay: 0.5,
    mode: "creative",
  });
  const oldIds = new Set(wildlife.entities.map((mob) => mob.id));
  assert.ok(oldIds.size > 0);
  center = { x: 1200, z: -2300 };
  advance(wildlife, 3, new THREE.Vector3(center.x, 9, center.z), {
    timeOfDay: 0.5,
    mode: "creative",
  });
  assert.ok(wildlife.entities.length > 0);
  assert.ok(wildlife.entities.every((mob) => !oldIds.has(mob.id)));
  assert.equal(
    wildlife.killed.size,
    0,
    "despawning does not mark an entity as killed"
  );
  assert.equal(world.unloadedReads, 0);
  wildlife.dispose();
});

test("raycast picks the nearest entity, respects reach, normalizes direction, and cannot hit through blocks", () => {
  const world = flatWorld();
  const wildlife = ecosystem(world);
  const near = wildlife.spawn("cow", { x: 3, y: 9, z: 0 });
  near.root.rotation.y = 0;
  wildlife.spawn("sheep", { x: 5, y: 9, z: 0 });
  const origin = { x: 0, y: 10, z: 0 },
    direction = { x: 8, y: 0, z: 0 };
  const hit = wildlife.raycast(origin, direction, 6);
  assert.equal(hit.entity, near);
  assert.equal(hit.name, "Cow");
  assert.ok(hit.distance > 2 && hit.distance < 3);
  assert.equal(wildlife.raycast(origin, direction, 1), null);
  assert.equal(wildlife.raycast(origin, { x: 0, y: 0, z: 0 }), null);
  assert.equal(wildlife.raycast(origin, direction, Infinity), null);
  wall(world, 1);
  assert.equal(wildlife.raycast(origin, direction, 6), null);
  wildlife.dispose();
});

test("picking intersects real animated model parts, including a horse's long head outside its feet collider", () => {
  const wildlife = ecosystem();
  const horse = wildlife.spawn("horse", { x: 3, y: 9, z: 0 });
  horse.root.rotation.y = Math.PI / 2;
  const hit = wildlife.raycast(
    { x: 5, y: 10.9, z: 0 },
    { x: -1, y: 0, z: 0 },
    1
  );
  assert.equal(hit?.entity, horse);
  assert.ok(hit.distance < 1);
  assert.equal(
    wildlife.raycast({ x: 5, y: 9.5, z: 0 }, { x: -1, y: 0, z: 0 }, 1),
    null
  );
  wildlife.dispose();
});

test("death drops use item IDs exactly once and removed entities cannot be damaged again", () => {
  const drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (...args) => drops.push(args),
  });
  const cow = wildlife.spawn("cow", { x: 2, y: 9, z: 2 });
  const result = wildlife.damage(cow, 100, { x: 1, y: 0, z: 0 });
  assert.ok(result.hit && result.killed);
  assert.equal(result.damage, cow.spec.health);
  assert.ok(drops.some(([id, count]) => id === ITEM.RAW_BEEF && count > 0));
  assert.ok(drops.some(([id, count]) => id === ITEM.LEATHER && count > 0));
  assert.deepEqual(drops[0][2], { x: 2, y: 9, z: 2 });
  assert.equal(wildlife.entities.length, 0);
  assert.ok(wildlife.killed.has(cow.id));
  const once = drops.length;
  assert.equal(wildlife.damage(cow, 100).hit, false);
  assert.equal(drops.length, once);
  assert.equal(
    wildlife.spawn("cow", { x: 2, y: 9, z: 2 }, { id: cow.id }),
    null
  );
  wildlife.dispose();
});

test("active wolves, health, killed sites, and combat state roundtrip; invalid saves fail atomically", () => {
  const world = flatWorld();
  const wildlife = ecosystem(world);
  const wolf = wildlife.spawn("wolf", { x: 2, y: 9, z: 2 });
  assert.equal(wildlife.interact(wolf, ITEM.BONE), true);
  wildlife.damage(wolf, 3);
  const sheep = wildlife.spawn("sheep", { x: 6, y: 9, z: 2 });
  wildlife.damage(sheep, 100);
  const data = JSON.parse(JSON.stringify(wildlife.serialize()));
  const restored = ecosystem(world);
  assert.equal(restored.load(data), true);
  const companion = restored.byId.get(wolf.id);
  assert.ok(companion.tamed);
  assert.equal(companion.health, wolf.health);
  assert.deepEqual(companion.position.toArray(), wolf.position.toArray());
  assert.ok(restored.killed.has(sheep.id));
  assert.equal(
    restored.spawn("sheep", { x: 6, y: 9, z: 2 }, { id: sheep.id }),
    null
  );
  const before = restored.serialize();
  for (const corrupt of [
    { ...data, dimension: "nether" },
    { ...data, entities: [...data.entities, data.entities[0]] },
    {
      ...data,
      entities: [{ ...data.entities[0], position: { x: NaN, y: 9, z: 0 } }],
    },
    {
      ...data,
      entities: [
        { ...data.entities[0], position: { x: 0, y: WORLD_HEIGHT, z: 0 } },
      ],
    },
    { ...data, entities: [{ ...data.entities[0], kind: "toString" }] },
    { ...data, entities: [null] },
    { ...data, randomState: NaN },
    { ...data, entities: [{ ...data.entities[0], health: 999 }] },
    { ...data, entities: [{ ...data.entities[0], id: sheep.id }] },
  ]) {
    assert.equal(restored.load(corrupt), false);
    assert.deepEqual(restored.serialize(), before);
  }
  wildlife.dispose();
  restored.dispose();
});

test("entity, killed-site, and GPU capacities remain bounded and dispose is idempotent", () => {
  const wildlife = ecosystem();
  for (let i = 0; i < MAX_MOBS + 12; i++)
    wildlife.spawn("rabbit", { x: i + 0.5, y: 9, z: 0.5 });
  assert.equal(wildlife.entities.length, MAX_MOBS);
  assert.equal(wildlife.spawn("toString", { x: 0, y: 9, z: 0 }), null);
  wildlife.update(0, 0);
  assert.ok(wildlife.mesh.count <= MAX_MOBS * MAX_PARTS_PER_MOB);
  for (let i = 0; i < MAX_KILLED_MOBS + 32; i++)
    wildlife.rememberKilled(`site:${i}`);
  assert.equal(wildlife.killed.size, MAX_KILLED_MOBS);
  const before = wildlife.serialize();
  wildlife.update(NaN, NaN, { x: Infinity, y: 0, z: 0 });
  assert.deepEqual(wildlife.serialize(), before);
  let disposed = 0;
  for (const resource of [wildlife.mesh, wildlife.geometry, wildlife.material])
    resource.addEventListener("dispose", () => disposed++);
  wildlife.dispose();
  wildlife.dispose();
  wildlife.update(1, 2);
  assert.equal(disposed, 3);
  assert.equal(wildlife.scene.children.length, 0);
});

test("empty or entirely submerged land does not create floating terrestrial mobs", () => {
  const world = flatWorld({ biome: "plains", water: () => 30 });
  const wildlife = ecosystem(world, { autoSpawn: true });
  advance(wildlife, 4, new THREE.Vector3(0, 31, 0), {
    mode: "creative",
    timeOfDay: 0.5,
  });
  assert.equal(wildlife.entities.length, 0);
  assert.equal(wildlife.mesh.count, 0);
  world.edits.set("0,8,0", BLOCK.LAVA);
  assert.equal(wildlife.surfaceAt(0.5, 0.5), null);
  wildlife.dispose();
});
