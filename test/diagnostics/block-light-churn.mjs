import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { churnWorld } from "../block-light-churn-fixture.js";
import { BLOCK } from "../../src/blocks.js";

const root = process.env.BLOCK_LIGHT_SOURCE_ROOT;
const { BlockLightField } = await import(root
  ? pathToFileURL(resolve(root, "src/block-light-field.js")).href : "../../src/block-light-field.js");
const versions = (process.env.BLOCK_LIGHT_VERSIONS ?? "4").split(",").map(Number);
const output = process.env.BLOCK_LIGHT_CHURN_OUTPUT;
const events = process.env.BLOCK_LIGHT_MUTATION_EVENTS === "1";
const radius = Number(process.env.BLOCK_LIGHT_RADIUS ?? 1);
const coldPeriod = Number(process.env.BLOCK_LIGHT_CHURN_PERIOD ?? 5);
const latencyOnly = process.env.BLOCK_LIGHT_CHURN_CASES === "latency";
assert.ok(Number.isInteger(radius) && radius >= 1 && radius <= 4);
assert.ok(Number.isInteger(coldPeriod) && coldPeriod >= 1);
const report = { complete: false, sourceRoot: root ?? "development",
  radius, loadRadius: radius === 1 ? 2 : radius + 2,
  eventWiring: events ? "Explicit fixture forwarding; production host integration still required" : "No event forwarding",
  kind: "Native World transaction CPU radiance trace; not GPU pixels", cases: [] };
let fixture, field;
const immediate = () => new Promise((done) => setImmediate(done));

function create(version, torch = true) {
  fixture = churnWorld(version, torch, "overworld", report.loadRadius); field = new BlockLightField();
  if (events) fixture.observe((world, event) => field.observeMutation(world, event));
}

async function frame(stage, position = fixture.position) {
  const cpu = process.cpuUsage();
  field.update(fixture.world, position, radius);
  const used = process.cpuUsage(cpu);
  const stats = { ...field.stats };
  assert.ok(stats.scans <= 8192 && stats.visits <= 32768);
  assert.ok(field.texture.layerUpdates.size <= 2);
  const row = { index: stage.frames.length + 1, rgb: fixture.points.map((p) => field.sample(p)),
    ...fixture.metrics(), pending: field.pending,
    scans: stats.scans, visits: stats.visits, uploads: field.texture.layerUpdates.size,
    bytes: stats.uploadBytes, ms: stats.updateMs, cpuMs: (used.user + used.system) / 1000,
    mutationCells: stats.mutationCells ?? 0, benignCells: stats.benignCells ?? 0, staleJobs: stats.staleJobs };
  stage.frames.push(row);
  // Model exactly one normal update/upload acknowledgment per frame. Never
  // drain the solver multiple times inside a simulated frame.
  field.texture.clearLayerUpdates();
  await immediate();
  return row;
}

async function untilLit(stage, limit = 3000) {
  for (let i = 0; i < limit; i++) {
    const row = await frame(stage);
    if (row.rgb.every((rgb) => rgb[0] > 0)) return;
  }
  throw new Error(`No first light in ${stage.name}`);
}

async function settle(stage) {
  for (let i = 0; field.pending && i < 6000; i++) await frame(stage);
  assert.equal(field.pending, 0);
}

function stage(name) { const result = { name, frames: [] }; report.cases.at(-1).stages.push(result); return result; }
function summary(s) {
  const initial = s.frames[0]?.rgb ?? [];
  return { name: s.name, updates: s.frames.length,
    firstLit: [0, 1, 2].map((point) => s.frames.find((f) => f.rgb[point][0] > 0)?.index ?? null),
    darkUpdates: [0, 1, 2].map((point) => s.frames.filter((f) => f.rgb[point][0] === 0).length),
    rgbChanges: [0, 1, 2].map((point) => s.frames.filter((f, i) => i &&
      JSON.stringify(f.rgb[point]) !== JSON.stringify(s.frames[i - 1].rgb[point])).length),
    initial, final: s.frames.at(-1)?.rgb,
    scans: s.frames.reduce((n, f) => n + f.scans, 0), visits: s.frames.reduce((n, f) => n + f.visits, 0),
    uploads: s.frames.reduce((n, f) => n + f.uploads, 0), bytes: s.frames.reduce((n, f) => n + f.bytes, 0),
    maxScans: Math.max(0, ...s.frames.map((f) => f.scans)), maxVisits: Math.max(0, ...s.frames.map((f) => f.visits)),
    maxUploads: Math.max(0, ...s.frames.map((f) => f.uploads)),
    mutationCells: s.frames.reduce((n, f) => n + f.mutationCells, 0), benignCells: s.frames.reduce((n, f) => n + f.benignCells, 0),
    maxMutationCells: Math.max(0, ...s.frames.map((f) => f.mutationCells)),
    p95Ms: s.frames.map((f) => f.ms).sort((a, b) => a - b)[Math.floor(s.frames.length * 0.95)],
    p95CpuMs: s.frames.map((f) => f.cpuMs).sort((a, b) => a - b)[Math.floor(s.frames.length * 0.95)],
    staleJobs: s.frames.reduce((n, f) => n + f.staleJobs, 0) };
}

