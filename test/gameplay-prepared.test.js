import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay, TransactionInvariantError } from "../src/gameplay.js";
import { cloneStack, takeStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";
import { preparedDropFixture } from "./prepared-drop-fixture.js";

const named = (id, count, name, durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  data: { version: 1, name },
});
const context = () =>
  createWorldContext({ seed: "inventory-bridge", generatorVersion: 3 });

function gameplayFixture(t, options = {}) {
  const game = new Gameplay({ context: context(), ...options });
  t.after(() => game.dispose());
  return game;
}

test("prepareInventory is detached, single-use and silent until publication and notification", (t) => {
  let notifications = 0;
  const game = gameplayFixture(t, { onChange: () => notifications++ });
  const before = game.serialize();
  const beforeBytes = game.reservedBytes;
  const tool = {
    ...named(ITEM.WOOD_PICKAXE, 1, "A | [B]", 17),
    data: {
      version: 1,
      name: "A | [B]",
      enchantments: { unbreaking: 2, efficiency: 3 },
    },
  };
  let captured;
  const participant = game.prepareInventory((draft) => {
    captured = draft;
    draft.slots[9] = tool;
    draft.experienceTotal = 27;
    return true;
  });
  assert.ok(participant);
  assert.equal(participant.owner, game);
  assert.equal(participant.beforeBytes, beforeBytes);
  assert.equal(
    participant.afterBytes - beforeBytes,
    encodedBytes(tool) - encodedBytes(null)
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.coordinator.usage(game), beforeBytes);
  assert.equal(notifications, 0);
  captured.slots[9].data.name = "Edited after preparation";
  captured.experienceTotal = 0;
  const committed = game.coordinator.commit([participant]);
  assert.equal(committed.ok, true);
  assert.equal(notifications, 1);
  assert.equal(game.slots[9].data.name, "A | [B]");
  assert.equal(game.getState().experience.total, 27);
  assert.equal(game.reservedBytes, participant.afterBytes);
  assert.equal(game.coordinator.usage(game), participant.afterBytes);
  assert.equal(game.coordinator.commit([participant]).ok, false);
  assert.equal(notifications, 1);
});

test("prepared stack and XP transfers share one coordinator and observers see both owners", (t) => {
  const coordinator = new TransactionCoordinator();
  const donor = gameplayFixture(t, { coordinator });
  const recipient = gameplayFixture(t, { coordinator });
  const item = named(ITEM.WOOD_PICKAXE, 1, "Transferred", 11);
  assert.equal(donor.addStack(item), true);
  const index = donor.slots.findIndex((stack) => stack?.id === item.id);
  const receive = recipient.prepareAddStack(item);
  let observed = 0;
  donor.onChange = () => {
    observed++;
    assert.equal(donor.count(item.id), 0);
    assert.equal(recipient.count(item.id), 1);
    assert.equal(
      recipient.addExperience(1),
      true,
      "observer runs outside the publication guard"
    );
  };
  assert.equal(
    donor.inventoryTransaction(
      (draft) => {
        assert.deepEqual(takeStack(draft.slots, index), item);
        return true;
      },
      { participants: [receive] }
    ),
    true
  );
  assert.equal(observed, 1);
  assert.deepEqual(
    recipient.slots.find((stack) => stack?.id === item.id),
    item
  );
  assert.equal(recipient.getState().experience.total, 1);
  assert.equal(recipient.coordinator.commit([receive]).ok, false);

  const credit = recipient.prepareExperience(4, { notify: false });
  assert.equal(recipient.getState().experience.total, 1);
  assert.equal(coordinator.commit([credit]).ok, true);
  assert.equal(recipient.getState().experience.total, 5);
});

test("malformed edits, metadata and async edits leave inventory, reservations and observers untouched", (t) => {
  let notices = 0;
  const game = gameplayFixture(t, { onChange: () => notices++ });
  const before = game.serialize();
  const bytes = game.reservedBytes;
  for (const edit of [
    null,
    async () => true,
    () => false,
    () => {
      throw new RangeError("invalid edit");
    },
    (draft) => {
      draft.cursor = { id: ITEM.APPLE, count: 65 };
      return true;
    },
    (draft) => {
      draft.slots[0].data = { version: 9 };
      return true;
    },
    (draft) => {
      draft.slots[0].data = { version: 1, enchantments: { sharpness: 1 } };
      return true;
    },
    (draft) => {
      draft.experienceTotal = Number.MAX_SAFE_INTEGER;
      return true;
    },
    (draft) => {
      draft.fuelTime = 81;
      return true;
    },
    (draft) => {
      draft.craftingGrid[8] = { id: ITEM.APPLE, count: 1 };
      return true;
    },
  ])
    assert.equal(game.prepareInventory(edit), null);
  assert.equal(
    game.prepareInventory(() => true, { notify: "yes" }),
    null
  );
  assert.equal(game.prepareExperience(-1), null);
  assert.equal(game.prepareExperience(0.5), null);
  assert.equal(game.prepareAddStack({ id: ITEM.APPLE, count: 0 }), null);
  assert.equal(
    game.add(ITEM.APPLE, 1, { data: { version: 1, name: "Must not strip" } }),
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.reservedBytes, bytes);
  assert.equal(game.coordinator.usage(game), bytes);
  assert.equal(notices, 0);
});

