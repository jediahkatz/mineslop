import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { takeStack } from "../src/inventory-slots.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { pickupFixture } from "./metadata-fixture.js";

function fixture(t, options = {}) {
  const { pickups, world, coordinator } = pickupFixture(t);
  world.coordinator = coordinator;
  const gameplay = new Gameplay({
    coordinator,
    context: world,
    mode: options.mode,
  });
  const overflow = new DropOverflow({
    coordinator,
    context: world,
    maxEntries: options.maxEntries,
  });
  const events = [];
  const game = {
    active: true,
    gameplay,
    world,
    pickups,
    overflow,
    player: {
      eyePosition: { x: 0.5, y: 2, z: 0.5 },
      forward: { x: 0, y: 0, z: -1 },
    },
    elapsed: 10,
    lastOverflowToast: 0,
    graphics: { rebuildDirty: () => events.push("rebuild") },
    effects: { sound: () => events.push("sound") },
    ui: { toast: (text) => events.push(text) },
    refreshHud: () => events.push("hud"),
    scheduleSave: () => events.push("save"),
    resetActions() {},
  };
  const actions = new GameInventoryActions(game);
  t.after(() => {
    gameplay.dispose();
    overflow.dispose();
  });
  return {
    game,
    gameplay,
    world,
    pickups,
    overflow,
    coordinator,
    actions,
    events,
  };
}

const named = (id, count, name, durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  data: { version: 1, name },
});
const snapshot = ({ gameplay, overflow, pickups, coordinator }) => ({
  gameplay: gameplay.serialize(),
  overflow: overflow.serialize(),
  pickups: pickups.serialize(),
  bytes: coordinator.budget.totalBytes,
});

test("prepared player drops publish source and overflow before flush, save or toast observers", (t) => {
  const f = fixture(t);
  const dropped = named(ITEM.WOOD_PICKAXE, 1, "<mine|west>", 7);
  assert.equal(
    f.gameplay.inventoryTransaction((draft) => {
      draft.slots[0] = dropped;
      return true;
    }),
    true
  );
  const before = snapshot(f);
  const retained = f.actions.preparePlayerDrops([dropped]);
  const source = f.gameplay.prepareInventory((draft) => {
    takeStack(draft.slots, 0);
    return true;
  });
  assert.ok(retained);
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.events, []);
  f.gameplay.onChange = () => {
    assert.equal(f.gameplay.slots[0], null);
    assert.equal(f.overflow.size, 1);
    assert.equal(
      f.pickups.size,
      0,
      "flushing belongs to drop notification, not publication"
    );
    f.events.push("both-published");
  };
  const result = f.coordinator.commit([source, retained]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(f.events[0], "both-published");
  assert.equal(f.events.at(-1), "save");
  assert.equal(f.overflow.size, 0);
  assert.deepEqual(f.pickups.getStack(0), dropped);
  assert.equal(f.coordinator.commit([retained]).ok, false);
});

test("source veto, stale source and capacity failure leave all drop owners and notifications unchanged", (t) => {
  const f = fixture(t);
  const prepareDrops = (stacks) => f.actions.preparePlayerDrops(stacks);
  const before = snapshot(f);
  const retained = prepareDrops([{ id: ITEM.APPLE, count: 1 }]);
  const source = f.gameplay.prepareInventory((draft) => {
    takeStack(draft.slots, 0, 1);
    return true;
  });
  assert.equal(
    f.coordinator.commit([{ ...source, validate: () => false }, retained]).ok,
    false
  );
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.events, []);
  f.gameplay.select(1);
  const afterSelection = snapshot(f);
  assert.equal(f.coordinator.commit([source, retained]).ok, false);
  assert.deepEqual(snapshot(f), afterSelection);
  assert.deepEqual(f.events, []);
  f.gameplay.select(0);
  const padding = {};
  assert.equal(
    f.coordinator.register(
      padding,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const full = snapshot(f);
  assert.equal(f.gameplay.dropSelected({ prepareDrops }), false);
  assert.deepEqual(snapshot(f), full);
  assert.deepEqual(f.events, []);
});

test("world/hand replacement between preparation and commit cannot orphan a retained drop", (t) => {
  const f = fixture(t);
  const source = f.gameplay.prepareInventory((draft) => {
    takeStack(draft.slots, 0, 1);
    return true;
  });
  const retained = f.actions.preparePlayerDrops([{ id: ITEM.APPLE, count: 1 }]);
  f.world.epoch++;
  const before = snapshot(f);
  assert.equal(f.coordinator.commit([source, retained]).ok, false);
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.events, []);
});

