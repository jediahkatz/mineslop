import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { CONDUIT_FRAME, CONDUIT_WATER, inspectConduit, inConduitRange } from "../src/conduit-rules.js";

function fixture(count = 42) {
  const cells = new Map();
  for (const position of CONDUIT_WATER)
    cells.set(position.join(","), { id: BLOCK.WATER, fluid: FLUID.WATER_SOURCE });
  CONDUIT_FRAME.forEach((position, i) => cells.set(position.join(","), {
    id: i < count ? BLOCK.PRISMARINE : BLOCK.AIR, fluid: FLUID.NONE,
  }));
  cells.set("0,0,0", { id: BLOCK.CONDUIT, fluid: FLUID.WATER_SOURCE });
  return { cells, read: (x, y, z) => cells.get(`${x},${y},${z}`) ?? null,
    inspect() { return inspectConduit({ x: 0, y: 0, z: 0 }, this.read); } };
}

test("exactly 42 unique intersecting ring cells and 27 distinct inner cells", () => {
  assert.equal(CONDUIT_FRAME.length, 42);
  assert.equal(new Set(CONDUIT_FRAME.map((p) => p.join(","))).size, 42);
  assert.equal(CONDUIT_WATER.length, 27);
  for (const p of CONDUIT_FRAME) {
    assert.equal(Math.max(...p.map(Math.abs)), 2);
    assert.ok(p.includes(0));
  }
});

for (const [count, radius] of [[15, 0], [16, 32], [20, 32], [21, 48], [27, 48],
  [28, 64], [34, 64], [35, 80], [41, 80], [42, 96]]) {
  test(`${count} frame blocks: radius ${radius}, attack only at 42`, () => {
    const value = fixture(count).inspect();
    assert.equal(value?.radius ?? 0, radius);
    assert.equal(value?.attacks ?? false, count === 42);
  });
}

test("each of all 27 inner water cells is required, including the waterlogged center", () => {
  for (const p of CONDUIT_WATER) {
    for (const fluid of [FLUID.NONE, FLUID.LAVA_SOURCE, undefined]) {
      const f = fixture(), key = p.join(",");
      f.cells.set(key, { ...f.cells.get(key), fluid });
      assert.equal(f.inspect(), null, `${key}: fluid ${fluid}`);
    }
    const f = fixture();
    f.cells.delete(p.join(","));
    assert.equal(f.inspect(), null, `${p}: unknown`);
  }
});

test("flow, falling water and both bubble directions are real water", () => {
  for (let fluid = FLUID.WATER_SOURCE; fluid <= FLUID.BUBBLE_DOWN; fluid++) {
    const f = fixture();
    for (const p of CONDUIT_WATER) if (p.some((v) => v !== 0))
      f.cells.set(p.join(","), { id: BLOCK.WATER, fluid });
    assert.equal(f.inspect().count, 42);
  }
});

test("only the four full block IDs count; corners and slab shapes do not", () => {
  for (const id of [BLOCK.PRISMARINE, BLOCK.PRISMARINE_BRICKS, BLOCK.DARK_PRISMARINE, BLOCK.SEA_LANTERN]) {
    const f = fixture();
    for (const p of CONDUIT_FRAME) f.cells.set(p.join(","), { id, fluid: 0 });
    assert.equal(f.inspect().count, 42);
  }
  const f = fixture(15);
  f.cells.set("2,2,2", { id: BLOCK.PRISMARINE });
  f.cells.set(CONDUIT_FRAME[15].join(","), { id: BLOCK.OAK_SLAB });
  assert.equal(f.inspect(), null);
  f.cells.delete(CONDUIT_FRAME[41].join(","));
  assert.equal(f.inspect(), null);
});

test("range is inclusive and spherical in all three axes", () => {
  const center = { x: 0.5, y: 0.5, z: 0.5 };
  for (const radius of [32, 48, 64, 80, 96]) {
    for (const axis of ["x", "y", "z"]) {
      assert.equal(inConduitRange(center, { ...center, [axis]: center[axis] + radius }, radius), true);
      assert.equal(inConduitRange(center, { ...center, [axis]: center[axis] - radius }, radius), true);
      assert.equal(inConduitRange(center, { ...center, [axis]: center[axis] + radius + 1e-7 }, radius), false);
    }
    assert.equal(inConduitRange(center, { x: radius, y: radius, z: radius }, radius), false);
  }
});
