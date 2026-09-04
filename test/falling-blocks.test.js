import test from "node:test";
import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { FallingBlocks, FALLING_BLOCK_LIMITS as LIMITS } from "../src/falling-blocks.js";
import { isFallingBlock } from "../src/falling-block-rules.js";
import { fluidFixture, retainedPlantDrops } from "./fluid-fixture.js";

function fixture(t, options = {}) {
  const base = fluidFixture(t, { radius: 0, connect: false, ...options });
  const gravity = new FallingBlocks(base.world, {
    isOccupied: () => false, ...options.hooks,
  });
  base.world.onMutation = (event) => gravity.onMutation(event);
  base.world.onChunkAdmitted = ({ chunk }) => gravity.onChunkLoaded(chunk);
  t.after(() => gravity.dispose());
  return { ...base, gravity };
}
const steps = (gravity, n = 20) => {
  for (let i = 0; i < n; i++) gravity.update(0.1);
};
function mass(world) {
  let count = 0;
  for (const chunk of world.chunks.values())
    for (const id of chunk.blocks) if (isFallingBlock(id)) count++;
  return count;
}

test("support removal moves an actual sand cell one step per tick then settles", (t) => {
  const { world, gravity, put } = fixture(t);
  put(3, 3, 3, BLOCK.STONE);
  put(3, 4, 3, BLOCK.SAND);
  steps(gravity);
  assert.equal(world.get(3, 4, 3), BLOCK.SAND);
  put(3, 3, 3, BLOCK.AIR);
  steps(gravity, 1);
  assert.equal(world.get(3, 3, 3), BLOCK.SAND);
  assert.equal(world.get(3, 4, 3), BLOCK.AIR);
  steps(gravity);
  assert.equal(world.get(3, 1, 3), BLOCK.SAND);
  assert.equal(mass(world), 1);
  assert.equal(gravity.diagnostics().queued, 0);
});

test("mixed stack cascades preserve every block and ordering", (t) => {
  const { world, gravity, put } = fixture(t);
  put(5, 4, 5, BLOCK.STONE);
  const ids = [BLOCK.GRAVEL, BLOCK.SAND, BLOCK.RED_SAND, BLOCK.GRAVEL];
  ids.forEach((id, i) => put(5, 5 + i, 5, id));
  steps(gravity);
  put(5, 4, 5, BLOCK.AIR);
  steps(gravity, 50);
  assert.deepEqual(ids.map((_, i) => world.get(5, i + 1, 5)), ids);
  assert.equal(mass(world), 4);
});

test("unsupported placement falls; inserting support stops subsequent steps", (t) => {
  const { world, gravity, put } = fixture(t);
  put(5, 8, 5, BLOCK.GRAVEL);
  steps(gravity, 1);
  assert.equal(world.get(5, 7, 5), BLOCK.GRAVEL);
  put(5, 6, 5, BLOCK.STONE);
  steps(gravity);
  assert.equal(world.get(5, 7, 5), BLOCK.GRAVEL);
});

test("slabs, stairs, gates and tall fence collision are never overwritten", (t) => {
  const { world, gravity, put } = fixture(t);
  const obstacles = [
    { id: BLOCK.OAK_SLAB }, { id: BLOCK.OAK_SLAB, state: BLOCK_STATE.TOP },
    { id: BLOCK.OAK_STAIRS }, { id: BLOCK.OAK_FENCE_GATE, state: BLOCK_STATE.OPEN },
  ];
  obstacles.forEach((cell, i) => {
    put(2 + i, 1, 2, cell);
    put(2 + i, 4, 2, BLOCK.SAND);
  });
  put(8, 1, 2, BLOCK.OAK_FENCE);
  put(8, 5, 2, BLOCK.GRAVEL);
  steps(gravity);
  obstacles.forEach((cell, i) => {
    assert.equal(world.get(2 + i, 1, 2), cell.id);
    assert.equal(world.get(2 + i, 2, 2), BLOCK.SAND);
  });
  assert.equal(world.get(8, 3, 2), BLOCK.GRAVEL);
  assert.equal(world.get(8, 2, 2), BLOCK.AIR);
  put(8, 1, 2, BLOCK.AIR);
  steps(gravity);
  assert.equal(world.get(8, 1, 2), BLOCK.GRAVEL);
});

