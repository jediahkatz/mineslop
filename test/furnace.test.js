import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  advanceFurnace,
  acceptsFurnaceStack,
  cloneFurnace,
  createFurnace,
  getSmeltingRecipe,
  isValidFurnace,
  syncFurnaceRecipe,
} from "../src/furnace.js";
import { ITEM } from "../src/items.js";
import { Settlement } from "../src/settlement.js";
import {
  containerFixture,
  dropCollector,
  editOwnership,
  experienceCollector,
  moveIntoContainer,
} from "./container-fixture.js";

const stack = (id, count) => ({ id, count });
const click = (index, button = 0) => ({
  type: "click",
  area: "container",
  index,
  button,
});

function furnaceWith(input, fuel = null, output = null) {
  const furnace = createFurnace();
  furnace.slots = [input, fuel, output];
  syncFurnaceRecipe(furnace);
  return furnace;
}

function at(fixture, hit) {
  return {
    ...fixture,
    hit,
    action: (action, options) =>
      fixture.settlement.containerAction(
        fixture.world,
        hit,
        fixture.game,
        action,
        options
      ),
    state: () =>
      fixture.settlement.getContainerState(fixture.world, hit, fixture.game),
  };
}

test("furnace time consumes real inputs and fuel, supports ore alternatives, and retains output XP", () => {
  const furnace = furnaceWith(stack(BLOCK.IRON_ORE, 2), stack(ITEM.COAL, 1));
  assert.equal(advanceFurnace(furnace, 4), true);
  assert.equal(furnace.cookTime, 4);
  assert.equal(furnace.burnTime, 76);
  assert.equal(furnace.slots[1], null);
  assert.equal(furnace.slots[0].count, 2);
  assert.equal(furnace.slots[2], null);
  assert.equal(advanceFurnace(furnace, 6), true);
  assert.deepEqual(furnace.slots[2], stack(ITEM.IRON_INGOT, 1));
  assert.equal(furnace.slots[0].count, 1);
  assert.equal(furnace.cookTime, 0);
  assert.equal(furnace.experience, 1);
  assert.equal(isValidFurnace(furnace), true);
});

test("empty fuel never consumes input; small fuel units can finish the same partial cook", () => {
  const furnace = furnaceWith(stack(ITEM.RAW_IRON, 1));
  const before = cloneFurnace(furnace);
  for (const dt of [0, -1, NaN, Infinity, "10", 10]) {
    assert.equal(advanceFurnace(furnace, dt), false);
    assert.deepEqual(furnace, before);
  }
  furnace.slots[1] = stack(ITEM.STICK, 1);
  advanceFurnace(furnace, 5);
  assert.equal(furnace.cookTime, 5);
  assert.equal(furnace.burnTime, 0);
  assert.equal(furnace.slots[0].count, 1);
  assert.equal(advanceFurnace(furnace, 20), false);
  assert.equal(furnace.cookTime, 5);
  furnace.slots[1] = stack(ITEM.STICK, 1);
  advanceFurnace(furnace, 5);
  assert.equal(furnace.slots[0], null);
  assert.deepEqual(furnace.slots[2], stack(ITEM.IRON_INGOT, 1));
  assert.equal(furnace.cookTime, 0);
});

test("mismatched and full output stop cooking without igniting fuel or destroying input", () => {
  for (const output of [
    stack(ITEM.GOLD_INGOT, 1),
    stack(ITEM.IRON_INGOT, 64),
  ]) {
    const furnace = furnaceWith(
      stack(ITEM.RAW_IRON, 2),
      stack(ITEM.COAL, 2),
      output
    );
    const before = cloneFurnace(furnace);
    assert.equal(advanceFurnace(furnace, 30), false);
    assert.deepEqual(furnace, before);
  }
  const furnace = furnaceWith(
    stack(ITEM.RAW_IRON, 2),
    stack(ITEM.COAL, 2),
    stack(ITEM.IRON_INGOT, 63)
  );
  advanceFurnace(furnace, 20);
  assert.equal(furnace.slots[2].count, 64);
  assert.equal(furnace.slots[0].count, 1);
  assert.equal(furnace.slots[1].count, 1);
  assert.equal(furnace.cookTime, 0);
  // Existing fuel burns down while blocked, but no second coal is ignited.
  assert.equal(furnace.burnTime, 60);
  assert.equal(furnace.experience, 1);
  advanceFurnace(furnace, 90);
  assert.equal(furnace.burnTime, 0);
  assert.equal(furnace.slots[1].count, 1);
});

