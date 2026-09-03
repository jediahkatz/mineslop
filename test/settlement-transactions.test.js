import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { MAX_EXPERIENCE } from "../src/experience.js";
import { createFurnace } from "../src/furnace.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { CROP_GROW_SECONDS, Settlement } from "../src/settlement.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  ContainerWorld,
  containerFixture,
  dropCollector,
  editOwnership,
  experienceCollector,
  moveIntoContainer,
} from "./container-fixture.js";

const stack = (id, count) => ({ id, count });
const tool = (durability) => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability,
  data: {
    version: 1,
    name: "North mine",
    enchantments: { efficiency: 3, unbreaking: 2 },
    repairCost: 4,
  },
});
const click = (index, button = 0) => ({
  type: "click",
  area: "container",
  index,
  button,
});
const drop = (index) => ({
  type: "drop",
  area: "container",
  index,
  wholeStack: true,
});

function cookedFurnace(count = 2) {
  const f = containerFixture("furnace");
  moveIntoContainer(f, 0, stack(ITEM.RAW_IRON, count));
  moveIntoContainer(f, 1, stack(ITEM.COAL, 1));
  assert.equal(f.settlement.update(count * 10, f.world), true);
  return f;
}

function farmFixture(generatorVersion = 4) {
  const world = new ContainerWorld({ generatorVersion });
  const ownership = { coordinator: world.coordinator, context: world.context };
  const game = new Gameplay(ownership);
  const settlement = new Settlement(ownership);
  editOwnership(game, (owned) => {
    owned.slots.fill(null);
    owned.slots[0] = stack(ITEM.SEEDS, 2);
  });
  game.select(0);
  const hit = {
    dimension: "overworld",
    x: 8,
    y: generatorVersion === 4 ? -64 : 20,
    z: 8,
    id: BLOCK.GRASS,
  };
  assert.equal(world.set(hit.x, hit.y, hit.z, hit.id), true);
  const target = { ...hit, y: hit.y + 1, id: BLOCK.WHEAT_CROP };
  const snapshot = () => [
    game.serialize(),
    settlement.serialize(),
    world.getCell(hit.x, hit.y, hit.z),
    world.getCell(target.x, target.y, target.z),
  ];
  return { world, settlement, game, hit, target, snapshot, ...ownership };
}

function vetoParticipant(coordinator, validate = () => false) {
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  return {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate,
    publish: () => {
      throw new Error("Rejected participant must never publish");
    },
  };
}

test("metadata and wear survive chest reload, hand swaps, cursor escrow, close overflow, and break receipts", () => {
  const f = containerFixture();
  const book = {
    ...stack(ITEM.BOOK, 3),
    data: { version: 1, name: "Field notes" },
  };
  moveIntoContainer(f, 0, tool(7));
  moveIntoContainer(f, 1, tool(29));
  moveIntoContainer(f, 2, book);
  assert.equal(
    f.settlement.load(JSON.parse(JSON.stringify(f.settlement.serialize())), {
      world: f.world,
    }),
    true
  );
  assert.equal(f.action(click(0)).ok, true);
  assert.deepEqual(f.game.getState().cursor, tool(7));
  assert.equal(
    f.action({ type: "swapOffhand", area: "container", index: 1 }).ok,
    true
  );
  assert.deepEqual(f.game.getState().offhand, tool(29));
  assert.equal(
    f.action({ type: "click", area: "inventory", index: 9, button: 0 }).ok,
    true
  );
  assert.equal(
    f.action({ type: "quickMove", area: "inventory", index: 9 }).ok,
    true
  );
  assert.deepEqual(f.state().slots[0], tool(7));
  assert.equal(
    f.action({
      type: "swapHotbar",
      area: "container",
      index: 0,
      hotbarIndex: 0,
    }).ok,
    true
  );
  assert.deepEqual(f.game.getState().slots[0], tool(7));
  assert.equal(
    f.action({ type: "click", area: "inventory", index: 0, button: 0 }).ok,
    true
  );
  editOwnership(f.game, (owned) => {
    owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
  });
  const retained = dropCollector(f.coordinator, { accept: false });
  const before = f.snapshot();
  assert.equal(
    f.action({ type: "close" }, { prepareDrops: retained.prepareDrops }).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(retained.drops, []);
  retained.accept = true;
  assert.equal(
    f.action({ type: "close" }, { prepareDrops: retained.prepareDrops }).ok,
    true
  );
  assert.deepEqual(retained.drops, [tool(7)]);
  assert.equal(f.game.getState().cursor, null);
  assert.equal(
    f.action({ type: "swapOffhand", area: "container", index: 1 }).ok,
    true
  );
  const result = f.settlement.removeContainer(f.world, f.hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dropsCommitted, true);
  assert.deepEqual(result.drops, [tool(29), book]);
  assert.deepEqual(retained.drops, [tool(7), tool(29), book]);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.AIR);
  assert.equal(f.settlement.chests.size, 0);
  result.drops[0].data.enchantments.efficiency = 1;
  assert.deepEqual(retained.drops[1], tool(29));
  retained.drops[0].data.name = "Independent retained copy";
  assert.equal(retained.drops[1].data.name, "North mine");
  assert.equal(f.settlement.removeContainer(f.world, f.hit).ok, false);
});

