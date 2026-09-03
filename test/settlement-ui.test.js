import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { Settlement } from "../src/settlement.js";
import { ContainerUI } from "../src/settlement-ui.js";
import { TransactionInvariantError } from "../src/transactions.js";
import {
  ContainerWorld,
  containerFixture,
  dropCollector,
  experienceCollector,
  moveIntoContainer,
} from "./container-fixture.js";

// Exercise the public close boundary with genuine domain transactions. The
// browser suite owns construction, rendered slots, focus and pointer behavior.
function closeFixture(accept = false) {
  const world = new ContainerWorld();
  world.set(1, 20, 1, BLOCK.CHEST);
  const ownership = { coordinator: world.coordinator, context: world.context };
  const gameplay = new Gameplay(ownership);
  assert.equal(
    gameplay.inventoryTransaction((draft) => {
      draft.slots = Array.from({ length: 36 }, () => ({
        id: BLOCK.DIRT,
        count: 64,
      }));
      draft.cursor = { id: ITEM.APPLE, count: 3 };
      return true;
    }),
    true
  );
  const settlement = new Settlement(ownership);
  const hit = { x: 1, y: 20, z: 1, id: BLOCK.CHEST };
  assert.ok(settlement.getContainerState(world, hit, gameplay));
  const changes = [];
  const openChanges = [];
  const retained = dropCollector(world.coordinator, { accept });
  const statuses = [];
  const ui = Object.assign(Object.create(ContainerUI.prototype), {
    document: { activeElement: {} },
    element: { hidden: false, contains: () => false },
    _session: { world, hit, gameplay, settlement, kind: "chest" },
    _interactions: { busy: false, reset() {} },
    _signature: "",
    prepareDrops: retained.prepareDrops,
    onChange: (change) => changes.push(change),
    onOpenChange: (open) => openChanges.push(open),
    _setStatus: (message, error) => statuses.push({ message, error }),
    refresh: () => true,
  });
  return { ui, gameplay, settlement, changes, openChanges, retained, statuses };
}

test("refused cursor overflow keeps the container open and all owned stacks unchanged", () => {
  const f = closeFixture(false);
  const before = f.gameplay.serialize();
  assert.equal(f.ui.close(), false);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.ui.element.hidden, false);
  assert.deepEqual(f.gameplay.serialize(), before);
  assert.deepEqual(f.retained.proposals, [[{ id: ITEM.APPLE, count: 3 }]]);
  assert.deepEqual(f.retained.drops, []);
  assert.equal(f.statuses.at(-1).error, true);
  assert.deepEqual(f.openChanges, []);
});

test("accepted close forwards drops exactly once and publishes the closed state", () => {
  const f = closeFixture(true);
  assert.equal(f.ui.close(), true);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.ui.element.hidden, true);
  assert.equal(f.gameplay.getState().cursor, null);
  assert.deepEqual(f.retained.drops, [{ id: ITEM.APPLE, count: 3 }]);
  assert.equal(f.changes[0].action.type, "close");
  assert.equal(f.changes[0].kind, "chest");
  assert.deepEqual(f.openChanges, [false]);
  assert.equal(f.ui.close(), false);
  assert.equal(f.retained.drops.length, 1);
  assert.equal(f.retained.proposals.length, 1);
});

test("forced invalid-screen cleanup retains owned cursor contents even during a pending UI action", () => {
  const f = closeFixture(false);
  f.ui._interactions.busy = true;
  assert.equal(f.ui.close(), false);
  assert.deepEqual(f.retained.proposals, []);
  assert.equal(f.ui.close({ force: true }), true);
  assert.equal(f.ui.isOpen, false);
  assert.deepEqual(f.gameplay.getState().cursor, { id: ITEM.APPLE, count: 3 });
  assert.deepEqual(
    f.retained.drops,
    [],
    "detaching a screen is not an ownership mutation"
  );
});

test("a domain exception remains a visible error instead of losing the screen", () => {
  const f = closeFixture();
  f.settlement.containerAction = () => {
    throw new Error("Transfer unavailable");
  };
  assert.equal(f.ui.close(), false);
  assert.equal(f.ui.isOpen, true);
  assert.equal(f.statuses.at(-1).message, "Transfer unavailable");
  assert.equal(f.gameplay.getState().cursor.count, 3);
});

test("a postcommit observer error cannot reject an accepted close or retain its cursor twice", () => {
  const f = closeFixture(true);
  f.ui.onChange = () => {
    throw new Error("Observer unavailable");
  };
  f.ui.onOpenChange = () => {
    throw new Error("Open observer unavailable");
  };
  assert.equal(f.ui.close(), true);
  assert.equal(f.ui.isOpen, false);
  assert.equal(f.gameplay.getState().cursor, null);
  assert.deepEqual(f.retained.drops, [{ id: ITEM.APPLE, count: 3 }]);
  assert.deepEqual(
    f.ui.observerErrors.map((error) => error.message),
    ["Observer unavailable", "Open observer unavailable"]
  );
});

test("publication invariants propagate instead of becoming a retryable UI error", () => {
  const f = closeFixture();
  f.settlement.containerAction = () => {
    throw new TransactionInvariantError("publication failed");
  };
  assert.throws(() => f.ui.close(), TransactionInvariantError);
  assert.equal(f.ui.isOpen, true);
});

test("furnace UI forwards prepared XP and marks a committed reward against a second award", () => {
  const f = containerFixture("furnace");
  moveIntoContainer(f, 0, { id: ITEM.RAW_IRON, count: 1 });
  moveIntoContainer(f, 1, { id: ITEM.COAL, count: 1 });
  f.settlement.update(10, f.world);
  const rewards = experienceCollector(f.coordinator, { accept: false });
  const changes = [];
  const ui = Object.assign(Object.create(ContainerUI.prototype), {
    _session: { ...f, gameplay: f.game, kind: "furnace" },
    prepareExperience: rewards.prepareExperience,
    onChange: (change) => changes.push(change),
    refresh: () => true,
  });
  const action = { type: "click", area: "container", index: 2, button: 0 };
  const before = f.snapshot();
  assert.equal(ui._action(action).ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(changes, []);
  rewards.accept = true;
  const result = ui._action(action);
  assert.equal(result.ok, true);
  assert.equal(result.experienceCommitted, true);
  assert.equal(changes[0].experienceCommitted, true);
  assert.equal(changes[0].experience, 1);
  assert.equal(rewards.total, 1);
  assert.equal(f.game.getState().experience.total, 0);
  assert.equal(f.state().experience, 0);
});
