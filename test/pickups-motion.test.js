import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import {
  MAX_LOOSE_SPEED,
  MAX_LOOSE_Y,
  MAX_PICKUP_DELAY,
} from "../src/loose-entity.js";
import { MAX_PICKUPS, Pickups, validatePickups } from "../src/pickups.js";
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";

const at = { x: 0.5, y: 1.14, z: 0.5 };
const still = { x: 0, y: 0, z: 0 };
const items = (pickups) => pickups.serialize().items;

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
  const pickups = new Pickups(new THREE.Scene(), world, options);
  t.after(() => pickups.dispose());
  return { pickups, world, queries };
}

test("paused, negative and nonfinite simulation steps neither collect nor advance delay/motion", (t) => {
  const { pickups } = fixture(t, {
    onCollect: () => assert.fail("paused collection"),
    onFull: () => assert.fail("paused full notice"),
  });
  pickups.spawn(ITEM.APPLE, 1, at);
  pickups.spawn(ITEM.COAL, 1, at, {
    pickupDelay: 2,
    velocity: { x: 4, y: 2, z: -1 },
  });
  const before = pickups.serialize();
  for (const dt of [0, -0.1, NaN, Infinity, -Infinity]) {
    pickups.update(dt, 1000, at, {
      add: () => assert.fail("paused inventory mutation"),
    });
    assert.deepEqual(pickups.serialize(), before);
    assert.equal(pickups.mesh.count, 2, "paused rendering remains available");
  }
});

test("remaining pickup delay and worn-tool velocity survive reload without a wall-clock shortcut", (t) => {
  const { pickups } = fixture(t);
  pickups.spawn(ITEM.IRON_PICKAXE, 1, at, {
    durability: [3],
    pickupDelay: 2,
    velocity: still,
  });
  pickups.update(0.75, 0.75, at, {
    add: () => assert.fail("delay has not expired"),
  });
  const saved = JSON.parse(JSON.stringify(pickups.serialize()));
  assert.equal(saved.items[0].pickupDelay, 1.25);
  const restored = fixture(t).pickups;
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  saved.items[0].velocity.x = 10;
  assert.equal(items(restored)[0].velocity.x, 0);
  const received = [];
  const sink = { add: (...args) => (received.push(args), true) };
  restored.update(0, 10000, at, sink);
  restored.update(1.2, 10001.2, at, sink);
  assert.deepEqual(received, []);
  restored.update(0.06, 10001.26, at, sink);
  assert.deepEqual(received, [[ITEM.IRON_PICKAXE, 1, { durability: [3] }]]);
  restored.update(1, 10002, at, sink);
  assert.equal(received.length, 1);
});

test("old component-v1 snapshots default to zero delay and stationary velocity without repairing wear", (t) => {
  const { pickups } = fixture(t);
  assert.equal(
    pickups.load({
      version: 1,
      items: [
        {
          id: ITEM.BOW,
          count: 1,
          ...at,
          dimension: "overworld",
          durability: [7],
        },
      ],
    }),
    true
  );
  assert.equal(items(pickups)[0].pickupDelay, 0);
  assert.deepEqual(items(pickups)[0].velocity, still);
  const received = [];
  pickups.update(0.01, 0.01, at, {
    add: (...args) => (received.push(args), true),
  });
  assert.deepEqual(received, [[ITEM.BOW, 1, { durability: [7] }]]);
});

test("delayed and differently thrown stacks cannot inherit an older stack's collection eligibility", (t) => {
  const { pickups } = fixture(t);
  pickups.spawn(BLOCK.STONE, 3, at);
  pickups.spawn(BLOCK.STONE, 2, at, { pickupDelay: 2 });
  pickups.spawn(BLOCK.STONE, 4, at, { pickupDelay: 2 });
  const velocity = { x: 4, y: 2.2, z: 0 };
  pickups.spawn(BLOCK.STONE, 5, at, { pickupDelay: 2, velocity });
  velocity.x = 0;
  assert.deepEqual(
    items(pickups).map((entry) => entry.count),
    [3, 6, 5]
  );
  assert.equal(items(pickups)[2].velocity.x, 4);
  const received = [];
  pickups.update(0.01, 0.01, at, {
    add: (...args) => (received.push(args), true),
  });
  assert.deepEqual(received, [[BLOCK.STONE, 3]]);
  assert.equal(
    items(pickups).reduce((sum, entry) => sum + entry.count, 0),
    11
  );
});