try {
  for (const version of versions) {
    report.cases.push({ version, stages: [] });
    create(version);
    const loaded = stage("load_first_light");
    await untilLit(loaded);
    if (latencyOnly) {
      field.dispose(); fixture.dispose();
      create(version, false);
      await frame(stage("source_free_initial")); await settle(stage("source_free_remaining"));
      assert.equal(fixture.world.set(13, 8, 2, BLOCK.TORCH), true);
      await untilLit(stage("placement_first_light"));
      field.dispose(); fixture.dispose();
      continue;
    }
    await settle(stage("load_remaining"));
    const expected = fixture.points.map((p) => field.sample(p));
    // 15 frames at nominal 60 Hz matches the native 0.25 s fluid tick.
    // Five frames is an additional faster churn stress schedule.
    for (const [kind, period] of [["fluid", 15], ["fluid", 5], ["state", 5], ["both", 5], ["both", 1]]) {
      const churn = stage(`warm_${kind}_every_${period}_frames`);
      for (let i = 0; i < 90; i++) {
        if (i % period === 0) fixture.mutate(i / period, kind);
        await frame(churn);
      }
      const recovery = stage(`recover_${kind}_${period}`);
      await untilLit(recovery); await settle(recovery);
      assert.deepEqual(fixture.points.map((p) => field.sample(p)), expected, "churn changes raw cells but not light semantics");
    }
    const boundary = stage("visible_neighbor_boundary");
    const far = (radius + 1) * 16 + 1;
    for (const x of [15.99, 16.01, far - 1.01, far - 0.99, far])
      await frame(boundary, { ...fixture.position, x });
    assert.deepEqual(fixture.points.slice(1).map((p) => field.sample(p)), expected.slice(1));
    const returning = stage("visible_neighbor_return");
    for (const x of [far - 1.01, 16.01, 15.99, 8])
      await frame(returning, { ...fixture.position, x });
    fixture.world.set(13, 8, 2, BLOCK.AIR);
    const removal = stage("removal_immediate");
    assert.ok((await frame(removal, { ...fixture.position, x: far })).rgb.every((rgb) => rgb[0] === 0));
    field.dispose(); fixture.dispose();

    create(version, false);
    await frame(stage("source_free_initial")); await settle(stage("source_free_remaining"));
    assert.equal(fixture.world.set(13, 8, 2, BLOCK.TORCH), true);
    await untilLit(stage("placement_first_light"));
    field.dispose(); fixture.dispose();

    create(version);
    const cold = stage(`cold_both_every_${coldPeriod}_frames`);
    for (let i = 0; i < 120; i++) {
      if (i % coldPeriod === 0) fixture.mutate(i / coldPeriod);
      await frame(cold);
    }
    await untilLit(stage("cold_recovery"));
    field.dispose(); fixture.dispose();
  }
  report.complete = true;
} finally {
  field?.dispose(); fixture?.dispose();
  const compact = { ...report, cases: report.cases.map((c) => ({ version: c.version, stages: c.stages.map(summary) })) };
  console.log(JSON.stringify(compact, null, 2));
  if (output) {
    mkdirSync(output, { recursive: true });
    // Compact per-frame data avoids oversized artifacts; the separate
    // summary/readout remain human-readable.
    writeFileSync(resolve(output, "trace.json"), JSON.stringify(report));
    writeFileSync(resolve(output, "summary.json"), JSON.stringify(compact, null, 2));
    const lines = [`complete=${report.complete}; radius=${radius}; loaded-radius=${report.loadRadius}`,
      report.kind, report.eventWiring, `source=${report.sourceRoot}`];
    for (const c of compact.cases) for (const s of c.stages) {
      if (/remaining|recover/.test(s.name)) continue;
      lines.push(`v${c.version} ${s.name}: updates=${s.updates} first-lit=${s.firstLit.join("/")} dark=${s.darkUpdates.join("/")} scans=${s.scans} visits=${s.visits} uploads=${s.uploads} bytes=${s.bytes} benign-cells=${s.benignCells} stale=${s.staleJobs} p95-ms=${s.p95Ms.toFixed(3)}`);
    }
    writeFileSync(resolve(output, "readout.log"), `${lines.join("\n")}\n`);
  }
}
