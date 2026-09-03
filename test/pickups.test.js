import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import { MAX_LOOSE_Y } from "../src/loose-entity.js";
import { MAX_PICKUPS, Pickups } from "../src/pickups.js";
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";

const position = { x: 0.5, y: 9.5, z: 0.5 };
const drops = (pickups) => pickups.serialize().items;
const total = (pickups) =>
  drops(pickups).reduce((sum, drop) => sum + drop.count, 0);

function setup(t, options) {
  const queries = [];
  const world = {
    dimension: "overworld",
    loaded: () => true,
    solid: (_x, y, _z) => y <= 8,
    isLoaded(x, z) {
      assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(z));
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
  const pickups = new Pickups(scene, world, options);
  t.after(() => pickups.dispose());
  return { pickups, scene, world, queries };
}

test("spawn splits stacks, merges nearby matching items, and copies positions", (t) => {
  const { pickups } = setup(t);
  const stack = getItem(BLOCK.STONE).stackSize;
  const source = { ...position };
  assert.equal(pickups.spawn(BLOCK.STONE, stack * 2 + 3, source), true);
  assert.deepEqual(
    drops(pickups).map((drop) => drop.count),
    [stack, stack, 3]
  );
  assert.equal(pickups.spawn(BLOCK.STONE, 5, position), true);
  assert.deepEqual(
    drops(pickups).map((drop) => drop.count),
    [stack, stack, 8]
  );
  assert.equal(pickups.spawn(ITEM.COAL, 1, position), true);
  assert.equal(pickups.spawn(ITEM.WOOD_PICKAXE, 2, position), true);
  assert.equal(pickups.size, 6, "unstackable tools occupy separate records");
  source.x = 100;
  assert.equal(drops(pickups)[0].x, position.x);
  assert.equal(pickups.spawn(BLOCK.STONE, 1, { ...position, x: 10 }), true);
  assert.equal(
    pickups.size,
    7,
    "distant stacks remain where they were dropped"
  );
  assert.equal(total(pickups), stack * 2 + 12);
});

test("a full pool rejects atomically, but a merge can still succeed at capacity", (t) => {
  const { pickups } = setup(t);
  const stack = getItem(BLOCK.STONE).stackSize;
  pickups.spawn(BLOCK.STONE, stack - 1, position);
  pickups.spawn(ITEM.WOOD_PICKAXE, MAX_PICKUPS - 1, position);
  const before = pickups.serialize();
  assert.equal(pickups.size, MAX_PICKUPS);
  assert.equal(pickups.spawn(BLOCK.STONE, 2, position), false);
  assert.deepEqual(
    pickups.serialize(),
    before,
    "even the partial merge rolls back"
  );
  assert.equal(pickups.spawn(ITEM.APPLE, 1, position), false);
  assert.deepEqual(pickups.serialize(), before, "no oldest-item eviction");
  assert.equal(pickups.spawn(BLOCK.STONE, 1, position), true);
  assert.equal(drops(pickups)[0].count, stack);
  assert.equal(pickups.size, MAX_PICKUPS);
});

test("spawn rejects invalid IDs, dimensions, positions, and unbounded counts", (t) => {
  const { pickups, world } = setup(t);
  pickups.spawn(ITEM.APPLE, 1, position);
  const before = pickups.serialize();
  for (const id of [0, -1, 99999, "3", 3.5, null, Number.NaN])
    assert.equal(pickups.spawn(id, 1, position), false);
  for (const count of [
    0,
    -1,
    0.5,
    "1",
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    getItem(ITEM.APPLE).stackSize * MAX_PICKUPS + 1,
  ])
    assert.equal(pickups.spawn(ITEM.APPLE, count, position), false);
  for (const invalid of [
    null,
    [],
    {},
    { ...position, x: WORLD_MAX },
    { ...position, x: WORLD_MIN - 1 },
    { ...position, x: Number.NaN },
    { ...position, y: -1 },
    { ...position, y: MAX_LOOSE_Y + 1 },
    { ...position, y: Infinity },
    { ...position, z: "0.5" },
  ])
    assert.equal(pickups.spawn(ITEM.APPLE, 1, invalid), false);
  world.dimension = "unknown";
  assert.equal(pickups.spawn(ITEM.APPLE, 1, position), false);
  assert.deepEqual(pickups.serialize(), before);
});

test("all item colors render as one instanced, texture-free cube batch", (t) => {
  const { pickups, scene } = setup(t);
  for (const id of [BLOCK.STONE, ITEM.APPLE, ITEM.DIAMOND])
    pickups.spawn(id, 1, position);
  pickups.update(0, 0, position);
  assert.equal(scene.children.length, 1);
  assert.equal(pickups.mesh.isInstancedMesh, true);
  assert.equal(pickups.mesh.count, 3);
  assert.equal(pickups.material.map, null);
  for (let i = 0; i < drops(pickups).length; i++) {
    const color = new THREE.Color();
    pickups.mesh.getColorAt(i, color);
    const expected = new THREE.Color(getItem(drops(pickups)[i].id).color);
    assert.ok(Math.abs(color.r - expected.r) < 1e-6);
    assert.ok(Math.abs(color.g - expected.g) < 1e-6);
    assert.ok(Math.abs(color.b - expected.b) < 1e-6);
  }
});

test("snapped origins preserve sub-block offsets at 29 million without moving world records", (t) => {
  for (const sign of [1, -1]) {
    const { pickups, scene, queries } = setup(t);
    const first = {
      x: sign * 29_000_000 + 0.25,
      y: position.y,
      z: -sign * 29_000_000 + 0.25,
    };
    const second = { ...first, x: first.x + 0.5, z: first.z + 0.5 };
    pickups.spawn(ITEM.APPLE, 1, first);
    pickups.spawn(ITEM.COAL, 1, second);
    const before = pickups.serialize();
    const instance = new THREE.Matrix4();
    let previousOrigin;
    for (const player of [
      first,
      { ...first, x: first.x + CHUNK_SIZE + 1, z: first.z - CHUNK_SIZE - 1 },
    ]) {
      pickups.update(0, 0, player);
      scene.updateMatrixWorld(true);
      const origin = pickups.mesh.position;
      assert.equal(Math.abs(origin.x % CHUNK_SIZE), 0);
      assert.equal(Math.abs(origin.z % CHUNK_SIZE), 0);
      assert.ok(Math.abs(origin.x - player.x) < CHUNK_SIZE);
      assert.ok(Math.abs(origin.z - player.z) < CHUNK_SIZE);
      if (previousOrigin) assert.notDeepEqual(origin.toArray(), previousOrigin);
      previousOrigin = origin.toArray();
      const rendered = [first, second].map((expected, index) => {
        pickups.mesh.getMatrixAt(index, instance);
        assert.ok(Math.abs(instance.elements[12]) < CHUNK_SIZE * 3);
        assert.ok(Math.abs(instance.elements[14]) < CHUNK_SIZE * 3);
        const center = new THREE.Vector3()
          .setFromMatrixPosition(instance)
          .applyMatrix4(pickups.mesh.matrixWorld);
        assert.ok(Math.abs(center.x - expected.x) < 1e-6);
        assert.ok(Math.abs(center.z - expected.z) < 1e-6);
        return center;
      });
      assert.equal(rendered[1].x - rendered[0].x, 0.5);
      assert.equal(rendered[1].z - rendered[0].z, 0.5);
      assert.deepEqual(pickups.serialize(), before);
    }
    assert.ok(queries.every(([, x]) => Math.abs(x) >= 28_000_000));
    const collected = [];
    pickups.update(1 / 60, 0, first, {
      add: (...args) => (collected.push(args), true),
    });
    assert.deepEqual(collected, [
      [ITEM.APPLE, 1],
      [ITEM.COAL, 1],
    ]);
    assert.equal(
      pickups.size,
      0,
      "collection still uses the unchanged world positions"
    );
  }
});

test("gravity lands on terrain using integer queries at negative fractional coordinates", (t) => {
  const { pickups, queries } = setup(t);
  const origin = { x: -0.1, y: 18.5, z: -0.2 };
  pickups.spawn(BLOCK.STONE, 1, origin);
  for (let i = 0; i < 120; i++) pickups.update(1 / 30, i / 30, origin);
  const settled = drops(pickups)[0];
  assert.ok(settled.y >= 9 && settled.y < 9.3);
  assert.equal(settled.x, origin.x);
  assert.equal(settled.z, origin.z);
  assert.ok(queries.some(([kind, x]) => kind === "loaded" && x === -1));
  assert.ok(queries.some(([kind]) => kind === "solid"));
  assert.equal(total(pickups), 1);
});

test("swept falls cannot tunnel through a thin platform after stalled frames", (t) => {
  const { pickups, world } = setup(t);
  world.solid = (_x, y) => y === 50;
  const origin = { ...position, y: 80 };
  pickups.spawn(ITEM.DIAMOND, 1, origin);
  for (let i = 0; i < 60; i++) {
    pickups.update(30, i * 30, origin);
    assert.ok(drops(pickups)[0].y > 51);
  }
  assert.ok(drops(pickups)[0].y < 51.3);
});

test("upward toss respects ceilings and newly placed blocks cannot bury drops", (t) => {
  const { pickups, world } = setup(t);
  world.solid = (_x, y) => y <= 8 || y === 11;
  pickups.spawn(BLOCK.STONE, 1, { ...position, y: 10.75 });
  for (let i = 0; i < 30; i++) {
    pickups.update(0.01, i / 100, position);
    assert.ok(drops(pickups)[0].y + 0.14 <= 11 + 1e-6);
  }
  world.solid = (_x, y) => y <= 10;
  pickups.update(0.05, 1, position);
  assert.ok(drops(pickups)[0].y > 11);
  world.solid = (_x, y) => y <= 8;
  for (let i = 0; i < 30; i++) pickups.update(0.05, 2, position);
  assert.ok(drops(pickups)[0].y >= 9 && drops(pickups)[0].y < 9.3);
  assert.equal(total(pickups), 1);
});

test("gentle bob changes the rendered center without moving saved physics positions", (t) => {
  const { pickups } = setup(t);
  pickups.spawn(ITEM.COAL, 1, position);
  for (let i = 0; i < 60; i++) pickups.update(0.05, i / 20, position);
  const before = pickups.serialize();
  const matrix = new THREE.Matrix4();
  const heights = [];
  for (const elapsed of [0, 0.7, 1.4]) {
    pickups.update(0, elapsed, position);
    pickups.mesh.getMatrixAt(0, matrix);
    heights.push(matrix.elements[13]);
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.01);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 0.1);
  assert.deepEqual(pickups.serialize(), before);
});

