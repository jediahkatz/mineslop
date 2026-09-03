// Opt-in CPU geometry/work probe on the entire native 71-point path. This is
// scripted sampling, not a GUI walk. No cell edits, player lights or save writes.
// MINESLOP_CAVE_SOURCE=/path/to/checkpoint node test/native-cave-daylight.probe.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.MINESLOP_CAVE_SOURCE ?? new URL("..", import.meta.url).pathname);
const load = (name) => import(pathToFileURL(resolve(root, "src", name)));
const [{ World }, { SkyColumns }, { CaveDaylight }, { sampleDaylightAt }, { raycast }] =
  await Promise.all(["world.js", "sky-columns.js", "cave-daylight.js", "daylight-material.js", "raycast.js"].map(load));
const world = new World("cedar-valley", { useWorker: false, generatorVersion: 3 });
const feature = world.generator.getCaveEntrances(0, 8)[0];
const points = feature.path.map((point) => ({ x: point.x + 0.5, y: point.low + 1.62, z: point.z + 0.5 }));
assert.equal(points.length, 71);
const bounds = {
  minX: Math.min(...points.map((p) => Math.floor(p.x / 16))) - 4,
  maxX: Math.max(...points.map((p) => Math.floor(p.x / 16))) + 4,
  minZ: Math.min(...points.map((p) => Math.floor(p.z / 16))) - 4,
  maxZ: Math.max(...points.map((p) => Math.floor(p.z / 16))) + 4,
};
// Establish the normal retention focus before admitting the remainder of the
// route; otherwise native World correctly evicts far-away setup columns.
await world.ensureArea(points[Math.floor(points.length / 2)], 4);
for (let z = bounds.minZ; z <= bounds.maxZ; z++)
  for (let x = bounds.minX; x <= bounds.maxX; x++) world._generateSync(x, z);
const signature = () => {
  const hash = createHash("sha256");
  for (const [key, chunk] of world.chunks) {
    hash.update(`${key}:${chunk.revision}:${chunk.incarnation}:`);
    hash.update(new Uint8Array(chunk.blocks.buffer, chunk.blocks.byteOffset, chunk.blocks.byteLength));
  }
  return hash.digest("hex");
};
const before = signature();
let berries = 0;
for (const chunk of world.chunks.values())
  for (const id of chunk.blocks) if (id === 104) berries++;
const session = () => {
  const columns = new SkyColumns(), daylight = new CaveDaylight(columns);
  return {
    columns, daylight,
    sample(point, forward = { x: 0, y: -0.18, z: -1 }) {
      const totals = {}, peak = {}, fieldTicksMs = [];
      let frames = 0;
      const started = performance.now();
      do {
        const tickStarted = performance.now();
        columns.begin(world);
        columns.updateField(point, 3);
        fieldTicksMs.push(performance.now() - tickStarted);
        for (const [name, value] of Object.entries(columns.stats)) {
          totals[name] = (totals[name] ?? 0) + value;
          peak[name] = Math.max(peak[name] ?? 0, value);
        }
        assert.ok(++frames <= 41);
      } while (columns.surfaceLight?.pending);
      const access = daylight.sample(world, point, forward);
      return { position: point, access, frames, totals, peak, fieldTicksMs, ms: performance.now() - started };
    },
  };
};
const near = { x: 60.517123807569995, y: 27.62, z: 951.1006377353367 };
const selection = session();
selection.sample(near, { x: 0, y: 0.25, z: 1 });
const faces = [];
for (const slope of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45])
  for (const sideways of [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]) {
    const hit = raycast(world, near, { x: sideways, y: slope, z: 1 }, 64, { channel: "occlusion" });
    if (!hit || hit.point.z < 956 || hit.point.z > 968) continue;
    const point = Object.fromEntries(["x", "y", "z"].map((axis) => [axis, hit.point[axis] + hit.normal[axis] * 0.02]));
    if (selection.columns.open(point)) continue;
    if (faces.some((face) => Math.hypot(face.point.x - point.x, face.point.y - point.y, face.point.z - point.z) < 0.5)) continue;
    faces.push({ point, block: [hit.x, hit.y, hit.z], normal: hit.normal });
  }
