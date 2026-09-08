import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { backingSets, combinedBackingResources } from "./resources.js";
import { paidTransaction, publicationObserved, farLoadingWitness } from "./edit-observation.js";
import { recoveryGate } from "./recovery.js";
import { evaluateRun, DEFAULT_CONSTRAINTS } from "./oracles.js";
import { timingQualified, linkCaptures, exitCodeFor } from "./acceptance.js";
import { compareTrials } from "./comparison.js";
import { correctnessFixture, performanceFixture, linkedFixture, pixelFixture } from "./audit-fixtures.js";
import { digest, sealManifest, fetchVerifiedBundle } from "./provenance.mjs";
import { RenderScaleController } from "../../src/render-scale.js";
import { pinRaster, fixedRasterEvidence } from "./raster.js";

function mesh(array) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

test("fixed real-controller configuration prevents observer-induced raster changes", () => {
  let ratio = 1;
  const renderer = { ratioCap: 1, scaleController: new RenderScaleController({ width: 800, height: 500 }),
    renderer: { getPixelRatio: () => ratio, setPixelRatio: value => { ratio = value; } } };
  pinRaster(renderer);
  for (let i = 0; i < 200; i++) assert.equal(renderer.scaleController.observe(200), null);
  assert.equal(renderer.scaleController.pixelRatio, 1);
  const run = performanceFixture();
  assert.equal(fixedRasterEvidence(run), true);
  run.samples[0].raster.width = 680;
  assert.equal(timingQualified(run, DEFAULT_CONSTRAINTS), false);
  run.samples[0].raster.width = 800; run.machine.drawingBuffer = [640, 400];
  assert.equal(timingQualified(run, DEFAULT_CONSTRAINTS), false);
});

test("native/LOD/vegetation buffers alias by allocation identity; live and pending are both charged", () => {
  const shared = new Float32Array(12), native = mesh(shared);
  const renderer = { chunks: new Map([["0,0", native]]), distant: {
    _active: { group: mesh(shared.subarray(0, 9)) },
    _vegetation: { layer: { group: mesh(new Float32Array(30)) } },
    _job: { positions: new Float32Array(100) },
    _vegetationJob: { job: { _indices: new Uint16Array(20), _positions: [1, 2, 3] } },
  } };
  const ledger = { gpuBytes: 48, combinedCpuBytes: 48, stagingBytes: 0, drawCalls: 1 };
  const value = combinedBackingResources(renderer, ledger);
  assert.equal(value.gpuBytes, 48 + 36 + 120, "distinct attribute identities allocate distinct GPU buffers");
  assert.equal(value.combinedCpuBytes, 48 + 120 + 400 + 40 + 24);
  assert.equal(value.stagingBytes, 400 + 40 + 24);
  assert.equal(value.independentBackingBytes, 48 + 120 + 400 + 40);
  renderer.distant._job.alias = renderer.distant._vegetationJob.job._indices;
  assert.deepEqual(combinedBackingResources(renderer, ledger), value);
  assert.equal(backingSets([native, native]).buffers.size, 1);
});

test("LOD seam height textures, seams and vegetation instance buffers are not omitted", () => {
  const heights = new Float32Array(64);
  const texture = new THREE.DataTexture(heights, 8, 8, THREE.RedFormat, THREE.FloatType);
  const geometry = new THREE.BufferGeometry();
  const instances = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 2);
  const renderer = { distant: {
    _active: { data: { seamHeights: heights }, heightTexture: texture },
    _seams: { borrowedHeightTexture: texture, group: mesh(new Float32Array(12)) },
    _vegetation: { group: instances },
  } };
  const value = combinedBackingResources(renderer, {});
  assert.equal(value.combinedCpuBytes, 256 + 48 + 128);
  assert.equal(value.gpuBytes, 256 + 48 + 128);
});

