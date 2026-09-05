import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { air, put, stats, finish, compare, cases, BlockLightSolver, COUNT, RED, BLUE } from "./block-light-reference-fixture.js";

test("dense oracle is the independently frozen 9f505cc solver, not shared optimized logic", async () => {
  const text = (await readFile(new URL("./block-light-dense-reference.js", import.meta.url), "utf8"))
    .replace('"../src/block-light-topology.js"', '"./block-light-topology.js"');
  const blob = createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  assert.equal(blob, "e0b7261321d62b68aef96cf5b76e62d62b017fc2");
});

for (const [name, sources] of Object.entries(cases()))
  test(`lazy scratch equals dense baseline: ${name}`, () => {
    const { optimized } = compare(sources, { cap: 32768 });
    assert.ok(optimized.initializedCells <= COUNT);
  });

test("unknown emitter metadata falls back to scanning, never assumes darkness", () => {
  const sources = cases().ties;
  for (const source of sources) if (source) delete source.emitters;
  compare(sources, { cap: 113 });
});

test("random mixed missing/uniform/opaque/water/emissive neighborhoods match baseline", () => {
  let seed = 7040;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let sample = 0; sample < 12; sample++) {
    const sources = air();
    for (let i = 0; i < 27; i++) {
      const n = random() % 5;
      if (n === 0) sources[i] = null;
      if (n === 1) sources[i] = { uniform: 16, emitters: 0 };
      if (n === 2) sources[i] = { uniform: 32, emitters: 0 };
    }
    for (let i = 0; i < 700; i++) {
      const x = random() % 48, y = random() % 48, z = random() % 48;
      const codes = [0, 16, 32, RED, BLUE | 16, 0x00ff000a, RED | 32];
      put(sources, x, y, z, codes[random() % codes.length]);
    }
    compare(sources, { cap: sample % 2 ? 32768 : 8192 });
  }
});

test("sparse initialization removes actual visits with unchanged work/storage limits", () => {
  const { reference, optimized } = compare(cases().sparse);
  assert.ok(optimized.seedVisits < reference.seedVisits / 20);
  assert.ok(optimized.visits < reference.visits / 4);
  assert.equal(optimized.resetVisits, 0);
  assert.deepEqual(
    [BLOCK_LIGHT_LIMITS.scans, BLOCK_LIGHT_LIMITS.visits, BLOCK_LIGHT_LIMITS.milliseconds,
      BLOCK_LIGHT_LIMITS.uploads, BLOCK_LIGHT_LIMITS.publications],
    [8192, 32768, 2, 2, 8],
  );
});

test("repeated scratch reuse and generation wrap retain no prior light/frontier", () => {
  const solver = new BlockLightSolver(), inputs = cases();
  for (let i = 0; i < 260; i++) {
    const { optimized } = compare(i % 3 ? inputs.absent : inputs.sparse, undefined, solver);
    assert.equal(optimized.resetVisits, i === 127 || i === 254 ? COUNT : 0);
  }
});

test("aborted seed/flood/output jobs, and an aborted generation reset, match fresh dense solves", () => {
  const solver = new BlockLightSolver(), inputs = cases();
  for (const phase of ["seed", "flood", "output"]) {
    solver.begin(inputs.sparse);
    for (let i = 0; solver.phase !== phase && i < COUNT * 3; i++)
      solver.step({ visit: (() => { let n = 0; return () => n++ < 1; })() }, stats());
    assert.equal(solver.phase, phase);
    solver.step({ visit: (() => { let n = 0; return () => n++ < 7; })() }, stats());
    compare(inputs.water, undefined, solver);
  }
  // Reach rollover by beginning and abandoning jobs, just as field invalidation
  // may do. Do not reach inside the generation bookkeeping to manufacture it.
  while (solver.generation !== 127) solver.begin(inputs.sparse);
  solver.begin(inputs.water);
  assert.equal(solver.phase, "reset");
  const s = stats();
  let n = 0;
  solver.step({ visit: () => n++ < 113 }, s);
  assert.equal(s.resetVisits, 113);
  solver.begin(inputs.ties); // Interrupted reset must restart before tag reuse.
  assert.equal(solver.phase, "reset");
  const result = finish(solver);
  assert.equal(result.resetVisits, COUNT);
  const expected = compare(inputs.ties).solver.values;
  assert.deepEqual(solver.values, expected);
});

test("zero visits do no seed/reset work outside step", () => {
  const solver = new BlockLightSolver();
  const source = new Proxy({}, { get() { throw new Error("unbudgeted topology access"); } });
  for (let i = 0; i < 130; i++) {
    solver.begin(Array(27).fill(source));
    const s = stats(), cursor = solver.cursor;
    assert.equal(solver.step({ visit: () => false }, s), false);
    assert.equal(solver.cursor, cursor);
    assert.equal(s.seedVisits + s.resetVisits + s.lazyReads, 0);
  }
});

test("rollover clearing stops at the same 32-visit deadline checkpoint as production", () => {
  const solver = new BlockLightSolver();
  for (let i = 0; i < 128; i++) solver.begin(Array(27).fill(null));
  assert.equal(solver.phase, "reset");
  const s = stats();
  let elapsed = 0, visits = 0;
  assert.equal(solver.step({ visit() {
    if (visits >= 32768 || (visits % 32 === 0 && elapsed >= 2)) return false;
    visits++; elapsed += 0.125; return true;
  } }, s), false);
  assert.equal(solver.cursor, 32);
  assert.equal(s.resetVisits, 32);
  assert.equal(s.seedVisits, 0);
  assert.equal(solver.resetPending, true);
});

test("real 2ms slices retain the visit cap and exact reference output", () => {
  const sources = cases().wall;
  const { optimized } = compare(sources, { cap: 32768, milliseconds: 2 });
  assert.ok(optimized.maxVisits <= 32768);
  // Wall time can overshoot under OS scheduling; deterministic expiry behavior
  // is tested separately and maxima are reported, never used as a flaky gate.
  assert.ok(optimized.slices > 0);
});
