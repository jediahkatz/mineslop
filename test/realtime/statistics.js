/** Nearest-rank percentiles; empty measurements stay null, never "0 ms". */
export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length)
    return {
      samples: 0,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
      total: 0,
    };
  const rank = (percentile) =>
    sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1),
    mean: total / sorted.length,
    total,
  };
}

export function summarizeFrames(intervals) {
  const valid = intervals.filter(
    (value) => Number.isFinite(value) && value > 0
  );
  const milliseconds = summarize(valid);
  const over50 = valid.filter((value) => value > 50).length;
  const over100 = valid.filter((value) => value > 100).length;
  return {
    intervalMs: milliseconds,
    fps: {
      ...summarize(valid.map((value) => 1000 / value)),
      // Average throughput, not the misleading arithmetic mean of instant FPS.
      average: valid.length ? (1000 * valid.length) / milliseconds.total : null,
    },
    jank: {
      over50Ms: over50,
      over100Ms: over100,
      over50MsFraction: valid.length ? over50 / valid.length : null,
      over100MsFraction: valid.length ? over100 / valid.length : null,
    },
  };
}

export function distance(a, b, horizontal = false) {
  return Math.hypot(a.x - b.x, horizontal ? 0 : a.y - b.y, a.z - b.z);
}

export function softwareRenderer(renderer) {
  if (typeof renderer !== "string" || !renderer.trim()) return null;
  return /swiftshader|llvmpipe|softpipe|software|lavapipe|swrast/i.test(
    renderer
  );
}

/** Explicit budgets apply to every renderer; absent budgets are informational. */
export function evaluateBudgets(measurement, budgets) {
  const values = {
    frameP95Ms: measurement?.frames.intervalMs.p95,
    frameP99Ms: measurement?.frames.intervalMs.p99,
    inputP95Ms: measurement?.latency.keyToMotionMs.p95,
    mouseP95Ms: measurement?.latency.mouseToCameraMs.p95,
    minimumFps: measurement?.frames.fps.average,
    jank100Fraction: measurement?.frames.jank.over100MsFraction,
  };
  return Object.entries(budgets).map(([name, limit]) => {
    const actual = values[name];
    return {
      name,
      limit,
      actual: actual ?? null,
      passed:
        Number.isFinite(actual) &&
        (name === "minimumFps" ? actual >= limit : actual <= limit),
    };
  });
}