test("two placed furnaces cook independently while no UI is open and never change their block IDs", () => {
  const first = containerFixture("furnace");
  const second = at(first, { ...first.hit, x: first.hit.x + 4 });
  first.world.set(second.hit.x, second.hit.y, second.hit.z, BLOCK.FURNACE);
  moveIntoContainer(first, 0, stack(ITEM.RAW_IRON, 2));
  moveIntoContainer(first, 1, stack(ITEM.COAL, 1));
  moveIntoContainer(second, 0, stack(ITEM.RAW_GOLD, 1));
  moveIntoContainer(second, 1, stack(ITEM.STICK, 2));
  const writes = first.world.writes.length;
  assert.equal(first.settlement.update(10, first.world), true);
  assert.deepEqual(first.state().slots[2], stack(ITEM.IRON_INGOT, 1));
  assert.deepEqual(second.state().slots[2], stack(ITEM.GOLD_INGOT, 1));
  assert.equal(first.state().burnTime, 70);
  assert.equal(second.state().burnTime, 0);
  assert.equal(first.world.writes.length, writes);
  assert.equal(
    first.world.get(first.hit.x, first.hit.y, first.hit.z),
    BLOCK.FURNACE
  );
  assert.equal(
    first.world.get(second.hit.x, second.hit.y, second.hit.z),
    BLOCK.FURNACE
  );
});

test("identical furnace coordinates remain independent in every dimension and unloaded blocks do not tick", () => {
  const fixture = containerFixture("furnace");
  for (const dimension of ["overworld", "nether", "end"]) {
    fixture.world.dimension = dimension;
    fixture.world.set(
      fixture.hit.x,
      fixture.hit.y,
      fixture.hit.z,
      BLOCK.FURNACE
    );
    const current = at(fixture, { ...fixture.hit, dimension });
    moveIntoContainer(current, 0, stack(ITEM.RAW_IRON, 1));
    moveIntoContainer(current, 1, stack(ITEM.COAL, 1));
  }
  fixture.settlement.update(10, fixture.world);
  fixture.world.dimension = "overworld";
  fixture.settlement.update(5, fixture.world);
  const before = fixture.settlement.serialize();
  fixture.world.unloaded.add(
    fixture.world.column(fixture.hit.x, fixture.hit.z)
  );
  assert.equal(fixture.settlement.update(20, fixture.world), false);
  assert.deepEqual(fixture.settlement.serialize(), before);
  assert.deepEqual(
    before.furnaces.map(({ dimension, cookTime, slots }) => [
      dimension,
      cookTime,
      slots[2]?.count ?? 0,
    ]),
    [
      ["overworld", 5, 0],
      ["nether", 0, 0],
      ["end", 0, 1],
    ]
  );
});

test("input, fuel, and output rules reject invalid click, drag, hotbar, and offhand insertion atomically", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 1));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(10, fixture.world);
  editOwnership(fixture.game, (owned) => {
    owned.cursor = stack(BLOCK.DIRT, 3);
    owned.slots[0] = stack(BLOCK.DIRT, 1);
    owned.offhand = stack(ITEM.APPLE, 1);
  });
  const before = fixture.snapshot();
  for (const action of [
    click(0),
    click(1),
    click(2),
    { type: "swapHotbar", area: "container", index: 0, hotbarIndex: 0 },
    { type: "swapHotbar", area: "container", index: 2, hotbarIndex: 0 },
    { type: "swapOffhand", area: "container", index: 1 },
    { type: "swapOffhand", area: "container", index: 2 },
    {
      type: "distribute",
      targets: [{ area: "container", index: 2 }],
      button: 0,
    },
  ]) {
    assert.equal(fixture.action(action).ok, false);
    assert.deepEqual(fixture.snapshot(), before);
  }
});

test("quick transfer routes smeltable logs to input and coal to fuel, never to output", () => {
  const fixture = containerFixture("furnace");
  editOwnership(fixture.game, (owned) => {
    owned.slots[9] = stack(BLOCK.OAK_LOG, 2);
    owned.slots[10] = stack(ITEM.COAL, 3);
    owned.slots[11] = stack(ITEM.DIAMOND, 4);
  });
  for (const index of [9, 10]) {
    assert.equal(
      fixture.action({
        type: "quickMove",
        area: "inventory",
        index,
      }).ok,
      true
    );
  }
  assert.deepEqual(fixture.state().slots, [
    stack(BLOCK.OAK_LOG, 2),
    stack(ITEM.COAL, 3),
    null,
  ]);
  const before = fixture.snapshot();
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "inventory",
      index: 11,
    }).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), before);
});

