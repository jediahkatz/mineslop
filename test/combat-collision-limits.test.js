import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { COMBAT_COLLISION_LIMITS, traceCombatSegment } from "../src/combat-collision.js";
import { WORLD_MAX } from "../src/terrain.js";
import {
  assertCombatScalars, combatActor, combatFacts, combatTrace, combatWorld,
} from "./combat-collision-fixtures.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

const limits = COMBAT_COLLISION_LIMITS;
function assertCaps(result) {
  for (const [name, value] of Object.entries(result.stats)) {
    const maximum = name === "cellReads" ? limits.readCells : limits[name];
    assert.ok(value >= 0 && value <= maximum, `${name}: ${value} exceeds ${maximum}`);
  }
}
function assertRefusal(result) {
  assert.equal(result.kind, "invalid");
  assert.equal(result.contact, undefined, "no partial nearest contact on budget/input failure");
  assert.equal(result.validate(), false);
  assertCaps(result);
  assertCombatScalars(result);
}

test("malformed/oversized vectors, radii and geometry extents refuse before any geometry read", (t) => {
  const world = combatWorld(t);
  let reads = 0;
  const getCell = world.getCell.bind(world);
  world.getCell = (...args) => { reads++; return getCell(...args); };
  const original = combatFacts(world);
  for (const change of [
    { from: null }, { from: { x: NaN, y: 20, z: 4 } },
    { to: { x: Infinity, y: 20, z: 4 } },
    { to: { x: 4 + limits.segmentLength + 0.01, y: 20, z: 4.5 } },
    { to: { x: Number.MAX_SAFE_INTEGER, y: 20, z: 4.5 } },
    { from: { x: WORLD_MAX, y: 20, z: 4.5 }, to: { x: WORLD_MAX, y: 20, z: 4.5 } },
    { from: { x: WORLD_MAX, y: 20, z: 4.5 }, to: { x: WORLD_MAX, y: 20, z: 4.5 }, radius: 0 },
    { radius: -1 }, { radius: NaN }, { radius: "0.1" }, { radius: limits.radius + 0.01 },
    { ticket: null }, { ticket: { ...original.ticket, revision: -1 } }, { world: null },
    // A legal chord length is not enough: refuse the entire overlarge 3D query.
    { from: { x: 4, y: 20, z: 4 }, to: { x: 13, y: 29, z: 13 }, radius: 1 },
    // Owner volume 12*12*13 fits, but the connected-read apron 16*16*17 does not.
    { from: { x: 4, y: 20, z: 4 }, to: { x: 12, y: 28, z: 13 }, radius: 0.5 },
  ]) assertRefusal(combatTrace({ ...original, ...change }));
  assert.equal(reads, 0);
});

test("candidate arrays are capped before enumeration; no iterator/dormant archive is accepted", (t) => {
  const world = combatWorld(t);
  const candidates = new Array(limits.candidates + 1);
  Object.defineProperty(candidates, "0", {
    get() { assert.fail("oversized candidate arrays must reject before reading entries"); },
  });
  assertRefusal(combatTrace(combatFacts(world, { candidates })));
  const unbounded = {
    *[Symbol.iterator]() { assert.fail("do not iterate unbounded candidate sources"); },
  };
  assertRefusal(combatTrace(combatFacts(world, { candidates: unbounded })));
  const tooManyMobs = Array.from({ length: 29 }, (_, index) =>
    combatActor(world, { id: `combat/mob/${index}` }));
  const result = combatTrace(combatFacts(world, { candidates: tooManyMobs }));
  assertRefusal(result);
  assert.equal(result.stats.geometryCells, 0);
  assertRefusal(combatTrace(combatFacts(world, {
    candidates: [combatActor(world, { kind: "player", id: "combat/player/1" }),
      combatActor(world, { kind: "player", id: "combat/player/2" })],
  })));
});

test("exactly 28 active mobs plus one player fit without touching dormant byId", (t) => {
  const world = combatWorld(t);
  Object.defineProperty(world, "byId", {
    get() { assert.fail("collision must not enumerate dormant byId residents"); },
  });
  const candidates = Array.from({ length: limits.mobs }, (_, index) =>
    combatActor(world, { id: `combat/active/${index}`, box: [7, 19, 7, 8, 22, 8] }));
  candidates.push(combatActor(world, {
    kind: "player", id: "combat/player", box: [8, 19, 7, 9, 22, 8],
  }));
  const result = combatTrace(combatFacts(world, { candidates }));
  assert.equal(result.kind, "flight");
  assert.equal(result.stats.candidates, 29);
  assert.equal(result.validate(), true);
  assertCaps(result);
});