test("water codes and lava are displaced upward, not deleted or duplicated", (t) => {
  const { world, gravity, put } = fixture(t);
  for (const [x, id, fluid] of [
    [2, BLOCK.WATER, FLUID.WATER_SOURCE],
    [3, BLOCK.WATER, FLUID.WATER_4],
    [4, BLOCK.LAVA, FLUID.LAVA_SOURCE],
  ]) {
    put(x, 1, 2, { id, fluid });
    put(x, 2, 2, BLOCK.SAND);
  }
  steps(gravity);
  for (const [x, id, fluid] of [
    [2, BLOCK.WATER, FLUID.WATER_SOURCE],
    [3, BLOCK.WATER, FLUID.WATER_4],
    [4, BLOCK.LAVA, FLUID.LAVA_SOURCE],
  ]) {
    assert.equal(world.get(x, 1, 2), BLOCK.SAND);
    assert.deepEqual(world.getCell(x, 2, 2), { id, state: 0, fluid });
  }
  assert.equal(mass(world), 3);
});

test("replaceable plants require atomic retention; rejection and replay grant once", (t) => {
  const { world, gravity, put } = fixture(t);
  const retained = retainedPlantDrops(world);
  t.after(() => world.coordinator.release(retained.owner));
  gravity.prepareDrops = retained.prepareDrops;
  retained.owner.accept = false;
  put(2, 1, 2, BLOCK.YELLOW_FLOWER);
  put(2, 2, 2, BLOCK.SAND);
  steps(gravity, 3);
  assert.equal(world.get(2, 1, 2), BLOCK.YELLOW_FLOWER);
  assert.equal(retained.owner.drops.length, 0);
  retained.owner.accept = true;
  steps(gravity);
  assert.equal(world.get(2, 1, 2), BLOCK.SAND);
  assert.equal(retained.owner.drops.length, 1);
  assert.equal(retained.owner.drops[0].stack.count, 1);
  assert.equal(mass(world), 1);
});

test("missing retention callback leaves plants and sand intact", (t) => {
  const { world, gravity, put } = fixture(t);
  put(2, 1, 2, BLOCK.YELLOW_FLOWER);
  put(2, 2, 2, BLOCK.SAND);
  steps(gravity);
  assert.equal(world.get(2, 1, 2), BLOCK.YELLOW_FLOWER);
  assert.equal(world.get(2, 2, 2), BLOCK.SAND);
});

test("player/vehicle swept occupancy suspends and resumes; rechecked at commit", (t) => {
  let blocked = true;
  const boxes = [];
  const { world, gravity, put } = fixture(t, {
    hooks: { isOccupied: (bounds) => { boxes.push(bounds); return blocked; } },
  });
  put(2, 2, 2, BLOCK.SAND);
  steps(gravity, 2);
  assert.equal(world.get(2, 2, 2), BLOCK.SAND);
  assert.deepEqual(boxes[0], [2, 1, 2, 3, 3, 3]);
  blocked = false;
  let calls = 0;
  gravity.isOccupied = () => ++calls >= 2;
  steps(gravity, 1);
  assert.equal(world.get(2, 2, 2), BLOCK.SAND);
  gravity.isOccupied = () => false;
  steps(gravity);
  assert.equal(world.get(2, 1, 2), BLOCK.SAND);
});

test("missing occupancy hook fails closed; pause does not accumulate catchup", (t) => {
  const { world, gravity, put } = fixture(t, { hooks: { isOccupied: undefined } });
  put(2, 8, 2, BLOCK.SAND);
  steps(gravity, 2);
  assert.equal(world.get(2, 8, 2), BLOCK.SAND);
  gravity.isOccupied = () => false;
  gravity.canAdvance = () => false;
  assert.equal(gravity.update(100), false);
  gravity.canAdvance = () => true;
  gravity.update(0);
  assert.equal(world.get(2, 8, 2), BLOCK.SAND);
  gravity.update(0.1);
  assert.equal(world.get(2, 7, 2), BLOCK.SAND);
});

test("own-column eviction suspends; boundary admission resumes without loading neighbors", (t) => {
  const { world, gravity, put } = fixture(t);
  put(15, 3, 3, BLOCK.GRAVEL);
  const chunk = world.chunks.get("0,0");
  world._removeChunk("0,0", chunk);
  steps(gravity, 2);
  assert.equal(world.chunks.size, 0);
  world._generateSync(0, 0);
  steps(gravity, 100);
  assert.equal(world.get(15, 1, 3), BLOCK.GRAVEL);
  assert.equal(world.chunks.size, 1);
  assert.equal(mass(world), 1);
});

test("prepared transaction replay is single use; refusing commits keeps pending gravity", (t) => {
  const { world, gravity, put } = fixture(t);
  put(2, 2, 2, BLOCK.SAND);
  const commit = world.coordinator.commit.bind(world.coordinator);
  let participants;
  world.coordinator.commit = (plans) => { participants = plans; return { ok: false }; };
  steps(gravity, 2);
  assert.equal(world.get(2, 2, 2), BLOCK.SAND);
  world.coordinator.commit = (plans) => { participants = plans; return commit(plans); };
  steps(gravity, 1);
  assert.equal(world.get(2, 1, 2), BLOCK.SAND);
  assert.equal(commit(participants).ok, false);
  assert.equal(mass(world), 1);
});