test("replacing a partially cooked recipe clears only cooking progress, not remaining fuel", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 1));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(5, fixture.world);
  assert.equal(fixture.state().cookTime, 5);
  editOwnership(fixture.game, (owned) => {
    owned.cursor = stack(ITEM.RAW_GOLD, 1);
  });
  assert.equal(fixture.action(click(0)).ok, true);
  assert.equal(fixture.state().cookTime, 0);
  assert.equal(fixture.state().burnTime, 75);
  assert.deepEqual(fixture.game.getState().cursor, stack(ITEM.RAW_IRON, 1));
  fixture.settlement.update(5, fixture.world);
  assert.equal(fixture.state().cookTime, 5);
  assert.equal(fixture.state().slots[2], null);
});

test("fractional burn/cook progress, contents, and unclaimed XP survive JSON reload", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 3));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 2));
  fixture.settlement.update(13.25, fixture.world);
  const saved = JSON.parse(JSON.stringify(fixture.settlement.serialize()));
  fixture.settlement.dispose();
  const restored = new Settlement({
    coordinator: fixture.coordinator,
    context: fixture.context,
  });
  assert.equal(restored.load(saved, { world: fixture.world }), true);
  assert.deepEqual(restored.serialize(), saved);
  restored.update(6.75, fixture.world);
  const state = restored.getContainerState(
    fixture.world,
    fixture.hit,
    fixture.game
  );
  assert.deepEqual(state.slots, [
    stack(ITEM.RAW_IRON, 1),
    stack(ITEM.COAL, 1),
    stack(ITEM.IRON_INGOT, 2),
  ]);
  assert.equal(state.cookTime, 0);
  assert.equal(state.burnTime, 60);
  assert.equal(state.experience, 2);
  const before = restored.serialize();
  state.slots[2].count = 64;
  saved.furnaces[0].burnTime = 0;
  assert.deepEqual(restored.serialize(), before);
});

test("XP follows partial output extraction exactly once, never reads or rendering", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 3));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(30, fixture.world);
  const before = fixture.snapshot();
  for (let index = 0; index < 3; index++) fixture.state();
  assert.deepEqual(fixture.snapshot(), before);
  editOwnership(fixture.game, (owned) => {
    owned.cursor = stack(ITEM.IRON_INGOT, 62);
  });
  const first = fixture.action(click(2));
  assert.equal(first.experience, 2);
  assert.equal(first.experienceCommitted, true);
  assert.equal(fixture.game.getState().cursor.count, 64);
  assert.equal(fixture.state().slots[2].count, 1);
  assert.equal(fixture.state().experience, 1);
  const blocked = fixture.snapshot();
  assert.equal(fixture.action(click(2)).ok, false);
  assert.deepEqual(fixture.snapshot(), blocked);
  assert.equal(
    fixture.action({
      type: "click",
      area: "inventory",
      index: 9,
      button: 0,
    }).ok,
    true
  );
  assert.equal(fixture.action(click(2, 2)).experience, 1);
  assert.equal(fixture.state().slots[2], null);
  assert.equal(fixture.state().experience, 0);
  assert.equal(fixture.game.getState().experience.total, 3);
  assert.equal(fixture.action(click(2)).ok, false);
});

test("right-half, Shift, number and F extraction each debit only their own output XP", () => {
  for (const action of [
    click(2, 2),
    { type: "quickMove", area: "container", index: 2 },
    { type: "swapHotbar", area: "container", index: 2, hotbarIndex: 0 },
    { type: "swapOffhand", area: "container", index: 2 },
  ]) {
    const fixture = containerFixture("furnace");
    moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 5));
    moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
    fixture.settlement.update(50, fixture.world);
    const result = fixture.action(action);
    const extracted = action.type === "click" ? 3 : 5;
    assert.equal(result.ok, true);
    assert.equal(result.experience, extracted);
    assert.equal(result.experienceCommitted, true);
    assert.equal(fixture.game.getState().experience.total, extracted);
    assert.equal(fixture.state().slots[2]?.count ?? 0, 5 - extracted);
    assert.equal(fixture.state().experience, 5 - extracted);
  }
});

test("a full inventory blocks furnace quick extraction without paying XP or losing output", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 1));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(10, fixture.world);
  editOwnership(fixture.game, (owned) => {
    owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
  });
  const before = fixture.snapshot();
  assert.equal(
    fixture.action({
      type: "quickMove",
      area: "container",
      index: 2,
    }).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), before);
});

