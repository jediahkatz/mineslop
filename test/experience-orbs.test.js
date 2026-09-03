import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  EXPERIENCE_ORB_LIFETIME,
  ExperienceOrbs,
  MAX_EXPERIENCE_ORBS,
  MAX_ORB_EXPERIENCE,
  validateExperienceOrbs,
} from "../src/experience-orbs.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import {
  MAX_LOOSE_SPEED,
  MAX_LOOSE_Y,
  MAX_PICKUP_DELAY,
} from "../src/loose-entity.js";
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";

const at = { x: 0.5, y: 1.5, z: 0.5 };
const feet = { ...at, y: 1 };
const still = { x: 0, y: 0, z: 0 };
const records = (orbs) => orbs.serialize().orbs;
const total = (orbs) => records(orbs).reduce((sum, orb) => sum + orb.amount, 0);

function fixture(t, options) {
  const queries = [];
  const world = {
    dimension: "overworld",
    loaded: () => true,
    solid: (_x, y) => y === 0,
    isLoaded(x, z) {
      assert.ok([x, z].every(Number.isSafeInteger));
      queries.push(["loaded", x, z]);
      return this.loaded(x, z);
    },
    isSolid(x, y, z) {
      assert.ok([x, y, z].every(Number.isSafeInteger));
      assert.ok(y >= 0 && y < WORLD_HEIGHT);
      queries.push(["solid", x, y, z]);
      return this.solid(x, y, z);
    },
  };
  const scene = new THREE.Scene();
  const orbs = new ExperienceOrbs(scene, world, options);
  t.after(() => orbs.dispose());
  return { orbs, scene, world, queries };
}

test("full item inventory does not prevent accepted XP collection or change any owned stack", (t) => {
  const game = new Gameplay();
  game.consume(ITEM.APPLE, 4);
  assert.equal(game.add(BLOCK.DIRT, 36 * 64), true);
  assert.equal(game.add(ITEM.APPLE, 1), false);
  const before = game.getState().slots;
  const { orbs } = fixture(t, {
    onCollect: (amount) => game.addExperience(amount),
  });
  assert.equal(orbs.spawn(11, at), true);
  orbs.update(0.01, 0.01, feet, game);
  assert.equal(orbs.size, 0);
  assert.equal(game.getState().experience.total, 11);
  assert.deepEqual(game.getState().slots, before);
  orbs.update(1, 1, feet, game);
  assert.equal(game.getState().experience.total, 11);
});

test("nearby XP attracts physically and credits its entire value exactly once", (t) => {
  const collected = [];
  const { orbs } = fixture(t, {
    onCollect: (amount) => (collected.push(amount), true),
  });
  const origin = { ...at, x: at.x + 6 };
  assert.equal(orbs.spawn(23, origin), true);
  orbs.update(0.05, 0.05, feet);
  assert.ok(
    records(orbs)[0].x < origin.x,
    "attraction moves toward the player"
  );
  assert.deepEqual(collected, []);
  for (let i = 0; i < 120 && orbs.size; i++) orbs.update(0.05, i / 20, feet);
  assert.equal(orbs.size, 0);
  assert.deepEqual(collected, [23]);
  assert.equal(orbs.mesh.count, 0);
  orbs.update(10, 20, feet);
  assert.deepEqual(collected, [23]);
});

test("refused collection retains the orb and retries after a simulation cooldown", (t) => {
  let accepts = false;
  const attempts = [];
  const { orbs } = fixture(t, {
    onCollect: (amount) => (attempts.push(amount), accepts),
  });
  orbs.spawn(7, at);
  orbs.update(0.01, 0.01, feet);
  assert.equal(total(orbs), 7);
  assert.deepEqual(attempts, [7]);
  orbs.update(0.1, 0.11, feet);
  assert.deepEqual(attempts, [7]);
  accepts = true;
  orbs.update(0.4, 0.51, feet);
  assert.deepEqual(attempts, [7, 7]);
  assert.equal(orbs.size, 0);
});