test("deliberately overflowing only distant geometry or pending vegetation fails combined budgets", () => {
  const run = correctnessFixture();
  for (const distant of [
    { _active: { group: mesh(new Float32Array(600)) } },
    { _job: { positions: new Uint8Array(2400) } },
    { _vegetationJob: { job: { _positions: Array(300).fill(1) } } },
    { _vegetation: { layer: { group: mesh(new Float32Array(600)) } } },
  ]) {
    run.samples[0].resources = combinedBackingResources({ chunks: new Map(), distant },
      { gpuBytes: 0, combinedCpuBytes: 0, stagingBytes: 0, drawCalls: 0 });
    const evaluation = evaluateRun(run, { ...DEFAULT_CONSTRAINTS, maxCpuBytes: 1024, maxGpuBytes: 1024, maxStagingBytes: 1024 });
    assert.equal(evaluation.hardStatus, "fail");
    assert.ok(evaluation.hard.some(g => /bytes/.test(g.name) && g.status === "fail"));
  }
});

test("native transient admission peaks must be added to resident LOD, not maxed against it", () => {
  const resources = combinedBackingResources({
    meshStats: { peakReservedGpuBytes: 500, peakCombinedCpuBytes: 500, peakStagingBytes: 100 },
    distant: { _active: { group: mesh(new Float32Array(150)) } },
  }, {});
  assert.equal(resources.gpuBytes, 1100);
  assert.equal(resources.combinedCpuBytes, 1100);
  const run = correctnessFixture(); run.samples[0].resources = resources;
  assert.equal(evaluateRun(run, { ...DEFAULT_CONSTRAINTS, maxGpuBytes: 1024 }).hardStatus, "fail");
  const timing = performanceFixture();
  timing.peaks = { gpuBytes: 1, combinedCpuBytes: 1, stagingBytes: 1 };
  assert.equal(evaluateRun(timing).hard.find(g => g.name === "canonical GPU bytes").status, "unavailable");
});

test("timing capture rejects every heavy observer, readback, screenshot and hidden/lost context fixture", () => {
  assert.equal(timingQualified(performanceFixture(), DEFAULT_CONSTRAINTS), true);
  for (const key of ["heavyObserverCalls", "resourceObserverCalls", "editRayCalls", "pixelReadsWhileRecording", "timedScreenshots"]) {
    const run = performanceFixture(); run[key] = 1;
    assert.equal(timingQualified(run, DEFAULT_CONSTRAINTS), false, key);
  }
  for (const mutate of [
    r => { r.measurementVersion = 2; },
    r => { r.timings.observer = [63.3, 72.6]; },
    r => { r.timings.editObserver = [1.1]; },
    r => { r.samples[0].hidden = true; },
    r => { r.samples[0].contextLost = true; },
    r => { r.visibilityEvents = [1]; },
    r => { r.contextLossEvents = [1]; },
    r => { r.edit.publicationMs = null; },
    r => { r.edit.farStillLoading = false; },
  ]) {
    const run = performanceFixture(); mutate(run);
    assert.equal(timingQualified(run, DEFAULT_CONSTRAINTS), false, mutate.toString());
  }
});

test("zero mask ownership is unavailable; stale bits when ownership disappears still fail", () => {
  const run = correctnessFixture(); run.samples[0].mask.expectedSections = 0;
  assert.equal(evaluateRun(run).hardStatus, "incomplete");
  run.samples[0].mask.mismatches = 1;
  assert.equal(evaluateRun(run).hardStatus, "fail");
  for (const key of ["hidden", "contextLost"]) {
    const run = correctnessFixture(); run.samples[0][key] = true;
    assert.equal(evaluateRun(run).hardStatus, "fail");
  }
});

