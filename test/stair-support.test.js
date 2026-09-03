import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE, normalizeCell } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  canAttachToFace,
  coversFace,
  FACING_NAMES,
  HORIZONTAL_DIRECTIONS,
  resolveShape,
} from "../src/block-shapes.js";

const cell = (id, state = 0) => normalizeCell({ id, state, fluid: 0 });
const key = (position) => position.join(",");
const add = (a, b) => a.map((value, axis) => value + b[axis]);

function scenario({
  consumerId = BLOCK.LADDER,
  supportId = BLOCK.OAK_STAIRS,
  turn = 0,
  half = 0,
  cornerTurn = 1,
  cornerHalf = half,
  withCorner = true,
  attachmentTurn = cornerTurn,
} = {}) {
  const origin = [-8, -17, 31];
  const facing = (turn + attachmentTurn) & 3;
  const face = FACING_NAMES[facing];
  const consumerPosition = add(origin, HORIZONTAL_DIRECTIONS[facing]);
  const cornerPosition = add(
    origin,
    HORIZONTAL_DIRECTIONS[turn].map((value) => -value)
  );
  const supportCell = cell(
    supportId,
    supportId === BLOCK.OAK_STAIRS ? turn | half : 0
  );
  const consumerCell = cell(
    consumerId,
    consumerId === BLOCK.LADDER ? facing : 0
  );
  const cells = new Map([
    [key(origin), supportCell],
    [key(consumerPosition), consumerCell],
  ]);
  if (withCorner && supportId === BLOCK.OAK_STAIRS)
    cells.set(
      key(cornerPosition),
      cell(BLOCK.OAK_STAIRS, ((turn + cornerTurn) & 3) | cornerHalf)
    );
  const reads = [];
  const neighborhood =
    (position, record = false) =>
    (dx, dy, dz) => {
      const at = add(position, [dx, dy, dz]);
      if (record) reads.push(at);
      // Missing/unloaded cells remain unavailable; no resolving callback may load.
      return cells.get(key(at)) ?? null;
    };
  const resolveConsumer = () =>
    resolveShape(consumerCell, neighborhood(consumerPosition, true));
  return {
    cells,
    cornerPosition,
    facing,
    face,
    reads,
    actual: resolveShape(supportCell, neighborhood(origin)),
    isolated: resolveShape(supportCell),
    placement: canAttachToFace(supportCell, face, neighborhood(origin)),
    consumer: resolveConsumer(),
    resolveConsumer,
  };
}

function assertConsumer(result, consumerId, expected) {
  assert.equal(result.placement, expected);
  if (consumerId === BLOCK.LADDER) {
    assert.equal(result.consumer.attachment.valid, expected);
    assert.equal(result.consumer.climbable, expected);
    assert.equal(result.consumer.attachment.face, result.face);
  } else {
    assert.equal(
      result.consumer.connections[(result.facing + 2) & 3],
      expected
    );
  }
}

test("ladders and fences use the real inner stair face in both corner directions, all rotations and halves", () => {
  for (const consumerId of [BLOCK.LADDER, BLOCK.OAK_FENCE])
    for (const half of [0, BLOCK_STATE.TOP])
      for (const turn of [0, 1, 2, 3])
        for (const cornerTurn of [1, 3]) {
          const result = scenario({ consumerId, turn, half, cornerTurn });
          assert.equal(
            result.actual.corner,
            cornerTurn === 1 ? "inner_right" : "inner_left"
          );
          assert.equal(coversFace(result.actual, result.face), true);
          assert.equal(coversFace(result.isolated, result.face), false);
          assertConsumer(result, consumerId, true);
          assert.ok(
            result.reads.some(
              (position) => key(position) === key(result.cornerPosition)
            ),
            "the consumer rebases its callback to the support's corner neighbor"
          );
        }
});

test("straight full faces still attach, while partial faces and opposite-half corners still reject", () => {
  for (const consumerId of [BLOCK.LADDER, BLOCK.OAK_FENCE])
    for (const half of [0, BLOCK_STATE.TOP])
      for (const turn of [0, 1, 2, 3]) {
        const options = { consumerId, turn, half };
        assertConsumer(
          scenario({ ...options, withCorner: false, attachmentTurn: 0 }),
          consumerId,
          true
        );
        for (const result of [
          scenario({ ...options, withCorner: false }),
          scenario({ ...options, cornerHalf: half ^ BLOCK_STATE.TOP }),
        ]) {
          assert.equal(result.actual.corner, "straight");
          assertConsumer(result, consumerId, false);
          assert.ok(
            result.reads.some(
              (position) => key(position) === key(result.cornerPosition)
            )
          );
        }
      }
});

test("full-cube support remains valid in every direction without a stair neighbor", () => {
  for (const consumerId of [BLOCK.LADDER, BLOCK.OAK_FENCE])
    for (const turn of [0, 1, 2, 3])
      assertConsumer(
        scenario({
          consumerId,
          supportId: BLOCK.STONE,
          turn,
          withCorner: false,
        }),
        consumerId,
        true
      );
});

test("attachment follows corner removal and restoration instead of caching an isolated support shape", () => {
  for (const consumerId of [BLOCK.LADDER, BLOCK.OAK_FENCE]) {
    const result = scenario({ consumerId });
    const cornerKey = key(result.cornerPosition);
    const corner = result.cells.get(cornerKey);
    const valid = (shape) =>
      consumerId === BLOCK.LADDER ? shape.climbable : shape.connections[3];
    assert.equal(valid(result.consumer), true);
    result.cells.delete(cornerKey);
    assert.equal(valid(result.resolveConsumer()), false);
    result.cells.set(cornerKey, corner);
    assert.equal(valid(result.resolveConsumer()), true);
  }
});

test("link-consumer guards still terminate ladder and fence support checks", () => {
  for (const supportId of [
    BLOCK.OAK_FENCE,
    BLOCK.OAK_FENCE_GATE,
    BLOCK.LADDER,
    BLOCK.OAK_DOOR,
    BLOCK.WHITE_BED,
  ]) {
    let reads = 0;
    const ladder = resolveShape(cell(BLOCK.LADDER, 1), (dx, dy, dz) => {
      reads++;
      assert.deepEqual([dx, dy, dz], [-1, 0, 0]);
      return cell(supportId);
    });
    assert.equal(
      reads,
      1,
      "support consumers must not recursively resolve links"
    );
    assert.equal(ladder.attachment.valid, false);
    assert.equal(ladder.climbable, false);
  }
  for (const supportId of [BLOCK.LADDER, BLOCK.OAK_DOOR, BLOCK.WHITE_BED]) {
    let reads = 0;
    const fence = resolveShape(cell(BLOCK.OAK_FENCE), (dx, dy, dz) => {
      reads++;
      return dx === -1 && dy === 0 && dz === 0 ? cell(supportId) : null;
    });
    assert.equal(reads, 4);
    assert.deepEqual(fence.connections, [false, false, false, false]);
  }
});
