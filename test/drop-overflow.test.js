import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import {
  MAX_LOOSE_SPEED,
  MAX_LOOSE_Y,
  MAX_PICKUP_DELAY,
} from "../src/loose-entity.js";
import { MAX_PICKUPS, Pickups } from "../src/pickups.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";

const world = {
  dimension: "overworld",
  isLoaded: () => true,
  isSolid: (_x, y) => y === 0,
  get: (_x, y) => (y === 0 ? BLOCK.STONE : 0),
};
const at = { x: 0.5, y: 1.5, z: 0.5 };
const total = (items) => items.reduce((sum, item) => sum + item.count, 0);

test("a full chest retains every worn tool when both backpack and pickup pool fill", () => {
  const pickups = new Pickups(new THREE.Scene(), world);
  const game = new Gameplay();
  game.consume(ITEM.APPLE, 4);
  assert.equal(game.add(BLOCK.DIRT, 36 * 64), true);
  assert.equal(pickups.spawn(ITEM.WOOD_PICKAXE, 248, at), true);
  const overflow = new DropOverflow();
  assert.equal(
    overflow.enqueue(
      [{ id: ITEM.WOOD_PICKAXE, count: 27, durability: Array(27).fill(39) }],
      at,
      "overworld"
    ),
    true
  );
  for (let i = 0; i < 20; i++) {
    overflow.flush(world, pickups);
    pickups.update(0.01, i, { x: 0.5, y: 1, z: 0.5 }, game);
  }
  assert.equal(
    total(pickups.serialize().items) + total(overflow.serialize().entries),
    275
  );
  const restored = new DropOverflow();
  assert.equal(
    restored.load(JSON.parse(JSON.stringify(overflow.serialize()))),
    true
  );
  assert.equal(total(restored.serialize().entries), 19);
  const retainedWear = [
    ...pickups.serialize().items.flatMap((item) => item.durability ?? []),
    ...restored
      .serialize()
      .entries.flatMap((entry) => Array(entry.count).fill(entry.wear)),
  ];
  assert.equal(retainedWear.filter((wear) => wear === 39).length, 27);
  pickups.dispose();
});

test("queued loot drains only into its own loaded dimension and preserves wear options", () => {
  const overflow = new DropOverflow();
  overflow.enqueue(
    [{ id: ITEM.WOOD_PICKAXE, count: 2, durability: [20, 30] }],
    at,
    "nether"
  );
  const received = [];
  const sink = {
    spawn: (...args) => {
      received.push(args);
      return true;
    },
  };
  assert.equal(overflow.flush(world, sink), 0);
  assert.equal(overflow.size, 2);
  overflow.flush({ ...world, dimension: "nether" }, sink);
  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((args) => args[3].durability[0]),
    [20, 30]
  );
  assert.equal(overflow.size, 0);
});