test("duplicate identities, missing life/incarnation and malformed colliders refuse the whole roster", (t) => {
  const world = combatWorld(t), actor = combatActor(world);
  for (const change of [
    { id: "" }, { id: "x".repeat(limits.idLength + 1) }, { ref: null },
    { incarnation: undefined }, { incarnation: NaN }, { kind: "horse" },
    { kind: "player", life: undefined }, { kind: "player", life: -1 },
    { dimension: "nether" }, { worldEpoch: world.epoch + 1 },
    { box: null }, { box: [7, 19, 4, 8, 22] },
    { box: [7, 19, 4, 7, 22, 5] }, { box: [7, 19, 4, Infinity, 22, 5] },
    { box: [7, 19, 4, 7 + limits.actorExtent + 1, 22, 5] },
    { box: [WORLD_MAX, 19, 4, WORLD_MAX + 1, 22, 5] },
  ]) assertRefusal(combatTrace(combatFacts(world, { candidates: [{ ...actor, ...change }] })));
  assertRefusal(combatTrace(combatFacts(world, { candidates: [actor, actor] })));
  const distinctKinds = combatTrace(combatFacts(world, {
    candidates: [actor, { ...actor, kind: "player", life: 0 }],
  }));
  assert.equal(distinctKinds.kind, "contact", "kind is part of the full physical identity key");
});

test("source-envelope metadata and member enumeration are bounded independently", (t) => {
  const world = combatWorld(t), actor = combatActor(world);
  const valid = { exited: false, box: actor.box, members: [actor] };
  for (const sourceEnvelope of [
    { ...valid, exited: "no" }, { ...valid, members: [] },
    { ...valid, members: new Array(1) },
    { ...valid, members: [actor, actor] },
    { ...valid, members: [actor, actor, actor] },
    { ...valid, box: [0, 0, 0, 100, 100, 100] },
  ]) assertRefusal(combatTrace(combatFacts(world, { sourceEnvelope })));
});

test("legal whole-segment work and every re-query stay bounded and never generate terrain", (t) => {
  const world = combatWorld(t);
  const getCell = world.getCell.bind(world), isLoaded = world.isLoaded.bind(world);
  let reads = 0, columnCalls = 0;
  let cells = new Set();
  world.getCell = (x, y, z) => {
    reads++;
    const key = `${x},${y},${z}`;
    assert.equal(cells.has(key), false, "one detached physical read per cell per query");
    cells.add(key);
    return getCell(x, y, z);
  };
  world.isLoaded = (...args) => { columnCalls++; return isLoaded(...args); };
  world.get = () => assert.fail("use non-generating scalar getCell only");
  world.ensureArea = () => assert.fail("collision must not request terrain");
  world.generator.generateChunk = () => assert.fail("collision must not generate terrain");
  const facts = combatFacts(world, {
    to: { x: 4 + limits.segmentLength, y: 20, z: 4.5 }, radius: limits.radius,
  });
  const pending = combatTrace(facts);
  assert.equal(pending.kind, "flight");
  assert.equal(reads, pending.stats.cellReads);
  assert.ok(columnCalls <= limits.columns * 2);
  assertCaps(pending);
  for (let index = 0; index < 3; index++) {
    const before = reads, beforeColumns = columnCalls;
    cells = new Set();
    assert.equal(pending.validate(), true);
    assert.ok(reads - before <= limits.readCells);
    assert.ok(columnCalls - beforeColumns <= limits.columns * 3,
      "old read-set check plus current query admission/final pins");
  }
});

test("a dense actual-geometry query that exhausts operations refuses rather than returning an early hit", (t) => {
  const world = combatWorld(t, {
    generatorFactory(seed, dimension, version) {
      const empty = emptyFixtureGenerator(seed, dimension, version);
      return {
        ...empty,
        generateChunk(cx, cz) {
          const chunk = empty.generateChunk(cx, cz);
          chunk.blocks.fill(BLOCK.OAK_FENCE);
          return chunk;
        },
      };
    },
  });
  const result = combatTrace(combatFacts(world, {
    from: { x: 4, y: 20, z: 4 }, to: { x: 12, y: 28, z: 12 }, radius: 0.5,
  }));
  assertRefusal(result);
  assert.match(result.reason, /^limit-(readOperations|geometryBoxes)$/);
  assert.ok(result.stats.geometryCells > 0, "exercise a running operation cap, not only preflight");
});

test("bad geometry and failing readers cannot turn unknown terrain into a successful flight", (t) => {
  const world = combatWorld(t);
  world.getCell = () => ({ id: 65535, state: 0, fluid: 0 });
  assertRefusal(combatTrace(combatFacts(world)));
  world.getCell = () => { throw new Error("geometry unavailable"); };
  assertRefusal(combatTrace(combatFacts(world)));
  world.getCell = () => null;
  const frontier = combatTrace(combatFacts(world));
  assert.equal(frontier.kind, "frontier");
  assert.equal(frontier.contact, undefined);
  assertCaps(frontier);
});

test("a formerly valid guard refuses a now oversized roster rather than validating the selected actor alone", (t) => {
  const world = combatWorld(t);
  let current = combatFacts(world, { candidates: [combatActor(world)] });
  const pending = traceCombatSegment(current, () => current);
  assert.equal(pending.kind, "contact");
  current = { ...current, candidates: Array(30).fill(current.candidates[0]) };
  assert.equal(pending.validate(), false);
});
