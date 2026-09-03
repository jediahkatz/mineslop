import assert from "node:assert/strict";
import test from "node:test";
import { summarize, summarizeFrames } from "./statistics.js";
import { evaluateStreamingReport } from "./streaming-checks.mjs";

// Synthetic report bookkeeping only: no game inputs or benchmark evidence.
function fixture() {
  return {
    config: { budgets: {} },
    requestedCases: { flights: ["unit-native-case"], transitions: [] },
    assertions: [],
    errors: [],
    pageErrors: [],
    flights: [
      {
        label: "unit-native-case",
        measurementType: "native-flight",
        completed: true,
        nativeControlTicks: 5,
        initial: { mode: "creative", flying: true, syntheticFixture: null },
        metrics: {
          movement: { chunksCrossed: 10 },
          inputs: { trusted: 3, untrusted: 0, byCode: { KeyW: 2, KeyS: 1 } },
          frames: {
            ...summarizeFrames([20, 30, 40]),
            callbacks: 4,
            active: 4,
            paused: 0,
          },
          latency: {
            keyToMotionMs: summarize([3]),
            mouseToCameraMs: summarize([]),
          },
        },
        streaming: {
          frames: 4,
          hiddenHorizonFrames: 0,
          coverageSamples: 2,
          coverageWithGroundInView: 2,
          coverageWithVisibleHoles: 0,
          coverageWithAllGroundFogged: 0,
        },
      },
    ],
    transitions: [],
  };
}

function addTransition(report) {
  const transition = {
    label: "unit-dimension-transition",
    measurementType: "programmatic-transition",
    completed: true,
    expected: { dimension: "end" },
    actionResult: { ok: true },
    initial: { position: { x: 0, y: 104, z: 0 } },
    final: {
      position: { x: 2048, y: 104, z: -1536 },
      dimension: "end",
      quality: "high",
      loaded: 25,
      lodVisible: true,
      lodActiveDimension: "end",
    },
    streaming: {
      frames: 4,
      coverageSamples: 2,
      hiddenHorizonFrames: 3,
      coverageWithVisibleHoles: 2,
      coverageWithAllGroundFogged: 2,
    },
    metrics: { frames: { intervalMs: { p95: 9000 } } },
  };
  report.requestedCases.transitions.push(transition.label);
  report.transitions.push(transition);
  return transition;
}

test("complete native coverage passes without mutating the source report", () => {
  const report = fixture();
  const original = structuredClone(report);
  const result = evaluateStreamingReport(report);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "no-coverage-loss-observed");
  assert.equal(result.nativeFlightValid, true);
  assert.equal(result.coverageLossObserved, false);
  assert.ok(result.assertions.every((entry) => entry.status === "passed"));
  assert.deepEqual(report, original);
});

for (const field of [
  "hiddenHorizonFrames",
  "coverageWithVisibleHoles",
  "coverageWithAllGroundFogged",
]) {
  test(`${field} fails coverage by default`, () => {
    const report = fixture();
    report.flights[0].streaming[field] = 1;
    const result = evaluateStreamingReport(report);
    assert.equal(result.exitCode, 2);
    assert.equal(result.status, "coverage-failed");
    assert.equal(result.coverageLossObserved, true);
    assert.equal(result.nativeFlightValid, true);
    assert.equal(result.diagnostic, false);
  });

  test(`explicit diagnostic mode retains failed ${field} evidence`, () => {
    const report = fixture();
    report.flights[0].streaming[field] = 1;
    const result = evaluateStreamingReport(report, { diagnostic: true });
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "coverage-loss-observed-diagnostic");
    assert.equal(result.coverageLossObserved, true);
    assert.ok(
      result.assertions.some(
        (entry) => entry.category === "coverage" && entry.status === "failed"
      )
    );
  });
}

test("empty, missing, negative or impossible probe counts cannot pass diagnosis", () => {
  for (const [field, value] of [
    ["frames", 0],
    ["coverageSamples", 0],
    ["coverageSamples", 5],
    ["coverageWithGroundInView", 0],
    ["coverageWithGroundInView", undefined],
    ["hiddenHorizonFrames", -1],
    ["hiddenHorizonFrames", 5],
    ["coverageWithVisibleHoles", NaN],
    ["coverageWithVisibleHoles", 3],
    ["coverageWithAllGroundFogged", undefined],
  ]) {
    const report = fixture();
    report.flights[0].streaming[field] = value;
    const result = evaluateStreamingReport(report, { diagnostic: true });
    assert.equal(result.exitCode, 1, `${field}=${value}`);
    assert.equal(result.nativeFlightValid, false);
  }
});

