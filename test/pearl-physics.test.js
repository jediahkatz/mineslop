import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  integratePearl,
  MAX_PEARL_QUERY_CELLS,
  MAX_PEARL_QUERY_COLUMNS,
  MAX_PEARL_SPEED,
  pearlImpactPose,
  pearlLaunchVelocity,
  PEARL_AIR_DRAG,
  PEARL_COLLISION_OFFSET,
  PEARL_GRAVITY,
  PEARL_RADIUS,
  PEARL_SPEED,
  PEARL_STEP_SECONDS,
  PEARL_WATER_DRAG,
  probePearlOrigin,
  stepPearlFlight,
} from "../src/pearl-physics.js";
import { WORLD_MAX } from "../src/terrain.js";
import { pearlRecord, pearlWorld } from "./pearl-fixtures.js";

const close = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-8,
    `${message ?? ""}: ${actual} != ${expected}`
  );
const body = { radius: 0.3, height: 1.8 };
const trace = (world, position, velocity) =>
  stepPearlFlight(
    world,
    world.context,
    pearlRecord({ position, velocity, dimension: world.dimension })
  );

test("pearl launch and discrete ballistics have deterministic gravity and drag", () => {
  assert.deepEqual(pearlLaunchVelocity({ x: 4, y: 0, z: 0 }), {
    x: PEARL_SPEED,
    y: 0,
    z: 0,
  });
  assert.equal(pearlLaunchVelocity({ x: 0, y: 0, z: 0 }), null);
  assert.equal(pearlLaunchVelocity({ x: Infinity, y: 0, z: 0 }), null);
  let motion = {
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: PEARL_SPEED, y: 0, z: 0 },
  };
  for (let i = 0; i < 20; i++)
    motion = integratePearl(motion.position, motion.velocity);
  const series = (1 - PEARL_AIR_DRAG ** 20) / (1 - PEARL_AIR_DRAG);
  close(motion.position.x, PEARL_SPEED * PEARL_STEP_SECONDS * series);
  close(motion.velocity.x, PEARL_SPEED * PEARL_AIR_DRAG ** 20);
  close(motion.velocity.y, -PEARL_GRAVITY * PEARL_STEP_SECONDS * series);
  close(
    motion.position.y,
    100 -
      ((PEARL_GRAVITY * PEARL_STEP_SECONDS ** 2) / (1 - PEARL_AIR_DRAG)) *
        (20 - series)
  );
  assert.equal(
    integratePearl(motion.position, { x: MAX_PEARL_SPEED + 1, y: 0, z: 0 }),
    null
  );
});

test("water applies drag without making fluid volumes solid impacts", () => {
  const world = pearlWorld();
  world.put(4, 20, 4, BLOCK.WATER);
  const flight = trace(
    world,
    { x: 4.5, y: 20.5, z: 4.5 },
    { x: 30, y: 0, z: 0 }
  );
  assert.equal(flight.kind, "flight");
  close(flight.position.x, 6);
  close(flight.velocity.x, PEARL_SPEED * PEARL_WATER_DRAG);
  close(flight.velocity.y, -PEARL_GRAVITY * PEARL_STEP_SECONDS);
});

test("a fast swept pearl hits slab material but passes through its empty half", () => {
  const world = pearlWorld();
  world.put(6, 10, 4, BLOCK.OAK_SLAB);
  const velocity = { x: 80, y: 0, z: 0 };
  assert.equal(
    trace(world, { x: 4, y: 10.75, z: 4.5 }, velocity).kind,
    "flight"
  );
  const hit = trace(world, { x: 4, y: 10.4, z: 4.5 }, velocity);
  assert.equal(hit.kind, "impact");
  close(hit.hit.center.x, 6 - PEARL_RADIUS);
  close(hit.hit.point.x, 6);
  assert.deepEqual(hit.hit.normal, { x: -1, y: 0, z: 0 });
});

