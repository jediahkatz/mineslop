import test from "node:test";
import assert from "node:assert/strict";
import { bufferUploadBytes, DEFAULT_CONSTRAINTS, evaluateRun, ringCensus, visibilityAt } from "./oracles.js";
import { classifySurface } from "./surface-oracle.js";

const sample = (ms = 1000) => ({
  ms, native: { fullRadius: 12, fullDetailBlocks: 192,
    rings: [{ ring: 0, physical: 1, fullFresh: 1, required: 1 }] },
  fog: { near: 200, far: 300 },
  resources: { includesDistantBacking: true, gpuBytes: 1, combinedCpuBytes: 1, stagingBytes: 1, drawCalls: 1 },
  mask: { checks: 4, expectedSections: 1, mismatches: 0 },
  hidden: false, contextLost: false,
  surfaces: [{ status: "native-match" }],
  rays: [64, 128, 192].flatMap(blocks => Array.from({ length: 4 }, () => ({ blocks, fallback: true }))),
});
const passing = () => ({
  samples: [sample()], frameIntervals: [16, 16, 16], copy: { maxBytes: 1 },
  edit: { visibleMs: 100, farStillLoading: true }, errors: [], controlErrors: [], provenanceStable: true,
  provenance: { servedVerified: true }, visibilityEvents: [], contextLossEvents: [],
  pixelControl: { status: "pass" }, lifecycle: { status: "pass" }, machine: { softwareRenderer: true },
});

test("empty, detached and missing telemetry never produce success", () => {
  assert.equal(evaluateRun({}).hardStatus, "fail");
  const run = passing();
  run.samples[0].native.rings[0].physical = 0;
  assert.equal(evaluateRun(run).hard[0].status, "fail");
  run.samples = [];
  assert.equal(evaluateRun(run).usefulMs, null);
  assert.ok(evaluateRun(run).thresholds.every(t => t.fullNativeMs === null));
});

test("complete synthetic control passes and every deliberate hard failure rejects", () => {
  assert.equal(evaluateRun(passing()).hardStatus, "pass");
  const faults = [
    r => { r.samples[0].mask.mismatches = 1; },
    r => { r.samples[0].resources.gpuBytes = DEFAULT_CONSTRAINTS.maxGpuBytes + 1; },
    r => { r.samples[0].resources.combinedCpuBytes = DEFAULT_CONSTRAINTS.maxCpuBytes + 1; },
    r => { r.samples[0].resources.stagingBytes = DEFAULT_CONSTRAINTS.maxStagingBytes + 1; },
    r => { r.samples[0].resources.drawCalls = DEFAULT_CONSTRAINTS.maxDrawCalls + 1; },
    r => { r.copy.maxBytes = DEFAULT_CONSTRAINTS.maxCopyBytesPerSlice + 1; },
    r => { r.edit.visibleMs = DEFAULT_CONSTRAINTS.correctnessProofMs + 1; },
    r => { r.errors.push("context lost"); },
    r => { r.pixelControl.status = "fail"; },
    r => { r.lifecycle.status = "fail"; },
    r => { r.samples[0].surfaces.push({ status: "missing-surface" }); },
    r => { r.samples[0].surfaces.push({ status: "duplicate-ownership" }); },
    r => { r.provenanceStable = false; },
  ];
  for (const fault of faults) {
    const run = passing(); fault(run);
    assert.equal(evaluateRun(run).hardStatus, "fail", fault.toString());
  }
});

test("unknown visual and lifecycle evidence prevents qualification", () => {
  const run = passing();
  delete run.pixelControl; delete run.lifecycle;
  assert.equal(evaluateRun(run).hardStatus, "incomplete");
  assert.match(evaluateRun(run).hardwareQualification, /diagnostic-only/);
});