selection.columns.dispose();
faces.sort((a, b) => b.point.z - a.point.z || a.point.x - b.point.x);
faces.length = Math.min(6, faces.length);
assert.ok(faces.length >= 3, "inspect native entrance-adjacent faces, not just the bright aperture");

const run = session(), samples = [], totals = {}, peak = {};
const take = (position, forward) => {
  const state = run.sample(position, forward);
  assert.equal(state.access.known, true);
  assert.ok(state.access.rays <= 29);
  // Frozen pre-fix checkpoints used a camera-source argument. Adapt only this
  // comparative probe; production surface lighting has no camera-source input.
  state.masks = faces.map((face) => run.columns.surfaceLight
    ? sampleDaylightAt(run.columns, face.point)
    : sampleDaylightAt(run.columns, state.access.sources, face.point));
  for (const [name, value] of Object.entries(state.totals)) totals[name] = (totals[name] ?? 0) + value;
  for (const [name, value] of Object.entries(state.peak)) peak[name] = Math.max(peak[name] ?? 0, value);
  samples.push(state);
  return state;
};
for (const point of points) take(point);
const cutoff = [
  take(near, { x: 0, y: 0.25, z: 1 }),
  take({ x: 60.52663703399782, y: 27.62, z: 948.9421586994134 }, { x: 0, y: 0.25, z: 1 }),
  take({ x: 60.66933543041449, y: 17.62, z: 916.5649731605562 }, { x: 0, y: 0.25, z: 1 }),
];
const fieldVersion = run.columns.surfaceLight?.texture.version;
const turns = [];
for (let i = 0; i < 64; i++) {
  const state = take(points.at(-1), { x: Math.sin(i), y: Math.sin(i * 0.3) * 0.4, z: Math.cos(i) });
  if (run.columns.surfaceLight) {
    assert.equal(state.totals.surfaceBuilds, 0);
    assert.equal(state.totals.surfaceCellReads, 0);
    assert.equal(state.totals.surfaceUploadBytes, 0);
    assert.equal(run.columns.surfaceLight.texture.version, fieldVersion);
  }
  turns.push(state.ms);
}
const measure = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) };
};
const result = {
  method: "CPU only; all 71 native v3 path points, followed by exact GUI cutoff positions and 64 fixed-position turns",
  root, seed: world.seed, generatorVersion: world.generatorVersion, bounds,
  nativePathPoints: points.length, pathHorizontalDistance: Math.hypot(points[0].x - points.at(-1).x, points[0].z - points.at(-1).z),
  residentColumns: world.chunks.size, naturalGlowBerries: berries, edits: world.edits.size,
  faces, cutoff, totals, peak,
  pathUpdateMs: measure(samples.slice(0, 71).map((state) => state.ms)), torqueUpdateMs: measure(turns),
  fieldTickMs: measure(samples.flatMap((state) => state.fieldTicksMs)),
  ceilingBytes: run.columns.data.byteLength, surfaceResources: run.columns.surfaceLight?.resources(),
  geometryHashBefore: before, geometryHashAfter: signature(), samples,
};
assert.equal(result.geometryHashAfter, before);
assert.equal(result.edits, 0);
if (run.columns.surfaceLight) {
  assert.ok(peak.surfaceBuilds <= 2);
  assert.deepEqual(cutoff[1].masks, cutoff[0].masks);
  assert.deepEqual(cutoff[2].masks, cutoff[0].masks);
  assert.ok(cutoff[0].masks.every((mask) => mask.direct === 0 && mask.ambient > 0.2));
  for (const [index, state] of samples.entries())
    assert.deepEqual(state.masks, cutoff[0].masks, `fixed native entrance faces at measured state ${index}`);
}
if (process.env.MINESLOP_CAVE_REPORT)
  writeFileSync(process.env.MINESLOP_CAVE_REPORT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, samples: `${samples.length} measured states in MINESLOP_CAVE_REPORT` }, null, 2));
run.columns.dispose();
world.dispose();
