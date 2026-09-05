import assert from "node:assert/strict";
import { BlockLightSolver } from "../src/block-light-solver.js";
import { BlockLightSolver as DenseSolver } from "./block-light-dense-reference.js";

export { BlockLightSolver, DenseSolver };
export const SIDE = 48, COUNT = SIDE ** 3;
export const RED = 0xff00000f, BLUE = 0x0000ff0f;
export const uniform = code => ({ uniform: code >>> 0, emitters: code & 15 ? 4096 : 0 });
export const air = () => Array.from({ length: 27 }, () => uniform(0));

export function put(sources, x, y, z, code) {
  const section = Math.floor(y / 16) * 9 + Math.floor(z / 16) * 3 + Math.floor(x / 16);
  const at = (y % 16) * 256 + (z % 16) * 16 + x % 16;
  let source = sources[section];
  if (!source || source.uniform != null) {
    source = sources[section] = {
      values: new Uint32Array(4096).fill(source?.uniform ?? 16),
      emitters: source?.emitters ?? 0, uniform: null,
    };
  }
  source.emitters += Number(!!(code & 15)) - Number(!!(source.values[at] & 15));
  source.values[at] = code >>> 0;
}

export function stats() {
  return { seedVisits: 0, floodVisits: 0, outputVisits: 0, queuePeak: 0,
    resetVisits: 0, lazyReads: 0, initializedCells: 0 };
}

export function finish(solver, { cap = 32768, milliseconds = Infinity } = {}) {
  const total = stats();
  let visits = 0, slices = 0, maxVisits = 0, maxSliceMs = 0, done = false;
  const start = performance.now();
  while (!done) {
    const s = stats(), sliceStart = performance.now();
    let used = 0;
    done = solver.step({ visit() {
      if (used >= cap || (used % 32 === 0 && performance.now() - sliceStart >= milliseconds)) return false;
      used++;
      return true;
    } }, s);
    const elapsed = performance.now() - sliceStart;
    maxSliceMs = Math.max(maxSliceMs, elapsed);
    maxVisits = Math.max(maxVisits, used);
    visits += used;
    for (const key of Object.keys(total)) total[key] += s[key];
    assert.ok(used <= cap);
    assert.ok(s.lazyReads <= 6 * s.floodVisits, "at most six lazy topology reads per flood visit");
    assert.ok(s.initializedCells <= s.seedVisits + 6 * s.floodVisits);
    if (++slices > 100000) throw new Error(`Solver not converged: ${solver.phase}`);
  }
  return { visits, slices, maxVisits, maxSliceMs, elapsedMs: performance.now() - start, ...total };
}

export function compare(sources, options, solver = new BlockLightSolver()) {
  const dense = new DenseSolver();
  dense.begin(sources); solver.begin(sources);
  const reference = finish(dense, options), optimized = finish(solver, options);
  assert.deepEqual(solver.values, dense.values, "exact independent dense-reference output");
  assert.equal(solver.lit, dense.lit);
  assert.ok(solver.peak <= COUNT);
  assert.equal(solver.resources(), dense.resources(), "no additional retained array storage");
  assert.equal(solver.count, 0);
  return { reference, optimized, solver };
}

export function cases() {
  const sparse = air();
  put(sparse, 24, 24, 24, RED);
  const water = Array.from({ length: 27 }, () => uniform(32));
  put(water, 24, 24, 24, BLUE);
  const ties = air();
  put(ties, 15, 24, 24, RED | 16); put(ties, 33, 24, 24, BLUE | 16);
  put(ties, 24, 15, 24, 0x00ff000f); put(ties, 24, 33, 24, 0xffff000f);
  const wall = air();
  for (let y = 0; y < 48; y++) for (let z = 0; z < 48; z++) put(wall, 24, y, z, 16);
  put(wall, 24, 24, 24, RED | 16); put(wall, 25, 24, 24, BLUE | 32);
  const edges = Array(27).fill(null);
  edges[13] = uniform(0);
  for (const x of [0, 14, 15, 16, 31, 32, 33, 47])
    for (const z of [0, 14, 15, 16, 31, 32, 33, 47])
      put(edges, x, x % 2 ? 31 : 16, z, RED | 16);
  return { sparse, water, ties, wall, edges, empty: air(),
    absent: Array(27).fill(null),
    denseBlocked: Array.from({ length: 27 }, () => uniform(0xffaa551f)),
    denseOpen: Array.from({ length: 27 }, () => uniform(0xffaa550f)) };
}
