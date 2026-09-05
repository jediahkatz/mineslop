// Bounded CPU-only experiment, not a browser/readiness/FPS acceptance gate.
// Run alone: node test/block-light-reference-benchmark.mjs --output <new.json>
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { World } from "../src/world.js";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { BlockLightSolver, DenseSolver, finish, cases } from "./block-light-reference-fixture.js";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert.ok(values.output, "--output is required (existing files are never overwritten)");
const median = ns => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)];
const start = performance.now();
const cpuBefore = await readFile("/proc/stat", "utf8");
const results = {};
for (const name of ["sparse", "water", "ties", "denseBlocked", "denseOpen"]) {
  const sources = cases()[name], dense = new DenseSolver(), lazy = new BlockLightSolver();
  const runs = { dense: [], lazy: [] };
  for (let i = 0; i < 20; i++) {
    for (const [key, solver] of i % 2 ? [["lazy", lazy], ["dense", dense]] : [["dense", dense], ["lazy", lazy]]) {
      solver.begin(sources);
      const run = finish(solver, { milliseconds: 2 });
      if (i >= 8) runs[key].push(run);
    }
    assert.deepEqual(lazy.values, dense.values);
  }
  results[name] = Object.fromEntries(Object.entries(runs).map(([key, rs]) => [key, {
    medianMs: median(rs.map(r => r.elapsedMs)), medianVisits: median(rs.map(r => r.visits)),
    medianSlices: median(rs.map(r => r.slices)),
    maxSliceMs: Math.max(...rs.map(r => r.maxSliceMs)),
    seedVisits: rs.at(-1).seedVisits, floodVisits: rs.at(-1).floodVisits,
    lazyReads: rs.at(-1).lazyReads, initializedCells: rs.at(-1).initializedCells,
  }]));
}

// Match the observed native seed/version/position and 121 resident columns.
// Full field work and unchanged 2ms/scan/visit/upload quotas are exercised,
// but calls run back-to-back and CPU tests acknowledge uploads, not GL.
const position = { x: 277.5, y: 54.62, z: 446.5 }, radius = 4;
const world = new World("cedar-valley", { generatorVersion: 3, useWorker: false });
await world.ensureArea(position, 5);
assert.equal(world.chunks.size, 121);
const revisions = [...world.chunks].map(([key, c]) => [key, c.revision]);
function fieldRun(Solver) {
  const field = new BlockLightField();
  field.solver = new Solver();
  const totals = { updates: 0, visits: 0, scans: 0, seedVisits: 0, floodVisits: 0,
    outputVisits: 0, resetVisits: 0, lazyReads: 0, initializedCells: 0,
    maxVisits: 0, maxScans: 0, maxUpdateMs: 0 };
  const t = performance.now();
  do {
    field.update(world, position, radius);
    const s = field.stats;
    for (const key of ["visits", "scans", "seedVisits", "floodVisits", "outputVisits",
      "resetVisits", "lazyReads", "initializedCells"]) totals[key] += s[key];
    totals.updates++;
    totals.maxVisits = Math.max(totals.maxVisits, s.visits);
    totals.maxScans = Math.max(totals.maxScans, s.scans);
    totals.maxUpdateMs = Math.max(totals.maxUpdateMs, s.updateMs);
    assert.ok(s.visits <= 32768 && s.scans <= 8192 && s.completed <= 8 && s.uploadLayers <= 2);
    field.texture.clearLayerUpdates();
    assert.ok(totals.updates < 3000 && performance.now() - t < 30000, "bounded native field experiment");
  } while (field.pending);
  totals.elapsedMs = performance.now() - t;
  assert.ok(field.valid.every(v => v === 127 || v === 255), "all 486 pages verified");
  const result = { ...totals, resources: field.resources(),
    outputHash: createHash("sha256").update(field.valid).update(field.data).digest("hex") };
  field.dispose();
  return result;
}
const native = { dense: [], lazy: [] };
try {
  for (let i = 0; i < 4; i++) {
    const pair = {};
    for (const [key, Solver] of i % 2
      ? [["lazy", BlockLightSolver], ["dense", DenseSolver]]
      : [["dense", DenseSolver], ["lazy", BlockLightSolver]]) {
      pair[key] = fieldRun(Solver);
      if (i) native[key].push(pair[key]); // First pair warms native paths.
    }
    assert.equal(pair.lazy.outputHash, pair.dense.outputHash);
    assert.deepEqual(pair.lazy.resources, pair.dense.resources, "same retained resource accounting");
    assert.deepEqual([...world.chunks].map(([key, c]) => [key, c.revision]), revisions);
  }
} finally { world.dispose(); }
const fingerprint = {};
for (const file of ["../src/block-light-solver.js", "../src/block-light-field.js", "./block-light-dense-reference.js"]) {
  fingerprint[file] = createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex");
}
const report = {
  methodology: "CPU-only, sequential alternating paired runs; 8 solver warmups + 12 measured pairs per fixture; native first pair warmup + 3 measured pairs. Exact dense-reference outputs checked. No GL/frame cadence, no acceptance or FPS claim.",
  limits: BLOCK_LIGHT_LIMITS, sourceSha256: fingerprint, solverScratchBytes: new BlockLightSolver().resources(),
  cases: results, native, elapsedMs: performance.now() - start,
  cpuBefore, cpuAfter: await readFile("/proc/stat", "utf8"),
  cpuPressureAfter: await readFile("/proc/pressure/cpu", "utf8"),
};
await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ cases: results, native: Object.fromEntries(Object.entries(native).map(([k, rs]) =>
  [k, { medianMs: median(rs.map(r => r.elapsedMs)), updates: rs.map(r => r.updates),
    visits: rs.map(r => r.visits), seedVisits: rs.map(r => r.seedVisits),
    resetVisits: rs.map(r => r.resetVisits), outputHash: rs[0].outputHash }])),
  report: values.output }, null, 2));
