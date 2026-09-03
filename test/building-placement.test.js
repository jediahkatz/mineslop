import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { HORIZONTAL_DIRECTIONS } from "../src/block-shapes.js";
import {
  facingFromForward,
  prepareBuildingPlacement,
  proposedBuildingShape,
} from "../src/building-placement.js";
import { WORLD_MAX } from "../src/terrain.js";
import { buildingFixture } from "./building-fixture.js";

const normals = [
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const point = (normal, height = 0.25) => ({
  x: normal.x ? (normal.x + 1) / 2 : 0.5,
  y: normal.y ? (normal.y + 1) / 2 : height,
  z: normal.z ? (normal.z + 1) / 2 : 0.5,
});
const forward = (facing) => {
  const [x, y, z] = HORIZONTAL_DIRECTIONS[facing];
  return { x, y, z };
};
const placement = (fixture, id, normal, atPoint = point(normal)) =>
  prepareBuildingPlacement(
    fixture.world,
    id,
    fixture.hit(2, 20, 3, normal, atPoint),
    fixture.player.forward
  );

test("all six hit normals orient logs and axis pillars from the selected face", (t) => {
  const f = buildingFixture(t);
  for (const id of [
    BLOCK.OAK_LOG,
    BLOCK.BIRCH_LOG,
    BLOCK.BASALT,
    BLOCK.DEEPSLATE,
  ])
    for (const normal of normals) {
      const proposal = placement(f, id, normal);
      assert.equal(proposal.ok, true);
      const cell = proposal.changes[0];
      assert.deepEqual(
        [cell.x, cell.y, cell.z],
        [2 + normal.x, 20 + normal.y, 3 + normal.z]
      );
      assert.equal(
        cell.after.state,
        normal.x ? S.AXIS_X : normal.z ? S.AXIS_Z : 0
      );
    }
  assert.equal(facingFromForward({ x: 0, y: 1, z: 0 }), null);
  assert.equal(facingFromForward({ x: 3, y: 4, z: -0.1 }), 1);
});

test("slab and stair halves use the normal and exact side hit height for every facing", (t) => {
  const f = buildingFixture(t);
  for (let facing = 0; facing < 4; facing++)
    for (const id of [BLOCK.OAK_SLAB, BLOCK.OAK_STAIRS])
      for (const normal of normals)
        for (const height of [0.25, 0.75]) {
          f.player.forward = forward(facing);
          f.player.yaw = 123; // Deliberately unrelated to the actual forward vector.
          const proposal = placement(f, id, normal, point(normal, height));
          assert.equal(proposal.ok, true);
          const top = normal.y ? normal.y < 0 : height > 0.5;
          assert.equal(
            proposal.changes[0].after.state,
            (id === BLOCK.OAK_STAIRS ? facing : 0) | (top ? S.TOP : 0)
          );
        }
});

test("stairs derive inner/outer corners without persisting a corner bit", (t) => {
  const f = buildingFixture(t);
  const hit = f.hit();
  f.put(2, 21, 4, BLOCK.OAK_STAIRS, 1);
  let proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_STAIRS,
    hit,
    forward(0)
  );
  assert.equal(proposal.changes[0].after.state, 0);
  assert.equal(proposedBuildingShape(f.world, proposal).corner, "inner_right");
  f.put(2, 21, 4, BLOCK.AIR);
  f.put(2, 21, 2, BLOCK.OAK_STAIRS, 1);
  proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_STAIRS,
    hit,
    forward(0)
  );
  assert.equal(proposedBuildingShape(f.world, proposal).corner, "outer_right");
  f.put(2, 21, 2, BLOCK.OAK_STAIRS, 1 | S.TOP);
  proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_STAIRS,
    hit,
    forward(0)
  );
  assert.equal(proposedBuildingShape(f.world, proposal).corner, "straight");
});

