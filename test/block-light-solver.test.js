import assert from "node:assert/strict";
import test from "node:test";
import { BlockLightSolver } from "../src/block-light-solver.js";
import { LIGHT_BLOCKED } from "../src/block-light-topology.js";

function finish(solver) {
  for (let step = 0; step < 100; step++) {
    let visits = 0;
    const stats = { seedVisits: 0, floodVisits: 0, outputVisits: 0, queuePeak: 0 };
    if (solver.step({ visit: () => visits++ < 32768 }, stats)) return;
  }
  throw new Error("Solver did not converge");
}

test("a completely emissive neighborhood fits the fixed queue without truncation", () => {
  const solver = new BlockLightSolver();
  solver.begin(Array.from({ length: 27 }, () => ({ uniform: (0xffaa550f | LIGHT_BLOCKED) >>> 0 })));
  finish(solver);
  assert.equal(solver.peak, 48 ** 3);
  assert.equal(solver.count, 0);
  assert.deepEqual([...solver.values.slice(0, 3)], [255, 170, 85]);
  assert.equal(solver.resources(), 48 ** 3 * 10);
});

test("competing colors have a deterministic strongest-source bound, not additive growth", () => {
  const solver = new BlockLightSolver();
  const values = new Uint32Array(4096);
  values[8 * 256 + 8 * 16 + 6] = 0xff00000f;
  values[8 * 256 + 8 * 16 + 10] = 0x0000ff0f;
  const sources = Array.from({ length: 27 }, () => ({ uniform: 0 }));
  sources[13] = { uniform: null, values };
  solver.begin(sources);
  finish(solver);
  const at = (8 * 400 + 10 * 20 + 10) * 4;
  assert.deepEqual([...solver.values.slice(at, at + 3)], [192, 0, 0]);
  const expected = solver.values.slice();
  solver.begin(sources);
  finish(solver);
  assert.deepEqual(solver.values, expected, "scratch reuse must not retain the previous frontier");
});