test("ID-only chest compatibility cannot spend or strip a decorated stack", () => {
  const f = containerFixture();
  assert.equal(f.game.addStack(tool(7)), true);
  const before = f.snapshot();
  assert.equal(
    f.settlement.transferToChest(f.world, f.hit, f.game, ITEM.IRON_PICKAXE),
    false
  );
  assert.deepEqual(f.snapshot(), before);
  const index = f.game
    .getState()
    .slots.findIndex((entry) => entry?.id === ITEM.IRON_PICKAXE);
  assert.equal(
    f.action({ type: "quickMove", area: "inventory", index }).ok,
    true
  );
  const stored = f.snapshot();
  assert.equal(
    f.settlement.transferFromChest(f.world, f.hit, f.game, ITEM.IRON_PICKAXE),
    false
  );
  assert.deepEqual(f.snapshot(), stored);
  assert.deepEqual(f.state().slots[0], tool(7));
});

test("missing prepared destinations never invoke an eager acceptance fallback", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(7));
  let eagerCalls = 0;
  const acceptDrop = () => {
    eagerCalls++;
    return true;
  };
  const before = f.snapshot();
  assert.equal(f.action(drop(0)).ok, false);
  assert.equal(f.action(drop(0), { acceptDrop }).ok, false);
  assert.equal(
    f.settlement.removeContainer(f.world, f.hit, { acceptDrop }).ok,
    false
  );
  assert.equal(eagerCalls, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.CHEST);
});

test("a source inventory veto after drop preparation leaves no orphaned retained loot", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(13));
  const retained = dropCollector(f.coordinator);
  const prepare = f.game.prepareInventory;
  f.game.prepareInventory = function (edit, options) {
    const participant = prepare.call(this, edit, options);
    return participant && { ...participant, validate: () => false };
  };
  const before = f.snapshot();
  const total = f.coordinator.budget.totalBytes;
  assert.equal(
    f.action(drop(0), { prepareDrops: retained.prepareDrops }).ok,
    false
  );
  assert.deepEqual(retained.proposals, [[tool(13)]]);
  assert.deepEqual(retained.drops, []);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.coordinator.budget.totalBytes, total);
  f.game.prepareInventory = prepare;
  assert.equal(
    f.action(drop(0), { prepareDrops: retained.prepareDrops }).ok,
    true
  );
  assert.deepEqual(retained.drops, [tool(13)]);
});

test("container world validation runs after prepared destinations and before any owner publishes", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(19));
  const retained = dropCollector(f.coordinator, {
    onPrepare: () =>
      f.world.blocked.add(f.world.key(f.hit.x, f.hit.y, f.hit.z)),
  });
  const before = f.snapshot();
  const writes = f.world.writes.length;
  assert.equal(
    f.settlement.removeContainer(f.world, f.hit, {
      prepareDrops: retained.prepareDrops,
    }).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(retained.drops, []);
  assert.equal(f.world.writes.length, writes);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.CHEST);
});

