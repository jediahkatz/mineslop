import { bounded } from "./input.mjs";
import { assertion } from "./scenarios.mjs";
import { streamingWithinBudget } from "./mesh-budget.js";
import { SPATIAL32 as S, setupKeys } from "./spatial-route.js";

const call = (input, method, argument) => bounded(input.page.evaluate(
  ({ method, argument }) => window.__voxelBot.spatialRoute[method](argument),
  { method, argument }
), input.config.timeoutMs, `Spatial route ${method}`);

function healthy(state) {
  if (!state.spatialRoute) throw new Error("The opt-in spatial driver is not enabled");
  if (state.spatialRoute.failure)
    throw new Error(`Spatial route ${state.spatialRoute.failure.kind}: ${state.spatialRoute.failure.message}`);
  if (state.failed || state.error) throw new Error(state.error ?? "Game failed");
  return state;
}

/** Explicitly versioned W-only smoke; the legacy wall-time controller is separate. */
export async function traverseSpatial32(input, report) {
  const errors = [], started = performance.now();
  let phase = "setup", ticks = 0;
  report.spatialSetup = { label: "unmeasured-native-spatial-32-v1", takeoffGestures: 0 };
  const budget = () => {
    if (performance.now() - started >= S.setupMs || ++ticks > S.maxControlTicks)
      throw new Error("Spatial native setup exceeded its predeclared wall/tick budget");
  };
  try {
    await input.release();
    let state = healthy(await input.state({ renderer: true }));
    if (input.lookMode !== "native-mouse")
      throw new Error("spatial-32-v1 requires native pointer-lock mouse input");
    report.renderer = state.renderer;
    report.world = {
      seed: state.seed, quality: state.quality, dimension: state.dimension,
      generatorVersion: state.generatorVersion, renderRadius: state.world.renderRadius,
      routeMode: S.mode,
    };
    if (!assertion(report, "Requested real generated world is active",
      state.seed === input.config.seed && state.quality === input.config.quality &&
      state.mode === "creative" && !state.syntheticFixture && state.world.renderedChunks > 0,
      report.world)) throw new Error("Spatial route has the wrong generated world");
    do {
      budget();
      const prepared = await call(input, "prepare");
      if (prepared.failure) throw new Error(prepared.failure.message);
      if (prepared.phase === "setup") break;
      await input.frames(1);
    } while (true);
    state = healthy(await input.state());
    if (!state.flying) {
      report.spatialSetup.takeoffGestures++;
      await input.doubleTap("Space", { holdSecondFrames: 2 });
      state = healthy(await input.state());
    }
    if (!state.flying || state.grounded)
      throw new Error("Native takeoff did not establish flight; no retry or measured retakeoff");
    while (!state.spatialRoute.ready) {
      budget();
      await input.steer(state, S.yaw, S.pitch);
      await input.setHeld(setupKeys(state, state.spatialRoute.targetFeet), { flight: true });
      state = healthy(await input.frames(1));
    }
    report.spatialSetup.elapsedMs = performance.now() - started;
    report.spatialSetup.controlTicks = ticks;
    report.spatialSetup.ready = state;
    await call(input, "begin");
    phase = "measured";
    // One fresh W hold. There is no steering, boosting, altitude correction,
    // takeoff, reset, detour, or retry anywhere in the measured segment.
    await input.down("KeyW");
    await input.until((next) => {
      healthy(next);
      return next.spatialRoute.phase === "braking";
    }, "Native W reaches the first 32-block frame boundary", S.measuredMs);
    phase = "braking";
    await input.release();
    await input.until((next) => {
      healthy(next);
      return next.spatialRoute.phase === "complete";
    }, "Native W release and four stationary braking frames", S.cleanupMs);
  } catch (error) {
    errors.push(error);
    report.spatialControllerFailure = { phase, message: error.message };
    try { await input.release(); }
    catch (releaseError) { errors.push(releaseError); }
    try { await call(input, "fail", `${phase}: ${error.message}`); }
    catch (captureError) { errors.push(captureError); }
  } finally {
    // Input cleanup precedes report reads and still runs after setup, timeout,
    // failed observation, or a metrics/report serialization error.
    try { await input.release(); }
    catch (error) { errors.push(error); }
    report.spatialSetup.elapsedMs ??= performance.now() - started;
    report.spatialSetup.controlTicks ??= ticks;
    try { report.spatialRoute = await call(input, "results"); }
    catch (error) { errors.push(error); }
    try {
      report.terrain = await bounded(input.page.evaluate(() =>
        window.__voxelBot.metrics.results({ stop: true })
      ), input.config.timeoutMs, "Read spatial measurement");
    } catch (error) { errors.push(error); }
  }
  if (errors.length)
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  const route = report.spatialRoute, result = report.terrain;
  report.world.routeStart = route.start;
  assertion(report, "Spatial 32 v1 completes with every frame in verified native flight",
    route.phase === "complete" && !route.failure && route.endpoint.progress >= S.length &&
      route.endpoint.progress <= S.length + S.overshoot && route.framesMeasured > 1,
    { start: route.start, endpoint: route.endpoint, end: route.end, failure: route.failure });
  assertion(report, "Traversal stays active and on loaded terrain",
    result.frames.active > 1 && result.frames.paused === 0 && result.frames.unloadedPlayer === 0,
    result.frames);
  assertion(report, "Native DOM movement events reach real player updates",
    result.inputs.trusted > 0 && result.inputs.untrusted === 0 &&
      result.latency.keyToMotionMs.samples > 0, result.inputs);
  assertion(report, "Terrain remains in the rendered view, not blank sky",
    result.view.samples > 0 && result.view.terrainVisibleFraction >= 0.4 &&
      result.maxima.triangles > 0, result.view);
  assertion(report, "Streaming cache and generation work remain bounded",
    streamingWithinBudget(result.maxima, report.world.renderRadius), result.maxima);
  assertion(report, "Day/night clock does not accelerate against wall time",
    result.clock.available && result.clock.discontinuities === 0 &&
      result.clock.simulationRate > 0 && result.clock.simulationRate < 1.05, result.clock);
}