test("same slabs merge only at the clicked empty half, or at an adjacent single slab", (t) => {
  const f = buildingFixture(t);
  f.put(2, 21, 3, BLOCK.OAK_SLAB);
  const top = f.hit(2, 21, 3, normals[0], { x: 0.5, y: 0.5, z: 0.5 });
  let proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_SLAB,
    top,
    forward(0)
  );
  assert.equal(proposal.ok, true);
  assert.equal(proposal.changes[0].y, 21);
  assert.equal(proposal.changes[0].after.state, S.DOUBLE);
  const side = f.hit(2, 21, 3, normals[2], { x: 1, y: 0.25, z: 0.5 });
  proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_SLAB,
    side,
    forward(0)
  );
  assert.equal(proposal.changes[0].x, 3);
  assert.equal(proposal.changes[0].after.state, 0);
  f.put(3, 21, 3, BLOCK.OAK_SLAB, S.TOP);
  proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_SLAB,
    side,
    forward(0)
  );
  assert.equal(proposal.changes[0].after.state, S.DOUBLE);
  f.put(2, 21, 3, BLOCK.OAK_SLAB, S.TOP);
  const bottom = f.hit(2, 21, 3, normals[1], { x: 0.5, y: 0.5, z: 0.5 });
  proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_SLAB,
    bottom,
    forward(0)
  );
  assert.equal(proposal.changes[0].y, 21);
  assert.equal(proposal.changes[0].after.state, S.DOUBLE);
});

test("waterlogging preserves source water and double slabs explicitly become dry", (t) => {
  const f = buildingFixture(t);
  for (const fluid of [
    FLUID.WATER_SOURCE,
    FLUID.BUBBLE_UP,
    FLUID.BUBBLE_DOWN,
  ]) {
    f.put(2, 21, 3, BLOCK.WATER, 0, fluid);
    for (const id of [
      BLOCK.OAK_SLAB,
      BLOCK.OAK_STAIRS,
      BLOCK.OAK_FENCE,
      BLOCK.OAK_TRAPDOOR,
    ]) {
      const proposal = placement(f, id, normals[0]);
      assert.equal(proposal.ok, true);
      assert.equal(proposal.changes[0].after.fluid, FLUID.WATER_SOURCE);
    }
  }
  f.put(2, 21, 3, BLOCK.OAK_SLAB, 0, FLUID.WATER_SOURCE);
  const proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.OAK_SLAB,
    f.hit(2, 21, 3, normals[0], { x: 0.5, y: 0.5, z: 0.5 }),
    forward(0)
  );
  assert.deepEqual(proposal.changes[0].after, {
    id: BLOCK.OAK_SLAB,
    state: S.DOUBLE,
    fluid: FLUID.NONE,
  });
});

test("door hinges use lateral hit position, neighboring walls and adjacent doors", (t) => {
  const f = buildingFixture(t);
  for (let facing = 0; facing < 4; facing++) {
    const [dx, , dz] = HORIZONTAL_DIRECTIONS[(facing + 1) & 3];
    const rightPoint = { x: 0.5 + dx * 0.25, y: 1, z: 0.5 + dz * 0.25 };
    const proposal = prepareBuildingPlacement(
      f.world,
      BLOCK.OAK_DOOR,
      f.hit(2, 20, 3, normals[0], rightPoint),
      forward(facing)
    );
    assert.equal(proposal.ok, true);
    assert.equal(proposal.changes[0].after.state, facing | S.HINGE_RIGHT);
    assert.equal(
      proposal.changes[1].after.state,
      facing | S.HINGE_RIGHT | S.PART
    );
  }
  f.put(3, 21, 3, BLOCK.STONE);
  f.put(3, 22, 3, BLOCK.STONE);
  let proposal = placement(f, BLOCK.OAK_DOOR, normals[0], {
    x: 0.25,
    y: 1,
    z: 0.5,
  });
  assert.ok(proposal.changes[0].after.state & S.HINGE_RIGHT);
  f.put(3, 21, 3, BLOCK.AIR);
  f.put(3, 22, 3, BLOCK.AIR);
  f.put(1, 21, 3, BLOCK.STONE);
  f.put(1, 22, 3, BLOCK.STONE);
  proposal = placement(f, BLOCK.OAK_DOOR, normals[0], {
    x: 0.75,
    y: 1,
    z: 0.5,
  });
  assert.equal(proposal.changes[0].after.state & S.HINGE_RIGHT, 0);
  f.put(1, 21, 3, BLOCK.OAK_DOOR);
  f.put(1, 22, 3, BLOCK.OAK_DOOR, S.PART);
  proposal = placement(f, BLOCK.OAK_DOOR, normals[0]);
  assert.ok(
    proposal.changes[0].after.state & S.HINGE_RIGHT,
    "an adjacent left door gets the complementary hinge"
  );
});