test("paused, negative and invalid time never attracts, ages or collects XP", (t) => {
  const { orbs } = fixture(t, {
    onCollect: () => assert.fail("inactive simulation awarded XP"),
  });
  orbs.spawn(3, at);
  const before = orbs.serialize();
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
    orbs.update(dt, 10000, feet);
    assert.deepEqual(orbs.serialize(), before);
    assert.equal(orbs.mesh.count, 1);
  }
  orbs.update(0.05, 10001, feet, { dead: true });
  assert.equal(orbs.size, 1, "dead players cannot collect either");
  assert.equal(records(orbs)[0].age, 0.05);
});

test("pickup delay, throw velocity and active lifetime survive reload and pause", (t) => {
  const { orbs } = fixture(t);
  const ground = { ...at, y: 1.12 };
  orbs.spawn(17, ground, { pickupDelay: 2, velocity: still });
  orbs.update(0.5, 0.5, feet);
  const saved = JSON.parse(JSON.stringify(orbs.serialize()));
  assert.equal(saved.orbs[0].pickupDelay, 1.5);
  assert.equal(saved.orbs[0].age, 0.5);
  const collected = [];
  const restored = fixture(t, {
    onCollect: (amount) => (collected.push(amount), true),
  }).orbs;
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  saved.orbs[0].velocity.x = 10;
  assert.equal(records(restored)[0].velocity.x, 0);
  restored.update(0, 10000, feet);
  restored.update(1.4, 10001.4, feet);
  assert.deepEqual(collected, []);
  restored.update(0.11, 10001.51, feet);
  assert.deepEqual(collected, [17]);
  assert.equal(restored.size, 0);
});

test("same-motion rewards merge and split, while delays, dimensions and velocities remain separate", (t) => {
  const { orbs, world } = fixture(t);
  orbs.spawn(MAX_ORB_EXPERIENCE + 2, at);
  assert.deepEqual(
    records(orbs).map((orb) => orb.amount),
    [MAX_ORB_EXPERIENCE, 2]
  );
  orbs.spawn(3, at);
  assert.deepEqual(
    records(orbs).map((orb) => orb.amount),
    [MAX_ORB_EXPERIENCE, 5]
  );
  orbs.spawn(4, at, { pickupDelay: 2 });
  const velocity = { x: 3, y: 2.2, z: 0 };
  orbs.spawn(5, at, { velocity });
  velocity.x = 0;
  assert.equal(records(orbs)[3].velocity.x, 3);
  world.dimension = "nether";
  orbs.spawn(6, at);
  assert.equal(orbs.size, 5);
  assert.equal(total(orbs), MAX_ORB_EXPERIENCE + 20);
});

test("a full XP pool refuses an unretainable reward atomically without evicting or partially merging", (t) => {
  const { orbs } = fixture(t);
  const capacity = MAX_ORB_EXPERIENCE * MAX_EXPERIENCE_ORBS;
  assert.equal(orbs.spawn(capacity - 1, at), true);
  assert.equal(orbs.size, MAX_EXPERIENCE_ORBS);
  const before = orbs.serialize();
  assert.equal(orbs.spawn(2, at), false);
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(orbs.spawn(1, at), true);
  assert.equal(total(orbs), capacity);
  const full = orbs.serialize();
  assert.equal(orbs.spawn(1, at), false);
  assert.deepEqual(orbs.serialize(), full);
  assert.equal(orbs.spawn(capacity + 1, at), false);
});