test("only nearby successful additions remove drops and notify after updating the mesh", (t) => {
  const events = [];
  const { pickups } = setup(t, {
    onCollect(id, count) {
      assert.equal(pickups.size, 0);
      assert.equal(pickups.mesh.count, 0);
      events.push([id, count]);
    },
  });
  const added = [];
  const gameplay = { add: (...args) => (added.push(args), true) };
  const at = { ...position, y: 9.14 };
  pickups.spawn(ITEM.APPLE, 3, at, { velocity: { x: 0, y: 0, z: 0 } });
  pickups.update(1 / 60, 0, { ...at, x: at.x + 1.81 }, gameplay);
  pickups.update(1 / 60, 0, { ...at, y: at.y + 1.81 }, gameplay);
  assert.equal(added.length, 0, "pickup distance is three-dimensional");
  pickups.update(1 / 60, 0, { ...at, x: at.x + 1.8 }, gameplay);
  assert.deepEqual(added, [[ITEM.APPLE, 3]]);
  assert.deepEqual(events, added);
  pickups.update(1, 1, position, gameplay);
  assert.equal(added.length, 1);
});

test("full inventories retain every stack, retry on a cooldown, and throttle full notices", (t) => {
  const full = [];
  const collected = [];
  const { pickups } = setup(t, {
    onFull: (...args) => full.push(args),
    onCollect: (...args) => collected.push(args),
  });
  let attempts = 0;
  let accepts = false;
  const gameplay = { add: () => (attempts++, accepts) };
  pickups.spawn(BLOCK.STONE, 1, position);
  pickups.spawn(ITEM.COAL, 2, position);
  pickups.update(1 / 60, 0, position, gameplay);
  assert.equal(attempts, 2);
  assert.equal(full.length, 1);
  for (let i = 0; i < 60; i++)
    pickups.update(0.01, i / 100, position, gameplay);
  assert.equal(attempts, 2, "not a failed add on every frame");
  assert.equal(total(pickups), 3);
  pickups.update(0.5, 1.1, position, gameplay);
  assert.equal(attempts, 4);
  assert.equal(full.length, 1);
  pickups.update(2, 3.1, position, gameplay);
  assert.equal(attempts, 6);
  assert.equal(full.length, 2);
  accepts = true;
  pickups.update(1, 4.1, position, gameplay);
  assert.deepEqual(collected, [
    [BLOCK.STONE, 1],
    [ITEM.COAL, 2],
  ]);
  assert.equal(pickups.size, 0);
});

