import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { CHEST_SLOTS, Settlement } from "../src/settlement.js";
import {
  ContainerWorld,
  containerFixture,
  dropCollector,
  editOwnership,
  moveIntoContainer,
  putPlayerStack,
} from "./container-fixture.js";

const stack = (id, count, durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
});
const click = (index, button = 0) => ({
  type: "click",
  area: "container",
  index,
  button,
});

test("component-v1 aggregates migrate to 27 slots with every tool's wear and crop field intact", () => {
  const settlement = new Settlement();
  const old = {
    version: 1,
    chests: ["overworld", "nether", "end"].map((dimension) => ({
      dimension,
      x: -17,
      y: 20,
      z: 33,
      items: [
        { id: BLOCK.DIRT, count: 130 },
        { id: ITEM.WOOD_PICKAXE, count: 2, durability: [7, 41] },
        { id: ITEM.IRON_ARMOR, count: 1, durability: [11] },
      ],
    })),
    crops: [
      { dimension: "overworld", x: -18, y: 21, z: 33, age: 12.75 },
      { dimension: "nether", x: 4, y: 22, z: -9, age: 45 },
      { dimension: "end", x: 4, y: 22, z: -9, age: 0 },
    ],
  };
  assert.equal(settlement.load(old), true);
  const saved = settlement.serialize();
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.furnaces, []);
  assert.deepEqual(saved.crops, old.crops);
  for (let index = 0; index < old.chests.length; index++) {
    const chest = saved.chests[index];
    const { items, ...position } = old.chests[index];
    assert.deepEqual(
      { dimension: chest.dimension, x: chest.x, y: chest.y, z: chest.z },
      position
    );
    assert.equal(chest.slots.length, CHEST_SLOTS);
    assert.deepEqual(chest.slots.filter(Boolean), [
      stack(BLOCK.DIRT, 64),
      stack(BLOCK.DIRT, 64),
      stack(BLOCK.DIRT, 2),
      stack(ITEM.WOOD_PICKAXE, 1, 7),
      stack(ITEM.WOOD_PICKAXE, 1, 41),
      stack(ITEM.IRON_ARMOR, 1, 11),
    ]);
    assert.equal(
      chest.slots.reduce((total, entry) => total + (entry?.count ?? 0), 0),
      items.reduce((total, item) => total + item.count, 0)
    );
  }
  old.chests[0].items[1].durability[0] = 1;
  assert.equal(settlement.serialize().chests[0].slots[3].durability, 7);
  const restored = new Settlement();
  assert.equal(restored.load(JSON.parse(JSON.stringify(saved))), true);
  assert.deepEqual(restored.serialize(), saved);
});

test("invalid v1 capacity, duplicate IDs, and malformed wear reject migration atomically", () => {
  const settlement = new Settlement();
  const valid = {
    version: 1,
    chests: [
      {
        dimension: "overworld",
        x: 0,
        y: 20,
        z: 0,
        items: [{ id: ITEM.WOOD_PICKAXE, count: 2, durability: [7, 41] }],
      },
    ],
    crops: [],
  };
  assert.equal(settlement.load(valid), true);
  const before = settlement.serialize();
  for (const alter of [
    (data) => {
      data.chests[0].items.push({ id: ITEM.WOOD_PICKAXE, count: 1 });
    },
    (data) => {
      data.chests[0].items[0].durability = [1];
    },
    (data) => {
      data.chests[0].items[0].durability = [0, 41];
    },
    (data) => {
      data.chests[0].items[0].durability = null;
    },
    (data) => {
      data.chests[0].items[0].durability = [7, "41"];
    },
    (data) => {
      data.chests[0].items = [{ id: BLOCK.DIRT, count: 64 * CHEST_SLOTS + 1 }];
    },
    (data) => {
      data.furnaces = [{ x: 1, y: 2, z: 3 }];
    },
  ]) {
    const invalid = structuredClone(valid);
    alter(invalid);
    assert.equal(settlement.load(invalid), false);
    assert.deepEqual(settlement.serialize(), before);
  }
});