test("XP lifetime advances only in active loaded simulation and an accepted merge protects fresh XP", (t) => {
  const { orbs, world } = fixture(t);
  const ground = { ...at, y: 1.12 };
  orbs.spawn(2, ground, { velocity: still });
  orbs.update(10, 10, feet);
  assert.equal(records(orbs)[0].age, 10);
  assert.equal(orbs.spawn(3, ground, { velocity: still }), true);
  assert.equal(orbs.size, 1);
  assert.equal(records(orbs)[0].age, 0);
  assert.equal(total(orbs), 5);
  orbs.update(EXPERIENCE_ORB_LIFETIME - 1, 300, feet);
  const before = orbs.serialize();
  orbs.update(0, 1000, feet);
  world.loaded = () => false;
  orbs.update(1000, 2000, feet);
  world.loaded = () => true;
  world.dimension = "end";
  orbs.update(1000, 3000, feet);
  world.dimension = "overworld";
  orbs.update(1000, 4000, { ...feet, x: 1000 });
  assert.deepEqual(orbs.serialize(), before);
  orbs.update(1, 4001, feet);
  assert.equal(orbs.size, 0);
  assert.equal(orbs.mesh.count, 0);
});

test("wrong dimensions and unloaded footprints freeze XP without terrain generation or collection", (t) => {
  const { orbs, world, queries } = fixture(t, {
    onCollect: () => assert.fail("frozen XP was collected"),
  });
  const origin = { x: 0.05, y: 4, z: 0.05 };
  world.dimension = "nether";
  orbs.spawn(9, origin, { pickupDelay: 2 });
  const before = orbs.serialize();
  world.dimension = "overworld";
  orbs.update(10, 10, origin);
  assert.equal(queries.length, 0);
  assert.equal(orbs.mesh.count, 0);
  world.dimension = "nether";
  world.loaded = (x, z) => x === 0 && z === 0;
  orbs.update(10, 20, origin);
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(orbs.mesh.count, 0);
  assert.ok(queries.every(([kind]) => kind === "loaded"));
  world.loaded = () => true;
  const queried = queries.length;
  orbs.update(10, 30, { ...origin, x: 2000 });
  orbs.update(10, 40);
  assert.equal(queries.length, queried);
  assert.deepEqual(orbs.serialize(), before);
});

test("XP throws freeze before entering unloaded columns and collide with thin terrain walls", (t) => {
  const { orbs, world } = fixture(t);
  const origin = { x: 1.5, y: 4, z: 0.5 };
  orbs.spawn(5, origin, { pickupDelay: 2, velocity: { x: 5, y: 0, z: 0 } });
  world.loaded = (x) => x < 2;
  const before = orbs.serialize();
  orbs.update(10, 10, origin);
  assert.deepEqual(orbs.serialize(), before);
  world.loaded = () => true;
  world.solid = (x, y) => y === 0 || (x === 2 && y < 7);
  orbs.update(0.1, 10.1, origin);
  assert.ok(records(orbs)[0].x + 0.12 * Math.SQRT2 <= 2 + 1e-6);
  assert.equal(records(orbs)[0].velocity.x, 0);
  assert.equal(total(orbs), 5);
});

test("high-altitude XP falls on terrain and remains finite at the save height bound", (t) => {
  const { orbs } = fixture(t);
  const high = { ...at, y: 250 };
  assert.equal(orbs.spawn(5, high), true);
  for (let i = 0; i < 200; i++) orbs.update(0.1, i / 10, high);
  assert.ok(records(orbs)[0].y >= 1 && records(orbs)[0].y < 1.3);
  assert.equal(orbs.load(orbs.serialize()), true);
  const highest = { ...at, y: MAX_LOOSE_Y };
  assert.equal(orbs.spawn(3, highest), true);
  orbs.update(0.1, 30, highest);
  assert.equal(orbs.load(orbs.serialize()), true);
  assert.ok([...orbs.mesh.instanceMatrix.array].every(Number.isFinite));
});

test("one instanced, texture-free pixel billboard batch renders all XP values", (t) => {
  const { orbs, scene } = fixture(t);
  for (const [amount, dx] of [
    [1, 0],
    [20, 3],
    [400, -3],
  ])
    orbs.spawn(amount, { ...at, x: at.x + dx });
  orbs.update(0, 0, feet);
  assert.equal(scene.children.length, 1);
  assert.equal(orbs.mesh.isInstancedMesh, true);
  assert.equal(orbs.mesh.count, 3);
  assert.equal(orbs.geometry.getAttribute("position").count, 4);
  assert.equal(orbs.material.isShaderMaterial, true);
  assert.equal(orbs.material.transparent, true);
  assert.equal(orbs.material.depthTest, true);
  assert.equal(orbs.material.depthWrite, false);
  assert.ok(
    Object.values(orbs.material.uniforms).every(
      (uniform) => !uniform.value?.isTexture
    )
  );
});