test("invalid overflow batches and saves do not partially mutate retained resources", () => {
  const overflow = new DropOverflow();
  overflow.enqueue([{ id: BLOCK.PLANKS, count: 10 }], at, "overworld");
  const before = overflow.serialize();
  assert.equal(
    overflow.enqueue(
      [
        { id: BLOCK.PLANKS, count: 1 },
        { id: -1, count: 3 },
      ],
      at,
      "overworld"
    ),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
  assert.equal(
    overflow.load({
      version: 1,
      entries: [{ ...before.entries[0], wear: 30 }],
    }),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
});

test("batch capacity refusal rolls back earlier merges and newly planned records", () => {
  const overflow = new DropOverflow({ maxEntries: 2 });
  const entry = { id: BLOCK.STONE, count: 3, ...at, dimension: "overworld" };
  assert.equal(overflow.addBatch([entry]), true);
  const before = overflow.serialize();
  assert.equal(
    overflow.addBatch([
      { ...entry, count: 4 },
      { ...entry, id: ITEM.COAL },
      { ...entry, id: ITEM.APPLE },
    ]),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
  assert.equal(overflow.addBatch([{ ...entry, id: ITEM.COAL }]), true);
  const full = overflow.serialize();
  assert.equal(overflow.size, 2);
  assert.equal(overflow.addBatch([{ ...entry, id: ITEM.APPLE }]), false);
  assert.deepEqual(overflow.serialize(), full);
  assert.equal(overflow.addBatch([{ ...entry, count: 1 }]), true);
  assert.equal(overflow.serialize().entries[0].count, 4);
});

test("all batch ownership is retained before a nearly full visible pool accepts only its first stack", (t) => {
  const pickups = new Pickups(new THREE.Scene(), world);
  t.after(() => pickups.dispose());
  assert.equal(pickups.spawn(ITEM.WOOD_PICKAXE, MAX_PICKUPS - 1, at), true);
  const overflow = new DropOverflow();
  const velocity = { x: 4, y: 2, z: -1 };
  const owned = [
    { id: ITEM.IRON_PICKAXE, count: 1, durability: 2 },
    { id: ITEM.IRON_PICKAXE, count: 1, durability: 17 },
    { id: ITEM.COAL, count: 64 },
  ];
  const visibleBefore = pickups.serialize();
  assert.equal(
    overflow.addBatch(
      owned.map((stack) => ({
        ...stack,
        ...at,
        dimension: "overworld",
        pickupDelay: 2,
        velocity,
      }))
    ),
    true
  );
  assert.deepEqual(
    pickups.serialize(),
    visibleBefore,
    "retention does not spawn"
  );
  assert.equal(total(overflow.serialize().entries), 66);
  assert.equal(overflow.flush(world, pickups, 8), 1);
  assert.equal(pickups.size, MAX_PICKUPS);
  assert.equal(total(overflow.serialize().entries), 65);
  const after = {
    pickups: pickups.serialize(),
    overflow: overflow.serialize(),
  };
  for (let i = 0; i < 8; i++) assert.equal(overflow.flush(world, pickups), 0);
  assert.deepEqual(pickups.serialize(), after.pickups);
  assert.deepEqual(overflow.serialize(), after.overflow);
  assert.equal(
    total(after.pickups.items) + total(after.overflow.entries),
    MAX_PICKUPS - 1 + 66
  );
  const restored = new DropOverflow();
  assert.equal(restored.load(JSON.parse(JSON.stringify(after.overflow))), true);
  assert.deepEqual(restored.serialize(), after.overflow);
  const worn = after.pickups.items.find(
    (item) => item.id === ITEM.IRON_PICKAXE
  );
  assert.deepEqual(worn.durability, [2]);
  assert.equal(worn.pickupDelay, 2);
  assert.deepEqual(worn.velocity, velocity);
  assert.equal(after.overflow.entries[0].wear, 17);
});

test("canonical scalar wear and old arrays conserve every duplicate tool through round-robin flushing", () => {
  const overflow = new DropOverflow();
  const entry = {
    id: ITEM.WOOD_PICKAXE,
    count: 1,
    ...at,
    dimension: "overworld",
    pickupDelay: 2,
    velocity: { x: 3, y: 2, z: 1 },
  };
  assert.equal(
    overflow.addBatch([
      { ...entry, durability: 7 },
      { ...entry, durability: 13 },
      { ...entry, count: 3, durability: [7, 13, 7] },
      entry,
    ]),
    true
  );
  const before = overflow.serialize();
  assert.equal(
    overflow.addBatch([{ ...entry, count: 2, durability: 7 }]),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
  const received = [];
  const sink = {
    spawn(id, count, position, options) {
      assert.equal(id, entry.id);
      assert.equal(count, 1);
      assert.deepEqual(position, at);
      assert.equal(options.pickupDelay, 2);
      assert.deepEqual(options.velocity, entry.velocity);
      received.push(...options.durability);
      return true;
    },
  };
  for (let i = 0; i < 8; i++) overflow.flush(world, sink);
  assert.deepEqual(
    received.sort((a, b) => a - b),
    [7, 7, 7, 13, 13, getItem(entry.id).durability]
  );
  assert.equal(overflow.size, 0);
});

test("different heights, delays and throw directions keep distinct records and copy motion metadata", () => {
  const overflow = new DropOverflow();
  const velocity = { x: 3, y: 2, z: -1 };
  const entry = {
    id: ITEM.APPLE,
    count: 1,
    ...at,
    dimension: "overworld",
    pickupDelay: 2,
    velocity,
  };
  assert.equal(
    overflow.addBatch([
      entry,
      { ...entry, y: 250 },
      { ...entry, pickupDelay: 0 },
      { ...entry, velocity: { ...velocity, x: -3 } },
    ]),
    true
  );
  assert.equal(overflow.size, 4);
  velocity.x = 0;
  assert.equal(overflow.serialize().entries[0].velocity.x, 3);
  const saved = JSON.parse(JSON.stringify(overflow.serialize()));
  const restored = new DropOverflow();
  assert.equal(restored.load(saved), true);
  assert.deepEqual(restored.serialize(), saved);
  saved.entries[0].velocity.x = 0;
  assert.equal(restored.serialize().entries[0].velocity.x, 3);
  const exported = restored.serialize();
  exported.entries[0].velocity.y = 0;
  assert.equal(restored.serialize().entries[0].velocity.y, 2);
});

test("pickup and overflow paths accept the same high-altitude range and atomically reject invalid positions", (t) => {
  const pickups = new Pickups(new THREE.Scene(), world);
  t.after(() => pickups.dispose());
  const overflow = new DropOverflow();
  for (const position of [
    { ...at, y: 250 },
    { x: 29_000_000.25, y: 900.5, z: -29_000_000.25 },
    { ...at, y: MAX_LOOSE_Y },
  ]) {
    assert.equal(pickups.spawn(ITEM.APPLE, 1, position), true);
    assert.equal(
      overflow.enqueue([{ id: ITEM.APPLE, count: 1 }], position, "overworld"),
      true
    );
  }
  const before = {
    pickups: pickups.serialize(),
    overflow: overflow.serialize(),
  };
  for (const position of [
    null,
    {},
    [],
    { ...at, y: -1 },
    { ...at, y: MAX_LOOSE_Y + 1 },
    { ...at, y: Infinity },
    { ...at, x: WORLD_MIN - 1 },
    { ...at, x: WORLD_MAX },
    { ...at, z: NaN },
  ]) {
    assert.equal(pickups.spawn(ITEM.APPLE, 1, position), false);
    assert.equal(
      overflow.enqueue([{ id: ITEM.APPLE, count: 1 }], position, "overworld"),
      false
    );
    assert.deepEqual(pickups.serialize(), before.pickups);
    assert.deepEqual(overflow.serialize(), before.overflow);
  }
});

test("malformed motion, wear and batch records reject without any partial retention or replacement", () => {
  const overflow = new DropOverflow();
  const entry = { id: ITEM.WOOD_AXE, count: 1, ...at, dimension: "overworld" };
  overflow.addBatch([{ ...entry, durability: 3 }]);
  const before = overflow.serialize();
  const invalid = [
    null,
    [],
    {},
    { ...entry, id: 0 },
    { ...entry, id: "260" },
    { ...entry, count: 0 },
    { ...entry, count: NaN },
    { ...entry, dimension: "void" },
    ...[null, [], [0], new Array(1), [NaN], [Infinity], [1, 2]].map(
      (durability) => ({ ...entry, durability })
    ),
    ...[-1, Infinity, NaN, null, "2", MAX_PICKUP_DELAY + 1].map(
      (pickupDelay) => ({ ...entry, pickupDelay })
    ),
    ...[
      null,
      [],
      { x: 0, y: 0 },
      { x: NaN, y: 0, z: 0 },
      { x: 0, y: MAX_LOOSE_SPEED + 1, z: 0 },
    ].map((velocity) => ({ ...entry, velocity })),
  ];
  for (const bad of invalid) {
    assert.equal(overflow.addBatch([{ ...entry, durability: 3 }, bad]), false);
    assert.deepEqual(overflow.serialize(), before);
  }
  for (const bad of [
    null,
    [],
    { ...before.entries[0], pickupDelay: -1 },
    { ...before.entries[0], velocity: null },
    { ...before.entries[0], velocity: { x: 0, y: 0 } },
    { ...before.entries[0], wear: 0 },
    { ...before.entries[0], id: ITEM.APPLE },
    { ...before.entries[0], y: MAX_LOOSE_Y + 1 },
    before.entries[0],
  ]) {
    assert.equal(
      overflow.load({ version: 1, entries: [before.entries[0], bad] }),
      false
    );
    assert.deepEqual(overflow.serialize(), before);
  }
  for (const batch of [null, {}, "drops", [null], new Array(1)]) {
    assert.equal(overflow.addBatch(batch), false);
    assert.deepEqual(overflow.serialize(), before);
  }
});

test("safe-integer aggregate overflow refuses an entire batch rather than rounding away ownership", () => {
  const overflow = new DropOverflow();
  const entry = {
    id: ITEM.APPLE,
    count: Number.MAX_SAFE_INTEGER,
    ...at,
    dimension: "overworld",
  };
  assert.equal(overflow.addBatch([entry]), true);
  const before = overflow.serialize();
  assert.equal(
    overflow.addBatch([
      { ...entry, id: ITEM.COAL, count: 1 },
      { ...entry, count: 1 },
    ]),
    false
  );
  assert.deepEqual(overflow.serialize(), before);
});

test("flushing makes bounded deterministic progress past other dimensions without re-enqueueing", () => {
  const overflow = new DropOverflow();
  const remote = Array.from({ length: 70 }, (_, i) => ({
    id: ITEM.APPLE,
    count: 1,
    x: i + 20,
    y: at.y,
    z: at.z,
    dimension: "nether",
  }));
  overflow.addBatch([
    ...remote,
    { id: ITEM.COAL, count: 1, ...at, dimension: "overworld" },
  ]);
  const received = [];
  const sink = { spawn: (...args) => (received.push(args), true) };
  assert.equal(overflow.flush(world, sink, 1), 0);
  assert.equal(received.length, 0);
  assert.equal(overflow.flush(world, sink, 1), 1);
  assert.equal(received[0][0], ITEM.COAL);
  assert.equal(overflow.size, remote.length);
  const before = overflow.serialize();
  for (const budget of [0, -1, 0.5, NaN, Infinity])
    assert.equal(overflow.flush(world, sink, budget), 0);
  assert.deepEqual(overflow.serialize(), before);
  assert.equal(
    overflow.flush(
      { ...world, dimension: "nether", isLoaded: () => false },
      sink
    ),
    0
  );
  assert.deepEqual(overflow.serialize(), before);
});

test("legacy overflow snapshots default to an ordinary zero-delay toss", () => {
  const overflow = new DropOverflow();
  assert.equal(
    overflow.load({
      version: 1,
      entries: [
        { id: ITEM.BOW, count: 1, ...at, dimension: "overworld", wear: 9 },
      ],
    }),
    true
  );
  const received = [];
  overflow.flush(world, {
    spawn: (...args) => (received.push(args), true),
  });
  assert.deepEqual(received[0][3], {
    durability: [9],
    pickupDelay: 0,
    velocity: { x: 0, y: 2.2, z: 0 },
  });
});

test("legacy implicit-full and explicit-full tool wear remain separate without losing either tool", () => {
  const overflow = new DropOverflow();
  const entry = { id: ITEM.BOW, count: 1, ...at, dimension: "overworld" };
  const maximum = getItem(entry.id).durability;
  assert.equal(
    overflow.load({
      version: 1,
      entries: [entry, { ...entry, wear: maximum }],
    }),
    true
  );
  assert.equal(overflow.size, 2);
  const received = [];
  assert.equal(
    overflow.flush(world, {
      spawn: (...args) => (received.push(args), true),
    }),
    2
  );
  assert.deepEqual(
    received.map((args) => args[3].durability),
    [undefined, [maximum]]
  );
  assert.equal(overflow.size, 0);
});
