import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { MOB_SPECIES, speciesForBiome } from "../src/mob-species.js";
import { World } from "../src/world.js";
import { advance, ecosystem, flatWorld } from "./mob-fixtures.js";

function caveWorld() {
  const world = flatWorld();
  const get = world.get;
  world.heightAt = () => 48;
  world.get = function (x, y, z) {
    return y >= 40 && y <= 48 ? BLOCK.STONE : get.call(this, x, y, z);
  };
  world.getBiome = (x, z, y) => ({
    id: y !== undefined && y < 40 ? "sulfur_caves" : "plains",
    dimension: "overworld",
  });
  return world;
}

test("sulfur cubes naturally populate underground sulfur caves independently of daylight", (t) => {
  for (const timeOfDay of [0, 0.5]) {
    assert.ok(
      speciesForBiome({ id: "sulfur_caves" }, { timeOfDay }).includes(
        "sulfur_cube"
      )
    );
    assert.ok(
      !speciesForBiome(
        { id: "sulfur_caves" },
        { timeOfDay, hostile: true }
      ).includes("sulfur_cube")
    );
    const wildlife = ecosystem(caveWorld(), { autoSpawn: true });
    advance(wildlife, 6, new THREE.Vector3(0, 9, 0), {
      mode: "creative",
      timeOfDay,
    });
    const cubes = wildlife.entities.filter((mob) => mob.kind === "sulfur_cube");
    assert.ok(
      cubes.length > 0 && cubes.length <= MOB_SPECIES.sulfur_cube.limit
    );
    assert.ok(cubes.every((cube) => cube.position.y < 20 && !cube.burning));
    t.diagnostic(
      `${timeOfDay === 0 ? "Midnight" : "Noon"}: ${cubes.length} live sulfur cubes in a roofed cave`
    );
    wildlife.dispose();
  }
  for (const id of ["plains", "lush_caves", "dripstone_caves", "deep_dark"]) {
    assert.ok(!speciesForBiome({ id }).includes("sulfur_cube"));
  }
  assert.ok(
    !speciesForBiome({ id: "sulfur_caves" }, { water: true }).includes(
      "sulfur_cube"
    )
  );
  for (const dimension of ["nether", "end"]) {
    assert.ok(
      !speciesForBiome({ id: "sulfur_caves" }, { dimension }).includes(
        "sulfur_cube"
      )
    );
  }
  const surface = ecosystem(flatWorld({ biome: "sulfur_caves" }), {
    autoSpawn: true,
  });
  advance(surface, 4, new THREE.Vector3(0, 9, 0), { timeOfDay: 0.5 });
  assert.ok(surface.entities.every((mob) => mob.kind !== "sulfur_cube"));
  assert.equal(MOB_SPECIES.sulfur_cube.nocturnal, false);
  t.diagnostic(
    `${Object.keys(MOB_SPECIES).length} total species; no extra mob variants`
  );
  surface.dispose();
});

test("real streamed sulfur cave terrain supports a live daytime cube population", {
  timeout: 15000,
}, async (t) => {
  const world = new World("cedar-valley", { useWorker: false });
  let wildlife;
  try {
    const location = world.locateBiome("sulfur_caves");
    assert.ok(location, "the real generator locates a sulfur cave");
    const player = new THREE.Vector3().copy(location);
    await world.ensureArea(player, 2);
    assert.equal(
      world.getBiome(player.x, player.z, player.y).id,
      "sulfur_caves"
    );
    wildlife = ecosystem(world, { autoSpawn: true });
    advance(wildlife, 8, player, { mode: "creative", timeOfDay: 0.5 });
    const cubes = wildlife.entities.filter((mob) => mob.kind === "sulfur_cube");
    assert.ok(cubes.length > 0, "live cubes spawn on natural cave floors");
    assert.ok(cubes.every((cube) => !cube.attacking && !cube.burning));
    t.diagnostic(
      `Real sulfur cave at ${player.toArray().join(", ")}: ${cubes.length} live daytime cubes, ${world.chunks.size} streamed chunks`
    );
  } finally {
    wildlife?.dispose();
    world.dispose();
  }
});