test("left/right clicks split, place one, and merge without aggregate repacking", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(BLOCK.DIRT, 9));
  assert.equal(fixture.action(click(0, 2)).ok, true);
  assert.equal(fixture.game.getState().cursor.count, 5);
  assert.equal(fixture.state().slots[0].count, 4);
  assert.equal(fixture.action(click(1, 2)).ok, true);
  assert.equal(fixture.game.getState().cursor.count, 4);
  assert.equal(fixture.state().slots[1].count, 1);
  assert.equal(fixture.action(click(0)).ok, true);
  assert.equal(fixture.game.getState().cursor, null);
  assert.deepEqual(fixture.state().slots.slice(0, 2), [
    stack(BLOCK.DIRT, 8),
    stack(BLOCK.DIRT, 1),
  ]);
  const counts = fixture.settlement.getChest(fixture.world, fixture.hit);
  assert.equal(counts.get(BLOCK.DIRT), 9);
  assert.equal(counts.size, 1);
  assert.deepEqual([...counts], [[BLOCK.DIRT, 9]]);
  assert.deepEqual([...counts.keys()], [BLOCK.DIRT]);
  assert.deepEqual([...counts.values()], [9]);
  const visited = [];
  counts.forEach((count, id, map) => visited.push([id, count, map === counts]));
  assert.deepEqual(visited, [[BLOCK.DIRT, 9, true]]);
  assert.throws(() => counts.set(BLOCK.DIRT, 100), /read-only/);
  const detached = fixture.state();
  detached.slots[0].count = 64;
  detached.gameplay.cursor = stack(ITEM.DIAMOND, 64);
  assert.equal(counts.get(BLOCK.DIRT), 9);
  assert.equal(fixture.game.getState().cursor, null);
});

test("Shift transfer moves only the clicked stack in either direction", () => {
  const fixture = containerFixture();
  putPlayerStack(fixture.game, 9, stack(BLOCK.DIRT, 20));
  putPlayerStack(fixture.game, 10, stack(BLOCK.DIRT, 30));
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    true
  );
  assert.equal(fixture.game.getState().slots[9], null);
  assert.deepEqual(fixture.game.getState().slots[10], stack(BLOCK.DIRT, 30));
  assert.deepEqual(fixture.state().slots[0], stack(BLOCK.DIRT, 20));
  moveIntoContainer(fixture, 1, stack(BLOCK.DIRT, 12));
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "container",
      index: 1,
    }).ok,
    true
  );
  assert.equal(fixture.state().slots[1], null);
  assert.deepEqual(fixture.state().slots[0], stack(BLOCK.DIRT, 20));
  assert.equal(fixture.game.count(BLOCK.DIRT), 42);
});

test("a partial quick transfer debits only the amount the target can hold", () => {
  const fixture = containerFixture();
  const saved = fixture.settlement.serialize();
  const { dimension, x, y, z } = fixture.hit;
  saved.chests.push({
    dimension,
    x,
    y,
    z,
    slots: Array.from({ length: CHEST_SLOTS }, (_, index) =>
      stack(ITEM.COAL, index === 0 ? 63 : 64)
    ),
  });
  assert.equal(fixture.settlement.load(saved, { world: fixture.world }), true);
  putPlayerStack(fixture.game, 9, stack(ITEM.COAL, 8));
  putPlayerStack(fixture.game, 10, stack(ITEM.COAL, 13));
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    true
  );
  assert.equal(fixture.state().slots[0].count, 64);
  assert.equal(fixture.game.getState().slots[9].count, 7);
  assert.equal(fixture.game.getState().slots[10].count, 13);
});

test("27 individually worn tools fill all chest slots even when their ID is shared", () => {
  const fixture = containerFixture();
  const saved = fixture.settlement.serialize();
  const { dimension, x, y, z } = fixture.hit;
  saved.chests.push({
    dimension,
    x,
    y,
    z,
    slots: Array.from({ length: CHEST_SLOTS }, (_, index) =>
      stack(ITEM.WOOD_PICKAXE, 1, index + 1)
    ),
  });
  assert.equal(fixture.settlement.load(saved), true);
  putPlayerStack(fixture.game, 9, stack(ITEM.WOOD_PICKAXE, 1, 40));
  const before = fixture.snapshot();
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), before);
  assert.equal(
    fixture.settlement
      .getChest(fixture.world, fixture.hit)
      .get(ITEM.WOOD_PICKAXE),
    27
  );
});

test("number and F swaps preserve the exact clicked tool, offhand, and occupied cursor", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.WOOD_PICKAXE, 1, 7));
  moveIntoContainer(fixture, 1, stack(ITEM.WOOD_PICKAXE, 1, 41));
  editOwnership(fixture.game, (owned) => {
    owned.slots[0] = stack(ITEM.WOOD_PICKAXE, 1, 19);
    owned.offhand = stack(ITEM.WOOD_SWORD, 1, 12);
    owned.cursor = stack(BLOCK.DIRT, 2);
  });
  assert.equal(
    fixture.action({
      type: "swapHotbar",
      area: "container",
      index: 0,
      hotbarIndex: 0,
    }).ok,
    true
  );
  assert.deepEqual(
    fixture.game.getState().slots[0],
    stack(ITEM.WOOD_PICKAXE, 1, 7)
  );
  assert.deepEqual(fixture.state().slots[0], stack(ITEM.WOOD_PICKAXE, 1, 19));
  assert.equal(
    fixture.action({
      type: "swapOffhand",
      area: "container",
      index: 1,
    }).ok,
    true
  );
  assert.deepEqual(
    fixture.game.getState().offhand,
    stack(ITEM.WOOD_PICKAXE, 1, 41)
  );
  assert.deepEqual(fixture.state().slots[1], stack(ITEM.WOOD_SWORD, 1, 12));
  assert.deepEqual(fixture.game.getState().cursor, stack(BLOCK.DIRT, 2));
});