test("real Gameplay inventory exhaustion conserves the entire dropped count", (t) => {
  const { pickups } = setup(t);
  const gameplay = new Gameplay({
    coordinator: pickups.coordinator,
    context: pickups.world,
  });
  t.after(() => gameplay.dispose());
  const stack = getItem(BLOCK.STONE).stackSize;
  assert.equal(gameplay.add(BLOCK.STONE, stack * 35), true);
  pickups.spawn(ITEM.COAL, stack, position);
  pickups.update(1 / 60, 0, position, gameplay);
  assert.equal(gameplay.count(ITEM.COAL), 0);
  assert.equal(total(pickups), stack);
  gameplay.consume(BLOCK.STONE, 1);
  pickups.update(1, 1, position, gameplay);
  assert.equal(
    total(pickups),
    stack,
    "partially empty slots cannot swallow a stack"
  );
  gameplay.consume(BLOCK.STONE, stack - 1);
  pickups.update(1, 2, position, gameplay);
  assert.equal(gameplay.count(ITEM.COAL), stack);
  assert.equal(pickups.size, 0);
});

test("durability follows every split tool and never merges differently worn tools", (t) => {
  const { pickups } = setup(t);
  const id = ITEM.IRON_PICKAXE;
  const maximum = getItem(id).durability;
  const durability = [1, maximum - 1, maximum];
  assert.equal(pickups.spawn(id, 3, position, { durability }), true);
  assert.equal(pickups.spawn(id, 1, position, { durability: [7] }), true);
  assert.equal(pickups.spawn(id, 1, position), true);
  assert.equal(pickups.size, 5);
  assert.deepEqual(
    drops(pickups).map((drop) => [drop.count, drop.durability]),
    [
      [1, [1]],
      [1, [maximum - 1]],
      [1, [maximum]],
      [1, [7]],
      [1, undefined],
    ]
  );
  durability[0] = 0;
  assert.equal(drops(pickups)[0].durability[0], 1);
  const saved = pickups.serialize();
  saved.items[0].durability[0] = maximum;
  assert.equal(drops(pickups)[0].durability[0], 1, "save arrays are copies");
  assert.equal(Object.hasOwn(saved.items[4], "durability"), false);
});