test("equal-byte edits, selection, reload, context changes and disposal stale prepared edits", (t) => {
  for (const mutate of [
    (game) =>
      game.inventoryTransaction((draft) => {
        draft.slots[0] = cloneStack(draft.slots[0]);
        return true;
      }),
    (game) => {
      game.select(1);
      game.select(0);
    },
    (game) => game.load(game.serialize(), { notify: false }),
    (game) => {
      game.context.seed = "changed-context";
    },
    (game) => game.dispose(),
  ]) {
    const mutableContext = { ...context() };
    const game = gameplayFixture(t, { context: mutableContext });
    const participant = game.prepareExperience(10);
    const bytes = game.reservedBytes;
    mutate(game);
    const afterMutation = game.serialize();
    assert.equal(
      game.coordinator.commit([participant]).ok,
      false,
      mutate.toString()
    );
    assert.deepEqual(game.serialize(), afterMutation);
    assert.equal(game.getState().experience.total, 0);
    if (!game._disposed) assert.equal(game.reservedBytes, bytes);
  }
});

test("composite veto, foreign/duplicate owners and budget refusal never debit a prepared source", (t) => {
  const game = gameplayFixture(t);
  const other = gameplayFixture(t);
  const sink = preparedDropFixture(game);
  t.after(() => sink.overflow.dispose());
  const before = game.serialize();
  const credit = other.prepareExperience(2);
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        takeStack(draft.slots, 0, 1);
        return true;
      },
      { participants: [credit] }
    ),
    false
  );
  assert.deepEqual(game.serialize(), before);
  assert.equal(other.getState().experience.total, 0);
  const source = game.prepareInventory((draft) => {
    draft.slots[0] = null;
    return true;
  });
  assert.equal(game.coordinator.commit([source, source]).ok, false);
  assert.deepEqual(game.serialize(), before);

  const drop = sink.prepareDrops([{ id: ITEM.APPLE, count: 1 }]);
  assert.equal(
    game.inventoryTransaction(
      (draft) => {
        takeStack(draft.slots, 0, 1);
        return true;
      },
      { participants: [{ ...drop, validate: () => false }] }
    ),
    false
  );
  assert.equal(sink.overflow.size, 0);
  assert.deepEqual(game.serialize(), before);

  const full = {};
  assert.equal(
    game.coordinator.register(
      full,
      MAX_RESERVED_BYTES - game.coordinator.budget.totalBytes
    ),
    true
  );
  const totalBytes = game.coordinator.budget.totalBytes;
  assert.equal(game.dropSelected({ prepareDrops: sink.prepareDrops }), false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(sink.overflow.size, 0);
  assert.equal(game.coordinator.budget.totalBytes, totalBytes);
});

