import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  BLOCK_STATE as S,
  cellAfterBreaking,
  defaultFluidFor,
  FLUID as F,
  isSourceWater,
  isValidCell,
  isWaterFluid,
  normalizeCell,
} from "../src/block-state.js";

test("canonical cells preserve high registered IDs and synthesize legacy sources", () => {
  for (const id of [BLOCK.COPPER_BLOCK, BLOCK.OAK_STAIRS, BLOCK.SEA_LANTERN])
    assert.deepEqual(normalizeCell({ id }), { id, state: 0, fluid: F.NONE });
  for (const id of [BLOCK.WATER, BLOCK.SEAGRASS, BLOCK.KELP])
    assert.deepEqual(normalizeCell({ id }), {
      id,
      state: 0,
      fluid: F.WATER_SOURCE,
    });
  assert.equal(defaultFluidFor(BLOCK.LAVA), F.LAVA_SOURCE);
  assert.equal(isValidCell({ id: 256 }), false, "items are not block cells");
  assert.equal(isValidCell({ id: 65536 }), false);
  assert.equal(isValidCell({ id: 999 }), false, "registry holes are not air");
});

test("only declared axes and shape-specific flags are persisted", () => {
  assert.equal(isValidCell({ id: BLOCK.OAK_LOG, state: S.AXIS_X }), true);
  assert.equal(isValidCell({ id: BLOCK.BASALT, state: S.AXIS_Z }), true);
  assert.equal(isValidCell({ id: BLOCK.BAMBOO, state: S.AXIS_X }), false);
  assert.equal(isValidCell({ id: BLOCK.SUGAR_CANE, state: S.AXIS_Z }), false);
  assert.equal(
    isValidCell({ id: BLOCK.OAK_LOG, state: S.AXIS_X | S.AXIS_Z }),
    false
  );
  for (const [id, state] of [
    [BLOCK.OAK_STAIRS, 1 | S.TOP],
    [BLOCK.OAK_DOOR, 3 | S.OPEN | S.HINGE_RIGHT | S.PART],
    [BLOCK.OAK_TRAPDOOR, 2 | S.TOP | S.OPEN],
    [BLOCK.WHITE_BED, 1 | S.PART],
    [BLOCK.OAK_SLAB, S.DOUBLE],
    [BLOCK.LADDER, 3],
  ])
    assert.equal(isValidCell({ id, state }), true);
  for (const cell of [
    { id: BLOCK.STONE, state: S.OPEN },
    { id: BLOCK.OAK_STAIRS, state: S.HINGE_RIGHT },
    { id: BLOCK.OAK_FENCE, state: 1 },
    { id: BLOCK.OAK_SLAB, state: S.DOUBLE | S.TOP },
    { id: BLOCK.STONE, state: 65536 },
    { id: BLOCK.STONE, state: 0.5 },
    { id: BLOCK.STONE, state: null },
  ])
    assert.throws(() => normalizeCell(cell), /Invalid block cell/);
});

test("source semantics distinguish bubbles from flowing and falling water", () => {
  for (const fluid of [F.WATER_SOURCE, F.BUBBLE_UP, F.BUBBLE_DOWN]) {
    assert.equal(isSourceWater(fluid), true);
    assert.equal(isValidCell({ id: BLOCK.WATER, fluid }), true);
  }
  for (const fluid of [F.WATER_1, F.WATER_7, F.WATER_FALLING]) {
    assert.equal(isWaterFluid(fluid), true);
    assert.equal(isSourceWater(fluid), false);
    assert.equal(isValidCell({ id: BLOCK.WATER, fluid }), true);
  }
  for (const fluid of [F.NONE, F.LAVA_SOURCE, 12, 1.5, "1"])
    assert.equal(isWaterFluid(fluid), false);
});

test("hosts accept only legal source water and explicit breaking preserves it", () => {
  const wetSlab = normalizeCell({
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.WATER_SOURCE,
  });
  assert.deepEqual(
    cellAfterBreaking(wetSlab),
    normalizeCell({ id: BLOCK.WATER })
  );
  assert.deepEqual(
    cellAfterBreaking({ id: BLOCK.OAK_SLAB }),
    normalizeCell({ id: BLOCK.AIR })
  );
  for (const cell of [
    { id: BLOCK.AIR, fluid: F.WATER_SOURCE },
    { id: BLOCK.WATER, fluid: F.NONE },
    { id: BLOCK.LAVA, fluid: F.WATER_SOURCE },
    { id: BLOCK.STONE, fluid: F.LAVA_SOURCE },
    { id: BLOCK.OAK_SLAB, fluid: F.WATER_FALLING },
    { id: BLOCK.OAK_SLAB, fluid: F.BUBBLE_UP },
    { id: BLOCK.OAK_SLAB, state: S.DOUBLE, fluid: F.WATER_SOURCE },
    { id: BLOCK.OAK_DOOR, fluid: F.WATER_SOURCE },
    { id: BLOCK.WHITE_BED, fluid: F.WATER_SOURCE },
    { id: BLOCK.KELP, fluid: F.NONE },
  ])
    assert.equal(isValidCell(cell), false);
  const detached = normalizeCell(wetSlab);
  detached.state = 0;
  assert.equal(wetSlab.state, S.TOP);
});