test("a refused output drop retains output and XP; accepting it returns XP once", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 1));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(10, fixture.world);
  const action = {
    type: "drop",
    area: "container",
    index: 2,
    wholeStack: true,
  };
  const before = fixture.snapshot();
  assert.equal(fixture.action(action, { prepareDrops: () => null }).ok, false);
  assert.deepEqual(fixture.snapshot(), before);
  const retained = dropCollector(fixture.coordinator);
  const result = fixture.action(action, {
    prepareDrops: retained.prepareDrops,
  });
  assert.equal(result.ok, true);
  assert.equal(result.experience, 1);
  assert.equal(result.experienceCommitted, true);
  assert.deepEqual(retained.drops, [stack(ITEM.IRON_INGOT, 1)]);
  assert.equal(fixture.state().experience, 0);
  assert.equal(
    fixture.action(action, { prepareDrops: retained.prepareDrops }).ok,
    false
  );
});

test("break and explosion release remaining finite contents and unpaid XP once, including retention refusal", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 3));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 2));
  fixture.settlement.update(20, fixture.world);
  assert.equal(fixture.action(click(2, 2)).experience, 1);
  fixture.world.set(fixture.hit.x, fixture.hit.y, fixture.hit.z, BLOCK.AIR);
  const before = fixture.snapshot();
  assert.equal(
    fixture.settlement.removeFurnace(fixture.world, fixture.hit, {
      prepareDrops: () => null,
    }).ok,
    false
  );
  assert.deepEqual(fixture.snapshot(), before);
  // A block already removed by an explosion must not keep simulating or pay out.
  assert.equal(fixture.settlement.update(10, fixture.world), false);
  assert.deepEqual(fixture.snapshot(), before);
  const retained = dropCollector(fixture.coordinator, {
    onPrepare: () =>
      assert.equal(
        fixture.settlement.removeFurnace(fixture.world, fixture.hit).ok,
        false
      ),
  });
  const rewards = experienceCollector(fixture.coordinator);
  const result = fixture.settlement.removeContainer(
    fixture.world,
    fixture.hit,
    {
      prepareDrops: retained.prepareDrops,
      prepareExperience: rewards.prepareExperience,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.experience, 1);
  assert.equal(result.experienceCommitted, true);
  assert.equal(rewards.total, 1);
  assert.deepEqual(result.drops, [
    stack(ITEM.RAW_IRON, 1),
    stack(ITEM.COAL, 1),
    stack(ITEM.IRON_INGOT, 1),
  ]);
  assert.deepEqual(retained.drops, result.drops);
  assert.equal(fixture.game.getState().cursor.count, 1);
  assert.deepEqual(
    fixture.settlement.removeContainer(fixture.world, fixture.hit),
    {
      ok: false,
      drops: [],
      experience: 0,
    }
  );
  assert.deepEqual(fixture.settlement.serialize().furnaces, []);
});

test("invalid furnace saves reject atomically without changing existing contents or crops", () => {
  const fixture = containerFixture("furnace");
  moveIntoContainer(fixture, 0, stack(ITEM.RAW_IRON, 2));
  moveIntoContainer(fixture, 1, stack(ITEM.COAL, 1));
  fixture.settlement.update(12, fixture.world);
  const before = fixture.settlement.serialize();
  for (const corrupt of [
    (data) => {
      data.furnaces = null;
    },
    (data) => {
      data.furnaces.push(structuredClone(data.furnaces[0]));
    },
    (data) => {
      data.furnaces[0].slots[0] = stack(BLOCK.DIRT, 1);
    },
    (data) => {
      data.furnaces[0].slots[1] = stack(ITEM.DIAMOND, 1);
    },
    (data) => {
      data.furnaces[0].slots[2] = stack(ITEM.DIAMOND, 1);
    },
    (data) => {
      data.furnaces[0].slots.push(null);
    },
    (data) => {
      data.furnaces[0].burnTime = 81;
    },
    (data) => {
      data.furnaces[0].burnDuration = -1;
    },
    (data) => {
      data.furnaces[0].cookTime = 10;
    },
    (data) => {
      data.furnaces[0].recipeId = "gold_ingot";
    },
    (data) => {
      data.furnaces[0].experience = 2;
    },
    (data) => {
      data.furnaces[0].experience = 0.5;
    },
    (data) => {
      data.furnaces[0].dimension = "moon";
    },
  ]) {
    const invalid = structuredClone(before);
    corrupt(invalid);
    assert.equal(fixture.settlement.load(invalid), false);
    assert.deepEqual(fixture.settlement.serialize(), before);
  }
});