test("invalid durability and full-pool spawns leave every existing drop unchanged", (t) => {
  const { pickups } = setup(t);
  const id = ITEM.WOOD_AXE;
  const maximum = getItem(id).durability;
  pickups.spawn(id, 1, position, { durability: [5] });
  pickups.spawn(BLOCK.STONE, 1, position);
  const before = pickups.serialize();
  for (const durability of [
    null,
    [],
    [1, 2],
    [0],
    [-1],
    [0.5],
    ["1"],
    [Number.NaN],
    [Infinity],
    [maximum + 1],
    new Array(1),
    new Uint16Array([1]),
    { 0: 1, length: 1 },
  ]) {
    assert.equal(pickups.spawn(id, 1, position, { durability }), false);
    assert.deepEqual(pickups.serialize(), before);
  }
  for (const options of [null, [], 1, "durability"]) {
    assert.equal(pickups.spawn(id, 1, position, options), false);
    assert.deepEqual(pickups.serialize(), before);
  }
  assert.equal(pickups.spawn(id, 2, position, { durability: [1] }), false);
  assert.equal(
    pickups.spawn(BLOCK.STONE, 1, position, { durability: [1] }),
    false
  );
  assert.deepEqual(
    pickups.serialize(),
    before,
    "invalid wear cannot merge into an existing stack"
  );
  pickups.spawn(id, MAX_PICKUPS - pickups.size, position);
  const full = pickups.serialize();
  assert.equal(
    pickups.spawn(id, 1, position, { durability: [maximum] }),
    false
  );
  assert.deepEqual(pickups.serialize(), full);
});

