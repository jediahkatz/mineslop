import { evaluateBudgets } from "./statistics.js";

const countWithin = (value, maximum) =>
  Number.isInteger(value) && value >= 0 && value <= maximum;

/** Report bookkeeping only; this never drives inputs or changes game state. */
export function evaluateStreamingReport(report, { diagnostic = false } = {}) {
  const assertions = [];
  const check = (name, category, passed, evidence) => {
    assertions.push({
      name,
      category,
      status: passed ? "passed" : "failed",
      evidence,
    });
    return Boolean(passed);
  };
  const flights = report.flights ?? [];
  const transitions = report.transitions ?? [];
  const requestedFlights = report.requestedCases?.flights ?? [];
  const requestedTransitions = report.requestedCases?.transitions ?? [];
  let nativeFlightValid = check(
    "All requested native-flight cases completed",
    "harness",
    requestedFlights.length > 0 &&
      flights.length === requestedFlights.length &&
      requestedFlights.every((label) =>
        flights.some((flight) => flight.label === label && flight.completed)
      ),
    {
      requested: requestedFlights,
      observed: flights.map((flight) => flight.label),
    }
  );
  for (const flight of flights) {
    const { label, metrics, streaming } = flight;
    const controls = check(
      `${label}: trusted continuous forward/reverse flight crosses chunks`,
      "harness",
      flight.measurementType === "native-flight" &&
        flight.completed === true &&
        flight.nativeControlTicks > 0 &&
        metrics?.movement?.chunksCrossed >= 2 &&
        metrics?.inputs?.trusted > 0 &&
        metrics?.inputs?.untrusted === 0 &&
        metrics?.inputs?.byCode?.KeyW > 0 &&
        metrics?.inputs?.byCode?.KeyS > 0 &&
        metrics?.frames?.active > 0 &&
        metrics?.frames?.active === metrics?.frames?.callbacks &&
        metrics?.frames?.paused === 0 &&
        metrics?.frames?.intervalMs?.samples > 0 &&
        flight.initial?.mode === "creative" &&
        flight.initial?.flying === true &&
        !flight.initial?.syntheticFixture,
      {
        movement: metrics?.movement,
        inputs: metrics?.inputs,
        frames: metrics?.frames,
      }
    );
    const observed = check(
      `${label}: rendered ground coverage is nonempty and counters are valid`,
      "harness",
      Number.isInteger(streaming?.frames) &&
        streaming.frames > 0 &&
        countWithin(streaming.coverageSamples, streaming.frames) &&
        streaming.coverageSamples > 0 &&
        countWithin(
          streaming.coverageWithGroundInView,
          streaming.coverageSamples
        ) &&
        streaming.coverageWithGroundInView > 0 &&
        countWithin(streaming.hiddenHorizonFrames, streaming.frames) &&
        countWithin(
          streaming.coverageWithVisibleHoles,
          streaming.coverageSamples
        ) &&
        countWithin(
          streaming.coverageWithAllGroundFogged,
          streaming.coverageSamples
        ),
      {
        frames: streaming?.frames,
        coverageSamples: streaming?.coverageSamples,
        groundInViewSamples: streaming?.coverageWithGroundInView,
      }
    );
    nativeFlightValid = nativeFlightValid && controls && observed;
    check(
      `${label}: horizon stays drawn`,
      "coverage",
      streaming?.hiddenHorizonFrames === 0,
      { hidden: streaming?.hiddenHorizonFrames, frames: streaming?.frames }
    );
    check(
      `${label}: no sampled in-view ground holes`,
      "coverage",
      streaming?.coverageWithVisibleHoles === 0,
      {
        holes: streaming?.coverageWithVisibleHoles,
        samples: streaming?.coverageSamples,
      }
    );
    check(
      `${label}: sampled in-view ground is not wholly opaque fog`,
      "coverage",
      streaming?.coverageWithAllGroundFogged === 0,
      {
        fogged: streaming?.coverageWithAllGroundFogged,
        samples: streaming?.coverageSamples,
      }
    );
  }
  let transitionsValid = check(
    "All requested programmatic transition cases completed",
    "harness",
    transitions.length === requestedTransitions.length &&
      requestedTransitions.every((label) =>
        transitions.some(
          (transition) => transition.label === label && transition.completed
        )
      ),
    {
      requested: requestedTransitions,
      observed: transitions.map((transition) => transition.label),
    }
  );
  for (const transition of transitions) {
    const { label, expected, initial, final, streaming, actionResult } =
      transition;
    const displacement = Math.hypot(
      final?.position?.x - initial?.position?.x,
      final?.position?.z - initial?.position?.z
    );
    const valid = check(
      `${label}: public transition reaches the requested rendered world`,
      "harness",
      transition.measurementType === "programmatic-transition" &&
        transition.completed === true &&
        actionResult !== false &&
        actionResult?.ok !== false &&
        Boolean(expected) &&
        (expected.quality === undefined ||
          final?.quality === expected.quality) &&
        (expected.dimension === undefined ||
          final?.dimension === expected.dimension) &&
        (expected.minimumDisplacement === undefined ||
          displacement >= expected.minimumDisplacement) &&
        final?.loaded > 0 &&
        streaming?.frames > 0 &&
        streaming?.coverageSamples > 0 &&
        typeof final.lodVisible === "boolean" &&
        (!final.lodVisible || final.lodActiveDimension === final.dimension),
      { expected, actionResult, displacement, final }
    );
    transitionsValid = transitionsValid && valid;
  }
  // Programmatic travel intentionally pauses/resets the scene. Its transient
  // coverage counters are retained, not judged as uninterrupted native flight.
  const coverageLossObserved = assertions.some(
    (entry) => entry.category === "coverage" && entry.status === "failed"
  );
  const harnessFailed =
    (report.errors?.length ?? 0) > 0 ||
    (report.pageErrors?.length ?? 0) > 0 ||
    (report.assertions ?? []).some((entry) => entry.status === "failed") ||
    assertions.some(
      (entry) => entry.category === "harness" && entry.status === "failed"
    );
  const performanceBudgets = flights.flatMap(({ label, metrics }) => {
    const measurement =
      metrics?.frames?.intervalMs &&
      metrics?.frames?.fps &&
      metrics?.frames?.jank &&
      metrics?.latency
        ? metrics
        : undefined;
    return evaluateBudgets(measurement, report.config?.budgets ?? {}).map(
      (budget) => ({ label, ...budget })
    );
  });
  const performanceFailed = performanceBudgets.some((budget) => !budget.passed);
  const exitCode = harnessFailed
    ? 1
    : coverageLossObserved && !diagnostic
      ? 2
      : performanceFailed
        ? 3
        : 0;
  const status = harnessFailed
    ? "harness-failed"
    : coverageLossObserved && !diagnostic
      ? "coverage-failed"
      : performanceFailed
        ? "performance-budget-failed"
        : coverageLossObserved
          ? "coverage-loss-observed-diagnostic"
          : "no-coverage-loss-observed";
  return {
    assertions,
    nativeFlightValid,
    transitionsValid,
    coverageLossObserved,
    performanceBudgets,
    diagnostic,
    status,
    exitCode,
  };
}