test("billboard uploads preserve nearby fractional coordinates at both 29-million world extremes", (t) => {
  for (const sign of [-1, 1]) {
    const { orbs } = fixture(t);
    const first = {
      x: sign * 29_000_000 + 0.25,
      y: 29_000_000.25,
      z: -sign * 29_000_000 + 0.25,
    };
    const second = { ...first, x: first.x + 0.5, z: first.z + 0.5 };
    orbs.spawn(1, first);
    orbs.spawn(2, second, { pickupDelay: 2 });
    const before = orbs.serialize();
    const matrix = new THREE.Matrix4();
    for (const player of [
      first,
      { ...first, x: first.x + CHUNK_SIZE, z: first.z - CHUNK_SIZE },
    ]) {
      orbs.update(0, 0, player);
      assert.equal(Math.abs(orbs.mesh.position.x % CHUNK_SIZE), 0);
      assert.equal(Math.abs(orbs.mesh.position.y % CHUNK_SIZE), 0);
      assert.equal(Math.abs(orbs.mesh.position.z % CHUNK_SIZE), 0);
      for (const [index, expected] of [first, second].entries()) {
        orbs.mesh.getMatrixAt(index, matrix);
        assert.ok(Math.abs(matrix.elements[12]) < CHUNK_SIZE * 3);
        assert.ok(Math.abs(matrix.elements[13]) < CHUNK_SIZE);
        assert.ok(Math.abs(matrix.elements[14]) < CHUNK_SIZE * 3);
        assert.equal(matrix.elements[12] + orbs.mesh.position.x, expected.x);
        assert.equal(matrix.elements[14] + orbs.mesh.position.z, expected.z);
      }
      assert.deepEqual(orbs.serialize(), before);
    }
  }
});

test("XP serialization is atomic, owns its motion objects and treats only absence as empty", (t) => {
  const { orbs, world } = fixture(t);
  for (const dimension of ["overworld", "nether", "end"]) {
    world.dimension = dimension;
    orbs.spawn(3, at, { pickupDelay: 2, velocity: { x: 1, y: 2, z: -1 } });
  }
  const saved = JSON.parse(JSON.stringify(orbs.serialize()));
  assert.equal(validateExperienceOrbs(saved), true);
  const restored = fixture(t).orbs;
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  saved.orbs[0].velocity.x = 20;
  assert.equal(records(restored)[0].velocity.x, 1);
  const before = restored.serialize();
  assert.equal(validateExperienceOrbs(null), false);
  assert.equal(restored.load(null), false);
  assert.deepEqual(restored.serialize(), before);
  assert.equal(validateExperienceOrbs(undefined), true);
  assert.equal(restored.load(undefined), true);
  assert.deepEqual(restored.serialize(), { version: 1, orbs: [] });
});

