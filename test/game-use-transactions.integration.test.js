import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { stackIdentity } from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { interactionSnapshot } from "./interaction-fixture.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

const named = (id, count, name, durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  data: { version: 1, name },
});
const bow = (name = "Held bow", durability = 100) =>
  named(ITEM.BOW, 1, name, durability);

function charge(game) {
  assert.equal(game.beginUse(), true);
  for (let index = 0; index < 4; index++) {
    game.elapsed += 0.25;
    game.useActions.update(0.25);
  }
}

function placementFixture() {
  const { game } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, named(BLOCK.COPPER_BLOCK, 2, "Copper reserve")]]);
  game.world.set(2, 9, 0, BLOCK.STONE);
  game.target = {
    x: 2,
    y: 9,
    z: 0,
    id: BLOCK.STONE,
    normal: { x: 0, y: 1, z: 0 },
  };
  return game;
}

test("actual use starts and updates carry the full named stack and hand revision", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [[0, named(ITEM.APPLE, 3, "<packed lunch>")]]);
  game.gameplay.hunger = 10;
  const start = game.useActions.use.start.bind(game.useActions.use);
  const matches = game.useActions.use.matches.bind(game.useActions.use);
  const calls = [];
  game.useActions.use.start = (...args) => {
    calls.push(["start", ...args]);
    return start(...args);
  };
  game.useActions.use.matches = (...args) => {
    calls.push(["matches", ...args]);
    return matches(...args);
  };
  assert.equal(game.beginUse(), true);
  game.useActions.update(0.25);
  const held = game.gameplay.getHandStack();
  const revision = game.gameplay.getHandRevision();
  assert.deepEqual(calls[0], ["start", "food", "main", held, revision]);
  assert.deepEqual(calls[1], ["matches", held, revision]);
});

for (const replacement of ["same-copy", "different-name", "selection"]) {
  test(`released shots reject ${replacement} replacement without ammo, wear or visuals`, () => {
    const { game } = parityGame();
    setOwnedSlots(game, [
      [0, bow()],
      [1, bow()],
      [9, { id: ITEM.ARROW, count: 4 }],
    ]);
    charge(game);
    if (replacement === "selection") game.gameplay.select(1);
    else
      assert.equal(
        game.gameplay.inventoryTransaction((owned) => {
          owned.slots[0] = bow(
            replacement === "same-copy" ? "Held bow" : "New bow"
          );
          return true;
        }),
        true
      );
    const before = interactionSnapshot(game);
    let visuals = 0;
    game.effects.shoot = () => visuals++;
    assert.equal(game.endUse(), false);
    assert.deepEqual(interactionSnapshot(game), before);
    assert.equal(visuals, 0);
  });
}

test("the Game release boundary refuses legacy ID-only or forged identity shots", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [0, bow()],
    [9, { id: ITEM.ARROW, count: 2 }],
  ]);
  const before = interactionSnapshot(game);
  for (const shot of [
    { hand: "main", itemId: ITEM.BOW, strength: 1 },
    {
      hand: "main",
      itemId: ITEM.BOW,
      strength: 1,
      stackIdentity: stackIdentity(bow("Other bow")),
      handRevision: game.gameplay.getHandRevision(),
    },
  ])
    assert.equal(game.useActions.fireBow(shot), false);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("bow ammo and wear publish once; a specifically held decorated arrow retains its data", () => {
  const { game } = parityGame();
  const held = bow("Precision", 20);
  setOwnedSlots(
    game,
    [
      [0, held],
      [9, { id: ITEM.ARROW, count: 4 }],
    ],
    named(ITEM.ARROW, 2, "Selected ammunition")
  );
  const revisions = [
    game.gameplay.getHandRevision(),
    game.gameplay.getHandRevision("offhand"),
  ];
  const observed = [];
  game.gameplay.onChange = () =>
    observed.push({
      bow: game.gameplay.getHandStack(),
      arrows: game.gameplay.getHandStack("offhand"),
    });
  charge(game);
  assert.equal(game.endUse(), true);
  assert.deepEqual(observed, [
    {
      bow: { ...held, durability: 19 },
      arrows: named(ITEM.ARROW, 1, "Selected ammunition"),
    },
  ]);
  assert.equal(game.gameplay.countPlain(ITEM.ARROW), 4);
  assert.deepEqual(
    [game.gameplay.getHandRevision(), game.gameplay.getHandRevision("offhand")],
    revisions
  );
});

