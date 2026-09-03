import assert from "node:assert/strict";
import test from "node:test";
import { boxVolume, containsPoint, rotateBox, UNIT_BOX } from "../src/aabb.js";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import {
  canAttachToFace,
  coversFace,
  HORIZONTAL_DIRECTIONS,
  resolveShape,
} from "../src/block-shapes.js";
import { cell } from "./shape-fixture.js";

const volume = (boxes) =>
  boxes.reduce((sum, bounds) => sum + boxVolume(bounds), 0);
const neighborhood = (entries) => {
  const map = new Map(
    entries.map(([x, y, z, value]) => [`${x},${y},${z}`, value])
  );
  return (x, y, z) => map.get(`${x},${y},${z}`) ?? null;
};
const occupies = (shape, point, channel = "render") =>
  shape[channel].some((bounds) => containsPoint(bounds, point));
const rotatedPoint = (point, turns) => {
  let result = point;
  for (let i = 0; i < turns; i++)
    result = [1 - result[2], result[1], result[0]];
  return result;
};

test("full cubes retain separate render, solid and opacity channels at real registry IDs", () => {
  for (const definition of BLOCK_CATALOG.filter(
    (entry) =>
      entry.shape === "cube" &&
      ![BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA].includes(entry.id)
  )) {
    const shape = resolveShape(cell(definition.id));
    assert.deepEqual(shape.render, [UNIT_BOX], definition.name);
    assert.equal(shape.fullCollision, definition.solid);
    assert.equal(
      shape.fullOcclusion,
      !definition.transparent && definition.texture !== "glass"
    );
  }
  const air = resolveShape(cell(BLOCK.AIR));
  assert.equal(air.render.length, 0);
  assert.equal(air.collision.length, 0);
  assert.equal(resolveShape(cell(BLOCK.WATER)).selection.length, 0);
  assert.equal(resolveShape(cell(BLOCK.RED_FLOWER)).collision.length, 0);
});

test("resolved AABBs, channels, open-face rectangles and link data are immutable", () => {
  const shape = resolveShape(cell(BLOCK.OAK_SLAB, 0, FLUID.WATER_SOURCE));
  for (const name of [
    "render",
    "collision",
    "selection",
    "support",
    "occlusion",
    "fluidVolume",
    "fluidCapacity",
  ]) {
    assert.ok(Object.isFrozen(shape[name]));
    for (const bounds of shape[name]) {
      assert.equal(bounds.length, 6);
      assert.ok(Object.isFrozen(bounds));
      assert.ok(bounds.every(Number.isFinite));
      assert.ok(boxVolume(bounds) > 0);
    }
  }
  assert.throws(() => {
    shape.render[0][4] = 1;
  }, TypeError);
  assert.ok(Object.isFrozen(shape.openFaces));
  assert.ok(
    Object.values(shape.openFaces).every(
      (rectangles) =>
        Object.isFrozen(rectangles) && rectangles.every(Object.isFrozen)
    )
  );
});

test("bottom, top and double slabs agree on occupancy, support and water space", () => {
  const bottom = resolveShape(cell(BLOCK.OAK_SLAB));
  const top = resolveShape(cell(BLOCK.OAK_SLAB, S.TOP));
  const double = resolveShape(cell(BLOCK.OAK_SLAB, S.DOUBLE));
  assert.deepEqual(bottom.render, [[0, 0, 0, 1, 0.5, 1]]);
  assert.deepEqual(top.render, [[0, 0.5, 0, 1, 1, 1]]);
  assert.equal(double.fullCube, true);
  assert.equal(double.fullCollision, true);
  assert.equal(volume(bottom.fluidCapacity), 0.5);
  assert.equal(volume(top.fluidCapacity), 0.5);
  assert.equal(volume(double.fluidCapacity), 0);
  assert.equal(coversFace(bottom, "down"), true);
  assert.equal(coversFace(bottom, "up"), false);
  assert.equal(coversFace(top, "up"), true);
  assert.deepEqual(bottom.openFaces.east, [[0, 0.5, 1, 1]]);
  const wetBottom = resolveShape(cell(BLOCK.OAK_SLAB, 0, FLUID.WATER_SOURCE));
  const wetTop = resolveShape(cell(BLOCK.OAK_SLAB, S.TOP, FLUID.WATER_SOURCE));
  assert.ok(Math.abs(volume(wetBottom.fluidVolume) - 0.38) < 1e-10);
  assert.equal(volume(wetTop.fluidVolume), 0.5);
});