test("a joint capacity release funds an inventory growth without a transient rejection", (t) => {
  const game = gameplayFixture(t);
  const owner = {};
  const coordinator = game.coordinator;
  const capacity = MAX_RESERVED_BYTES - coordinator.budget.totalBytes;
  assert.equal(coordinator.register(owner, capacity), true);
  const add = game.prepareAddStack(named(ITEM.PAPER, 1, "Reserved capacity"));
  assert.ok(add);
  const delta = add.afterBytes - add.beforeBytes;
  assert.ok(delta > 0);
  assert.equal(coordinator.commit([add]).ok, false);
  const release = {
    owner,
    beforeBytes: capacity,
    afterBytes: capacity - delta,
    validate: () => true,
    publish: () => {},
  };
  assert.equal(coordinator.commit([add, release]).ok, true);
  assert.equal(game.count(ITEM.PAPER), 1);
  assert.equal(coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
});

test("over-budget staged imports retain all metadata and permit only non-growing ownership edits", (t) => {
  const game = gameplayFixture(t);
  const owner = {};
  const coordinator = game.coordinator;
  coordinator.register(
    owner,
    MAX_RESERVED_BYTES - coordinator.budget.totalBytes
  );
  const save = game.serialize();
  save.slots[0].data = { version: 1, name: "Imported progress" };
  const before = game.serialize();
  assert.equal(game.load(save), false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.load(save, { allowOverBudget: true, notify: false }), true);
  assert.deepEqual(game.serialize(), save);
  assert.ok(coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
  assert.equal(game.addStack(named(ITEM.PAPER, 1, "More progress")), false);
  assert.equal(game.consumeHand("main", 4), true);
  assert.equal(game.slots[0], null);
  assert.ok(coordinator.budget.totalBytes <= MAX_RESERVED_BYTES);
});

test("generic recipe planning and consumption never pay with decorated ingredients or fuel", (t) => {
  const game = gameplayFixture(t);
  const log = named(BLOCK.OAK_LOG, 1, "Building keepsake");
  assert.equal(game.addStack(log), true);
  let before = game.serialize();
  assert.equal(game.count(BLOCK.OAK_LOG), 1);
  assert.equal(game.countPlain(BLOCK.OAK_LOG), 0);
  assert.equal(
    game.getCraftableRecipes().find((recipe) => recipe.id === "planks")
      .canCraft,
    false
  );
  assert.equal(game.craft("planks").reason, "ingredients");
  assert.equal(game.consume(BLOCK.OAK_LOG), false);
  assert.deepEqual(game.serialize(), before);
  assert.equal(game.add(BLOCK.OAK_LOG, 1), true);
  assert.equal(game.count(BLOCK.OAK_LOG), 2);
  assert.equal(game.countPlain(BLOCK.OAK_LOG), 1);
  assert.equal(game.craft("planks").ok, true);
  assert.equal(game.count(BLOCK.OAK_LOG), 1);
  assert.equal(game.countPlain(BLOCK.OAK_LOG), 0);
  assert.deepEqual(
    game.slots.find((stack) => stack?.id === BLOCK.OAK_LOG),
    log
  );
  assert.equal(game.count(BLOCK.PLANKS), 4);

  const fuelOnly = gameplayFixture(t);
  fuelOnly.add(ITEM.RAW_IRON, 1);
  fuelOnly.addStack(named(ITEM.COAL, 1, "Not fuel"));
  before = fuelOnly.serialize();
  assert.equal(
    fuelOnly.craft("iron_ingot", { station: "furnace" }).reason,
    "fuel"
  );
  assert.deepEqual(fuelOnly.serialize(), before);
  assert.equal(fuelOnly.getState().crafting.length, 0);
});

test("paid queue progress invalidates preparations and drains exactly once without new ingredients", (t) => {
  const game = gameplayFixture(t);
  game.add(ITEM.RAW_IRON, 1);
  game.add(ITEM.COAL, 1);
  assert.equal(game.craft("iron_ingot", { station: "furnace" }).ok, true);
  const participant = game.prepareExperience(7);
  game.update(3);
  assert.equal(game.coordinator.commit([participant]).ok, false);
  assert.equal(game.getState().experience.total, 0);
  const restored = gameplayFixture(t);
  assert.equal(restored.load(game.serialize()), true);
  restored.update(7);
  restored.update(60);
  assert.equal(restored.count(ITEM.IRON_INGOT), 1);
  assert.equal(restored.count(ITEM.RAW_IRON), 0);
  assert.equal(restored.count(ITEM.COAL), 0);
  assert.equal(restored.getState().fuelTime, 70);
});

test("eager drop handlers are never called and fatal publication invariants are never ordinary failures", (t) => {
  const game = gameplayFixture(t);
  const before = game.serialize();
  let calls = 0;
  assert.equal(
    game.inventoryAction(
      {
        type: "drop",
        area: "inventory",
        index: 0,
      },
      {
        acceptDrop: () => {
          calls++;
          return true;
        },
      }
    ).ok,
    false
  );
  assert.equal(calls, 0);
  assert.deepEqual(game.serialize(), before);

  const owner = {};
  game.coordinator.register(owner, 0);
  const failure = new Error("fixture publication failure");
  assert.throws(
    () =>
      game.inventoryTransaction(
        (draft) => {
          takeStack(draft.slots, 0, 1);
          return true;
        },
        {
          participants: [
            {
              owner,
              beforeBytes: 0,
              afterBytes: 0,
              validate: () => true,
              publish: () => {
                throw failure;
              },
            },
          ],
        }
      ),
    (error) =>
      error instanceof TransactionInvariantError && error.cause === failure
  );
});

test("notification failures do not undo an already committed metadata transfer", (t) => {
  const failure = new Error("observer failure");
  const game = gameplayFixture(t, {
    onChange: () => {
      throw failure;
    },
  });
  const stack = named(ITEM.BOOK, 1, "Recorded");
  const result = game.coordinator.commit([game.prepareAddStack(stack)]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, [failure]);
  assert.deepEqual(
    game.slots.find((entry) => entry?.id === ITEM.BOOK),
    stack
  );
});