test("throwing observers and duplicate event delivery do not duplicate blocks", (t) => {
  const { world, gravity, put } = fixture(t);
  put(2, 4, 2, BLOCK.SAND);
  world.onMutation = (event) => {
    gravity.onMutation(event);
    gravity.onMutation(event);
    throw new Error("observer fixture");
  };
  steps(gravity);
  assert.equal(world.get(2, 1, 2), BLOCK.SAND);
  assert.equal(mass(world), 1);
});

test("ordinary World save/reload during a fall resumes with no sidecar", (t) => {
  const first = fixture(t);
  first.put(2, 6, 2, BLOCK.SAND);
  steps(first.gravity, 1);
  const saved = JSON.parse(JSON.stringify(first.world.serialize()));
  const second = fixture(t);
  assert.equal(second.world.loadEdits(saved), true);
  steps(second.gravity, 100);
  assert.equal(second.world.get(2, 1, 2), BLOCK.SAND);
  assert.equal(mass(second.world), 1);
  assert.equal(second.world.serialize().version, saved.version);
});

test("save inside mutation notification contains exactly one published falling block", (t) => {
  const { world, gravity, put } = fixture(t);
  put(2, 5, 2, BLOCK.SAND);
  const snapshots = [];
  world.onMutation = (event) => {
    snapshots.push(world.serialize());
    gravity.onMutation(event);
  };
  steps(gravity);
  assert.equal(snapshots.length, 4);
  for (const snapshot of snapshots) {
    // Authored generator is empty above its floor, so all mass is in edits.
    assert.equal(snapshot.edits.filter((tuple) => isFallingBlock(tuple[4])).length, 1);
  }
});

test("live water and gravity share committed mutations without losing granular mass", (t) => {
  const { world, gravity, fluids, put } = fixture(t);
  world.onMutation = (event) => {
    fluids.onMutation(event);
    gravity.onMutation(event);
  };
  put(4, 1, 4, BLOCK.WATER);
  put(4, 5, 4, BLOCK.SAND);
  for (let i = 0; i < 30; i++) {
    gravity.update(0.1);
    fluids.update(0.25);
    assert.equal(mass(world), 1);
  }
  assert.equal(world.get(4, 1, 4), BLOCK.SAND);
});

test("admission scan discovers legacy unsupported terrain once; supported terrain goes idle", (t) => {
  const { world, gravity } = fixture(t, { initial: [[3, 3, 3, BLOCK.SAND]] });
  const chunk = world.chunks.get("0,0");
  gravity.onChunkLoaded(chunk);
  steps(gravity, 210);
  assert.equal(world.get(3, 1, 3), BLOCK.SAND);
  assert.equal(gravity.diagnostics().scanJobs, 0);
  gravity.onChunkLoaded(chunk);
  steps(gravity, 1);
  assert.equal(gravity.diagnostics().last.scanCells, 0);
  assert.equal(gravity.diagnostics().last.evaluated, 0);
});

test("queue overflow recovers affected cells with bounded work and memory", (t) => {
  const { world, gravity, put } = fixture(t);
  // Saturate intake with supported/empty locations ahead of this falling block.
  for (let y = 10; y < 28; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) gravity._offer(x, y, z);
  put(15, 3, 15, BLOCK.GRAVEL);
  for (let i = 0; i < 260; i++) {
    gravity.update(100);
    const { queued, scanJobs, last } = gravity.diagnostics();
    assert.ok(queued <= LIMITS.queuedCells);
    assert.ok(scanJobs <= LIMITS.scanJobs);
    assert.ok(last.evaluated <= LIMITS.evaluationsPerTick * LIMITS.ticksPerUpdate);
    assert.ok(last.scanCells <= LIMITS.scanCellsPerUpdate);
    assert.ok(last.scanVisits <= LIMITS.scanVisitsPerUpdate);
    assert.ok(last.moved <= LIMITS.evaluationsPerTick * LIMITS.ticksPerUpdate);
  }
  assert.equal(world.get(15, 1, 15), BLOCK.GRAVEL);
  assert.equal(mass(world), 1);
});

test("a saturated queue of actor-blocked cells cannot starve an independent fall", (t) => {
  const initial = [];
  for (let y = 2; y < 42; y += 2)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 14; x++) initial.push([x, y, z, BLOCK.SAND]);
  const { world, gravity, put } = fixture(t, {
    initial, hooks: { isOccupied: (bounds) => bounds[0] < 14 },
  });
  for (const [x, y, z] of initial) gravity._offer(x, y, z);
  put(15, 3, 15, BLOCK.GRAVEL);
  steps(gravity, 300);
  assert.equal(world.get(15, 1, 15), BLOCK.GRAVEL);
});