test("component-v1 load never relocates or spends legacy prepaid player smelting jobs and fuel", () => {
  const fixture = containerFixture("furnace");
  fixture.game.add(ITEM.RAW_IRON, 1);
  fixture.game.add(ITEM.COAL, 1);
  assert.equal(
    fixture.game.craft("iron_ingot", { station: "furnace" }).ok,
    true
  );
  const playerBefore = fixture.game.serialize();
  assert.equal(
    fixture.settlement.load({ version: 1, chests: [], crops: [] }),
    true
  );
  assert.deepEqual(fixture.settlement.serialize().furnaces, []);
  assert.deepEqual(fixture.state().slots, [null, null, null]);
  assert.equal(fixture.state().burnTime, 0);
  assert.equal(fixture.state().cookTime, 0);
  assert.deepEqual(fixture.game.serialize(), playerBefore);
});

test("generic smelting and fuel reject decorated stacks without consuming their metadata", () => {
  const named = (id) => ({
    id,
    count: 2,
    data: { version: 1, name: "Keep this" },
  });
  for (const input of [named(ITEM.RAW_IRON), named(BLOCK.OAK_LOG)]) {
    assert.equal(getSmeltingRecipe(input), null);
    assert.equal(acceptsFurnaceStack(0, input), false);
    const furnace = furnaceWith(input, stack(ITEM.COAL, 1));
    const before = structuredClone(furnace);
    assert.equal(isValidFurnace(furnace), false);
    assert.equal(advanceFurnace(furnace, 20), false);
    assert.deepEqual(furnace, before);
  }
  for (const fuel of [
    named(ITEM.COAL),
    named(BLOCK.OAK_LOG),
    named(ITEM.STICK),
  ]) {
    assert.equal(acceptsFurnaceStack(1, fuel), false);
    const furnace = furnaceWith(stack(ITEM.RAW_IRON, 1), fuel);
    const before = structuredClone(furnace);
    assert.equal(isValidFurnace(furnace), false);
    assert.equal(advanceFurnace(furnace, 20), false);
    assert.deepEqual(furnace, before);
  }
  // Empty canonical metadata is still plain, not a different ingredient kind.
  const plain = { ...stack(ITEM.COAL, 1), data: { version: 1 } };
  assert.equal(acceptsFurnaceStack(1, plain), true);
});

test("v2 and v3 active furnace fuel was prepaid and is never charged again after load", () => {
  for (const version of [2, 3]) {
    const fixture = containerFixture("furnace");
    const furnace = furnaceWith(stack(ITEM.RAW_IRON, 2), stack(ITEM.COAL, 1));
    Object.assign(furnace, { burnTime: 20, burnDuration: 80, cookTime: 5 });
    editOwnership(fixture.game, (owned) => {
      owned.fuelTime = 65;
    });
    const playerBefore = fixture.game.serialize();
    const { dimension, x, y, z } = fixture.hit;
    assert.equal(
      fixture.settlement.load({
        version,
        chests: [],
        crops: [],
        furnaces: [{ dimension, x, y, z, ...furnace }],
      }),
      true
    );
    assert.equal(fixture.settlement.update(5, fixture.world), true);
    assert.equal(fixture.state().burnTime, 15);
    assert.deepEqual(fixture.state().slots[1], stack(ITEM.COAL, 1));
    assert.deepEqual(fixture.state().slots[2], stack(ITEM.IRON_INGOT, 1));
    fixture.settlement.update(10, fixture.world);
    fixture.settlement.update(30, fixture.world);
    assert.equal(fixture.state().burnTime, 0);
    assert.deepEqual(fixture.state().slots[1], stack(ITEM.COAL, 1));
    assert.deepEqual(fixture.state().slots[2], stack(ITEM.IRON_INGOT, 2));
    assert.equal(fixture.state().experience, 2);
    assert.deepEqual(fixture.game.serialize(), playerBefore);
  }
});

test("cloned furnace output metadata is detached from the source and other snapshots", () => {
  const furnace = furnaceWith(null, null, {
    id: ITEM.IRON_INGOT,
    count: 2,
    data: { version: 1, name: "Saved output" },
  });
  furnace.experience = 2;
  assert.equal(isValidFurnace(furnace), true);
  const first = cloneFurnace(furnace);
  const second = cloneFurnace(furnace);
  first.slots[2].data.name = "Edited detached output";
  assert.equal(furnace.slots[2].data.name, "Saved output");
  assert.equal(second.slots[2].data.name, "Saved output");
});
