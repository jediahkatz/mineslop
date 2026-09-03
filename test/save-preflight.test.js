import assert from "node:assert/strict";
import test from "node:test";
import { VoxelGame } from "../src/game.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { preflightWorldComponents } from "../src/save-preflight.js";

test("component preflight accepts canonical cursor/grid ownership without changing the input", () => {
  const gameplay = new Gameplay();
  assert.equal(
    gameplay.inventoryTransaction((draft) => {
      draft.cursor = { id: ITEM.STICK, count: 3 };
      draft.craftingGrid[0] = { id: ITEM.COAL, count: 2 };
      return true;
    }),
    true
  );
  const saved = {
    gameplay: gameplay.serialize(),
    experienceOrbs: {
      version: 1,
      orbs: [{ amount: 5, x: 1, y: 250, z: 2, dimension: "overworld" }],
    },
  };
  const before = structuredClone(saved);
  assert.equal(preflightWorldComponents(saved), true);
  assert.deepEqual(saved, before);
  assert.equal(
    preflightWorldComponents({}),
    true,
    "old saves can omit new components"
  );
});

test("invalid slots and XP fail before initializing or disposing any active-world resources", async () => {
  const invalidInventory = new Gameplay().serialize();
  invalidInventory.slots[0].count = 1000;
  for (const [saved, expected] of [
    [{ gameplay: invalidInventory }, /inventory/],
    [{ gameplay: null }, /inventory/],
    [{ pickups: null }, /pickups/],
    [
      {
        pickups: {
          version: 1,
          items: [
            {
              id: ITEM.APPLE,
              count: 1,
              x: 1,
              y: 9,
              z: 2,
              dimension: "overworld",
              pickupDelay: -1,
            },
          ],
        },
      },
      /pickups/,
    ],
    [
      {
        experienceOrbs: {
          version: 1,
          orbs: [{ amount: -5, x: 1, y: 9, z: 2, dimension: "overworld" }],
        },
      },
      /experience/,
    ],
  ]) {
    let disposals = 0;
    const game = {
      building: false,
      world: { dispose: () => disposals++ },
      player: { dispose: () => disposals++ },
      graphics: { dispose: () => disposals++ },
      ui: {
        closeInventory: () =>
          assert.fail("Preflight must precede UI replacement"),
      },
    };
    await assert.rejects(
      VoxelGame.prototype.initialize.call(game, "preserved", saved),
      expected
    );
    assert.equal(disposals, 0);
    assert.equal(game.building, false);
  }
});

test("a refused asynchronous inventory close cannot resume or replace its world", async () => {
  let menus = 0;
  let disposals = 0;
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    started: true,
    paused: false,
    building: false,
    overlayOpen: true,
    gameplay: { dead: false },
    player: { enabled: true, unlock() {}, dispose: () => disposals++ },
    world: { dispose: () => disposals++ },
    containerUI: { isOpen: false },
    ui: {
      closeInventory: async () => false,
      closeAtlas() {},
      showMenu: () => menus++,
      toast() {},
    },
    save: async () => ({ ok: true }),
  });
  const paused = game.pause();
  assert.equal(
    game.paused,
    true,
    "simulation pauses before awaiting the close"
  );
  assert.equal(await paused, false);
  assert.equal(menus, 0);
  assert.equal(game.overlayOpen, true);
  assert.equal(await game.play(), false);
  await assert.rejects(
    game.initialize("replacement", {}),
    /Close the inventory safely/
  );
  assert.equal(disposals, 0);
  assert.equal(game.building, false);
});

test("concurrent close requests share one ownership-settlement operation", async () => {
  let resolve;
  let closes = 0;
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    overlayOpen: true,
    containerUI: { isOpen: false },
    ui: {
      closeInventory: () => {
        closes++;
        return new Promise((done) => {
          resolve = done;
        });
      },
      closeAtlas() {},
    },
  });
  const first = game.closeScreens();
  const second = game.closeScreens();
  assert.equal(closes, 1);
  assert.equal(game.closingScreens, true);
  resolve(true);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(game.overlayOpen, false);
  assert.equal(game.closingScreens, false);
});