test("doors and beds place both dry cells from metadata in every horizontal direction", (t) => {
  const f = buildingFixture(t);
  f.floor();
  for (let facing = 0; facing < 4; facing++) {
    const [dx, , dz] = HORIZONTAL_DIRECTIONS[facing];
    const proposal = prepareBuildingPlacement(
      f.world,
      BLOCK.WHITE_BED,
      f.hit(),
      forward(facing)
    );
    assert.equal(proposal.ok, true);
    assert.equal(proposal.changes.length, 2);
    assert.deepEqual(
      proposal.changes.map(({ x, y, z }) => [x, y, z]),
      [
        [2, 21, 3],
        [2 + dx, 21, 3 + dz],
      ]
    );
    assert.deepEqual(
      proposal.changes.map(({ after }) => after.state),
      [facing, facing | S.PART]
    );
  }
  f.put(2, 21, 3, BLOCK.WATER);
  f.put(2, 22, 3, BLOCK.WATER);
  const door = placement(f, BLOCK.OAK_DOOR, normals[0]);
  assert.equal(door.ok, true);
  assert.ok(door.changes.every(({ after }) => after.fluid === FLUID.NONE));
  f.put(2, 21, 2, BLOCK.WATER);
  const bed = placement(f, BLOCK.WHITE_BED, normals[0]);
  assert.equal(bed.ok, true);
  assert.ok(bed.changes.every(({ after }) => after.fluid === FLUID.NONE));
});

test("trapdoors use face attachment/half, while gates and fences have derived connections", (t) => {
  const f = buildingFixture(t);
  for (const normal of normals)
    for (const height of [0.25, 0.75]) {
      const proposal = placement(
        f,
        BLOCK.OAK_TRAPDOOR,
        normal,
        point(normal, height)
      );
      assert.equal(proposal.ok, true);
      const facing = normal.y
        ? 2
        : normal.x
          ? normal.x > 0
            ? 1
            : 3
          : normal.z > 0
            ? 2
            : 0;
      assert.equal(
        proposal.changes[0].after.state,
        facing | ((normal.y ? normal.y < 0 : height > 0.5) ? S.TOP : 0)
      );
    }
  f.put(3, 21, 3, BLOCK.OAK_FENCE);
  const fence = placement(f, BLOCK.OAK_FENCE, normals[0]);
  assert.equal(fence.changes[0].after.state, 0);
  assert.deepEqual(proposedBuildingShape(f.world, fence).connections, [
    false,
    true,
    false,
    false,
  ]);
  for (let facing = 0; facing < 4; facing++) {
    f.player.forward = forward(facing);
    assert.equal(
      placement(f, BLOCK.OAK_FENCE_GATE, normals[0]).changes[0].after.state,
      facing
    );
  }
});

test("ladders attach to actual full faces, including a neighbor-derived inner stair corner", (t) => {
  const f = buildingFixture(t);
  for (const normal of normals.slice(2)) {
    const proposal = placement(f, BLOCK.LADDER, normal);
    assert.equal(proposal.ok, true);
    assert.equal(
      proposedBuildingShape(f.world, proposal).attachment.valid,
      true
    );
  }
  for (const normal of normals.slice(0, 2))
    assert.equal(placement(f, BLOCK.LADDER, normal).ok, false);
  f.put(2, 21, 3, BLOCK.OAK_STAIRS);
  const eastHit = f.hit(2, 21, 3, normals[2], { x: 1, y: 0.25, z: 0.5 });
  assert.equal(
    prepareBuildingPlacement(f.world, BLOCK.LADDER, eastHit, forward(1)).ok,
    false
  );
  f.put(2, 21, 4, BLOCK.OAK_STAIRS, 1);
  f.put(3, 21, 3, BLOCK.WATER);
  const proposal = prepareBuildingPlacement(
    f.world,
    BLOCK.LADDER,
    eastHit,
    forward(1)
  );
  assert.equal(proposal.ok, true);
  assert.equal(proposal.changes[0].after.state, 1);
  assert.equal(proposal.changes[0].after.fluid, FLUID.WATER_SOURCE);
  assert.equal(proposedBuildingShape(f.world, proposal).attachment.valid, true);
});