test("invalid spawn or saved motion rejects the entire operation without partial merges or replacement", (t) => {
  const { pickups } = fixture(t);
  pickups.spawn(ITEM.APPLE, 2, at);
  const before = pickups.serialize();
  const patches = [
    ...[-1, MAX_PICKUP_DELAY + 1, NaN, Infinity, "2", null].map(
      (pickupDelay) => ({ pickupDelay })
    ),
    ...[
      null,
      [],
      {},
      { x: 0, y: 0 },
      { x: "0", y: 0, z: 0 },
      { x: NaN, y: 0, z: 0 },
      { x: 0, y: Infinity, z: 0 },
      { x: MAX_LOOSE_SPEED + 1, y: 0, z: 0 },
      { x: 0, y: 0, z: -MAX_LOOSE_SPEED - 1 },
    ].map((velocity) => ({ velocity })),
  ];
  for (const patch of patches) {
    assert.equal(pickups.spawn(ITEM.APPLE, 1, at, patch), false);
    assert.deepEqual(pickups.serialize(), before);
    const saved = {
      version: 1,
      items: [
        { ...before.items[0], count: 3 },
        { ...before.items[0], ...patch },
      ],
    };
    assert.equal(validatePickups(saved), false);
    assert.equal(pickups.load(saved), false);
    assert.deepEqual(pickups.serialize(), before);
  }
});

test("fast horizontal throws hit thin walls instead of tunneling through them", (t) => {
  const { pickups, world } = fixture(t);
  world.solid = (x, y) => y === 0 || (x === 2 && y < 7);
  pickups.spawn(ITEM.DIAMOND, 1, at, {
    pickupDelay: 2,
    velocity: { x: MAX_LOOSE_SPEED, y: 0, z: 0 },
  });
  pickups.update(0.1, 0.1, at);
  const [drop] = items(pickups);
  assert.ok(drop.x > at.x);
  assert.ok(drop.x + 0.14 * Math.SQRT2 <= 2 + 1e-6);
  assert.equal(drop.velocity.x, 0);
  assert.equal(drop.count, 1);
});

test("a thrown path into unloaded terrain freezes position, velocity, delay and collection", (t) => {
  const { pickups, world, queries } = fixture(t);
  const origin = { x: 1.5, y: 5, z: 0.5 };
  world.loaded = (x) => x < 2;
  pickups.spawn(ITEM.APPLE, 1, origin, {
    pickupDelay: 2,
    velocity: { x: 5, y: 1, z: 0 },
  });
  const before = pickups.serialize();
  pickups.update(10, 10, origin, {
    add: () => assert.fail("unloaded frontier collection"),
  });
  assert.deepEqual(pickups.serialize(), before);
  assert.ok(queries.some(([kind, x]) => kind === "loaded" && x === 2));
  assert.ok(queries.every(([kind]) => kind === "loaded"));
});

test("high creative drops fall onto terrain without querying above terrain height", (t) => {
  const { pickups, queries } = fixture(t);
  const origin = { ...at, y: 250 };
  assert.equal(pickups.spawn(ITEM.COAL, 1, origin), true);
  for (let i = 0; i < 200; i++) pickups.update(0.1, i / 10, origin);
  const [drop] = items(pickups);
  assert.ok(drop.y >= 1 && drop.y < 1.3);
  assert.ok(queries.some(([kind]) => kind === "solid"));
  assert.equal(pickups.load(pickups.serialize()), true);
  assert.equal(pickups.spawn(ITEM.APPLE, 1, { ...at, y: MAX_LOOSE_Y }), true);
  pickups.update(0.1, 30, { ...at, y: MAX_LOOSE_Y });
  assert.equal(pickups.load(pickups.serialize()), true);
  assert.ok([...pickups.mesh.instanceMatrix.array].every(Number.isFinite));
});

test("high-altitude GPU uploads remain local in all axes at positive and negative 29 million", (t) => {
  for (const sign of [-1, 1]) {
    const { pickups } = fixture(t);
    const origin = {
      x: sign * 29_000_000 + 0.25,
      y: 29_000_000.25,
      z: -sign * 29_000_000 + 0.25,
    };
    pickups.spawn(ITEM.APPLE, 1, origin);
    pickups.spawn(ITEM.COAL, 1, { ...origin, x: origin.x + 0.5 });
    const before = pickups.serialize();
    pickups.update(0, 0, origin);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 2; i++) {
      pickups.mesh.getMatrixAt(i, matrix);
      for (const index of [12, 13, 14])
        assert.ok(Math.abs(matrix.elements[index]) < CHUNK_SIZE);
      assert.equal(
        matrix.elements[12] + pickups.mesh.position.x,
        origin.x + i * 0.5
      );
      assert.equal(matrix.elements[14] + pickups.mesh.position.z, origin.z);
    }
    assert.deepEqual(pickups.serialize(), before);
  }
});