test("closing metadata escrow and Creative swaps refuse drop capacity without altering source or palette", (t) => {
  const f = fixture(t, { mode: "creative", maxEntries: 1 });
  const kept = named(ITEM.APPLE, 1, "Existing overflow");
  f.overflow.enqueue([kept], { x: 1, y: 2, z: 1 }, "overworld");
  f.gameplay.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => ({
      id: BLOCK.DIRT,
      count: 64,
    }));
    draft.slots[0] = named(ITEM.WOOD_PICKAXE, 1, "Displaced tool", 9);
    draft.cursor = named(ITEM.APPLE, 2, "Held escrow");
    return true;
  });
  f.gameplay.assignSlot(0, ITEM.SHIELD);
  const before = snapshot(f);
  assert.equal(f.actions.action({ type: "close" }).ok, false);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.actions.swapHands(), false);
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.events, []);
});

test("Creative copy swaps commit finite displacement, both hands and palette together", (t) => {
  const f = fixture(t, { mode: "creative" });
  const displaced = named(ITEM.WOOD_PICKAXE, 1, "Displaced", 7);
  f.gameplay.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => ({
      id: BLOCK.DIRT,
      count: 64,
    }));
    draft.slots[0] = displaced;
    draft.offhand = named(ITEM.APPLE, 3, "Offhand");
    return true;
  });
  f.gameplay.assignSlot(0, ITEM.SHIELD);
  const previousRevision = f.gameplay.getHandRevision();
  assert.equal(f.actions.swapHands(), true);
  assert.equal(f.gameplay.hotbar[0], ITEM.APPLE);
  assert.equal(f.gameplay.slots[0].data.name, "Offhand");
  assert.equal(f.gameplay.offhand.id, ITEM.SHIELD);
  assert.equal(f.gameplay.count(ITEM.WOOD_PICKAXE), 0);
  assert.deepEqual(f.pickups.getStack(0), displaced);
  assert.ok(f.gameplay.getHandRevision() > previousRevision);
});

test("swapHandItem accepts prepared World work and rejects eager callbacks before invoking them", (t) => {
  const f = fixture(t);
  f.gameplay.inventoryTransaction((draft) => {
    draft.slots[0] = named(ITEM.BUCKET, 2, "Watering");
    return true;
  });
  const owner = {};
  assert.equal(f.coordinator.register(owner, 0), true);
  let worldWrites = 0;
  // Pure protocol fixture, not a fake production World or terrain generator.
  const worldParticipant = (valid) => ({
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => valid,
    publish: () => {
      worldWrites++;
    },
  });
  const before = snapshot(f);
  assert.equal(
    f.actions.swapHandItem("main", ITEM.WATER_BUCKET, () => {
      worldWrites++;
      return true;
    }),
    false
  );
  assert.equal(worldWrites, 0);
  assert.equal(f.actions.swapHandItem("main", ITEM.WATER_BUCKET, null), false);
  assert.equal(
    f.actions.swapHandItem("main", ITEM.WATER_BUCKET, worldParticipant(false)),
    false
  );
  assert.deepEqual(snapshot(f), before);
  assert.equal(worldWrites, 0);
  assert.equal(
    f.actions.swapHandItem("main", ITEM.WATER_BUCKET, worldParticipant(true)),
    true
  );
  assert.equal(worldWrites, 1);
  assert.deepEqual(f.gameplay.slots[0], named(ITEM.BUCKET, 1, "Watering"));
  assert.deepEqual(
    f.gameplay.slots.find((stack) => stack?.id === ITEM.WATER_BUCKET),
    named(ITEM.WATER_BUCKET, 1, "Watering")
  );
});

test("a full bucket-result inventory rejects before any prepared World publication", (t) => {
  const f = fixture(t);
  f.gameplay.inventoryTransaction((draft) => {
    draft.slots = Array.from({ length: 36 }, () => ({
      id: BLOCK.DIRT,
      count: 64,
    }));
    draft.slots[0] = named(ITEM.BUCKET, 2, "Do not lose");
    return true;
  });
  const owner = {};
  f.coordinator.register(owner, 0);
  const before = snapshot(f);
  let writes = 0;
  assert.equal(
    f.actions.swapHandItem("main", ITEM.WATER_BUCKET, {
      owner,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () => true,
      publish: () => {
        writes++;
      },
    }),
    false
  );
  assert.deepEqual(snapshot(f), before);
  assert.equal(writes, 0);
});
