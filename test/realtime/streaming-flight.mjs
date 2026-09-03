import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "../../src/terrain.js";
import { chromeExecutable, readConfig } from "./config.mjs";
import { bounded, RealInputs } from "./input.mjs";
import { verifyNativeMouse } from "./scenarios.mjs";
import { evaluateStreamingReport } from "./streaming-checks.mjs";

const config = readConfig();
if (config.help) {
  console.log(`Usage: node test/realtime/streaming-flight.mjs [options]
  --duration <seconds>   Duration of each primary flight (default 55)
  --quality <level>      low, medium, or high (default medium)
  --seed <seed>          Generated world seed (default cedar-valley)
  --width <pixels>       Viewport width (default 1280)
  --height <pixels>      Viewport height (default 720)
  --output <file.json>   JSON report, including failures
  --screenshot <file>    Optional capture after measurement
  --pixel-ratio <ratio>  Explicit, reported resolution experiment

VOXELCRAFT_TEST_URL selects an already-running benchmark host.
VOXELCRAFT_FLIGHT_ALTITUDES selects player-feet heights (default 64,104,152).
VOXELCRAFT_STREAMING_TRANSITIONS=1 adds programmatic transition cases.
VOXELCRAFT_STREAMING_DIAGNOSTIC=1 permits coverage loss for baseline diagnosis;
invalid/incomplete native input, page errors and explicit budgets still fail.
VOXELCRAFT_REQUIRE_NATIVE_MOUSE=1 requires pointer-lock mouse verification.
Exit codes: 0 pass/explicit diagnostic, 1 harness failure, 2 coverage failure,
3 explicit performance-budget failure. Timings include the coverage observer.`);
  process.exit(0);
}
const url = new URL(config.url);
url.searchParams.set("streamingProbe", "1");
config.url = url.href;
// This runner never invokes the normal bot's synthetic or Survival fixtures.
config.syntheticControls = false;
config.naturalSurvival = false;
const altitudes = (process.env.VOXELCRAFT_FLIGHT_ALTITUDES ?? "64,104,152")
  .split(",")
  .map(Number);
if (
  !altitudes.length ||
  altitudes.some(
    (value) => !Number.isFinite(value) || value < 40 || value > 512
  )
)
  throw new Error(
    "VOXELCRAFT_FLIGHT_ALTITUDES must be comma-separated heights in [40,512]"
  );