test("thrown bodies remain inside horizontal world boundaries", (t) => {
  for (const direction of [-1, 1]) {
    const { pickups } = fixture(t);
    const origin = {
      x: direction < 0 ? WORLD_MIN + 0.25 : WORLD_MAX - 0.25,
      y: 5,
      z: 0.5,
    };
    pickups.spawn(ITEM.APPLE, 1, origin, {
      velocity: { x: direction * MAX_LOOSE_SPEED, y: 0, z: 0 },
    });
    pickups.update(0.1, 0.1, origin);
    const [drop] = items(pickups);
    assert.ok(drop.x >= WORLD_MIN && drop.x < WORLD_MAX);
    assert.equal(drop.velocity.x, 0);
    assert.equal(pickups.load(pickups.serialize()), true);
  }
});

test("pickup preflight accepts frozen v1 data without constructing render resources", (t) => {
  for (const [prototype, method] of [
    [THREE.Color.prototype, "set"],
    [THREE.BufferGeometry.prototype, "setAttribute"],
    [THREE.Material.prototype, "setValues"],
  ])
    t.mock.method(prototype, method, () =>
      assert.fail("preflight must not construct colors, geometry or materials")
    );
  const legacy = Object.freeze({
    version: 1,
    items: Object.freeze([
      Object.freeze({
        id: ITEM.BOW,
        count: 1,
        x: 29_000_000.25,
        y: 250,
        z: -29_000_000.25,
        dimension: "nether",
        durability: Object.freeze([7]),
      }),
    ]),
  });
  assert.equal(validatePickups(legacy), true);
  assert.equal(
    validatePickups({
      version: 1,
      items: [
        {
          ...legacy.items[0],
          pickupDelay: 2,
          velocity: Object.freeze({ x: 3, y: 2, z: -1 }),
        },
      ],
    }),
    true
  );
  assert.equal(validatePickups(undefined), true);
  assert.equal(validatePickups({ version: 1, items: [] }), true);
  assert.equal(validatePickups(null), false);
});

test("preflight and atomic load reject the same malformed wear, positions and component shapes", (t) => {
  const { pickups } = fixture(t);
  pickups.spawn(ITEM.BOW, 1, at, { durability: [7], pickupDelay: 2 });
  pickups.update(0, 0, at);
  const before = pickups.serialize();
  const valid = before.items[0];
  const invalidEntries = [
    null,
    {},
    { ...valid, id: 0 },
    { ...valid, count: 2 },
    { ...valid, dimension: "void" },
    { ...valid, x: WORLD_MAX },
    { ...valid, z: WORLD_MIN - 1 },
    { ...valid, y: MAX_LOOSE_Y + 1 },
    { ...valid, y: NaN },
    { ...valid, durability: 7 },
    { ...valid, durability: [0] },
    { ...valid, durability: [getItem(ITEM.BOW).durability + 1] },
    { ...valid, durability: new Array(1) },
    { ...valid, id: ITEM.APPLE, durability: [7] },
  ];
  const invalidComponents = [
    null,
    [],
    {},
    { version: 2, items: [] },
    { version: 1, items: {} },
    { version: 1, items: new Array(1) },
    { version: 1, items: Array(MAX_PICKUPS + 1).fill(valid) },
    ...invalidEntries.map((invalid) => ({
      version: 1,
      items: [{ ...valid, durability: [3] }, invalid],
    })),
  ];
  for (const saved of invalidComponents) {
    assert.equal(validatePickups(saved), false);
    assert.equal(pickups.load(saved), false);
    assert.deepEqual(pickups.serialize(), before);
    assert.equal(pickups.mesh.count, 1, "failed load keeps the active mesh");
  }
  assert.equal(validatePickups(before), true);
  assert.equal(pickups.load(before), true);
  assert.deepEqual(pickups.serialize(), before);
});

test("missing pickup components load empty while v1 motion defaults and wear remain lossless", (t) => {
  const { pickups } = fixture(t);
  const saved = {
    version: 1,
    items: [
      { id: ITEM.BOW, count: 1, ...at, dimension: "end", durability: [7] },
    ],
  };
  assert.equal(validatePickups(saved), true);
  assert.equal(pickups.load(saved), true);
  assert.deepEqual(items(pickups)[0], {
    ...saved.items[0],
    pickupDelay: 0,
    velocity: still,
  });
  saved.items[0].durability[0] = 1;
  assert.deepEqual(items(pickups)[0].durability, [7]);
  assert.equal(validatePickups(undefined), true);
  assert.equal(pickups.load(undefined), true);
  assert.deepEqual(pickups.serialize(), { version: 1, items: [] });
  assert.equal(pickups.mesh.count, 0);
});
