import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { COMBAT_CONTACT_EPSILON } from "../src/combat-collision.js";
import {
  assertCombatScalars, combatActor, combatCell, combatClose, combatFacts, combatTrace, combatWorld,
} from "./combat-collision-fixtures.js";

test("the whole segment hits the nearest actor independently of candidate order", (t) => {
  const world = combatWorld(t);
  const near = combatActor(world, { id: "combat/near", box: [6, 19, 4, 6.5, 22, 5] });
  const far = combatActor(world, { id: "combat/far", box: [8, 19, 4, 8.5, 22, 5] });
  const first = combatTrace(combatFacts(world, { candidates: [far, near] }));
  const reversed = combatTrace(combatFacts(world, { candidates: [near, far] }));
  assert.equal(first.kind, "contact");
  assert.equal(first.contact.actor.id, near.id);
  assert.deepEqual(first.contact, reversed.contact);
  combatClose(first.contact.fraction, (6 - 0.125 - 4) / 6);
  assert.equal(first.validate(), true);
  assertCombatScalars(first);
});

test("tied actors use full stable IDs, not prefix truncation or enumeration order", (t) => {
  const world = combatWorld(t);
  const prefix = `combat/${"same-prefix/".repeat(30)}`;
  const a = combatActor(world, { id: `${prefix}a` });
  const b = combatActor(world, { id: `${prefix}b` });
  for (const candidates of [[a, b], [b, a]]) {
    const result = combatTrace(combatFacts(world, { candidates }));
    assert.equal(result.contact.actor.id, a.id);
    assert.equal(result.contact.actor.key, JSON.stringify(["mob", a.id]));
    assert.ok(result.contact.actor.id.length > 100);
  }
});

test("epsilon ties are anchored to the global minimum, avoiding non-transitive A/B/C order bugs", (t) => {
  const world = combatWorld(t), epsilon = COMBAT_CONTACT_EPSILON;
  const at = (id, fraction) => combatActor(world, {
    id, box: [4 + fraction * 6 + 0.125, 19, 4, 5 + fraction * 6, 22, 5],
  });
  const near = at("combat/z-nearest", 0.4);
  const middle = at("combat/m-within-tolerance", 0.4 + epsilon * 0.75);
  const outside = at("combat/a-outside-tolerance", 0.4 + epsilon * 1.5);
  for (const candidates of [[near, middle, outside], [outside, middle, near], [middle, near, outside]]) {
    const result = combatTrace(combatFacts(world, { candidates }));
    assert.equal(result.contact.actor.id, middle.id);
    combatClose(result.contact.fraction, 0.4 + epsilon * 0.75);
  }
});

test("world shapes win declared tolerance ties, but a genuinely earlier actor still wins", (t) => {
  const world = combatWorld(t);
  combatCell(world, 7, 20, 4, BLOCK.STONE);
  const at = (offset) => combatActor(world, {
    id: "combat/a-foreground", box: [7 - offset, 19, 4, 8 - offset, 22, 5],
  });
  const tied = combatTrace(combatFacts(world, {
    candidates: [at(6 * COMBAT_CONTACT_EPSILON * 0.5)],
  }));
  assert.equal(tied.contact.kind, "world");
  assert.equal(tied.contact.cell.x, 7);
  const earlier = combatTrace(combatFacts(world, {
    candidates: [at(6 * COMBAT_CONTACT_EPSILON * 2)],
  }));
  assert.equal(earlier.contact.kind, "actor");
  combatCell(world, 7, 19, 4, BLOCK.STONE);
  const blocks = combatTrace(combatFacts(world));
  assert.equal(blocks.contact.cell.y, 19, "block ties use cell coordinates, then shape part");
  assert.equal(blocks.contact.cell.part, 0);
});