test("removing and replacing an identical block during preparation invalidates its captured revision", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, stack(ITEM.COAL, 3));
  const retained = dropCollector(f.coordinator, {
    onPrepare: () => {
      f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.AIR);
      f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.CHEST);
    },
  });
  const before = f.snapshot();
  assert.equal(
    f.action(drop(0), { prepareDrops: retained.prepareDrops }).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(retained.drops, []);
});

test("all participants must be registered with the same coordinator", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(7));
  const other = dropCollector(new TransactionCoordinator());
  const before = f.snapshot();
  assert.equal(
    f.action(drop(0), { prepareDrops: other.prepareDrops }).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(other.drops, []);
});

test("sharing a coordinator does not allow a player's different archive context to access a station", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, stack(ITEM.COAL, 3));
  const other = new Gameplay({
    coordinator: f.coordinator,
    context: createWorldContext({
      seed: "different-archive",
      generatorVersion: 3,
    }),
  });
  const before = [f.settlement.serialize(), other.serialize()];
  assert.equal(f.settlement.getContainerState(f.world, f.hit, other), null);
  assert.equal(
    f.settlement.containerAction(f.world, f.hit, other, click(0)).ok,
    false
  );
  assert.deepEqual([f.settlement.serialize(), other.serialize()], before);
  other.dispose();
});

test("prepared removal is side-effect free and its committed loot receipt is single-use", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(7));
  const retained = dropCollector(f.coordinator);
  const before = f.snapshot();
  const plan = f.settlement.prepareRemoveContainer(f.world, f.hit, {
    prepareDrops: retained.prepareDrops,
  });
  assert.ok(plan);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(retained.drops, []);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.CHEST);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.deepEqual(retained.drops, [tool(7)]);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.AIR);
  assert.equal(f.settlement.chests.size, 0);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(retained.drops, [tool(7)]);
});