test("drag and double-click gathering preserve ownership across both container sides", () => {
  const fixture = containerFixture();
  editOwnership(fixture.game, (owned) => {
    owned.cursor = stack(ITEM.COAL, 11);
  });
  assert.equal(
    fixture.action({
      type: "distribute",
      button: 0,
      targets: [
        { area: "container", index: 0 },
        { area: "container", index: 1 },
        { area: "inventory", index: 9 },
      ],
    }).ok,
    true
  );
  assert.equal(fixture.state().slots[0].count, 3);
  assert.equal(fixture.state().slots[1].count, 3);
  assert.equal(fixture.game.getState().slots[9].count, 3);
  assert.equal(fixture.game.getState().cursor.count, 2);
  assert.equal(
    fixture.action({
      type: "collect",
      area: "container",
      index: 0,
    }).ok,
    true
  );
  assert.deepEqual(fixture.game.getState().cursor, stack(ITEM.COAL, 11));
  assert.equal(fixture.game.getState().slots[9], null);
  assert.ok(fixture.state().slots.every((slot) => slot === null));
});

test("double-click gathering also starts from an empty cursor after the second ordinary click", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.COAL, 7));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 5));
  putPlayerStack(fixture.game, 9, stack(ITEM.COAL, 3));
  assert.equal(
    fixture.action({
      type: "collect",
      area: "container",
      index: 0,
    }).ok,
    true
  );
  assert.deepEqual(fixture.game.getState().cursor, stack(ITEM.COAL, 15));
  assert.equal(fixture.game.count(ITEM.COAL), 0);
  assert.ok(fixture.state().slots.every((slot) => slot === null));
});

test("quick-moving one worn copy and releasing the other through block removal never duplicates tools", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.WOOD_PICKAXE, 1, 7));
  moveIntoContainer(fixture, 1, stack(ITEM.WOOD_PICKAXE, 1, 41));
  const counts = fixture.settlement.getChest(fixture.world, fixture.hit);
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "container",
      index: 1,
    }).ok,
    true
  );
  assert.deepEqual(fixture.game.getState().slots.filter(Boolean), [
    stack(ITEM.WOOD_PICKAXE, 1, 41),
  ]);
  assert.deepEqual(fixture.state().slots[0], stack(ITEM.WOOD_PICKAXE, 1, 7));
  fixture.world.set(fixture.hit.x, fixture.hit.y, fixture.hit.z, BLOCK.AIR);
  const before = fixture.snapshot();
  assert.deepEqual(
    fixture.settlement.removeChest(fixture.world, fixture.hit, {
      prepareDrops: () => null,
    }),
    []
  );
  assert.deepEqual(fixture.snapshot(), before);
  const retained = dropCollector(fixture.coordinator);
  const drops = fixture.settlement.removeChest(fixture.world, fixture.hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.deepEqual(drops, [stack(ITEM.WOOD_PICKAXE, 1, 7)]);
  assert.deepEqual(retained.drops, drops);
  assert.equal(counts.size, 0);
  assert.deepEqual(
    fixture.settlement.removeChest(fixture.world, fixture.hit),
    []
  );
});

test("invalid actions leave both participants unchanged", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.COAL, 4));
  const before = fixture.snapshot();
  for (const action of [
    null,
    {},
    { type: "unknown", area: "container", index: 0 },
    click(-1),
    click(CHEST_SLOTS),
    click(0, 1),
    { type: "quickMove", area: "container", index: 0.5 },
    { type: "swapHotbar", area: "container", index: 0, hotbarIndex: 9 },
    { type: "drop", area: "container", index: 0, wholeStack: "yes" },
    { type: "distribute", targets: {}, button: 0 },
  ]) {
    assert.equal(fixture.action(action).ok, false);
    assert.deepEqual(fixture.snapshot(), before);
  }
  for (const options of [null, false, [], 4]) {
    assert.equal(fixture.action(click(0), options).ok, false);
    assert.equal(
      fixture.settlement.removeContainer(fixture.world, fixture.hit, options)
        .ok,
      false
    );
    assert.deepEqual(fixture.snapshot(), before);
  }
});