test("origin embedding, entering touches and endpoint contacts cannot tunnel; leaving touches can fly", (t) => {
  const world = combatWorld(t);
  combatCell(world, 6, 20, 4, BLOCK.STONE);
  const trace = (from, to) => combatTrace(combatFacts(world, { from, to }));
  const inside = { x: 6.5, y: 20.5, z: 4.5 };
  const embedded = trace(inside, inside);
  assert.equal(embedded.kind, "contact");
  assert.equal(embedded.contact.fraction, 0);
  assert.deepEqual(embedded.contact.normal, { x: 0, y: 0, z: 0 });
  const touch = { x: 5.875, y: 20.5, z: 4.5 };
  assert.equal(trace(touch, { ...touch, x: 4 }).kind, "flight");
  assert.equal(trace(touch, { ...touch, y: 20.8 }).kind, "flight");
  assert.equal(trace(touch, touch).kind, "flight");
  const entering = trace(touch, { ...touch, x: 7 });
  assert.equal(entering.contact.fraction, 0);
  const end = trace({ ...touch, x: 4 }, touch);
  assert.equal(end.kind, "contact");
  assert.equal(end.contact.fraction, 1);
  assert.deepEqual(end.contact.normal, { x: -1, y: 0, z: 0 });
  assert.equal(trace({ ...touch, x: 4 }, { ...touch, x: touch.x - 1e-5 }).kind, "flight");
});

test("actor origin overlaps, moving-away surfaces and endpoint contacts use the same physical rule", (t) => {
  const world = combatWorld(t);
  const actor = combatActor(world);
  const trace = (from, to) => combatTrace(combatFacts(world, { from, to, candidates: [actor] }));
  const inside = { x: 7.5, y: 20, z: 4.5 };
  assert.equal(trace(inside, inside).contact.fraction, 0);
  const touch = { ...inside, x: 6.875 };
  assert.equal(trace(touch, { ...touch, x: 4 }).kind, "flight");
  assert.equal(trace({ ...touch, x: 4 }, touch).contact.fraction, 1);
});

test("bottom, top and double slabs use real material at negative cells and signed heights", (t) => {
  const world = combatWorld(t);
  const trace = (y) => combatTrace(combatFacts(world, {
    from: { x: -8, y, z: -4.5 }, to: { x: -4, y, z: -4.5 },
  }));
  combatCell(world, -6, -10, -5, BLOCK.OAK_SLAB);
  assert.equal(trace(-9.25).kind, "flight");
  const lower = trace(-9.7);
  assert.equal(lower.kind, "contact");
  assert.equal(lower.contact.cell.x, -6);
  assert.equal(lower.contact.cell.y, -10);
  assert.equal(lower.contact.cell.z, -5);
  combatClose(lower.contact.center.x, -6.125);
  combatCell(world, -6, -10, -5, BLOCK.OAK_SLAB, BLOCK_STATE.TOP);
  assert.equal(trace(-9.75).kind, "flight");
  assert.equal(trace(-9.25).kind, "contact");
  combatCell(world, -6, -10, -5, BLOCK.OAK_SLAB, BLOCK_STATE.DOUBLE);
  assert.equal(trace(-9.75).kind, "contact");
});

test("stairs retain their open halves and resolve a neighboring outer corner", (t) => {
  const world = combatWorld(t);
  const trace = (y, z) => combatTrace(combatFacts(world, {
    from: { x: 4, y, z }, to: { x: 9, y, z }, radius: 0.1,
  }));
  combatCell(world, 6, 10, 4, BLOCK.OAK_STAIRS);
  assert.equal(trace(10.75, 4.75).kind, "flight");
  assert.equal(trace(10.75, 4.25).kind, "contact");
  combatCell(world, 6, 10, 4, BLOCK.OAK_STAIRS, BLOCK_STATE.TOP);
  assert.equal(trace(10.25, 4.75).kind, "flight");
  assert.equal(trace(10.25, 4.25).kind, "contact");
  combatCell(world, 6, 10, 4, BLOCK.OAK_STAIRS);
  combatCell(world, 6, 10, 3, BLOCK.OAK_STAIRS, 1);
  const corner = trace(10.75, 4.25);
  assert.equal(corner.kind, "contact");
  combatClose(corner.contact.center.x, 6.4);
  assert.equal(corner.contact.cell.part, 1);
});