test("durability round-trips across dimensions while legacy drops keep default wear", (t) => {
  const { pickups, world } = setup(t);
  const id = ITEM.IRON_SWORD;
  pickups.spawn(id, 2, position, { durability: [2, 17] });
  pickups.spawn(id, 1, position);
  world.dimension = "nether";
  pickups.spawn(ITEM.IRON_ARMOR, 1, position, { durability: [3] });
  const saved = JSON.parse(JSON.stringify(pickups.serialize()));
  const other = setup(t);
  assert.equal(other.pickups.load(saved), true);
  assert.deepEqual(other.pickups.serialize(), saved);
  saved.items[0].durability[0] = 100;
  assert.deepEqual(drops(other.pickups)[0].durability, [2]);
  const received = [];
  const notices = [];
  other.pickups.onCollect = (...args) => notices.push(args);
  other.pickups.update(1 / 60, 0, position, {
    add: (...args) => (received.push(args), true),
  });
  assert.deepEqual(received, [
    [id, 1, { durability: [2] }],
    [id, 1, { durability: [17] }],
    [id, 1],
  ]);
  assert.deepEqual(notices, [
    [id, 1],
    [id, 1],
    [id, 1],
  ]);
  assert.equal(other.pickups.size, 1, "the other dimension's armor remains");
  other.world.dimension = "nether";
  other.pickups.update(1 / 60, 0, position, {
    add: (...args) => (received.push(args), true),
  });
  assert.deepEqual(received.at(-1), [ITEM.IRON_ARMOR, 1, { durability: [3] }]);
  assert.equal(other.pickups.size, 0);
});

test("failed collection retains durability through cooldowns and passes an owned copy", (t) => {
  const { pickups } = setup(t);
  const id = ITEM.DIAMOND_PICKAXE;
  pickups.spawn(id, 1, position, { durability: [19] });
  let attempts = 0;
  const gameplay = {
    add(receivedId, count, options) {
      assert.equal(receivedId, id);
      assert.equal(count, 1);
      assert.deepEqual(options, { durability: [19] });
      options.durability[0] = 1;
      return ++attempts > 1;
    },
  };
  pickups.update(1 / 60, 0, position, gameplay);
  assert.deepEqual(drops(pickups)[0].durability, [19]);
  pickups.update(0.2, 0.2, position, gameplay);
  assert.equal(attempts, 1);
  pickups.update(1, 1.2, position, gameplay);
  assert.equal(attempts, 2);
  assert.equal(pickups.size, 0);
});

