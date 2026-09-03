import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID, normalizeCell } from "../src/block-state.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { interactionSnapshot } from "./interaction-fixture.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

const bucket = (id = ITEM.BUCKET, count = 1) => ({
  id,
  count,
  data: { version: 1, name: "<cistern|north>" },
});

function bucketGame(id = ITEM.BUCKET, count = 1, hand = "main") {
  const { game, messages } = parityGame("survival", {
    generatorVersion: 4,
    floor: null,
  });
  setOwnedSlots(
    game,
    hand === "main" ? [[0, bucket(id, count)]] : [],
    hand === "offhand" ? bucket(id, count) : null
  );
  return { game, messages };
}

function pourTarget(game) {
  game.world.set(0, 10, -2, BLOCK.STONE);
  game.target = {
    x: 0,
    y: 10,
    z: -2,
    id: BLOCK.STONE,
    normal: { x: 0, y: 0, z: 1 },
  };
}

for (const fluid of [FLUID.WATER_SOURCE, FLUID.BUBBLE_UP, FLUID.BUBBLE_DOWN]) {
  test(`bucket collection recognizes source code ${fluid} and preserves the named hand`, () => {
    const { game } = bucketGame();
    assert.equal(
      game.world.setCell(0, 10, -2, {
        id: BLOCK.WATER,
        state: 0,
        fluid,
      }),
      true
    );
    assert.equal(game.beginUse(), true);
    assert.equal(game.world.get(0, 10, -2), BLOCK.AIR);
    assert.deepEqual(game.gameplay.getHandStack(), bucket(ITEM.WATER_BUCKET));
    assert.equal(game.gameplay.count(ITEM.BUCKET), 0);
  });
}

for (const fluid of [FLUID.WATER_1, FLUID.WATER_7, FLUID.WATER_FALLING]) {
  test(`flowing code ${fluid} alone cannot fill an empty bucket`, () => {
    const { game } = bucketGame();
    game.world.setCell(0, 10, -2, { id: BLOCK.WATER, state: 0, fluid });
    const before = interactionSnapshot(game);
    assert.equal(game.beginUse(), false);
    assert.deepEqual(interactionSnapshot(game), before);
  });
}

test("flow is skipped in favor of a real source without draining the flow cell", () => {
  const { game } = bucketGame();
  game.world.setCell(0, 10, -1, {
    id: BLOCK.WATER,
    fluid: FLUID.WATER_FALLING,
  });
  game.world.set(0, 10, -2, BLOCK.WATER);
  assert.equal(game.beginUse(), true);
  assert.equal(game.world.get(0, 10, -2), BLOCK.AIR);
  assert.equal(game.world.getFluid(0, 10, -1), FLUID.WATER_FALLING);
});

test("waterlogged source collection dries the exact high-ID host and preserves orientation", () => {
  const { game } = bucketGame(ITEM.BUCKET, 1, "offhand");
  const cell = { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: FLUID.WATER_SOURCE };
  game.world.setCell(0, 10, -2, cell);
  assert.equal(game.beginUse(), true);
  assert.deepEqual(game.world.getCell(0, 10, -2), {
    ...cell,
    fluid: FLUID.NONE,
  });
  assert.deepEqual(
    game.gameplay.getHandStack("offhand"),
    bucket(ITEM.WATER_BUCKET)
  );
  assert.equal(game.gameplay.getHandStack("main"), null);
});

test("bucket sight uses shape channels: an empty slab half is open, a full wall is not", () => {
  for (const wall of [BLOCK.OAK_SLAB, BLOCK.STONE]) {
    const { game } = bucketGame();
    game.world.set(0, 10, -1, wall);
    game.world.set(0, 10, -2, BLOCK.WATER);
    assert.equal(game.beginUse(), wall === BLOCK.OAK_SLAB);
    assert.equal(
      game.world.get(0, 10, -2),
      wall === BLOCK.OAK_SLAB ? BLOCK.AIR : BLOCK.WATER
    );
  }
});