test("fluid volumes retain source, flow, falling and bubble codes without becoming solid selection", () => {
  for (const [fluid, height] of [
    [FLUID.WATER_SOURCE, 0.88],
    [FLUID.WATER_1, 7 / 9],
    [FLUID.WATER_7, 1 / 9],
    [FLUID.WATER_FALLING, 1],
    [FLUID.BUBBLE_UP, 0.88],
    [FLUID.BUBBLE_DOWN, 0.88],
  ]) {
    const shape = resolveShape(cell(BLOCK.WATER, 0, fluid));
    assert.equal(shape.fluid, fluid);
    assert.equal(shape.fluidVolume[0][4], height);
    assert.equal(shape.collision.length, 0);
    assert.equal(shape.selection.length, 0);
    assert.deepEqual(shape.render, shape.fluidVolume);
  }
  const stacked = resolveShape(
    cell(BLOCK.WATER),
    neighborhood([[0, 1, 0, cell(BLOCK.WATER, 0, FLUID.BUBBLE_UP)]])
  );
  assert.deepEqual(stacked.fluidVolume, [UNIT_BOX]);
});

for (const half of [0, S.TOP]) {
  test(`stairs rotate their ${half ? "upper" : "lower"} treads and derive all neighbor corners`, () => {
    for (let facing = 0; facing < 4; facing++) {
      const self = cell(BLOCK.OAK_STAIRS, facing | half);
      const straight = resolveShape(self);
      assert.equal(volume(straight.render), 0.75);
      for (const point of [
        [0.25, 0.25, 0.25],
        [0.75, 0.75, 0.25],
        [0.25, 0.75, 0.75],
      ]) {
        assert.equal(
          occupies(straight, rotatedPoint(point, facing)),
          occupies(resolveShape(cell(BLOCK.OAK_STAIRS, half)), point)
        );
      }
      for (const turn of [1, 3]) {
        const side = (facing + turn) & 3;
        const [dx, , dz] = HORIZONTAL_DIRECTIONS[facing];
        const neighbor = cell(BLOCK.OAK_STAIRS, side | half);
        const outer = resolveShape(self, neighborhood([[dx, 0, dz, neighbor]]));
        const inner = resolveShape(
          self,
          neighborhood([[-dx, 0, -dz, neighbor]])
        );
        assert.equal(outer.corner, turn === 1 ? "outer_right" : "outer_left");
        assert.equal(inner.corner, turn === 1 ? "inner_right" : "inner_left");
        assert.equal(volume(outer.render), 0.625);
        assert.equal(volume(inner.render), 0.875);
        assert.deepEqual(outer.collision, outer.render);
        assert.deepEqual(inner.support, inner.collision);
        const mismatch = resolveShape(
          self,
          neighborhood([
            [dx, 0, dz, cell(BLOCK.OAK_STAIRS, side | (half ^ S.TOP))],
          ])
        );
        assert.equal(mismatch.corner, "straight");
      }
    }
  });
}

test("an aligned adjacent stair suppresses a corner instead of cutting a hole in a straight run", () => {
  const shape = resolveShape(
    cell(BLOCK.OAK_STAIRS),
    neighborhood([
      [0, 0, -1, cell(BLOCK.OAK_STAIRS, 1)],
      [-1, 0, 0, cell(BLOCK.OAK_STAIRS)],
    ])
  );
  assert.equal(shape.corner, "straight");
});

test("door halves derive one facing/open/hinge panel from their linked pair", () => {
  for (let facing = 0; facing < 4; facing++)
    for (const open of [0, S.OPEN])
      for (const hinge of [0, S.HINGE_RIGHT]) {
        const lower = cell(BLOCK.OAK_DOOR, facing | open);
        const upper = cell(BLOCK.OAK_DOOR, S.PART | hinge);
        const a = resolveShape(lower, neighborhood([[0, 1, 0, upper]]));
        const b = resolveShape(upper, neighborhood([[0, -1, 0, lower]]));
        assert.deepEqual(a.render, b.render);
        assert.equal(a.part, "lower");
        assert.equal(b.part, "upper");
        assert.equal(a.link.valid, true);
        assert.equal(b.link.valid, true);
        assert.equal(a.hinge, hinge ? "right" : "left");
        assert.equal(volume(a.collision), 3 / 16);
        if (!open)
          assert.deepEqual(a.render, [
            rotateBox([0, 0, 13 / 16, 1, 1, 1], facing),
          ]);
      }
  assert.equal(resolveShape(cell(BLOCK.OAK_DOOR)).link.valid, false);
});