test("real Gameplay preserves worn tool durability through partial inventory recovery", (t) => {
  const { pickups } = setup(t);
  const gameplay = new Gameplay({
    coordinator: pickups.coordinator,
    context: pickups.world,
  });
  t.after(() => gameplay.dispose());
  const id = ITEM.IRON_PICKAXE;
  const maximum = getItem(id).durability;
  const stack = getItem(BLOCK.STONE).stackSize;
  assert.equal(gameplay.add(BLOCK.STONE, stack * 34), true);
  assert.equal(gameplay.add(id, 1), true);
  const originalToolSlot = gameplay
    .getState()
    .slots.findIndex((slot) => slot?.id === id);
  assert.equal(
    pickups.spawn(id, 2, position, { durability: [3, maximum - 2] }),
    true
  );
  pickups.update(1 / 60, 0, position, gameplay);
  assert.equal(pickups.size, 2);
  assert.deepEqual(gameplay.serialize().durability[id], [maximum]);
  gameplay.consume(BLOCK.STONE, stack);
  pickups.update(1, 1, position, gameplay);
  assert.deepEqual(
    [...gameplay.serialize().durability[id]].sort((a, b) => a - b),
    [3, maximum]
  );
  assert.equal(gameplay.getState().slots[originalToolSlot].durability, maximum);
  assert.deepEqual(
    drops(pickups).map((drop) => drop.durability),
    [[maximum - 2]]
  );
  gameplay.consume(BLOCK.STONE, stack);
  pickups.update(1, 2, position, gameplay);
  assert.deepEqual(
    [...gameplay.serialize().durability[id]].sort((a, b) => a - b),
    [3, maximum - 2, maximum]
  );
  assert.equal(gameplay.getState().slots[originalToolSlot].durability, maximum);
  assert.equal(pickups.size, 0);
  gameplay.consume(BLOCK.STONE, stack);
  pickups.spawn(id, 1, position);
  pickups.update(1 / 60, 2, position, gameplay);
  assert.deepEqual(
    [...gameplay.serialize().durability[id]].sort((a, b) => a - b),
    [3, maximum - 2, maximum, maximum]
  );
  assert.equal(gameplay.getState().slots[originalToolSlot].durability, maximum);
  assert.equal(gameplay.count(id), 4);
});

test("invalid saved durability is rejected atomically without partial replacement", (t) => {
  const { pickups } = setup(t);
  const id = ITEM.BOW;
  const maximum = getItem(id).durability;
  pickups.spawn(id, 1, position, { durability: [23] });
  const before = pickups.serialize();
  const valid = before.items[0];
  for (const durability of [
    null,
    [],
    [1, 2],
    [0],
    [-1],
    [0.5],
    ["1"],
    [Number.NaN],
    [Infinity],
    [maximum + 1],
    new Array(1),
    new Uint16Array([1]),
  ]) {
    assert.equal(
      pickups.load({
        version: 1,
        items: [
          { ...valid, durability: [maximum] },
          { ...valid, durability },
        ],
      }),
      false
    );
    assert.deepEqual(pickups.serialize(), before);
  }
  assert.equal(
    pickups.load({
      version: 1,
      items: [{ ...valid, id: ITEM.APPLE, durability: [1] }],
    }),
    false
  );
  assert.deepEqual(pickups.serialize(), before);
});

test("dead players cannot collect drops or trigger inventory-full notifications", (t) => {
  const { pickups } = setup(t, {
    onFull: () => assert.fail("unexpected notice"),
  });
  pickups.spawn(ITEM.APPLE, 1, position);
  pickups.update(1 / 60, 0, position, {
    dead: true,
    add: () => assert.fail("dead player must not receive items"),
  });
  assert.equal(pickups.size, 1);
});