const transitionsEnabled = process.env.VOXELCRAFT_STREAMING_TRANSITIONS === "1";
const diagnostic = process.env.VOXELCRAFT_STREAMING_DIAGNOSTIC === "1";
const transitionQualities = ["low", "medium", "high"].filter(
  (value) => value !== config.quality
);
const dimensions = ["nether", "end", "overworld"];
const runId =
  process.env.VOXELCRAFT_STREAMING_RUN_ID ?? new Date().toISOString();
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  config,
  altitudes,
  transitionsEnabled,
  coverageAssertionScope: "native-flight",
  requestedCases: {
    flights: [
      ...altitudes.map((target) => `${config.quality}-altitude-${target}`),
      ...(transitionsEnabled
        ? [
            ...transitionQualities.map(
              (quality) => `${quality}-after-quality-change`
            ),
            "after-large-teleport",
            "after-dimension-roundtrip",
          ]
        : []),
    ],
    transitions: transitionsEnabled
      ? [
          ...transitionQualities.map((quality) => `quality-${quality}`),
          "large-teleport",
          ...dimensions.map((dimension) => `dimension-${dimension}`),
        ]
      : [],
  },
  methodology: {
    movement:
      "Trusted Chromium keyboard/mouse input via Playwright: double-Space flight, Space/Shift vertical movement, W/S/Ctrl/A/D and Arrow-key pitch. Altitude corrections leave the double-tap window before a fresh Space hold. No dispatchEvent, pose/velocity writes, fake RAF or accelerated clock during flight or altitude setup.",
    altitude:
      "Requested player-feet heights; obstacle clearance may raise the native-flight target. Actual min/max heights are in metrics.movement; probe state.position is the camera, not player feet.",
    coverage:
      "Up to 21 vertical columns intersect actual visible indexed detail and active distant-ground meshes, respecting drawRange and scene attachment. Far canopies cannot stand in for distant ground. In-view ground uses the real camera projection; this is sparse geometry coverage, not pixel-complete visual QA.",
    sampling:
      "Horizon visibility is checked each rendered frame. Ground columns are sampled on streaming-state changes or the first rendered frame after a 500 ms deadline; slow frames can delay sampling. The first 20 sampled failures per case are retained in JSON. End void is intentional absence.",
    fog: "Both shader view-depth and horizontal-distance smoothstep values are recorded; the shipped Three shader uses view depth.",
    timing:
      "BotMetrics reports unclamped RAF intervals and inclusive synchronous CPU phases, not GPU completion. streaming.observerMs measures synchronous coverage-collector cost per rendered frame; it is included in game.frame and RAF timing, outside graphics.render's inner timing. It excludes CDP/report serialization and wrapper dispatch. metrics.observerCpuMs is the separate BotMetrics observer. Do not subtract percentiles or compare these observer-on timings as an observer-free performance baseline.",
    transitions:
      "Opt-in programmatic-transition cases call the real teleport/dimension/quality paths; they are functional API coverage, not UI-input or native-flight performance proof. Their pause/reset coverage counters are diagnostic, with requested-world completion asserted. Subsequent native-flight segments have separate metrics and a precedingTransition label.",
    isolation:
      "Owned headless browser and fresh non-persistent context only; no shared manual-GUI profile or service lifecycle changes.",
    failurePolicy:
      "Coverage loss fails by default. VOXELCRAFT_STREAMING_DIAGNOSTIC=1 suppresses only the coverage exit failure for explicit baseline diagnosis. Incomplete/empty measurements, invalid native inputs, failed transitions, page errors and explicitly configured observer-inclusive performance budgets still fail.",
  },
  assertions: [],
  warnings: [],
  pageErrors: [],
  errors: [],
  flights: [],
  transitions: [],
};
let browser;
let context;
let input;
let stage = "browser-startup";
let precedingTransition = null;

async function begin(label) {
  stage = label;
  await input.page.evaluate((label) => {
    window.__voxelBot.metrics.reset(label);
    window.__voxelBot.streaming.start(label);
  }, label);
}

async function end() {
  return input.page.evaluate(() => ({
    metrics: window.__voxelBot.metrics.results({ stop: true }),
    streaming: window.__voxelBot.streaming.results({ stop: true }),
    final: window.__voxelBot.streaming.state(),
  }));
}

async function play() {
  await input.release();
  if ((await input.state()).paused) await input.click(".play-button");
  await input.until(
    (state) => state.active && state.enabled,
    "Native flight controls active"
  );
  if (!(await input.state()).flying) await input.doubleTap("Space");
  await input.until(
    (state) => state.flying,
    "Double-Space enables Creative flight"
  );
}

async function settle() {
  await input.release();
  await input.until(
    (state) =>
      Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) < 0.03,
    "Released flight settles"
  );
}

async function altitude(target) {
  await play();
  const before = await input.state();
  if (Math.abs(before.position.y - target) > 0.75) {
    const ascending = before.position.y < target;
    await input.down(ascending ? "Space" : "ShiftLeft", { flight: true });
    try {
      await input.until(
        (state) =>
          ascending
            ? state.position.y >= target - 0.4
            : state.position.y <= target + 0.4,
        `Reach altitude ${target} using native vertical flight`,
        120000
      );
    } finally {
      await input.release();
    }
  }
  await settle();
  let state = await input.state();
  if (Math.abs(state.pitch + 1.04) > 0.08) {
    const down = state.pitch > -1.04;
    await input.down(down ? "ArrowDown" : "ArrowUp");
    try {
      await input.until(
        (next) => (down ? next.pitch <= -1.02 : next.pitch >= -1.06),
        "Native downward-looking flight camera"
      );
    } finally {
      await input.release();
    }
  }
  await input.page.waitForFunction(
    ({ size, min, max }) => {
      const { graphics, world } = window.__voxelBot.game;
      const coverage =
        graphics.detailCoverage?.() ??
        new Set(
          [...graphics.chunks]
            .filter(([, group]) => group.visible)
            .map(([key]) => key)
        );
      const cx = Math.floor(graphics.camera.position.x / size);
      const cz = Math.floor(graphics.camera.position.z / size);
      const radius = graphics.renderRadius;
      for (let z = cz - radius; z <= cz + radius; z++)
        for (let x = cx - radius; x <= cx + radius; x++) {
          if (
            x * size < min ||
            x * size >= max ||
            z * size < min ||
            z * size >= max
          )
            continue;
          if (!coverage.has(`${x},${z}`)) return false;
        }
      return graphics.distant.ready && world._requests.size === 0;
    },
    { size: CHUNK_SIZE, min: WORLD_MIN, max: WORLD_MAX },
    { timeout: 120000 }
  );
  await input.frames(3);
  state = await input.state({ renderer: true });
  return state;
}