test("an unopened station retains its block loot in the same world transaction without inventing a saved record", () => {
  const f = containerFixture();
  assert.equal(f.settlement.chests.size, 0);
  const retained = dropCollector(f.coordinator);
  const result = f.settlement.removeContainer(f.world, f.hit, {
    prepareDrops: (contents) => {
      assert.deepEqual(contents, []);
      return retained.prepareDrops([...contents, stack(BLOCK.CHEST, 1)]);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dropsCommitted, true);
  assert.deepEqual(retained.drops, [stack(BLOCK.CHEST, 1)]);
  assert.equal(f.settlement.chests.size, 0);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.AIR);
});

test("explicit XP preparation or validation refusal retains furnace outputs and XP, including a partial fit", () => {
  for (const rejectAt of ["prepare", "validate"]) {
    for (const action of [
      click(2),
      { type: "quickMove", area: "container", index: 2 },
      drop(2),
    ]) {
      const f = cookedFurnace(3);
      editOwnership(f.game, (owned) => {
        owned.cursor = stack(ITEM.IRON_INGOT, 63);
        owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
        owned.slots[9] = stack(ITEM.IRON_INGOT, 63);
      });
      const rewards = experienceCollector(f.coordinator, {
        accept: rejectAt !== "prepare",
        validate: () => rejectAt !== "validate",
      });
      const retained = dropCollector(f.coordinator);
      const before = f.snapshot();
      assert.equal(
        f.action(action, {
          prepareDrops: retained.prepareDrops,
          prepareExperience: rewards.prepareExperience,
        }).ok,
        false
      );
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(retained.drops, []);
      assert.equal(rewards.total, 0);
    }
  }
});

test("scene-less XP capacity is validated in the same Gameplay edit as output extraction", () => {
  const f = cookedFurnace(2);
  editOwnership(f.game, (owned) => {
    owned.experienceTotal = MAX_EXPERIENCE;
  });
  const before = f.snapshot();
  assert.equal(f.action(click(2)).ok, false);
  assert.deepEqual(f.snapshot(), before);
  const rewards = experienceCollector(f.coordinator);
  const result = f.action(click(2), {
    prepareExperience: rewards.prepareExperience,
  });
  assert.equal(result.ok, true);
  assert.equal(result.experienceCommitted, true);
  assert.equal(f.game.getState().experience.total, MAX_EXPERIENCE);
  assert.equal(rewards.total, 2);
  assert.equal(f.state().experience, 0);
});

test("decorated saved furnace output remains detached through partial extraction and retained drops", () => {
  const f = containerFixture("furnace");
  const output = {
    ...stack(ITEM.IRON_INGOT, 4),
    data: { version: 1, name: "Owned ingots" },
  };
  const { dimension, x, y, z } = f.hit;
  assert.equal(
    f.settlement.load(
      {
        version: 3,
        chests: [],
        crops: [],
        furnaces: [
          {
            dimension,
            x,
            y,
            z,
            ...createFurnace(),
            slots: [null, null, output],
            experience: 4,
          },
        ],
      },
      { world: f.world }
    ),
    true
  );
  editOwnership(f.game, (owned) => {
    owned.cursor = { ...structuredClone(output), count: 62 };
  });
  const rewards = experienceCollector(f.coordinator);
  const result = f.action(click(2), {
    prepareExperience: rewards.prepareExperience,
  });
  assert.equal(result.experience, 2);
  assert.equal(result.experienceCommitted, true);
  assert.equal(f.game.getState().cursor.count, 64);
  assert.deepEqual(f.state().slots[2], { ...output, count: 2 });
  const cursor = f.game.getState().cursor;
  cursor.data.name = "Detached cursor view";
  assert.equal(f.state().slots[2].data.name, "Owned ingots");
  const retained = dropCollector(f.coordinator);
  assert.equal(
    f.action(drop(2), {
      prepareDrops: retained.prepareDrops,
      prepareExperience: rewards.prepareExperience,
    }).ok,
    true
  );
  assert.deepEqual(retained.drops, [{ ...output, count: 2 }]);
  assert.equal(rewards.total, 4);
  assert.equal(f.state().experience, 0);
});

test("all postcommit observers see source, inventory, drops, and XP together with guards released", () => {
  const f = cookedFurnace(2);
  const notifications = [];
  let retained;
  let rewards;
  const observe = (name) => () => {
    assert.equal(f.settlement._busy, false);
    assert.equal(f.game.getState().cursor, null);
    assert.equal(f.state().slots[2], null);
    assert.equal(f.state().experience, 0);
    assert.deepEqual(retained.drops, [stack(ITEM.IRON_INGOT, 2)]);
    assert.equal(rewards.total, 2);
    assert.equal(f.coordinator.usage(f.settlement), f.settlement.reservedBytes);
    notifications.push(name);
    throw new Error(`${name} observer`);
  };
  retained = dropCollector(f.coordinator, { notify: observe("drops") });
  rewards = experienceCollector(f.coordinator, { notify: observe("XP") });
  f.settlement.onChange = observe("station");
  f.game.onChange = observe("inventory");
  const result = f.action(drop(2), {
    prepareDrops: retained.prepareDrops,
    prepareExperience: rewards.prepareExperience,
  });
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 4);
  assert.deepEqual(notifications, ["station", "inventory", "drops", "XP"]);
  assert.equal(
    f.action(drop(2), {
      prepareDrops: retained.prepareDrops,
      prepareExperience: rewards.prepareExperience,
    }).ok,
    false
  );
  assert.equal(rewards.total, 2);
});

test("furnace break XP refusal preserves the live block and every retained stack", () => {
  const f = cookedFurnace(2);
  const retained = dropCollector(f.coordinator);
  const rewards = experienceCollector(f.coordinator, { accept: false });
  const before = f.snapshot();
  const writes = f.world.writes.length;
  const options = {
    prepareDrops: retained.prepareDrops,
    prepareExperience: rewards.prepareExperience,
  };
  assert.equal(f.settlement.removeFurnace(f.world, f.hit, options).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.writes.length, writes);
  assert.deepEqual(retained.drops, []);
  rewards.accept = true;
  const result = f.settlement.removeFurnace(f.world, f.hit, options);
  assert.equal(result.ok, true);
  assert.equal(result.experienceCommitted, true);
  assert.deepEqual(retained.drops, [stack(ITEM.IRON_INGOT, 2)]);
  assert.equal(rewards.total, 2);
  assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.AIR);
});