test("dimension switches preserve all records and never merge or collect across dimensions", (t) => {
  const { pickups, world, queries } = setup(t);
  pickups.spawn(BLOCK.STONE, 3, position);
  world.dimension = "nether";
  pickups.spawn(BLOCK.STONE, 4, position);
  const before = pickups.serialize();
  pickups.update(0, 0, position);
  assert.equal(pickups.mesh.count, 1);
  assert.deepEqual(pickups.serialize(), before);
  world.dimension = "end";
  const queryCount = queries.length;
  pickups.update(10, 10, position);
  assert.equal(queries.length, queryCount);
  assert.equal(pickups.mesh.count, 0);
  assert.deepEqual(pickups.serialize(), before);
  const added = [];
  const gameplay = { add: (...args) => (added.push(args), true) };
  world.dimension = "overworld";
  pickups.update(1 / 60, 0, position, gameplay);
  assert.deepEqual(added, [[BLOCK.STONE, 3]]);
  assert.equal(total(pickups), 4);
  world.dimension = "nether";
  pickups.update(1 / 60, 0, position, gameplay);
  assert.deepEqual(added, [
    [BLOCK.STONE, 3],
    [BLOCK.STONE, 4],
  ]);
});

test("unloaded, partially loaded, and distant drops freeze without terrain generation", (t) => {
  const { pickups, world, queries } = setup(t);
  const origin = { x: 0.05, y: 18.5, z: 0.05 };
  pickups.spawn(BLOCK.STONE, 1, origin);
  const before = pickups.serialize();
  world.loaded = (x, z) => x === 0 && z === 0;
  pickups.update(10, 10, origin);
  assert.deepEqual(pickups.serialize(), before);
  assert.equal(pickups.mesh.count, 0);
  assert.ok(queries.every(([kind]) => kind === "loaded"));
  world.loaded = () => true;
  const queryCount = queries.length;
  pickups.update(10, 20, { ...origin, x: 2000 });
  pickups.update(10, 30);
  assert.equal(queries.length, queryCount);
  assert.deepEqual(pickups.serialize(), before);
  pickups.update(0.05, 31, origin);
  assert.notEqual(drops(pickups)[0].y, origin.y);
  assert.equal(pickups.mesh.count, 1);
  world.loaded = () => false;
  const paused = pickups.serialize();
  pickups.update(1000, 1000, origin);
  assert.deepEqual(pickups.serialize(), paused);
  assert.equal(pickups.mesh.count, 0);
});

test("saves round-trip all dimensions without sharing mutable records", (t) => {
  const { pickups, world } = setup(t);
  for (const dimension of ["overworld", "nether", "end"]) {
    world.dimension = dimension;
    pickups.spawn(ITEM.EGG, 17, position);
  }
  const saved = JSON.parse(JSON.stringify(pickups.serialize()));
  const other = setup(t);
  other.world.dimension = "end";
  assert.equal(other.pickups.load(saved), true);
  assert.deepEqual(other.pickups.serialize(), saved);
  other.pickups.update(0, 0, position);
  assert.equal(other.pickups.mesh.count, 2);
  assert.equal(other.pickups.size, 6);
  saved.items[0].count = 1;
  assert.equal(drops(other.pickups)[0].count, 16);
  const exported = other.pickups.serialize();
  exported.items[0].x = 100;
  assert.equal(drops(other.pickups)[0].x, position.x);
});

test("save validation is atomic for malformed dimensions, counts, coordinates, and capacity", (t) => {
  const { pickups } = setup(t);
  pickups.spawn(ITEM.APPLE, 2, position);
  const before = pickups.serialize();
  const valid = before.items[0];
  for (const invalid of [
    null,
    [],
    {},
    { version: 2, items: [] },
    { version: 1, items: {} },
    { version: 1, items: Array(MAX_PICKUPS + 1).fill(valid) },
  ]) {
    assert.equal(pickups.load(invalid), false);
    assert.deepEqual(pickups.serialize(), before);
  }
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, dimension: "the_void" },
    { ...valid, id: 0 },
    { ...valid, id: "285" },
    { ...valid, id: 99999 },
    { ...valid, count: 0 },
    { ...valid, count: 1.5 },
    { ...valid, count: Infinity },
    { ...valid, count: getItem(ITEM.APPLE).stackSize + 1 },
    { ...valid, id: ITEM.WOOD_PICKAXE, count: 2 },
    { ...valid, x: WORLD_MAX },
    { ...valid, x: WORLD_MIN - 1 },
    { ...valid, z: Number.NaN },
    { ...valid, y: -1 },
    { ...valid, y: MAX_LOOSE_Y + 1 },
  ]) {
    assert.equal(pickups.load({ version: 1, items: [valid, invalid] }), false);
    assert.deepEqual(pickups.serialize(), before);
  }
  assert.equal(pickups.load({ version: 1, items: [] }), true);
  assert.equal(pickups.size, 0);
});