test("malformed rewards, positions, motion and lifetimes never partially replace live XP", (t) => {
  const { orbs } = fixture(t);
  orbs.spawn(7, at);
  const before = orbs.serialize();
  const entry = before.orbs[0];
  const badEntries = [
    null,
    [],
    {},
    ...[0, -1, 0.5, NaN, Infinity, "7", MAX_ORB_EXPERIENCE + 1].map(
      (amount) => ({ ...entry, amount })
    ),
    ...[-1, NaN, Infinity, EXPERIENCE_ORB_LIFETIME, "0"].map((age) => ({
      ...entry,
      age,
    })),
    { ...entry, dimension: "void" },
    { ...entry, x: WORLD_MIN - 1 },
    { ...entry, z: WORLD_MAX },
    { ...entry, y: MAX_LOOSE_Y + 1 },
    { ...entry, y: -1 },
    { ...entry, pickupDelay: MAX_PICKUP_DELAY + 1 },
    { ...entry, pickupDelay: null },
    { ...entry, velocity: null },
    { ...entry, velocity: { x: 0, y: 0 } },
    { ...entry, velocity: { x: MAX_LOOSE_SPEED + 1, y: 0, z: 0 } },
  ];
  for (const bad of badEntries) {
    const saved = { version: 1, orbs: [{ ...entry, amount: 2 }, bad] };
    assert.equal(validateExperienceOrbs(saved), false);
    assert.equal(orbs.load(saved), false);
    assert.deepEqual(orbs.serialize(), before);
  }
  for (const saved of [
    [],
    {},
    { version: 2, orbs: [] },
    { version: 1, orbs: {} },
    { version: 1, orbs: new Array(1) },
    { version: 1, orbs: Array(MAX_EXPERIENCE_ORBS + 1).fill(entry) },
  ]) {
    assert.equal(orbs.load(saved), false);
    assert.deepEqual(orbs.serialize(), before);
  }
  for (const amount of [
    0,
    -1,
    0.5,
    "3",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])
    assert.equal(orbs.spawn(amount, at), false);
  for (const options of [
    null,
    [],
    { pickupDelay: -1 },
    { pickupDelay: Infinity },
    { velocity: { x: 0, y: NaN, z: 0 } },
  ])
    assert.equal(orbs.spawn(1, at, options), false);
  assert.deepEqual(orbs.serialize(), before);
});

test("collection callbacks cannot double-credit via reentrant update or consume a newly spawned orb", (t) => {
  const { orbs } = fixture(t);
  const collected = [];
  orbs.onCollect = (amount) => {
    collected.push(amount);
    orbs.update(0.1, 1, feet);
    if (amount === 3) assert.equal(orbs.spawn(5, at), true);
    return true;
  };
  orbs.spawn(3, at);
  orbs.update(0.01, 0.01, feet);
  assert.deepEqual(collected, [3]);
  assert.equal(total(orbs), 5);
  orbs.update(0.01, 0.02, feet);
  assert.deepEqual(collected, [3, 5]);
  assert.equal(orbs.size, 0);
});

test("XP throws stay within world boundaries and invalid observer inputs cannot poison GPU matrices", (t) => {
  const { orbs } = fixture(t);
  const origin = { x: WORLD_MAX - 0.25, y: 4, z: WORLD_MIN + 0.25 };
  orbs.spawn(5, origin, {
    velocity: { x: MAX_LOOSE_SPEED, y: 0, z: -MAX_LOOSE_SPEED },
  });
  orbs.update(0.1, Number.MAX_VALUE, origin);
  const [orb] = records(orbs);
  assert.ok(orb.x < WORLD_MAX && orb.z >= WORLD_MIN);
  assert.equal(orb.velocity.x, 0);
  assert.equal(orb.velocity.z, 0);
  assert.equal(orbs.load(orbs.serialize()), true);
  const before = orbs.serialize();
  orbs.update(1, NaN, { ...origin, y: Infinity });
  assert.deepEqual(orbs.serialize(), before);
  assert.equal(orbs.mesh.count, 0);
  assert.ok([...orbs.mesh.instanceMatrix.array].every(Number.isFinite));
});

test("disposal releases the single XP mesh, geometry and material exactly once", (t) => {
  const { orbs, scene } = fixture(t);
  orbs.spawn(1, at);
  orbs.update(0, 0, feet);
  let disposed = 0;
  for (const resource of [orbs.mesh, orbs.geometry, orbs.material])
    resource.addEventListener("dispose", () => disposed++);
  orbs.dispose();
  orbs.dispose();
  orbs.update(1, 1, feet);
  assert.equal(disposed, 3);
  assert.equal(scene.children.length, 0);
  assert.equal(orbs.mesh.count, 0);
  assert.equal(orbs.size, 0);
  assert.equal(orbs.spawn(1, at), false);
  assert.equal(orbs.load(undefined), false);
});
