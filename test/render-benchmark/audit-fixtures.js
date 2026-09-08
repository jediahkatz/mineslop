// Deliberately synthetic oracle/CLI controls, never performance evidence.
import { DEFAULT_CONSTRAINTS, evaluateRun } from "./oracles.js";
import { linkCaptures, timingQualified } from "./acceptance.js";

export function correctnessFixture(source = "baseline") {
  const run = {
    measurementVersion: 3, capture: "correctness", scene: "classic", configurationLabel: "default",
    constraints: { ...DEFAULT_CONSTRAINTS }, settings: { limits: {}, rasterPolicy: "fixed-quality-cap",
      fixedRaster: { width: 800, height: 500, pixelRatio: 1 } },
    machine: { softwareRenderer: true, drawingBuffer: [800, 500], pixelRatio: 1 }, host: { cpu: "test-fixture" },
    provenanceStable: true,
    provenance: { sourceIdentity: source, manifestHash: `${source}-bundle`, servedVerified: true,
      sourceRef: `${source}-ref`, patchHash: `${source}-patch`, harnessHash: "same-harness", dependencies: {} },
    frameIntervals: [16, 16, 16], errors: [], controlErrors: [],
    visibilityEvents: [], contextLossEvents: [], copy: { maxBytes: 1 },
    edit: { visibleMs: 100, farStillLoading: true, transactionMs: 10, publicationMs: null },
    pixelControl: { status: "pass" }, lifecycle: { status: "pass" },
    samples: [{
      ms: 1000, position: [0, 10, 0], yaw: 0, pitch: 0, hidden: false, contextLost: false,
      raster: { width: 800, height: 500, pixelRatio: 1 },
      native: { available: true, fullRadius: 12, fullDetailBlocks: 192,
        rings: [{ required: 1, physical: 1, fullFresh: 1 }] },
      fog: { near: 200, far: 300 }, mask: { checks: 4, expectedSections: 1, mismatches: 0 },
      resources: { includesDistantBacking: true, gpuBytes: 1, combinedCpuBytes: 1, stagingBytes: 1, drawCalls: 1 },
      surfaces: [{ status: "native-match" }], rays: [],
    }],
    measurementScope: { route: "fixture-route", durationSeconds: 30 },
  };
  run.evaluation = evaluateRun(run);
  return run;
}

export function performanceFixture(source = "baseline", mesh = 10) {
  const run = correctnessFixture(source);
  Object.assign(run, { capture: "performance", heavyObserverCalls: 0, resourceObserverCalls: 0,
    editRayCalls: 0, pixelReadsWhileRecording: 0, timedScreenshots: 0,
    timings: { observer: [0.01], editObserver: [0.01], mesh: [mesh] },
    statistics: { frames: { p95: 16 }, timings: { mesh: { p95: mesh } } } });
  run.samples[0] = { ...run.samples[0], native: { available: false, rings: [] }, mask: null,
    resources: {}, surfaces: [], rays: [] };
  run.edit.visibleMs = null; run.edit.publicationMs = 100;
  delete run.pixelControl; delete run.lifecycle;
  run.evaluation = evaluateRun(run);
  run.performanceQualified = timingQualified(run, run.constraints);
  return run;
}

export function linkedFixture(source = "baseline", mesh = 10) {
  return linkCaptures(performanceFixture(source, mesh), correctnessFixture(source));
}