async function flight(targetAltitude, duration, label) {
  stage = `${label}:altitude-setup`;
  const initial = await altitude(targetAltitude);
  await begin(label);
  const started = performance.now();
  let nextProgress = started;
  let tick = 0;
  let planning;
  let completed = false;
  try {
    while (performance.now() - started < duration * 1000) {
      const state = await input.state({ planning: tick % 5 === 0 });
      if (!state.active || !state.enabled || state.hidden || !state.flying)
        throw new Error("Native flight lost active controls");
      if (input.lookMode === "native-mouse" && !state.locked)
        throw new Error("Native flight lost pointer lock");
      planning = state.planning ?? planning;
      const seconds = (performance.now() - started) / 1000;
      const target = Math.max(
        targetAltitude,
        ...(planning?.samples ?? []).map((sample) =>
          Math.max(sample.terrainHeight + 8, (sample.topSolid ?? 0) + 5)
        )
      );
      const predictedY = state.position.y + state.velocity.y * 0.15;
      const keys = [seconds < duration / 2 ? "KeyW" : "KeyS", "ControlLeft"];
      // Sustained diagonal crossings, then native S reversal through the same cache.
      const strafe = Math.floor(seconds / 3) % 4;
      if (strafe === 0) keys.push("KeyD");
      if (strafe === 2) keys.push("KeyA");
      if (predictedY < target - 0.65) keys.push("Space");
      if (predictedY > target + 0.65) keys.push("ShiftLeft");
      await input.setHeld(keys, { flight: true });
      if (performance.now() >= nextProgress) {
        const observed = await input.page.evaluate(() =>
          window.__voxelBot.streaming.state()
        );
        console.log(
          `[${label} ${seconds.toFixed(1)}s] y=${state.position.y.toFixed(1)} crossings=${state.live.chunksCrossed} fog=${observed.fogFar.toFixed(1)} horizon=${observed.lodVisible} missing=${observed.missing.length} cache=${observed.loaded} queued=${observed.requests}`
        );
        nextProgress = performance.now() + 1000;
      }
      tick++;
      await delay(config.tickMs);
    }
    completed = true;
  } finally {
    const result = await end();
    result.label = label;
    result.measurementType = "native-flight";
    result.timingIncludesObserver = true;
    result.precedingTransition = precedingTransition;
    result.completed = completed;
    result.durationSeconds = duration;
    result.targetAltitude = targetAltitude;
    result.initial = initial;
    result.nativeControlTicks = tick;
    report.flights.push(result);
    await input.release();
    const { streaming, metrics } = result;
    console.log(
      `[${label}] ${metrics.movement.chunksCrossed} crossings, hidden horizon ${streaming.hiddenHorizonFrames}/${streaming.frames} frames, holes ${streaming.coverageWithVisibleHoles}/${streaming.coverageSamples}, all ground fogged ${streaming.coverageWithAllGroundFogged}/${streaming.coverageSamples}, frame p95 ${metrics.frames.intervalMs.p95} ms`
    );
  }
}

async function transition(label, expected, action) {
  stage = `${label}:settle`;
  await settle();
  const initial = await input.state();
  await begin(label);
  let actionResult;
  let completed = false;
  try {
    actionResult = await action();
    if (actionResult === false || actionResult?.ok === false)
      throw new Error(
        `Public transition failed: ${JSON.stringify(actionResult)}`
      );
    await input.until(
      (state) => !state.building && !state.failed,
      label,
      120000
    );
    await input.frames(45);
    completed = true;
  } finally {
    report.transitions.push({
      label,
      measurementType: "programmatic-transition",
      timingIncludesObserver: true,
      expected,
      initial,
      actionResult,
      completed,
      ...(await end()),
    });
  }
  precedingTransition = label;
}