test("targeted owned blocks consume once and replacement/death callbacks conserve inventory", (t) => {
  const gameplay = new Gameplay({ mode: "survival" });
  gameplay.add(BLOCK.PLANKS, 2);
  gameplay.add(BLOCK.STONE, 1);
  const consumed = [],
    drops = [];
  const consume = gameplay.consume.bind(gameplay);
  gameplay.consume = (id, count) => {
    consumed.push({ id, count });
    return consume(id, count);
  };
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (id, count, position) => {
      drops.push({ id, count, position });
      assert.equal(gameplay.add(id, count), true);
    },
  });
  const cube = wildlife.spawn("sulfur_cube", { x: 2, y: 9, z: 0 });
  cube.root.rotation.y = 0;
  const target = wildlife.raycast(
    { x: 2, y: 9.7, z: 3 },
    { x: 0, y: 0, z: -1 },
    5
  );
  assert.equal(target?.entity, cube);
  const balance = () =>
    gameplay.count(BLOCK.PLANKS) +
    gameplay.count(BLOCK.STONE) +
    (cube.absorbedBlock === null ? 0 : 1);
  // The parent's existing handshake: require an owned selected item, interact,
  // then consume one only when accepted. Wildlife never owns the inventory.
  const feedSelected = () => {
    const id = gameplay.hotbar[gameplay.selected];
    return !!(
      gameplay.selectedItem &&
      gameplay.count(id) > 0 &&
      wildlife.interact(target.entity, id) &&
      gameplay.consume(id, 1)
    );
  };
  const select = (id) => {
    assert.equal(gameplay.assignSlot(0, id), true);
    gameplay.select(0);
  };
  select(BLOCK.PLANKS);
  assert.equal(feedSelected(), true);
  assert.equal(gameplay.count(BLOCK.PLANKS), 1);
  assert.equal(cube.absorbedBlock, BLOCK.PLANKS);
  assert.deepEqual(consumed, [{ id: BLOCK.PLANKS, count: 1 }]);
  assert.equal(drops.length, 0, "an empty cube never provides a free block");
  assert.equal(balance(), 3);
  assert.equal(feedSelected(), false, "same material is a no-op");
  assert.equal(consumed.length, 1);
  assert.equal(drops.length, 0);
  for (let i = 0; i < 20; i++) {
    select(i % 2 === 0 ? BLOCK.STONE : BLOCK.PLANKS);
    assert.equal(feedSelected(), true);
    assert.equal(balance(), 3, "swapping never creates or destroys a block");
  }
  assert.equal(drops.length, 20);
  assert.ok(drops.every(({ count }) => count === 1));
  assert.deepEqual(drops[0], {
    id: BLOCK.PLANKS,
    count: 1,
    position: { x: 2, y: 9, z: 0 },
  });
  // A stale/unowned hotbar ID cannot feed or consume anything.
  gameplay.hotbar[0] = BLOCK.BLUE_ICE;
  assert.equal(feedSelected(), false);
  assert.equal(consumed.length, 21);
  const killed = wildlife.damage(cube, 100);
  assert.deepEqual(killed.drops, [{ id: BLOCK.PLANKS, count: 1 }]);
  assert.equal(cube.absorbedBlock, null);
  assert.equal(balance(), 3);
  assert.equal(wildlife.damage(cube, 100).hit, false);
  assert.equal(wildlife.interact(cube, BLOCK.STONE), false);
  assert.equal(drops.length, 21);
  const empty = wildlife.spawn("sulfur_cube", { x: 5, y: 9, z: 0 });
  assert.deepEqual(wildlife.damage(empty, 100).drops, []);
  assert.equal(drops.length, 21);
  t.diagnostic(
    "21 accepted feeds, 20 swaps, one death: 3 original blocks remain; duplicate/empty/dead interactions mint none"
  );
  wildlife.dispose();
});

test("only catalog solid blocks are absorbed; invalid inputs preserve state and emit nothing", () => {
  const drops = [],
    toasts = [];
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (...args) => drops.push(args),
    onToast: (message) => toasts.push(message),
  });
  const cube = wildlife.spawn("sulfur_cube", { x: 2, y: 9, z: 0 });
  assert.equal(wildlife.interact(cube.id, BLOCK.COBBLESTONE), true);
  const before = wildlife.serialize();
  for (const id of [
    BLOCK.AIR,
    BLOCK.WATER,
    BLOCK.LAVA,
    BLOCK.RED_FLOWER,
    BLOCK.SULFUR_SPIKE,
    BLOCK.NETHER_PORTAL,
    ITEM.IRON_PICKAXE,
    ITEM.BREAD,
    -1,
    0xffff,
    3.5,
    "3",
    null,
    undefined,
    NaN,
    Infinity,
  ]) {
    assert.equal(wildlife.interact(cube, id), false, `reject ${String(id)}`);
    assert.deepEqual(wildlife.serialize(), before);
  }
  assert.equal(wildlife.interact({ ...cube }, BLOCK.STONE), false);
  assert.equal(drops.length, 0);
  assert.equal(toasts.length, 1);
  wildlife.dispose();
});