test("thin trapdoors and door panels cannot tunnel between endpoints", () => {
  const world = pearlWorld();
  world.put(6, 10, 4, BLOCK.OAK_TRAPDOOR);
  const trapdoor = trace(
    world,
    { x: 6.5, y: 12, z: 4.5 },
    { x: 0, y: -80, z: 0 }
  );
  assert.equal(trapdoor.kind, "impact");
  close(trapdoor.hit.point.y, 10 + 3 / 16);
  world.put(6, 10, 4, BLOCK.OAK_DOOR);
  const door = trace(world, { x: 6.5, y: 10.5, z: 3 }, { x: 0, y: 0, z: 80 });
  assert.equal(door.kind, "impact");
  close(door.hit.point.z, 4 + 13 / 16);
});

test("open gates use empty collision and fence owners are found above their cell", () => {
  const world = pearlWorld();
  const position = { x: 6.5, y: 11.35, z: 3 };
  const velocity = { x: 0, y: 0, z: 80 };
  world.put(6, 10, 4, BLOCK.OAK_FENCE_GATE, BLOCK_STATE.OPEN);
  assert.equal(trace(world, position, velocity).kind, "flight");
  world.put(6, 10, 4, BLOCK.OAK_FENCE_GATE);
  assert.equal(trace(world, position, velocity).kind, "impact");
  world.put(6, 10, 4, BLOCK.OAK_FENCE);
  const fence = trace(world, position, velocity);
  assert.equal(fence.kind, "impact");
  assert.equal(fence.hit.cell.y, 10);
  close(fence.hit.point.z, 4 + 6 / 16);
});

test("straight stairs preserve their open upper half and diagonal sweeps hit corners", () => {
  const world = pearlWorld();
  world.put(6, 10, 4, BLOCK.OAK_STAIRS);
  const velocity = { x: 80, y: 0, z: 0 };
  assert.equal(
    trace(world, { x: 4, y: 10.75, z: 4.75 }, velocity).kind,
    "flight"
  );
  assert.equal(
    trace(world, { x: 4, y: 10.75, z: 4.25 }, velocity).kind,
    "impact"
  );
  world.put(6, 10, 6, BLOCK.STONE);
  const corner = trace(
    world,
    { x: 4.5, y: 10.5, z: 4.5 },
    { x: 80, y: 0, z: 80 }
  );
  assert.equal(corner.kind, "impact");
  assert.equal(corner.hit.cell.x, 6);
  assert.equal(corner.hit.cell.z, 6);
});

test("a missing shape apron freezes instead of reading unloaded terrain as air", () => {
  const world = pearlWorld();
  world.chunks.delete("1,0");
  const flight = trace(world, { x: 13, y: 20, z: 4.5 }, { x: 30, y: 0, z: 0 });
  assert.equal(flight.kind, "frontier");
  assert.deepEqual(flight.columns, [{ cx: 1, cz: 0 }]);
  assert.ok(flight.columns.length <= MAX_PEARL_QUERY_COLUMNS);
  assert.equal(world.reads, 0);
  assert.equal(flight.validate(), true);
  world.admit(1, 0);
  assert.equal(flight.validate(), false);
  assert.equal(
    trace(world, { x: 13, y: 20, z: 4.5 }, { x: 30, y: 0, z: 0 }).kind,
    "flight"
  );
});

test("flight and destination read sets reject cell edits and equal-cell readmission", () => {
  const world = pearlWorld();
  const a = trace(world, { x: 4, y: 20, z: 4 }, { x: 30, y: 0, z: 0 });
  assert.equal(a.validate(), true);
  world.put(5, 20, 4, BLOCK.STONE);
  assert.equal(a.validate(), false);
  const b = trace(world, { x: 4, y: 20, z: 4 }, { x: 30, y: 0, z: 0 });
  assert.equal(b.kind, "impact");
  world.admit(0, 0);
  assert.equal(b.validate(), false);
});

test("signed and tall dimensions read only real build cells; high flight remains valid", () => {
  for (const generatorVersion of [3, 4]) {
    for (const dimension of ["overworld", "nether", "end"]) {
      const world = pearlWorld({ generatorVersion, dimension });
      for (const y of [world.spec.minY, world.spec.maxY - 1]) {
        world.put(4, y, 4, BLOCK.OAK_SLAB);
        const flight = trace(
          world,
          { x: 4.5, y: y + 2, z: 4.5 },
          { x: 0, y: -40, z: 0 }
        );
        assert.equal(
          flight.kind,
          "impact",
          `${generatorVersion}/${dimension}/${y}`
        );
        close(flight.hit.point.y, y + 0.5);
        world.put(4, y, 4, BLOCK.AIR);
      }
      const before = world.reads;
      const high = trace(
        world,
        { x: 4.5, y: 10_000, z: 4.5 },
        { x: 30, y: 0, z: 0 }
      );
      assert.equal(high.kind, "flight");
      assert.equal(world.reads, before);
    }
  }
});

