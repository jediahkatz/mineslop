import { CHUNK_SIZE } from "../../src/terrain.js";
import { sampleGroundCoverage } from "./ground-coverage.js";
import { summarize } from "./statistics.js";

export { probeGroundColumn, sampleGroundCoverage } from "./ground-coverage.js";

const COVERAGE_INTERVAL_MS = 500;
const FAILURE_SAMPLE_LIMIT = 20;
const copy = ({ x, y, z }) => ({ x, y, z });

function streamingState(game) {
  const { graphics, world } = game;
  const position = graphics.camera.position;
  const cx = Math.floor(position.x / CHUNK_SIZE);
  const cz = Math.floor(position.z / CHUNK_SIZE);
  const missing = [];
  for (let dz = -graphics.renderRadius; dz <= graphics.renderRadius; dz++)
    for (let dx = -graphics.renderRadius; dx <= graphics.renderRadius; dx++) {
      const key = `${cx + dx},${cz + dz}`;
      if (!graphics.chunks.has(key)) missing.push(key);
    }
  return {
    position: copy(position),
    center: `${cx},${cz}`,
    quality: graphics.quality,
    dimension: world.dimension,
    generatorVersion: world.generatorVersion,
    epoch: world._epoch,
    radius: graphics.renderRadius,
    loaded: world.chunks.size,
    rendered: graphics.chunks.size,
    missing,
    dirty: world.dirtyChunks.size,
    requests: world._requests.size,
    inFlight: world._inFlight.size,
    fogNear: graphics.scene.fog.near,
    fogFar: graphics.scene.fog.far,
    lodVisible: graphics.distant.group.visible,
    lodReady: graphics.distant.ready,
    lodFogDistance: graphics.distant._fogDistance,
    lodActiveKey: graphics.distant._active?.data.request.key ?? null,
    lodActiveDimension:
      graphics.distant._active?.data.request.dimension ?? null,
    lodJob: graphics.distant._job
      ? {
          key: graphics.distant._job.request.key,
          phase: graphics.distant._job.phase,
          cursor: graphics.distant._job.cursor,
          count: graphics.distant._job.count,
        }
      : null,
    lodSamples: graphics.distant._samples.size,
  };
}

/**
 * Opt-in, read-only coverage observer for the dedicated realtime test host.
 * Only the test instance's render call is wrapped; production work budgets and
 * return values stay unchanged. Results are collected in the runner's JSON.
 * Observer timing includes synchronous sampling, not CDP/report serialization.
 */
export function installStreamingProbe(game) {
  let recording = false;
  let aggregate;
  let startedAt = 0;
  let nextCoverageAt = 0;
  let lastFrameSignature;
  let lastFogFar;
  const { graphics } = game;
  const originalRender = graphics.render;
  graphics.render = function (...args) {
    const result = originalRender.apply(this, args);
    if (!recording) return result;
    const started = performance.now();
    const state = streamingState(game);
    aggregate.frames++;
    aggregate.hiddenHorizonFrames += Number(!state.lodVisible);
    aggregate.missingDetailFrames += Number(state.missing.length > 0);
    aggregate.minFogFar = Math.min(aggregate.minFogFar, state.fogFar);
    aggregate.maxFogFar = Math.max(aggregate.maxFogFar, state.fogFar);
    if (lastFogFar !== undefined && lastFogFar - state.fogFar > 1)
      aggregate.fogRetractions++;
    lastFogFar = state.fogFar;
    aggregate.maxCachedSamples = Math.max(
      aggregate.maxCachedSamples,
      state.lodSamples
    );
    const signature = `${state.center}:${state.quality}:${state.dimension}:${state.missing.length}:${state.lodVisible}`;
    if (signature !== lastFrameSignature || started >= nextCoverageAt) {
      lastFrameSignature = signature;
      nextCoverageAt = started + COVERAGE_INTERVAL_MS;
      const coverage = sampleGroundCoverage(game);
      aggregate.coverageSamples++;
      aggregate.coverageWithGroundInView += Number(coverage.inViewExpected > 0);
      aggregate.coverageWithMissingDetail += Number(coverage.missingDetail > 0);
      aggregate.coverageWithVisibleHoles += Number(
        coverage.inViewExpected > coverage.inViewDrawn
      );
      aggregate.coverageWithAllGroundFogged += Number(
        coverage.inViewExpected > 0 && coverage.inViewUnfogged === 0
      );
      aggregate.lastCoverage = coverage;
      if (
        aggregate.failureSamples.length < FAILURE_SAMPLE_LIMIT &&
        (!state.lodVisible ||
          coverage.inViewExpected > coverage.inViewDrawn ||
          (coverage.inViewExpected > 0 && coverage.inViewUnfogged === 0))
      )
        aggregate.failureSamples.push({
          frame: aggregate.frames,
          elapsedMs: started - startedAt,
          state,
          coverage,
        });
    }
    aggregate.observerMs.push(performance.now() - started);
    return result;
  };
  return {
    start(label) {
      startedAt = performance.now();
      aggregate = {
        label,
        coverageIntervalMs: COVERAGE_INTERVAL_MS,
        failureSampleLimit: FAILURE_SAMPLE_LIMIT,
        frames: 0,
        hiddenHorizonFrames: 0,
        missingDetailFrames: 0,
        fogRetractions: 0,
        minFogFar: Infinity,
        maxFogFar: 0,
        maxCachedSamples: 0,
        coverageSamples: 0,
        coverageWithMissingDetail: 0,
        coverageWithGroundInView: 0,
        coverageWithVisibleHoles: 0,
        coverageWithAllGroundFogged: 0,
        observerMs: [],
        lastCoverage: null,
        failureSamples: [],
      };
      lastFrameSignature = undefined;
      lastFogFar = undefined;
      nextCoverageAt = 0;
      recording = true;
    },
    results({ stop = false } = {}) {
      if (stop) recording = false;
      if (!aggregate) return null;
      return {
        ...aggregate,
        minFogFar: aggregate.frames ? aggregate.minFogFar : null,
        maxFogFar: aggregate.frames ? aggregate.maxFogFar : null,
        observerMs: summarize(aggregate.observerMs),
      };
    },
    state: () => streamingState(game),
    dispose() {
      recording = false;
      graphics.render = originalRender;
    },
  };
}