test("world identity, loaded block, stale dimension, wrong block kind, and death gate transfers", () => {
  for (const invalidate of [
    (fixture) =>
      fixture.world.unloaded.add(
        fixture.world.column(fixture.hit.x, fixture.hit.z)
      ),
    (fixture) => {
      fixture.hit.dimension = "nether";
    },
    (fixture) => {
      fixture.hit.id = BLOCK.FURNACE;
    },
    (fixture) =>
      fixture.world.set(
        fixture.hit.x,
        fixture.hit.y,
        fixture.hit.z,
        BLOCK.STONE
      ),
    (fixture) => {
      fixture.world.seed = "different-archive";
    },
    (fixture) => fixture.game.damage(20),
  ]) {
    const fixture = containerFixture();
    moveIntoContainer(fixture, 0, stack(ITEM.COAL, 4));
    invalidate(fixture);
    const before = fixture.snapshot();
    assert.equal(fixture.action(click(0)).ok, false);
    assert.deepEqual(fixture.snapshot(), before);
  }
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.COAL, 4));
  const other = new ContainerWorld({ coordinator: fixture.coordinator });
  other.set(fixture.hit.x, fixture.hit.y, fixture.hit.z, BLOCK.CHEST);
  const before = fixture.snapshot();
  assert.equal(
    fixture.settlement.getContainerState(other, fixture.hit, fixture.game),
    null
  );
  assert.equal(
    fixture.settlement.containerAction(
      other,
      fixture.hit,
      fixture.game,
      click(0)
    ).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), before);
});

test("world changes before commit reject a completed draft without publishing either side", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.COAL, 4));
  const before = fixture.snapshot();
  const transaction = fixture.game.prepareInventory;
  fixture.game.prepareInventory = function (change, options) {
    return transaction.call(
      this,
      (owned) => {
        const result = change(owned);
        fixture.world.set(
          fixture.hit.x,
          fixture.hit.y,
          fixture.hit.z,
          BLOCK.AIR
        );
        return result;
      },
      options
    );
  };
  assert.equal(fixture.action(click(0)).ok, false);
  assert.deepEqual(fixture.snapshot(), before);
});

test("refused container drops and full-inventory cursor closes retain every item", () => {
  const fixture = containerFixture();
  moveIntoContainer(fixture, 0, stack(ITEM.WOOD_PICKAXE, 1, 7));
  const beforeDrop = fixture.snapshot();
  assert.equal(
    fixture.action(
      {
        type: "drop",
        area: "container",
        index: 0,
        wholeStack: true,
      },
      { prepareDrops: () => null }
    ).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), beforeDrop);
  assert.equal(fixture.action(click(0)).ok, true);
  editOwnership(fixture.game, (owned) => {
    owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
  });
  const beforeClose = fixture.snapshot();
  assert.equal(
    fixture.action({ type: "close" }, { prepareDrops: () => null }).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), beforeClose);
  const retained = dropCollector(fixture.coordinator);
  assert.equal(
    fixture.action(
      { type: "close" },
      {
        prepareDrops: retained.prepareDrops,
      }
    ).ok,
    true
  );
  assert.deepEqual(retained.drops, [stack(ITEM.WOOD_PICKAXE, 1, 7)]);
  assert.equal(fixture.game.getState().cursor, null);
});

test("creative transactions move finite stacks without changing the unlimited palette", () => {
  const fixture = containerFixture();
  putPlayerStack(fixture.game, 9, stack(ITEM.WOOD_PICKAXE, 1, 7));
  fixture.game.setMode("creative");
  fixture.game.assignSlot(2, BLOCK.DIAMOND_ORE);
  fixture.game.select(2);
  const palette = [...fixture.game.getState().hotbar];
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "inventory",
      index: 9,
    }).ok,
    true
  );
  assert.equal(fixture.game.count(ITEM.WOOD_PICKAXE), 0);
  assert.deepEqual(fixture.state().slots[0], stack(ITEM.WOOD_PICKAXE, 1, 7));
  assert.deepEqual(fixture.game.getState().hotbar, palette);
  assert.equal(fixture.game.getState().selected, 2);
  fixture.game.setMode("survival");
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "container",
      index: 0,
    }).ok,
    true
  );
  assert.deepEqual(
    fixture.game
      .getState()
      .slots.filter((slot) => slot?.id === ITEM.WOOD_PICKAXE),
    [stack(ITEM.WOOD_PICKAXE, 1, 7)]
  );
  assert.ok(getItem(ITEM.WOOD_PICKAXE).durability > 7);
});