test("void and horizontal border misses cannot synthesize impacts or landing platforms", () => {
  const world = pearlWorld();
  const missed = trace(
    world,
    { x: 4.5, y: world.spec.voidY + 0.1, z: 4.5 },
    { x: 0, y: -10, z: 0 }
  );
  assert.equal(missed.kind, "miss");
  assert.equal(missed.reason, "void");
  assert.equal(world.reads, 0);
  world.admit(WORLD_MAX / 16 - 1, 0);
  const border = trace(
    world,
    { x: WORLD_MAX - 0.2, y: 20, z: 4.5 },
    { x: 30, y: 0, z: 0 }
  );
  assert.equal(border.kind, "miss");
  assert.equal(border.reason, "border");
});

test("impact offset preserves lava and unsupported ledges without searching for safety", () => {
  const world = pearlWorld();
  world.put(4, 0, 4, BLOCK.STONE);
  world.put(4, 1, 4, BLOCK.LAVA);
  const flight = trace(world, { x: 4.5, y: 2, z: 4.5 }, { x: 0, y: -30, z: 0 });
  const lava = pearlImpactPose(world, world.context, flight.hit, body);
  assert.equal(lava.kind, "ready");
  close(lava.position.y, 1 + PEARL_COLLISION_OFFSET);
  assert.equal(world.cells.get("4,1,4").id, BLOCK.LAVA);
  world.put(6, 40, 4, BLOCK.STONE);
  const side = trace(world, { x: 4, y: 40.5, z: 4.5 }, { x: 80, y: 0, z: 0 });
  const ledge = pearlImpactPose(world, world.context, side.hit, body);
  assert.equal(ledge.kind, "ready");
  close(ledge.position.x, 6 - body.radius - PEARL_COLLISION_OFFSET);
  close(ledge.position.y, 40.5);
  assert.equal(world.cells.size, 3);
});

test("too-small headroom, embedded contacts and undersides reject rather than relocate", () => {
  const world = pearlWorld();
  world.put(4, 0, 4, BLOCK.OAK_SLAB);
  world.put(4, 1, 4, BLOCK.STONE);
  const hit = {
    point: { x: 4.5, y: 0.5, z: 4.5 },
    normal: { x: 0, y: 1, z: 0 },
  };
  assert.equal(
    pearlImpactPose(world, world.context, hit, body).kind,
    "blocked"
  );
  assert.equal(
    pearlImpactPose(
      world,
      world.context,
      { ...hit, normal: { x: 0, y: -1, z: 0 } },
      body
    ).kind,
    "blocked"
  );
  assert.equal(
    pearlImpactPose(
      world,
      world.context,
      { ...hit, normal: { x: 0, y: 0, z: 0 } },
      body
    ).kind,
    "blocked"
  );
  assert.equal(
    probePearlOrigin(world, world.context, { x: 4.5, y: 0.25, z: 4.5 }).kind,
    "blocked"
  );
});

test("pathological motion is refused and one legal sweep has a bounded read set", () => {
  const world = pearlWorld();
  const result = trace(
    world,
    { x: 4.5, y: 20, z: 4.5 },
    { x: MAX_PEARL_SPEED + 1, y: 0, z: 0 }
  );
  assert.equal(result.kind, "invalid");
  assert.equal(world.reads, 0);
  const legal = trace(
    world,
    { x: 4.5, y: 20, z: 4.5 },
    { x: MAX_PEARL_SPEED, y: MAX_PEARL_SPEED, z: MAX_PEARL_SPEED }
  );
  assert.equal(legal.kind, "flight");
  assert.ok(world.reads <= MAX_PEARL_QUERY_CELLS);
});