test("a generic backpack arrow search excludes decoration and a source veto spends neither cost", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [0, bow()],
    [9, named(ITEM.ARROW, 2, "Keepsake")],
  ]);
  assert.equal(game.useActions.hasArrow("main"), false);
  assert.equal(game.beginUse(), false);
  assert.equal(game.gameplay.count(ITEM.ARROW), 2);
  assert.equal(game.gameplay.add(ITEM.ARROW, 1), true);
  game.elapsed++;
  charge(game);
  const prepare = game.gameplay.prepareBowShot.bind(game.gameplay);
  game.gameplay.prepareBowShot = (...args) => {
    const participant = prepare(...args);
    return participant && { ...participant, validate: () => false };
  };
  const before = interactionSnapshot(game);
  assert.equal(game.endUse(), false);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("a bow's last use still fires exactly once and a stale prepared shot never fires", () => {
  const { game } = parityGame();
  setOwnedSlots(game, [
    [0, bow("Final arrow", 1)],
    [9, { id: ITEM.ARROW, count: 2 }],
  ]);
  charge(game);
  const shot = game.useActions.use.release();
  const prepared = game.gameplay.prepareBowShot(shot);
  const before = game.gameplay.serialize();
  assert.ok(prepared);
  assert.deepEqual(game.gameplay.serialize(), before);
  game.gameplay.select(1);
  assert.equal(game.coordinator.commit([prepared]).ok, false);
  assert.equal(game.gameplay.slots[0].durability, 1);
  game.gameplay.select(0);
  game.elapsed++;
  charge(game);
  assert.equal(game.endUse(), true);
  assert.equal(game.gameplay.getHandStack(), null);
  assert.equal(game.gameplay.countPlain(ITEM.ARROW), 1);
  assert.equal(game.endUse(), false);
});

test("ordinary shield wear continues the same use, but an identical replacement cannot block", () => {
  const { game } = parityGame();
  const shield = named(ITEM.SHIELD, 1, "<guard>", 50);
  setOwnedSlots(game, [], shield);
  assert.equal(game.beginUse(), true);
  game.useActions.update(0.25);
  const revision = game.gameplay.getHandRevision("offhand");
  const source = { x: 0.5, y: 9, z: -2 };
  assert.equal(game.useActions.damage(3, "test", source).blocked, true);
  game.useActions.update(0.1);
  assert.equal(game.useActions.use.active, true);
  assert.equal(game.gameplay.getHandRevision("offhand"), revision);
  assert.equal(game.useActions.damage(3, "test", source).blocked, true);
  const current = game.gameplay.getHandStack("offhand");
  assert.equal(current.durability, 42);
  assert.deepEqual(current.data, shield.data);
  assert.equal(
    game.gameplay.inventoryTransaction((owned) => {
      owned.offhand = { ...owned.offhand };
      return true;
    }),
    true
  );
  assert.equal(game.useActions.damage(3, "test", source).blocked, false);
  assert.equal(game.gameplay.getHandStack("offhand").durability, 42);
});

test("generic high-ID placement publishes one held debit and one exact World mutation", () => {
  const game = placementFixture();
  const revision = game.gameplay.getHandRevision();
  const observed = [];
  game.player.intersectsPlacement = (changes) => {
    assert.equal(changes.length, 1);
    assert.equal(changes[0].after.id, BLOCK.COPPER_BLOCK);
    return false;
  };
  game.gameplay.onChange = () =>
    observed.push({
      id: game.world.get(2, 10, 0),
      held: game.gameplay.getHandStack(),
    });
  assert.equal(game.secondary(), true);
  assert.deepEqual(observed, [
    {
      id: BLOCK.COPPER_BLOCK,
      held: named(BLOCK.COPPER_BLOCK, 1, "Copper reserve"),
    },
  ]);
  assert.equal(game.gameplay.getHandRevision(), revision);
});

for (const refusal of ["collision", "world", "hand", "budget", "unloaded"]) {
  test(`generic placement ${refusal} refusal preserves both domains without a rollback write`, () => {
    const game = placementFixture();
    if (refusal === "collision") game.player.intersectsPlacement = () => true;
    if (refusal === "world") game.world.blocked.add(game.world.key(2, 10, 0));
    if (refusal === "unloaded") game.world.setLoaded(2, 0, false);
    if (refusal === "hand") {
      const prepare = game.gameplay.prepareHandCost.bind(game.gameplay);
      game.gameplay.prepareHandCost = (...args) => {
        const participant = prepare(...args);
        return participant && { ...participant, validate: () => false };
      };
    }
    if (refusal === "budget")
      assert.equal(
        game.coordinator.register(
          {},
          MAX_RESERVED_BYTES - game.coordinator.budget.totalBytes
        ),
        true
      );
    const before = interactionSnapshot(game);
    assert.equal(game.secondary(), false);
    assert.deepEqual(interactionSnapshot(game), before);
  });
}

test("placement captures the pre-World hand revision and checks collision again at commit", () => {
  for (const change of ["hand", "body"]) {
    const game = placementFixture();
    const beforeSlots = game.gameplay.slots;
    const prepare = game.world.prepareMutation.bind(game.world);
    game.world.prepareMutation = (...args) => {
      const participant = prepare(...args);
      if (change === "hand") game.gameplay.select(1);
      else game.player.intersectsPlacement = () => true;
      return participant;
    };
    const beforeWorld = structuredClone([...game.world.cells]);
    assert.equal(game.secondary(), false);
    assert.deepEqual(game.gameplay.slots, beforeSlots);
    assert.deepEqual([...game.world.cells], beforeWorld);
  }
});