test("R12 means every ring, not one distant loaded/nonempty column", () => {
  const columns = [];
  for (let z = -12; z <= 12; z++) for (let x = -12; x <= 12; x++)
    columns.push({ key: `${x},${z}`, ring: Math.max(Math.abs(x), Math.abs(z)), physical: true, fullFresh: true });
  assert.equal(ringCensus(columns, 12).fullDetailBlocks, 192);
  columns.find(c => c.key === "3,2").fullFresh = false;
  assert.equal(ringCensus(columns, 12).fullRadius, 2);
  assert.equal(ringCensus([{ key: "12,0", ring: 12, physical: true }], 12).fullRadius, -1);
  assert.throws(() => ringCensus([columns[0], columns[0]], 12), /Duplicate/);
});

test("fog shader depth and native/fallback horizons remain independent", () => {
  assert.equal(visibilityAt(4, 8, 64), 0);
  assert.equal(visibilityAt(4, 8, 6), 0.5);
  assert.equal(visibilityAt(4, 8, 4), 1);
  assert.equal(visibilityAt(8, 8, 4), null);
  const run = passing();
  run.samples[0].fog = { near: 4, far: 8 };
  const result = evaluateRun(run);
  assert.equal(result.thresholds[0].fullNativeMs, 1000);
  assert.equal(result.thresholds[0].sampledFallbackMs, null);
  assert.equal(result.thresholds[0].fogVisibilityMs, null);
  run.samples[0].fog = { near: 200, far: 300 };
  run.samples[0].rays = [];
  assert.equal(evaluateRun(run).thresholds[0].sampledFallbackMs, null);
});

test("frame target is strict, configurable and never silently software-qualified", () => {
  const run = passing(); run.frameIntervals = [20, 21, 22];
  assert.equal(evaluateRun(run).targets[1].status, "fail");
  assert.equal(evaluateRun(run, { ...DEFAULT_CONSTRAINTS, frameP95Ms: 23 }).targets[1].status, "pass");
  run.frameIntervals = [];
  assert.equal(evaluateRun(run).targets[1].status, "unavailable");
});

test("surface classifier rejects missing/duplicate surfaces and separates fog/occlusion", () => {
  const base = { expectedDistance: 5, nativeDistances: [5], fallbackDistances: [], transmission: 1, known: true };
  assert.equal(classifySurface(base), "native-match");
  assert.equal(classifySurface({ ...base, fallbackDistances: [5] }), "duplicate-ownership");
  assert.equal(classifySurface({ ...base, nativeDistances: [] }), "missing-surface");
  assert.equal(classifySurface({ ...base, nativeDistances: [3] }), "physical-occlusion");
  assert.equal(classifySurface({ ...base, nativeDistances: [], fallbackDistances: [5.5] }), "fallback-approximation");
  assert.equal(classifySurface({ ...base, known: false }), "unknown-residency");
  assert.equal(classifySurface({ ...base, transmission: 0 }), "fog-hidden");
  const run = passing();
  run.samples[0].surfaces = [{ status: "fog-hidden" }];
  assert.equal(evaluateRun(run).hardStatus, "incomplete");
  run.samples[0].mask.checks = 0;
  assert.equal(evaluateRun(run).hard[1].status, "unavailable");
});

test("GL buffer upload counter respects element offsets, lengths and allocation-only calls", () => {
  const values = new Float32Array(8);
  assert.equal(bufferUploadBytes(values), 32);
  assert.equal(bufferUploadBytes(values, 2), 24);
  assert.equal(bufferUploadBytes(values, 2, 3), 12);
  assert.equal(bufferUploadBytes(4096), 0);
  assert.equal(bufferUploadBytes(new DataView(new ArrayBuffer(8)), 2), 6);
});

test("a seed name does not certify a dense river scene without native water", () => {
  const run = passing();
  run.scene = "river"; run.profile = { waterCells: 0, leafCells: 7501 };
  assert.equal(evaluateRun(run).hardStatus, "fail");
  run.profile.waterCells = 1000;
  assert.equal(evaluateRun(run).hardStatus, "pass");
});