test("an unloaded source column is an occluder, never an AIR read that allows collection through it", () => {
  const { game } = bucketGame();
  game.world.set(0, 10, -2, BLOCK.WATER);
  game.world.setLoaded(0, -2, false);
  const before = interactionSnapshot(game);
  assert.equal(game.beginUse(), false);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("aquatic-only hosts remain intact when canonical cells do not permit a dry host", () => {
  const { game } = bucketGame();
  game.world.set(0, 10, -2, BLOCK.KELP);
  const before = interactionSnapshot(game);
  assert.equal(game.beginUse(), false);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("a full backpack of stacked buckets refuses collection before the water can disappear", () => {
  const { game } = bucketGame();
  setOwnedSlots(
    game,
    Array.from({ length: 36 }, (_, index) => [
      index,
      index === 0 ? bucket(ITEM.BUCKET, 2) : { id: BLOCK.DIRT, count: 64 },
    ])
  );
  game.world.set(0, 10, -2, BLOCK.WATER);
  const before = interactionSnapshot(game);
  assert.equal(game.beginUse(), false);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("a hand replaced while World collection is prepared cannot be exchanged by stale use", () => {
  const { game } = bucketGame();
  setOwnedSlots(game, [
    [0, bucket()],
    [1, bucket()],
  ]);
  game.world.set(0, 10, -2, BLOCK.WATER);
  const beforeSlots = game.gameplay.slots;
  const beforeWorld = structuredClone([...game.world.cells]);
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    game.gameplay.select(1);
    return participant;
  };
  assert.equal(game.beginUse(), false);
  assert.deepEqual(game.gameplay.slots, beforeSlots);
  assert.deepEqual([...game.world.cells], beforeWorld);
});

test("replacing the Gameplay owner during bucket preparation cannot spend a matching replacement hand", () => {
  const { game } = bucketGame();
  game.world.set(0, 10, -2, BLOCK.WATER);
  const previous = game.gameplay;
  const before = previous.serialize();
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    game.gameplay = new Gameplay({
      coordinator: game.coordinator,
      context: game.worldContext,
    });
    assert.equal(
      game.gameplay.load(before, { context: game.worldContext }),
      true
    );
    assert.equal(game.gameplay.getHandRevision(), previous.getHandRevision());
    return participant;
  };
  assert.equal(game.beginUse(), false);
  assert.deepEqual(previous.serialize(), before);
  assert.deepEqual(game.gameplay.serialize(), before);
  assert.equal(game.world.get(0, 10, -2), BLOCK.WATER);
});

test("a stale prepared water read cannot spend the bucket even when the source was replaced with the same cell", () => {
  const { game } = bucketGame();
  game.world.set(0, 10, -2, BLOCK.WATER);
  const beforeSlots = game.gameplay.slots;
  const prepare = game.gameplay.prepareInventory.bind(game.gameplay);
  game.gameplay.prepareInventory = (...args) => {
    const participant = prepare(...args);
    game.world.set(0, 10, -2, BLOCK.AIR);
    game.world.set(0, 10, -2, BLOCK.WATER);
    return participant;
  };
  assert.equal(game.beginUse(), false);
  assert.deepEqual(game.gameplay.slots, beforeSlots);
  assert.equal(game.world.get(0, 10, -2), BLOCK.WATER);
});

test("pouring fills a dry host in place with its state preserved", () => {
  const { game } = bucketGame(ITEM.WATER_BUCKET);
  const before = { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: FLUID.NONE };
  game.world.setCell(0, 10, -2, before);
  game.target = {
    x: 0,
    y: 10,
    z: -2,
    id: before.id,
    state: before.state,
    normal: { x: 0, y: 0, z: 1 },
  };
  assert.equal(game.secondary(), true);
  assert.deepEqual(game.world.getCell(0, 10, -2), {
    ...before,
    fluid: FLUID.WATER_SOURCE,
  });
  assert.equal(game.world.get(0, 10, -1), BLOCK.AIR);
  assert.deepEqual(game.gameplay.getHandStack(), bucket());
});

for (const refusal of [
  "budget",
  "collision",
  "world",
  "invalid-face",
  "stale-hit",
]) {
  test(`pouring ${refusal} refusal keeps the filled bucket and exact World state`, () => {
    const { game } = bucketGame(ITEM.WATER_BUCKET);
    pourTarget(game);
    if (refusal === "budget")
      assert.equal(
        game.coordinator.register(
          {},
          MAX_RESERVED_BYTES - game.coordinator.budget.totalBytes
        ),
        true
      );
    if (refusal === "collision") game.player.intersectsPlacement = () => true;
    if (refusal === "world") game.world.blocked.add(game.world.key(0, 10, -1));
    if (refusal === "invalid-face") game.target.normal.x = 1;
    if (refusal === "stale-hit") game.target.id = BLOCK.DIRT;
    const before = interactionSnapshot(game);
    assert.equal(game.secondary(), false);
    assert.deepEqual(interactionSnapshot(game), before);
  });
}

test("water onto lava atomically creates obsidian and debits the actual offhand bucket", () => {
  const { game } = bucketGame(ITEM.WATER_BUCKET, 1, "offhand");
  pourTarget(game);
  game.world.set(0, 10, -1, BLOCK.LAVA);
  assert.equal(game.secondary(), true);
  assert.deepEqual(
    game.world.getCell(0, 10, -1),
    normalizeCell({ id: BLOCK.OBSIDIAN })
  );
  assert.deepEqual(game.gameplay.getHandStack("offhand"), bucket());
});

test("Nether evaporation uses only the prepared hand, with no World participant", () => {
  const { game, messages } = bucketGame(ITEM.WATER_BUCKET);
  game.world.dimension = "nether";
  pourTarget(game);
  const before = structuredClone([...game.world.cells]);
  game.world.prepareMutation = () =>
    assert.fail("evaporation must not prepare a World write");
  assert.equal(game.secondary(), true);
  assert.deepEqual([...game.world.cells], before);
  assert.deepEqual(game.gameplay.getHandStack(), bucket());
  assert.ok(messages.some((message) => /evaporates/.test(message)));
});

test("Nether read invalidation still vetoes an evaporation exchange without World publication", () => {
  const { game } = bucketGame(ITEM.WATER_BUCKET);
  game.world.dimension = "nether";
  pourTarget(game);
  const before = game.gameplay.serialize();
  const prepare = game.gameplay.prepareInventory.bind(game.gameplay);
  game.gameplay.prepareInventory = (...args) => {
    const participant = prepare(...args);
    game.world.setLoaded(0, -1, false);
    return participant;
  };
  assert.equal(game.secondary(), false);
  assert.deepEqual(game.gameplay.serialize(), before);
});