test("new sulfur, cinnabar and potent sulfur blocks feed and persist through the shared catalog", () => {
  const wildlife = ecosystem();
  const cube = wildlife.spawn("sulfur_cube", { x: 2, y: 9, z: 0 });
  for (const block of [BLOCK.SULFUR, BLOCK.CINNABAR, BLOCK.POTENT_SULFUR]) {
    assert.equal(wildlife.interact(cube, block), true);
    assert.equal(cube.absorbedBlock, block);
    assert.equal(cube.absorbedMaterial, "stone");
    assert.ok(
      cube.model.absorbedColors[0].equals(new THREE.Color(BLOCKS[block].color))
    );
    const restored = ecosystem();
    assert.equal(restored.load(wildlife.serialize()), true);
    assert.equal(restored.byId.get(cube.id).absorbedBlock, block);
    restored.dispose();
  }
  wildlife.dispose();
});

test("absorbed materials measurably change real AI movement and hop height without changing other cubes", (t) => {
  const results = {};
  for (const [name, block] of [
    ["unfed", null],
    ["wood", BLOCK.PLANKS],
    ["stone", BLOCK.STONE],
    ["wool", BLOCK.WOOL],
    ["ice", BLOCK.BLUE_ICE],
    ["organic", BLOCK.LEAVES],
  ]) {
    const wildlife = ecosystem();
    const cube = wildlife.spawn("sulfur_cube", { x: 0, y: 9, z: 0 });
    const untouched = wildlife.spawn("sulfur_cube", { x: 8, y: 9, z: 0 });
    if (block !== null) assert.equal(wildlife.interact(cube, block), true);
    assert.equal(untouched.spec.speed, MOB_SPECIES.sulfur_cube.speed);
    assert.equal(untouched.spec.hop, MOB_SPECIES.sulfur_cube.hop);
    cube.followTime = 0;
    cube.walking = true;
    cube.wanderTimer = 10;
    cube.targetYaw = 0;
    cube.root.rotation.y = 0;
    let apex = 0;
    for (let i = 0; i < 10; i++) {
      wildlife.update(0.05, i * 0.05, new THREE.Vector3(0, 9, -3), {
        timeOfDay: 0.5,
        mode: "survival",
      });
      apex = Math.max(apex, cube.position.y - 9);
      assert.equal(cube.attacking, false);
    }
    results[name] = { distance: cube.position.z, apex };
    assert.ok(cube.position.z > 0);
    assert.ok(cube.position.toArray().every(Number.isFinite));
    wildlife.dispose();
  }
  assert.ok(results.wood.distance > results.stone.distance * 2);
  assert.ok(results.wood.apex > results.stone.apex);
  assert.ok(results.wool.apex > results.wood.apex);
  assert.ok(results.stone.apex > results.unfed.apex);
  assert.ok(results.ice.distance > results.wood.distance);
  assert.equal(results.ice.apex, 0);
  assert.ok(results.organic.apex < results.unfed.apex);
  t.diagnostic(`Measured distance/apex after 0.5s: ${JSON.stringify(results)}`);
});

test("unfed and block-fed sulfur cubes never attack, burn, shoot or explode, even after a hit", () => {
  const attacks = [],
    explosions = [];
  const wildlife = ecosystem(flatWorld(), {
    onDamage: (...args) => attacks.push(args),
    onExplode: (...args) => explosions.push(args),
  });
  const cube = wildlife.spawn("sulfur_cube", { x: 0.8, y: 9, z: 0 });
  const player = new THREE.Vector3(0, 9, 0);
  advance(wildlife, 3, player, { timeOfDay: 0.5 });
  assert.equal(cube.health, cube.spec.health);
  assert.equal(wildlife.interact(cube, BLOCK.TNT), true);
  wildlife.damage(cube, 1, { x: 1, y: 0, z: 0 });
  const start = cube.position.clone();
  advance(wildlife, 0.5, player, { timeOfDay: 0.5 });
  assert.ok(cube.position.x > start.x);
  cube.angry = 20;
  advance(wildlife, 5, player, { timeOfDay: 0.5 });
  assert.equal(cube.attacking, false);
  assert.equal(cube.burning, false);
  assert.equal(cube.fusing, false);
  assert.equal(cube.health, cube.spec.health - 1);
  assert.equal(wildlife.projectiles.length, 0);
  assert.deepEqual(attacks, []);
  assert.deepEqual(explosions, []);
  wildlife.dispose();
});