try {
  browser = await chromium.launch({
    executablePath: await chromeExecutable(config.chromeBin),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
    timeout: 60000,
  });
  context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("crash", () =>
    report.errors.push({ stage, message: "Headless renderer crashed" })
  );
  stage = "loading-real-game";
  await page.goto(config.url, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(
    () => window.__voxelBot?.ready || window.__voxelBot?.error,
    undefined,
    { timeout: 120000 }
  );
  input = new RealInputs(page, config);
  const initial = await input.state({ renderer: true });
  if (!initial.ready || initial.error)
    throw new Error(initial.error ?? "Realtime host failed");
  if (!(await page.evaluate(() => Boolean(window.__voxelBot.streaming))))
    throw new Error(
      "Rebuild the realtime host: the streaming probe is missing"
    );
  report.initial = initial;
  report.browser = { version: browser.version(), renderer: initial.renderer };
  stage = "native-input-verification";
  await verifyNativeMouse(input, report);
  for (const target of altitudes)
    await flight(
      target,
      config.durationSeconds,
      `${config.quality}-altitude-${target}`
    );
  if (transitionsEnabled) {
    for (const quality of transitionQualities) {
      await transition(`quality-${quality}`, { quality }, () =>
        page.evaluate((value) => {
          const game = window.__voxelBot.game;
          game.quality = value;
          game.graphics.setQuality(value);
        }, quality)
      );
      await flight(
        104,
        Math.max(8, config.durationSeconds / 2),
        `${quality}-after-quality-change`
      );
    }
    const from = (await input.state()).position;
    await transition(
      "large-teleport",
      { dimension: "overworld", minimumDisplacement: 1024 },
      () =>
        bounded(
          page.evaluate(
            (from) =>
              window.__voxelBot.game.teleport({
                x: from.x + 2048,
                z: from.z - 1536,
                y: 104,
                dimension: "overworld",
              }),
            from
          ),
          120000,
          "Public teleport"
        )
    );
    await flight(
      104,
      Math.max(8, config.durationSeconds / 2),
      "after-large-teleport"
    );
    for (const dimension of dimensions)
      await transition(`dimension-${dimension}`, { dimension }, () =>
        bounded(
          page.evaluate(
            (dimension) => window.__voxelBot.game.travelDimension(dimension),
            dimension
          ),
          120000,
          `Public ${dimension} travel`
        )
      );
    await flight(
      104,
      Math.max(8, config.durationSeconds / 2),
      "after-dimension-roundtrip"
    );
  }
  if (config.screenshot) {
    await mkdir(dirname(config.screenshot), { recursive: true });
    await page.screenshot({ path: config.screenshot });
    report.screenshot = config.screenshot;
  }
} catch (error) {
  report.errors.push({ stage, message: error.message, stack: error.stack });
  console.error(`[failed] ${stage}: ${error.message}`);
} finally {
  if (input) {
    report.inputCommands = input.counts;
    await bounded(input.release(), 5000, "Release owned native inputs").catch(
      () => {}
    );
  }
  if (context)
    await bounded(context.close(), 10000, "Close isolated context").catch(
      () => {}
    );
  if (browser)
    await bounded(browser.close(), 10000, "Close owned test browser").catch(
      () => {}
    );
}
const { assertions, ...outcome } = evaluateStreamingReport(report, {
  diagnostic,
});
report.assertions.push(...assertions);
Object.assign(report, outcome);
report.finishedAt = new Date().toISOString();
for (const entry of assertions) console.log(`[${entry.status}] ${entry.name}`);
await mkdir(dirname(config.output), { recursive: true });
await writeFile(config.output, JSON.stringify(report, null, 2) + "\n");
console.log(
  `[${report.status}] ${report.flights.length} native flights, ${report.transitions.length} programmatic transitions; report ${config.output}`
);
process.exitCode = report.exitCode;