test("transaction clock includes real prepare and commit, excludes inventory setup, and requires live far witness", () => {
  assert.equal(farLoadingWitness({ requiredAbsent: true }), false, "missing is not necessarily loading");
  assert.equal(farLoadingWitness({ requiredAbsent: true, generationPending: true }), true);
  assert.equal(farLoadingWitness({ requiredAbsent: false, lodPending: true }), false);
  let clock = 123;
  const result = paidTransaction({ now: () => clock, farStillLoading: true,
    prepare: () => { clock += 20; return {}; }, commit: () => { clock += 30; return true; } });
  assert.deepEqual(result, { startedMs: 123, transactionMs: 50, farStillLoading: true });
  assert.throws(() => paidTransaction({ farStillLoading: false }), /far-loading/);
  assert.throws(() => paidTransaction({ now: () => 0, farStillLoading: true, prepare: () => null }), /refused/);
  assert.equal(publicationObserved({ ticket: 2 }, { stamp: { ticket: 2 } }, false, false), true);
  for (const args of [
    [{}, { stamp: {} }, false, false], [{ ticket: 2 }, { stamp: { ticket: 1 } }, false, false],
    [{ ticket: 2 }, { stamp: { ticket: 2 } }, true, false], [{ ticket: 2 }, { stamp: { ticket: 2 } }, false, true],
  ]) assert.equal(publicationObserved(...args), false);
});

test("CPU meshes plus restored context cannot pass a broken GPU republish", () => {
  const pixels = pixelFixture();
  const make = () => ({ sawLost: true, contextRestored: true, recoveryDisposals: 2, retired: true,
    before: { ...pixels }, after: { ...pixels }, errors: [] });
  assert.equal(recoveryGate(make()), true);
  for (const mutate of [
    r => { r.after.changedChannels = 0; }, // claimed pass but GPU geometry never republishes
    r => { r.after.draws = 0; }, r => { r.after.nonzeroChannels = 0; },
    r => { r.after.positiveSurface = false; }, r => { r.after.restoredChannels = 3; },
    r => { r.after.glError = 1282; }, r => { r.after.poseKey = "different-pose"; },
    r => { r.errors.push("Lighting draw barrier unavailable"); },
  ]) { const run = make(); mutate(run); assert.equal(recoveryGate(run), false, mutate.toString()); }
});

test("served manifests and actual downloaded module bytes must match the frozen input", async () => {
  const code = "export const value = 1";
  const manifest = sealManifest({ sourceIdentity: "source", sourceRef: "ref", patchHash: "patch",
    assets: { "assets/main.js": digest(code) } });
  const serve = (m = manifest, bytes = code) => async url =>
    new Response(String(url).endsWith("__benchmark_manifest.json") ? JSON.stringify(m) : bytes);
  const verified = await fetchVerifiedBundle("http://fixture/mineslop/", manifest, serve());
  assert.equal(verified.assets.get("/mineslop/assets/main.js").toString(), code);
  await assert.rejects(fetchVerifiedBundle("http://fixture/mineslop/", manifest, serve(manifest, "wrong code")), /asset hash mismatch/);
  const other = sealManifest({ sourceIdentity: "other", sourceRef: "ref", patchHash: "patch", assets: manifest.assets });
  await assert.rejects(fetchVerifiedBundle("http://fixture/mineslop/", manifest, serve(other)), /differs/);
  await assert.rejects(fetchVerifiedBundle("http://fixture/mineslop/", manifest, serve({ ...manifest, sourceRef: "changed" })), /manifest hash mismatch/);
});

test("three mixed source groups and mismatched independent capture links cannot be accepted", () => {
  const baseline = Array.from({ length: 3 }, () => linkedFixture("baseline", 10));
  const candidate = Array.from({ length: 3 }, () => linkedFixture("candidate", 8));
  assert.equal(compareTrials(baseline, candidate).accepted, true);
  for (let i = 0; i < 3; i++) {
    baseline[i].provenance.sourceIdentity = `baseline-${i}`;
    candidate[i].provenance.sourceIdentity = `candidate-${i}`;
  }
  assert.equal(compareTrials(baseline, candidate).accepted, false);
  const linked = linkCaptures(performanceFixture("A"), correctnessFixture("B"));
  assert.equal(linked.captureLink.matched, false);
  assert.equal(exitCodeFor(linked), 1);
  const contaminated = performanceFixture(); contaminated.performanceQualified = false;
  assert.equal(linkCaptures(contaminated, correctnessFixture()).captureLink.matched, false);
});