test("publication invariants are fatal, not ordinary station refusals", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, stack(ITEM.COAL, 1));
  const bad = vetoParticipant(f.coordinator, () => true);
  assert.throws(
    () =>
      f.action(drop(0), {
        prepareDrops: () => bad,
      }),
    TransactionInvariantError
  );
});

test("negative-Y planting publishes world, seed, and crop records only if every participant accepts", () => {
  const f = farmFixture();
  const before = f.snapshot();
  const writes = f.world.writes.length;
  const veto = vetoParticipant(f.coordinator);
  assert.equal(
    f.settlement.plant(f.world, f.hit, f.game, { participants: [veto] }),
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.writes.length, writes);
  let seen = false;
  f.world.onMutation = () => {
    seen = true;
    assert.equal(f.settlement._busy, false);
    assert.equal(f.game.count(ITEM.SEEDS), 1);
    assert.equal(f.settlement.crops.size, 1);
    assert.equal(f.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.FARMLAND);
    assert.equal(
      f.world.get(f.target.x, f.target.y, f.target.z),
      BLOCK.TALL_GRASS
    );
  };
  assert.equal(f.settlement.plant(f.world, f.hit, f.game), true);
  assert.equal(seen, true);
  assert.equal(f.settlement.serialize().crops[0].y, -63);
});

test("a refused crop maturation leaves both its age and world cell unchanged", () => {
  const f = farmFixture();
  assert.equal(f.settlement.plant(f.world, f.hit, f.game), true);
  assert.equal(f.settlement.update(CROP_GROW_SECONDS - 1, f.world), true);
  const before = f.snapshot();
  const writes = f.world.writes.length;
  f.world.blocked.add(f.world.key(f.target.x, f.target.y, f.target.z));
  assert.equal(f.settlement.update(1, f.world), false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.writes.length, writes);
  f.world.blocked.clear();
  assert.equal(f.settlement.update(1, f.world), true);
  assert.equal(
    f.world.get(f.target.x, f.target.y, f.target.z),
    BLOCK.WHEAT_CROP
  );
});

test("full and partial harvest overflow is retained atomically with the live crop removal", () => {
  for (const partial of [false, true]) {
    const f = farmFixture();
    assert.equal(f.settlement.plant(f.world, f.hit, f.game), true);
    assert.equal(f.settlement.update(CROP_GROW_SECONDS, f.world), true);
    editOwnership(f.game, (owned) => {
      owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
      if (partial) owned.slots[9] = stack(ITEM.WHEAT, 63);
    });
    const before = f.snapshot();
    const retained = dropCollector(f.coordinator, { accept: false });
    const options = { prepareDrops: retained.prepareDrops };
    assert.equal(f.settlement.harvestCrop(f.world, f.target, f.game), false);
    assert.equal(
      f.settlement.harvestCrop(f.world, f.target, f.game, options),
      false
    );
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(retained.drops, []);
    retained.accept = true;
    assert.equal(
      f.settlement.harvestCrop(f.world, f.target, f.game, options),
      true
    );
    assert.deepEqual(retained.drops, [
      stack(ITEM.WHEAT, partial ? 1 : 2),
      stack(ITEM.SEEDS, 1),
    ]);
    assert.equal(f.game.count(ITEM.WHEAT), partial ? 64 : 0);
    assert.equal(f.settlement.crops.size, 0);
    assert.equal(f.world.get(f.target.x, f.target.y, f.target.z), BLOCK.AIR);
    assert.equal(
      f.settlement.harvestCrop(f.world, f.target, f.game, options),
      false
    );
  }
});