test("multipart destinations, support faces, legacy bottom bounds and plants reject safely", async (t) => {
  const f = buildingFixture(t);
  f.put(2, f.world.spec.maxY - 2, 3, BLOCK.STONE);
  const high = f.hit(2, f.world.spec.maxY - 2, 3);
  assert.equal(
    prepareBuildingPlacement(f.world, BLOCK.OAK_DOOR, high, forward(0)).ok,
    false
  );
  f.put(2, 20, 3, BLOCK.OAK_SLAB);
  assert.equal(placement(f, BLOCK.OAK_DOOR, normals[0]).ok, false);
  f.put(2, 20, 3, BLOCK.OAK_SLAB, S.TOP);
  assert.equal(placement(f, BLOCK.OAK_DOOR, normals[0]).ok, true);
  f.put(2, 21, 3, BLOCK.TALL_GRASS);
  const before = f.world.serialize();
  assert.match(placement(f, BLOCK.OAK_SLAB, normals[0]).message, /plant/);
  assert.deepEqual(f.world.serialize(), before);
  f.put(31, 20, 3, BLOCK.STONE);
  assert.equal(
    prepareBuildingPlacement(
      f.world,
      BLOCK.WHITE_BED,
      f.hit(31, 20, 3),
      forward(1)
    ).ok,
    false
  );
  await f.world.ensureArea({ x: WORLD_MAX - 1, y: 20, z: 3 }, 0);
  f.put(WORLD_MAX - 1, 20, 3, BLOCK.STONE);
  assert.equal(
    prepareBuildingPlacement(
      f.world,
      BLOCK.WHITE_BED,
      f.hit(WORLD_MAX - 1, 20, 3),
      forward(1)
    ).ok,
    false
  );
  const old = buildingFixture(t, { generatorVersion: 3 });
  old.put(2, 1, 3, BLOCK.STONE);
  assert.equal(
    prepareBuildingPlacement(
      old.world,
      BLOCK.OAK_SLAB,
      old.hit(2, 1, 3, normals[1], point(normals[1])),
      forward(0)
    ).ok,
    false
  );
  const modern = buildingFixture(t);
  modern.put(2, modern.world.spec.minY + 1, 3, BLOCK.STONE);
  assert.equal(
    prepareBuildingPlacement(
      modern.world,
      BLOCK.OAK_SLAB,
      modern.hit(
        2,
        modern.world.spec.minY + 1,
        3,
        normals[1],
        point(normals[1])
      ),
      forward(0)
    ).ok,
    true
  );
});

test("ordinary decorative plants still place, aquatic plants require water, and crops keep their owner", (t) => {
  const f = buildingFixture(t);
  for (const id of [
    BLOCK.TORCH,
    BLOCK.RED_FLOWER,
    BLOCK.YELLOW_FLOWER,
    BLOCK.BAMBOO,
  ]) {
    const proposal = placement(f, id, normals[0]);
    assert.equal(proposal.ok, true);
    assert.equal(
      proposal.changes[0].after.state,
      0,
      "log-like plant artwork does not opt into log axes"
    );
  }
  assert.equal(placement(f, BLOCK.SEAGRASS, normals[0]).ok, false);
  f.put(2, 21, 3, BLOCK.WATER);
  const aquatic = placement(f, BLOCK.SEAGRASS, normals[0]);
  assert.equal(aquatic.ok, true);
  assert.equal(aquatic.changes[0].after.fluid, FLUID.WATER_SOURCE);
  assert.match(
    placement(f, BLOCK.WHEAT_CROP, normals[0]).message,
    /seed interaction/
  );
});