test("thin trapdoors and both linked door halves resolve their actual open/closed panels", (t) => {
  const world = combatWorld(t);
  combatCell(world, 6, 10, 4, BLOCK.OAK_TRAPDOOR);
  const trapdoor = combatTrace(combatFacts(world, {
    from: { x: 6.5, y: 12, z: 4.5 }, to: { x: 6.5, y: 9, z: 4.5 }, radius: 0.1,
  }));
  assert.equal(trapdoor.kind, "contact");
  combatClose(trapdoor.contact.point.y, 10 + 3 / 16);
  const through = (x = 6.5, y = 10.5) => combatTrace(combatFacts(world, {
    from: { x, y, z: 3 }, to: { x, y, z: 7 }, radius: 0.05,
  }));
  combatCell(world, 6, 10, 4, BLOCK.OAK_DOOR);
  combatClose(through().contact.point.z, 4 + 13 / 16);
  combatCell(world, 6, 10, 4, BLOCK.OAK_DOOR, BLOCK_STATE.OPEN);
  assert.equal(through().kind, "flight");
  assert.equal(through(6.125).kind, "contact");
  combatCell(world, 6, 11, 4, BLOCK.OAK_DOOR, BLOCK_STATE.PART | BLOCK_STATE.HINGE_RIGHT);
  assert.equal(through(6.5, 11.5).kind, "flight");
  const upper = through(6.875, 11.5);
  assert.equal(upper.kind, "contact");
  assert.equal(upper.contact.cell.y, 11);
  combatClose(upper.contact.point.z, 4);
});

test("closed gates and thin fences collide above their owner cell; open gates do not", (t) => {
  const world = combatWorld(t);
  const facts = combatFacts(world, {
    from: { x: 6.5, y: 11.35, z: 3 }, to: { x: 6.5, y: 11.35, z: 7 }, radius: 0.1,
  });
  combatCell(world, 6, 10, 4, BLOCK.OAK_FENCE_GATE, BLOCK_STATE.OPEN);
  assert.equal(combatTrace(facts).kind, "flight");
  combatCell(world, 6, 10, 4, BLOCK.OAK_FENCE_GATE);
  assert.equal(combatTrace(facts).kind, "contact");
  combatCell(world, 6, 10, 4, BLOCK.OAK_FENCE);
  const fence = combatTrace(facts);
  assert.equal(fence.kind, "contact");
  assert.equal(fence.contact.cell.y, 10);
  combatClose(fence.contact.point.z, 4 + 6 / 16);
});

test("radius sweeps catch edge contacts without treating liquids or selection-only shapes as solid", (t) => {
  const world = combatWorld(t);
  combatCell(world, 6, 20, 4, BLOCK.STONE);
  const facts = combatFacts(world, {
    from: { x: 4, y: 20.5, z: 5.1 }, to: { x: 9, y: 20.5, z: 5.1 },
  });
  assert.equal(combatTrace({ ...facts, radius: 0.15 }).kind, "contact");
  assert.equal(combatTrace({ ...facts, radius: 0.05 }).kind, "flight");
  combatCell(world, 6, 20, 4, BLOCK.WATER);
  combatCell(world, 7, 20, 4, BLOCK.LADDER);
  assert.equal(combatTrace(combatFacts(world)).kind, "flight");
});

test("high flight respects loaded columns without querying cells outside real build bounds", (t) => {
  for (const dimension of ["overworld", "nether", "end"]) {
    const world = combatWorld(t, { dimension });
    const getCell = world.getCell.bind(world);
    let calls = 0;
    world.getCell = (x, y, z) => {
      calls++;
      assert.ok(y >= world.spec.minY && y < world.spec.maxY);
      return getCell(x, y, z);
    };
    const high = combatTrace(combatFacts(world, {
      from: { x: 4, y: 10000, z: 4.5 }, to: { x: 9, y: 10000, z: 4.5 },
    }));
    assert.equal(high.kind, "flight");
    assert.equal(calls, 0);
    combatCell(world, 6, world.spec.minY, 4, BLOCK.OAK_SLAB);
    const floor = combatTrace(combatFacts(world, {
      from: { x: 4, y: world.spec.minY + 0.25, z: 4.5 },
      to: { x: 9, y: world.spec.minY + 0.25, z: 4.5 },
    }));
    assert.equal(floor.kind, "contact");
  }
});