test("a harvest world veto after overflow preparation cannot orphan drops or credit partial inventory", () => {
  const f = farmFixture();
  f.settlement.plant(f.world, f.hit, f.game);
  f.settlement.update(CROP_GROW_SECONDS, f.world);
  editOwnership(f.game, (owned) => {
    owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
    owned.slots[9] = stack(ITEM.WHEAT, 63);
  });
  const retained = dropCollector(f.coordinator, {
    onPrepare: () =>
      f.world.blocked.add(f.world.key(f.target.x, f.target.y, f.target.z)),
  });
  const before = f.snapshot();
  const writes = f.world.writes.length;
  assert.equal(
    f.settlement.harvestCrop(f.world, f.target, f.game, {
      prepareDrops: retained.prepareDrops,
    }),
    false
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(retained.drops, []);
  assert.equal(f.world.writes.length, writes);
});

test("a prepared harvest stays owned until its full plan is accepted and cannot pay twice", () => {
  const f = farmFixture();
  f.settlement.plant(f.world, f.hit, f.game);
  f.settlement.update(CROP_GROW_SECONDS, f.world);
  const before = f.snapshot();
  const plan = f.settlement.prepareHarvestCrop(f.world, f.target, f.game);
  assert.ok(plan);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.settlement.hasCrop(f.world, f.target), true);
  const veto = vetoParticipant(f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.settlement.hasCrop(f.world, f.target), false);
  assert.equal(f.game.count(ITEM.WHEAT), 2);
  assert.equal(f.game.count(ITEM.SEEDS), 2);
  assert.equal(f.world.get(f.target.x, f.target.y, f.target.z), BLOCK.AIR);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.game.count(ITEM.WHEAT), 2);
});

test("a real full overflow ledger refuses different worn copies but can merge an identical retained kind", () => {
  const f = containerFixture();
  moveIntoContainer(f, 0, tool(7));
  moveIntoContainer(f, 1, tool(29));
  const overflow = new DropOverflow({
    coordinator: f.coordinator,
    context: f.context,
    maxEntries: 1,
  });
  const position = { x: f.hit.x + 0.5, y: f.hit.y + 0.5, z: f.hit.z + 0.5 };
  assert.equal(overflow.enqueue([tool(7)], position, f.world.dimension), true);
  const prepareDrops = (stacks) =>
    overflow.prepareEnqueue(stacks, position, f.world.dimension);
  const before = f.snapshot();
  const retained = overflow.serialize();
  assert.equal(f.action(drop(1), { prepareDrops }).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(overflow.serialize(), retained);
  assert.equal(f.action(drop(0), { prepareDrops }).ok, true);
  const [entry] = overflow.serialize().entries;
  assert.equal(entry.count, 2);
  assert.equal(entry.wear, 7);
  assert.deepEqual(entry.data, tool(7).data);
  assert.deepEqual(f.state().slots[1], tool(29));
  overflow.dispose();
});

test("scene-less furnace break prepares Gameplay XP once and never falls back after an explicit refusal", () => {
  const f = cookedFurnace(1);
  const overflow = new DropOverflow({
    coordinator: f.coordinator,
    context: f.context,
  });
  const position = { x: f.hit.x + 0.5, y: f.hit.y + 0.5, z: f.hit.z + 0.5 };
  const prepareDrops = (stacks) =>
    overflow.prepareEnqueue(stacks, position, f.world.dimension);
  const prepare = f.game.prepareExperience;
  let credits = 0;
  f.game.prepareExperience = function (amount, options) {
    credits++;
    return prepare.call(this, amount, options);
  };
  const before = f.snapshot();
  assert.equal(
    f.settlement.removeFurnace(f.world, f.hit, {
      gameplay: f.game,
      prepareDrops,
      prepareExperience: () => null,
    }).ok,
    false
  );
  assert.equal(credits, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(overflow.serialize().entries, []);
  const result = f.settlement.removeFurnace(f.world, f.hit, {
    gameplay: f.game,
    prepareDrops,
  });
  assert.equal(result.ok, true);
  assert.equal(result.experienceCommitted, true);
  assert.equal(credits, 1);
  assert.equal(f.game.getState().experience.total, 1);
  assert.equal(overflow.serialize().entries[0].id, ITEM.IRON_INGOT);
  assert.equal(overflow.serialize().entries[0].count, 1);
  assert.equal(
    f.settlement.removeFurnace(f.world, f.hit, {
      gameplay: f.game,
      prepareDrops,
    }).ok,
    false
  );
  assert.equal(credits, 1);
  overflow.dispose();
});