test("incomplete or invalid native controls still fail in diagnostic mode", () => {
  for (const mutate of [
    (flight) => {
      flight.completed = false;
    },
    (flight) => {
      flight.measurementType = "programmatic-transition";
    },
    (flight) => {
      flight.nativeControlTicks = 0;
    },
    (flight) => {
      flight.metrics.movement.chunksCrossed = 1;
    },
    (flight) => {
      flight.metrics.inputs.trusted = 0;
    },
    (flight) => {
      flight.metrics.inputs.untrusted = 1;
    },
    (flight) => {
      flight.metrics.inputs.byCode.KeyS = 0;
    },
    (flight) => {
      flight.metrics.frames.paused = 1;
    },
    (flight) => {
      flight.metrics.frames.active = 3;
    },
    (flight) => {
      flight.initial.syntheticFixture = { label: "unit" };
    },
    (flight) => {
      flight.initial.flying = false;
    },
    (flight) => {
      flight.metrics = {};
    },
  ]) {
    const report = fixture();
    mutate(report.flights[0]);
    const result = evaluateStreamingReport(report, { diagnostic: true });
    assert.equal(result.exitCode, 1);
    assert.equal(result.nativeFlightValid, false);
  }
});

test("missing requested flights, empty runs and missing transitions fail", () => {
  const incomplete = fixture();
  incomplete.requestedCases.flights.push("unrun-altitude");
  const empty = fixture();
  empty.flights = [];
  const missingTransition = fixture();
  missingTransition.requestedCases.transitions.push("unrun-transition");
  for (const report of [incomplete, empty, missingTransition]) {
    assert.equal(evaluateStreamingReport(report).exitCode, 1);
    assert.equal(
      evaluateStreamingReport(report, { diagnostic: true }).exitCode,
      1
    );
  }
});

test("page errors, harness errors and required native mouse failures stay fatal", () => {
  for (const field of ["errors", "pageErrors", "assertions"]) {
    const report = fixture();
    report[field].push({ name: "unit failure", status: "failed" });
    assert.equal(
      evaluateStreamingReport(report, { diagnostic: true }).exitCode,
      1
    );
  }
});

test("programmatic reset counters and timings are not native-flight evidence", () => {
  const report = fixture();
  addTransition(report);
  report.config.budgets = { frameP95Ms: 45 };
  const result = evaluateStreamingReport(report);
  assert.equal(result.exitCode, 0);
  assert.equal(result.transitionsValid, true);
  assert.equal(result.coverageLossObserved, false);
  assert.equal(result.performanceBudgets.length, 1);
  assert.equal(result.performanceBudgets[0].label, "unit-native-case");
});

test("failed, stale or wrong-target programmatic transitions fail diagnosis", () => {
  for (const mutate of [
    (transition) => {
      transition.completed = false;
    },
    (transition) => {
      transition.actionResult = false;
    },
    (transition) => {
      transition.actionResult = { ok: false };
    },
    (transition) => {
      transition.final.dimension = "overworld";
    },
    (transition) => {
      transition.final.lodActiveDimension = "overworld";
    },
    (transition) => {
      transition.expected.quality = "low";
    },
    (transition) => {
      transition.final.loaded = 0;
    },
    (transition) => {
      transition.streaming.coverageSamples = 0;
    },
    (transition) => {
      transition.expected.minimumDisplacement = 1024;
      transition.final.position = transition.initial.position;
    },
  ]) {
    const report = fixture();
    mutate(addTransition(report));
    const result = evaluateStreamingReport(report, { diagnostic: true });
    assert.equal(result.exitCode, 1);
    assert.equal(result.transitionsValid, false);
  }
});

test("explicit observer-inclusive performance budgets still fail diagnosis", () => {
  const report = fixture();
  report.config.budgets = { frameP95Ms: 20 };
  report.flights[0].streaming.hiddenHorizonFrames = 1;
  const result = evaluateStreamingReport(report, { diagnostic: true });
  assert.equal(result.exitCode, 3);
  assert.equal(result.status, "performance-budget-failed");
  assert.equal(result.coverageLossObserved, true);
  assert.equal(result.performanceBudgets[0].passed, false);
});