test("the actual use dispatcher reaches oriented placement and linked toggles", () => {
  const { game } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, { id: BLOCK.OAK_SLAB, count: 2 }]]);
  game.target = {
    x: 2,
    y: 8,
    z: 0,
    id: BLOCK.STONE,
    normal: { x: 0, y: 1, z: 0 },
    localPoint: { x: 0.5, y: 1, z: 0.5 },
  };
  assert.equal(game.secondary(), true);
  assert.equal(game.world.getCell(2, 9, 0).state, 0);
  assert.equal(game.gameplay.getHandStack().count, 1);
  game.world.set(3, 9, 0, BLOCK.OAK_TRAPDOOR);
  game.target = {
    x: 3,
    y: 9,
    z: 0,
    id: BLOCK.OAK_TRAPDOOR,
    normal: { x: 0, y: 1, z: 0 },
  };
  game.elapsed++;
  assert.equal(game.secondary(), true);
  assert.equal(game.world.getCell(3, 9, 0).state & S.OPEN, S.OPEN);
  assert.equal(game.gameplay.getHandStack().count, 1);
});

test("flint use composes priming with wear, including refusal before any fuse or block write", () => {
  const { game } = parityGame();
  const flint = named(
    ITEM.FLINT_AND_STEEL,
    1,
    "Spark",
    getItem(ITEM.FLINT_AND_STEEL).durability
  );
  setOwnedSlots(game, [[0, flint]]);
  game.world.set(2, 9, 0, BLOCK.TNT);
  game.target = { x: 2, y: 9, z: 0, id: BLOCK.TNT };
  const before = interactionSnapshot(game);
  const prepare = game.gameplay.prepareHandCost.bind(game.gameplay);
  game.gameplay.prepareHandCost = () => null;
  assert.equal(game.secondary(), false);
  assert.deepEqual(interactionSnapshot(game), before);
  assert.equal(game.fuses.entries.length, 0);
  game.gameplay.prepareHandCost = prepare;
  game.elapsed++;
  assert.equal(game.secondary(), true);
  assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(game.fuses.entries.length, 1);
  assert.deepEqual(game.gameplay.getHandStack(), {
    ...flint,
    durability: flint.durability - 1,
  });
});

test("portal ignition reserves all six cells with one tool cost and never overwrites an unharvested plant", () => {
  const { game } = parityGame();
  const flint = named(ITEM.FLINT_AND_STEEL, 1, "Portal spark", 20);
  setOwnedSlots(game, [[0, flint]]);
  for (let width = 0; width < 4; width++)
    for (let height = 0; height < 5; height++)
      if (width === 0 || width === 3 || height === 0 || height === 4)
        game.world.set(2 + width, 9 + height, 0, BLOCK.OBSIDIAN);
  game.target = { x: 2, y: 10, z: 0, id: BLOCK.OBSIDIAN };
  game.world.set(3, 10, 0, BLOCK.TALL_GRASS);
  const withPlant = interactionSnapshot(game);
  assert.equal(game.secondary(), false);
  assert.deepEqual(interactionSnapshot(game), withPlant);
  game.world.set(3, 10, 0, BLOCK.AIR);
  const before = interactionSnapshot(game);
  const prepareCost = game.gameplay.prepareHandCost.bind(game.gameplay);
  game.gameplay.prepareHandCost = () => null;
  game.elapsed++;
  assert.equal(game.secondary(), false);
  assert.deepEqual(interactionSnapshot(game), before);
  game.gameplay.prepareHandCost = prepareCost;
  game.world.blocked.add(game.world.key(4, 12, 0));
  game.elapsed++;
  assert.equal(game.secondary(), false);
  assert.deepEqual(interactionSnapshot(game), before);
  game.world.blocked.clear();
  game.elapsed++;
  assert.equal(game.secondary(), true);
  for (const x of [3, 4])
    for (const y of [10, 11, 12])
      assert.equal(game.world.get(x, y, 0), BLOCK.NETHER_PORTAL);
  assert.deepEqual(game.gameplay.getHandStack(), { ...flint, durability: 19 });
  game.elapsed++;
  assert.equal(
    game.secondary(),
    false,
    "an already-lit portal must not spend wear"
  );
  assert.deepEqual(game.gameplay.getHandStack(), { ...flint, durability: 19 });
});

test("unexpected publication failures propagate through actual Game use, never ordinary refusal", () => {
  const game = placementFixture();
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    return (
      participant && {
        ...participant,
        publish: () => {
          throw new Error("authored publication invariant");
        },
      }
    );
  };
  assert.throws(() => game.secondary(), TransactionInvariantError);
});