test("trapdoors rotate when open and keep fractional closed top/bottom support", () => {
  for (let facing = 0; facing < 4; facing++)
    for (const half of [0, S.TOP]) {
      const closed = resolveShape(cell(BLOCK.OAK_TRAPDOOR, facing | half));
      const open = resolveShape(
        cell(BLOCK.OAK_TRAPDOOR, facing | half | S.OPEN)
      );
      assert.equal(volume(closed.render), 3 / 16);
      assert.equal(volume(open.render), 3 / 16);
      assert.equal(closed.collision[0][4], half ? 1 : 3 / 16);
      assert.deepEqual(open.render, [
        rotateBox([0, 0, 13 / 16, 1, 1, 1], facing),
      ]);
    }
});

test("all fence connection masks have lower art/selection than their 1.5-high collisions", () => {
  for (let mask = 0; mask < 16; mask++) {
    const neighbors = HORIZONTAL_DIRECTIONS.flatMap((offset, side) =>
      mask & (1 << side) ? [[...offset, cell(BLOCK.STONE)]] : []
    );
    const shape = resolveShape(cell(BLOCK.OAK_FENCE), neighborhood(neighbors));
    assert.deepEqual(
      shape.connections,
      [0, 1, 2, 3].map((side) => !!(mask & (1 << side)))
    );
    assert.ok(shape.render.every((bounds) => bounds[4] <= 1));
    assert.ok(shape.selection.every((bounds) => bounds[4] <= 1));
    assert.ok(shape.collision.every((bounds) => bounds[4] === 1.5));
    assert.deepEqual(shape.support, shape.collision);
    assert.equal(shape.fullOcclusion, false);
  }
});

test("fences connect to gate posts across the gate axis; open gates remove only solid collision", () => {
  for (let facing = 0; facing < 4; facing++)
    for (const open of [0, S.OPEN]) {
      const gate = cell(BLOCK.OAK_FENCE_GATE, facing | open);
      const shape = resolveShape(gate);
      assert.ok(shape.render.length > 0);
      assert.equal(shape.collision.length === 0, !!open);
      const fence = resolveShape(
        cell(BLOCK.OAK_FENCE),
        neighborhood([[1, 0, 0, gate]])
      );
      assert.equal(fence.connections[1], !(facing & 1));
    }
});

test("ladders need a full attachment face and have selection/climbing but no solid body", () => {
  for (let facing = 0; facing < 4; facing++) {
    const offset = HORIZONTAL_DIRECTIONS[(facing + 2) & 3];
    const shape = resolveShape(
      cell(BLOCK.LADDER, facing),
      neighborhood([[...offset, cell(BLOCK.STONE)]])
    );
    assert.equal(shape.climbable, true);
    assert.equal(shape.collision.length, 0);
    assert.equal(shape.support.length, 0);
    assert.equal(shape.selection.length, 1);
    assert.equal(resolveShape(cell(BLOCK.LADDER, facing)).climbable, false);
    assert.equal(
      resolveShape(
        cell(BLOCK.LADDER, facing),
        neighborhood([[...offset, cell(BLOCK.OAK_SLAB)]])
      ).climbable,
      false
    );
  }
  assert.equal(canAttachToFace(cell(BLOCK.OAK_SLAB), "up"), false);
  assert.equal(canAttachToFace(cell(BLOCK.OAK_SLAB, S.TOP), "up"), true);
});

test("beds retain linked fractional standing surfaces in every facing and part", () => {
  for (let facing = 0; facing < 4; facing++) {
    const [dx, dy, dz] = HORIZONTAL_DIRECTIONS[facing];
    const foot = cell(BLOCK.WHITE_BED, facing);
    const head = cell(BLOCK.WHITE_BED, facing | S.PART);
    for (const shape of [
      resolveShape(foot, neighborhood([[dx, dy, dz, head]])),
      resolveShape(head, neighborhood([[-dx, -dy, -dz, foot]])),
    ]) {
      assert.equal(shape.link.valid, true);
      assert.deepEqual(shape.collision, [[0, 0, 0, 1, 9 / 16, 1]]);
      assert.equal(shape.selection[0][4], 9 / 16);
      assert.ok(volume(shape.render) < volume(shape.collision));
    }
  }
});

test("declared log axes change texture orientation without changing full-cube physics", () => {
  for (const [state, axis] of [
    [0, "y"],
    [S.AXIS_X, "x"],
    [S.AXIS_Z, "z"],
  ]) {
    const shape = resolveShape({ id: BLOCK.OAK_LOG, state, fluid: FLUID.NONE });
    assert.equal(shape.textureAxis, axis);
    assert.equal(shape.fullCollision, true);
  }
  assert.equal(
    resolveShape({ id: BLOCK.BAMBOO, state: S.AXIS_X, fluid: 0 }).textureAxis,
    "y"
  );
});