test("absorbed block colors appear in the instance batch while the distinct sulfur shell stays yellow", () => {
  const wildlife = ecosystem();
  const cube = wildlife.spawn("sulfur_cube", {
    x: 29000000.375,
    y: 9,
    z: -29000000.625,
  });
  const shell = cube.model.parts[0].color.clone();
  wildlife.render(0);
  const emptyCount = wildlife.mesh.count;
  assert.ok(shell.r > shell.g && shell.g > shell.b);
  for (const block of [BLOCK.PLANKS, BLOCK.STONE, BLOCK.BLUE_ICE]) {
    assert.equal(wildlife.interact(cube, block), true);
    wildlife.render(0);
    assert.equal(wildlife.mesh.count, emptyCount + 1);
    assert.ok(cube.model.parts[0].color.equals(shell));
    const color = new THREE.Color();
    wildlife.mesh.getColorAt(wildlife.mesh.count - 1, color);
    const expected = new THREE.Color(BLOCKS[block].color);
    for (const component of ["r", "g", "b"]) {
      assert.ok(Math.abs(color[component] - expected[component]) < 1e-6);
    }
    const matrix = new THREE.Matrix4();
    wildlife.mesh.getMatrixAt(wildlife.mesh.count - 1, matrix);
    assert.ok(Math.abs(matrix.elements[12]) < 16);
    assert.ok(Math.abs(matrix.elements[14]) < 16);
    const part = cube.model.parts.at(-1);
    for (const [axis, index] of [
      ["x", 12],
      ["z", 14],
    ]) {
      assert.ok(
        Math.abs(
          matrix.elements[index] +
            wildlife.mesh.position[axis] -
            part.node.matrixWorld.elements[index]
        ) < 1e-5
      );
    }
    assert.equal(
      wildlife.raycast(
        { x: cube.position.x, y: 9.6, z: cube.position.z + 3 },
        { x: 0, y: 0, z: -1 },
        5
      )?.entity,
      cube
    );
  }
  assert.equal(wildlife.group.children.length, 1);
  wildlife.dispose();
});

test("absorbed block, derived movement and color persist; repeated load and death cannot duplicate the core", () => {
  const drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (...args) => drops.push(args),
  });
  const cube = wildlife.spawn("sulfur_cube", { x: 2, y: 9, z: 0 });
  assert.equal(wildlife.interact(cube, BLOCK.IRON_ORE), true);
  const saved = JSON.parse(JSON.stringify(wildlife.serialize()));
  assert.equal(saved.entities[0].absorbedBlock, BLOCK.IRON_ORE);
  for (let i = 0; i < 5; i++) {
    assert.equal(wildlife.load(saved), true);
    const restored = wildlife.byId.get(cube.id);
    assert.equal(restored.absorbedBlock, BLOCK.IRON_ORE);
    assert.equal(restored.absorbedMaterial, "stone");
    assert.equal(restored.spec.speed, cube.spec.speed);
    assert.equal(restored.spec.hop, cube.spec.hop);
    assert.ok(
      restored.model.absorbedColors[0].equals(
        new THREE.Color(BLOCKS[BLOCK.IRON_ORE].color)
      )
    );
    assert.equal(drops.length, 0, "loading is not a loot-producing removal");
  }
  const restored = wildlife.byId.get(cube.id);
  assert.equal(wildlife.damage(restored, 100).killed, true);
  assert.deepEqual(drops, [[BLOCK.IRON_ORE, 1, { x: 2, y: 9, z: 0 }]]);
  assert.equal(wildlife.damage(restored, 100).hit, false);
  assert.equal(wildlife.load(wildlife.serialize()), true);
  assert.equal(
    wildlife.spawn("sulfur_cube", restored.position, { id: cube.id }),
    null
  );
  assert.equal(drops.length, 1);
  wildlife.dispose();
});

test("invalid absorbed save data is rejected atomically and old saves without a core still load", () => {
  const drops = [];
  const wildlife = ecosystem(flatWorld(), {
    onDrop: (...args) => drops.push(args),
  });
  const cube = wildlife.spawn("sulfur_cube", { x: 2, y: 9, z: 0 });
  wildlife.interact(cube, BLOCK.PLANKS);
  const saved = wildlife.serialize();
  for (const absorbedBlock of [
    BLOCK.WATER,
    BLOCK.AIR,
    BLOCK.TORCH,
    ITEM.IRON_INGOT,
    -1,
    0xffff,
    1.2,
    "3",
    NaN,
    Infinity,
    {},
  ]) {
    assert.equal(
      wildlife.load({
        ...saved,
        entities: [{ ...saved.entities[0], absorbedBlock }],
      }),
      false
    );
    assert.deepEqual(wildlife.serialize(), saved);
  }
  assert.equal(
    wildlife.load({
      ...saved,
      entities: [{ ...saved.entities[0], kind: "pig", health: 10 }],
    }),
    false,
    "other species cannot smuggle in a stored block"
  );
  const legacyEntry = { ...saved.entities[0] };
  delete legacyEntry.absorbedBlock;
  assert.equal(wildlife.load({ ...saved, entities: [legacyEntry] }), true);
  const empty = wildlife.byId.get(cube.id);
  assert.equal(empty.absorbedBlock, null);
  assert.equal(empty.spec.speed, MOB_SPECIES.sulfur_cube.speed);
  assert.equal(empty.spec.hop, MOB_SPECIES.sulfur_cube.hop);
  assert.deepEqual(wildlife.damage(empty, 100).drops, []);
  assert.equal(drops.length, 0);
  wildlife.dispose();
});