test("world-height terrain and empty voids retain valid, reloadable drops indefinitely", (t) => {
  const { pickups, world } = setup(t);
  world.solid = (_x, y) => y === WORLD_HEIGHT - 1;
  const high = { ...position, y: WORLD_HEIGHT + 0.6 };
  assert.equal(pickups.spawn(ITEM.DIAMOND, 1, high), true);
  for (let i = 0; i < 40; i++) pickups.update(0.1, i / 10, high);
  assert.ok(drops(pickups)[0].y > WORLD_HEIGHT);
  assert.ok(drops(pickups)[0].y < WORLD_HEIGHT + 0.3);
  assert.equal(pickups.load(pickups.serialize()), true);
  world.solid = () => false;
  for (let i = 0; i < 150; i++) pickups.update(10, i * 10, high);
  assert.ok(drops(pickups)[0].y >= 0 && drops(pickups)[0].y < 0.3);
  assert.equal(total(pickups), 1);
  assert.equal(pickups.load(pickups.serialize()), true);
});

test("invalid frame inputs cannot poison drop positions or instance matrices", (t) => {
  const { pickups } = setup(t);
  pickups.spawn(ITEM.APPLE, 1, position);
  for (const dt of [Number.NaN, Infinity, -1, 0, Number.MAX_VALUE]) {
    for (const elapsed of [Number.NaN, Infinity, Number.MAX_VALUE]) {
      pickups.update(dt, elapsed, position);
      assert.ok(
        Object.values(drops(pickups)[0]).every(
          (value) => typeof value !== "number" || Number.isFinite(value)
        )
      );
      assert.ok([...pickups.mesh.instanceMatrix.array].every(Number.isFinite));
    }
  }
  const before = pickups.serialize();
  pickups.update(10, 10, { ...position, x: Number.NaN });
  assert.deepEqual(pickups.serialize(), before);
  assert.equal(pickups.mesh.count, 0);
});

test("collection callbacks can spawn another drop without corrupting iteration", (t) => {
  const { pickups } = setup(t);
  pickups.onCollect = (id) => {
    if (id === BLOCK.STONE)
      assert.equal(pickups.spawn(ITEM.APPLE, 1, position), true);
  };
  pickups.spawn(BLOCK.STONE, 1, position);
  const added = [];
  const gameplay = { add: (...args) => (added.push(args), true) };
  pickups.update(1 / 60, 0, position, gameplay);
  assert.equal(pickups.size, 1);
  assert.deepEqual(added, [[BLOCK.STONE, 1]]);
  pickups.update(1 / 60, 0, position, gameplay);
  assert.deepEqual(added, [
    [BLOCK.STONE, 1],
    [ITEM.APPLE, 1],
  ]);
  assert.equal(pickups.size, 0);
});

test("dispose releases the mesh, geometry, and material exactly once", (t) => {
  const { pickups, scene } = setup(t);
  pickups.spawn(ITEM.APPLE, 1, position);
  pickups.update(0, 0, position);
  let disposed = 0;
  for (const resource of [pickups.mesh, pickups.geometry, pickups.material])
    resource.addEventListener("dispose", () => disposed++);
  pickups.dispose();
  pickups.dispose();
  pickups.update(1, 1, position);
  assert.equal(disposed, 3);
  assert.equal(scene.children.length, 0);
  assert.equal(pickups.mesh.count, 0);
  assert.equal(pickups.size, 0);
  assert.equal(pickups.spawn(ITEM.APPLE, 1, position), false);
  assert.equal(pickups.load({ version: 1, items: [] }), false);
});
