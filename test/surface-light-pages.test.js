import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceLightSolver } from "../src/surface-light-solver.js";
import { lightWorkBudget } from "../src/light-work-budget.js";
import { SkyColumns } from "../src/sky-columns.js";
import { BLOCK } from "../src/blocks.js";
import { lightWorld } from "./block-light-fixture.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { flushColumns } from "./light-renderer-fixture.js";

// Independent dense relaxation reference: no production queue, seeding,
// phase machine or publication code. Repeated Bellman sweeps converge for
// all paths shorter than sixteen (the production light radius).
function reference(sources, minY, height) {
  const n = 48 ** 2 * height, values = new Uint8Array(n), blocked = new Uint8Array(n);
  for (let y = 0; y < height; y++)
    for (let z = 0; z < 48; z++)
      for (let x = 0; x < 48; x++) {
        const i = y * 2304 + z * 48 + x, column = (z % 16) * 16 + x % 16;
        const s = sources[Math.floor(z / 16) * 3 + Math.floor(x / 16)], at = y * 256 + column;
        if (!s) blocked[i] = 1;
        else if (y + minY >= s.heights[column]) values[i] = 16;
        else if (s.blocked[at >>> 5] & (1 << (at & 31))) blocked[i] = 1;
      }
  for (let sweep = 0; sweep < 15; sweep++) {
    const next = values.slice();
    for (let i = 0; i < n; i++) {
      if (blocked[i] || values[i] === 16) continue;
      const x = i % 48, z = Math.floor(i / 48) % 48;
      const neighbors = [x ? i - 1 : -1, x < 47 ? i + 1 : -1, z ? i - 48 : -1,
        z < 47 ? i + 48 : -1, i >= 2304 ? i - 2304 : -1, i + 2304 < n ? i + 2304 : -1];
      next[i] = Math.max(values[i], ...neighbors.map((j) => j < 0 ? 0 : Math.max(0, values[j] - 1)));
    }
    values.set(next);
  }
  return values;
}

test("resumable surface R8 pages exactly preserve 0..16, negative height and outer apron", () => {
  const minY = -16, height = 32;
  const sources = Array.from({ length: 9 }, () => ({ heights: new Float32Array(256).fill(minY + 12),
    depth: 12, blocked: new Uint32Array(12 * 256 / 32) }));
  // A roofed tunnel opens into direct sky on one side, with blocked roof and
  // floor; all attenuated levels appear in the 18-wide receiver/apron.
  sources[3].heights.fill(minY);
  for (const source of sources)
    for (let i = 0; i < 256; i++) {
      source.blocked[i >>> 5] |= 1 << (i & 31);
      const at = 11 * 256 + i;
      source.blocked[at >>> 5] |= 1 << (at & 31);
    }
  const expected = reference(sources, minY, height), solver = new SurfaceLightSolver(height);
  solver.begin(sources, minY, height);
  const stats = { surfaceVoxelVisits: 0, surfaceFloodVisits: 0 };
  let slices = 0;
  while (!solver.step(lightWorkBudget({ visits: 113, now: () => 0 }), stats)) assert.ok(++slices < 2000);
  const levels = new Set();
  for (let y = 0; y < height; y++)
    for (let z = 0; z < 18; z++)
      for (let x = 0; x < 18; x++) {
        const page = solver.pages[Math.floor(y / 16)];
        const value = typeof page === "number" ? page : page[(y % 16) * 324 + z * 18 + x];
        assert.equal(value, expected[y * 2304 + (z + 15) * 48 + x + 15]);
        levels.add(value);
      }
  assert.deepEqual([...levels].sort((a, b) => a - b), Array.from({ length: 17 }, (_, i) => i));
});

test("work clocks stop at explicit cells/visits and 32-work deadline checkpoints", () => {
  let clock = 0;
  const budget = lightWorkBudget({ now: () => clock });
  for (let i = 0; i < 32; i++) { assert.ok(budget.take()); clock += 0.125; }
  assert.equal(budget.take(), false);
  assert.equal(budget.cells, 32);
  const counted = lightWorkBudget({ cells: 17, visits: 29, now: () => 0 });
  while (counted.take()) {}
  while (counted.take("visits")) {}
  assert.equal(counted.cells, 17);
  assert.equal(counted.visits, 29);
});

test("incremental ceilings and surface topology settle real geometry without synchronous column scans", (t) => {
  t.mock.method(performance, "now", () => 0);
  const coords = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) coords.push([x, z]);
  const world = lightWorld({ columns: coords }), columns = new SkyColumns(0);
  t.after(() => columns.dispose());
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.put(x, 11, z, BLOCK.STONE);
  const point = { x: 1.5, y: 10.5, z: 8.5 }, observer = { x: 8, y: 8, z: 8 };
  let frames = 0;
  do {
    columns.begin(world); columns.updateField(observer, 0);
    flushColumns(columns);
    assert.ok(columns.stats.cellReads <= 8192);
    assert.ok(columns.stats.surfaceCellReads <= 8192);
    assert.ok(columns.stats.surfaceVoxelVisits + columns.stats.surfaceFloodVisits + columns.stats.surfaceOutputVisits <= 32768);
    assert.ok(++frames < 1500, `pending ${columns.surfaceLight.pending} sky ${columns.requests.size}`);
  } while (columns.surfaceLight.pending || columns.requests.size || columns.skyUploads.size || columns.surfaceLight.store.queue.size);
  assert.ok(frames > 1);
  const mask = sampleDaylightAt(columns, point);
  assert.equal(mask.direct, 0);
  assert.ok(mask.ambient > 0.8);
  assert.equal(columns.surfaceLight.resources().certifiedChunks, 1);
  const entry = columns.surfaceLight.cache.get("0,0");
  columns.begin(world); columns.updateField(observer, 0);
  assert.equal(columns.surfaceLight.cache.get("0,0"), entry);
  assert.equal(columns.stats.cellReads + columns.stats.surfaceCellReads + columns.stats.surfaceVoxelVisits, 0);
  world.put(1, 10, 8, BLOCK.STONE);
  columns.begin(world); columns.updateField(observer, 0);
  assert.equal(columns.surfaceLight.store.pages.size, 0, "closure invalidates before resumable re-verification");
});
