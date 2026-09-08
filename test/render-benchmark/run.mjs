// Standalone, bounded real-Game benchmark. No package.json integration needed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { chromium } from "playwright";
import { chromeExecutable } from "../realtime/config.mjs";
import { summarize } from "../realtime/statistics.js";
import { bounded } from "../realtime/input.mjs";
import { DEFAULT_CONSTRAINTS, evaluateRun } from "./oracles.js";
import { SCENES, captureConfiguration } from "./scenes.js";
import { fetchVerifiedBundle, verifyManifest } from "./provenance.mjs";
import { exitCodeFor, timingQualified } from "./acceptance.js";

if (process.argv[2] === "--check-result") {
  const record = JSON.parse(await readFile(process.argv[3], "utf8"));
  record.evaluation = evaluateRun(record, record.constraints ?? DEFAULT_CONSTRAINTS);
  console.log(JSON.stringify(record.evaluation));
  process.exit(exitCodeFor(record, { diagnosticOnly: process.env.BENCH_DIAGNOSTIC_ONLY === "1" }));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scene = process.env.BENCH_SCENE ?? "classic";
const scenes = SCENES;
if (!scenes[scene]) throw new Error(`Unknown BENCH_SCENE ${scene}; supported: ${Object.keys(scenes)}`);
const configuration = captureConfiguration(process.env.BENCH_CAPTURE, process.env.BENCH_CONFIGURATION);
const seconds = Number(process.env.BENCH_SECONDS ?? 30);
if (!Number.isFinite(seconds) || seconds < 20 || seconds > 120) throw new Error("BENCH_SECONDS must be 20..120");
const base = new URL(process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/");
const artifactOutput = resolve(process.env.BENCH_OUTPUT ?? `/opt/cursor/artifacts/render_benchmark_${scene}_${Date.now()}`);
// Remote artifact stores can have high latency and append races. Never let
// artifact I/O pace measured frames; publish each completed file once at end.
const output = await mkdtemp("/tmp/mineslop-render-benchmark-");
const logLines = [];
const log = async (text) => {
  console.log(text);
  logLines.push(text);
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 ** 2 });
const bundle = JSON.parse(await readFile(resolve(root, ".benchmark-bundle.json"), "utf8"));
verifyManifest(bundle);
async function provenance() {
  const snapshot = await readFile(resolve(root, ".benchmark-source.json"), "utf8")
    .then(JSON.parse).catch(e => { if (e.code !== "ENOENT") throw e; return null; });
  if (snapshot?.sha !== bundle.sourceRef || hash(snapshot?.dirtyDiff ?? "") !== bundle.patchHash)
    throw new Error("Frozen ref/patch provenance changed");
  for (const [name, data] of Object.entries(snapshot.extraFilesBase64 ?? {}))
    if (hash(Buffer.from(data, "base64")) !== bundle.hashes[name])
      throw new Error(`Extra untracked input provenance changed: ${name}`);
  const files = Object.keys(bundle.hashes).sort();
  const hashes = Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(resolve(root, name)))])));
  for (const [name, sha] of Object.entries(bundle.hashes))
    if (hashes[name] !== sha) throw new Error(`Local frozen input changed: ${name}`);
  const dependencies = {};
  for (const name of ["three", "vite", "playwright"])
    dependencies[name] = JSON.parse(await readFile(resolve(root, `node_modules/${name}/package.json`), "utf8")).version;
  return { sha: snapshot?.sha ?? git("rev-parse", "HEAD").trim(), branch: snapshot?.branch ?? git("branch", "--show-current").trim(),
    sourceHash: hash(JSON.stringify(hashes)), hashes, dependencies,
    dirtyDiff: snapshot?.dirtyDiff ?? git("diff", "--", "src"),
    extraFilesBase64: snapshot?.extraFilesBase64 ?? {}, status: snapshot?.status ?? git("status", "--short") };
}
const before = await provenance();
await writeFile(`${output}/provenance-before.json`, JSON.stringify(before, null, 2));
await writeFile(`${output}/renderer-before.patch`, before.dirtyDiff);
await log(`START ${scene} SHA=${before.sha} sourceHash=${before.sourceHash} wall=${seconds}s output=${output}`);
const constraints = { ...DEFAULT_CONSTRAINTS,
  ...(process.env.BENCH_CONSTRAINTS ? JSON.parse(await readFile(process.env.BENCH_CONSTRAINTS, "utf8")) : {}) };
for (const [key, value] of Object.entries(constraints))
  if (!(key in DEFAULT_CONSTRAINTS) || !Number.isFinite(value) || value <= 0)
    throw new Error(`Invalid positive finite constraint ${key}`);
if (!Number.isInteger(constraints.radius) || constraints.radius > 12 || constraints.minVisibility > 1)
  throw new Error("Constraint radius must be an integer 1..12 and minVisibility must be in (0,1]");
let browser, context, page, result = { samples: [], errors: [] };
let servedVerified = false;
const errors = [], controlErrors = [], progress = [];
let measured = false;
const viewport = { width: 800, height: 500 };
const args = ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"];
const runtimeLoadBefore = { loadAverage: os.loadavg(), freeMemory: os.freemem() };
const started = performance.now();
try {
  await bounded((async () => {
    const verified = await fetchVerifiedBundle(base, bundle);
    servedVerified = true;
    browser = await chromium.launch({ executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true, args });
    context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const initialStorage = await context.storageState({ indexedDB: true });
    if (initialStorage.cookies.length || initialStorage.origins.length) throw new Error("Nonempty browser storage");
    await context.addInitScript(() => {
      localStorage.setItem("voxelcraft-controls-v1", JSON.stringify({ inputMode: "remote", mouseSensitivity: 1.25 }));
    });
    page = await context.newPage();
    // Pin fetched verified bytes, including workers. A changing independent
    // server cannot substitute another checkout after manifest verification.
    await context.route("**/*", route => {
      const path = new URL(route.request().url()).pathname;
      const bytes = verified.assets.get(path);
      if (bytes) return route.fulfill({ body: bytes,
        contentType: path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" :
          path.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
      if (path.endsWith("/favicon.ico")) return route.fulfill({ status: 204 });
      errors.push(`Unmanifested request: ${route.request().url()}`);
      return route.abort();
    });
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => {
      const target = measured ? controlErrors : errors;
      if (target.length < 50) {
        target.push(e.stack || e.message || String(e));
        void log(`${measured ? "CONTROL" : "PAGE"}ERROR ${e.stack || e.message || String(e)}`);
      }
    });
    page.on("dialog", d => d.dismiss());
    if (configuration.heavyCensus) await page.exposeFunction("__benchmarkSample", sample => {
      progress.push(sample);
      return undefined;
    });
    const url = new URL("test/render-benchmark/index.html", base);
    for (const [key, value] of Object.entries({ seed: scenes[scene].seed, version: scenes[scene].version,
      scene, capture: configuration.capture, configuration: configuration.configuration,
      correctnessProofMs: constraints.correctnessProofMs })) url.searchParams.set(key, value);
    await page.goto(url.href, { waitUntil: "load" });
    await page.waitForFunction(() => window.renderBenchmark?.ready, undefined, { timeout: 45000 });
    await log("READY: actual Game.start returned; normal RAF continues");
    if (configuration.heavyCensus && scenes[scene].region) {
      let profile;
      for (let attempt = 0; attempt < 8; attempt++) {
        profile = await page.evaluate(() => window.renderBenchmark.checkScenePrecondition());
        if (profile.passed) break;
        await page.waitForTimeout(500);
      }
      await log(`SCENE PRECONDITION ${JSON.stringify(profile)}`);
      if (!profile.passed) throw new Error("Native camera-region water/foliage precondition failed; fixture rejected");
    }
    await page.locator(".play-button").click();
    await page.evaluate(() => { window.renderBenchmark.phase = "fresh-spawn-stationary"; });
    await page.waitForTimeout(4000);
    await page.evaluate(() => { window.renderBenchmark.phase = "paid-near-edit-while-streaming"; });
    // Retry only input selection, never invoke a meshing/generation drain.
    for (let i = 0; i < 8; i++) {
      if (await page.evaluate(() => window.renderBenchmark.payEdit())) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    await page.evaluate(() => { window.renderBenchmark.phase = "pan-walk"; });
    await page.mouse.move(400, 250);
    await page.mouse.move(460, 265, { steps: 12 });
    await page.keyboard.down("w");
    await page.waitForTimeout(3000);
    await page.keyboard.up("w");
    await page.mouse.move(400, 250, { steps: 12 });
    await page.evaluate(() => { window.renderBenchmark.phase = "settle"; });
    const remaining = seconds * 1000 - await page.evaluate(() => performance.now() - window.renderBenchmark.started);
    if (remaining > 0) await page.waitForTimeout(remaining);
    result = await page.evaluate(() => window.renderBenchmark.stop());
    measured = true;
    result.machine = await page.evaluate(() => window.renderBenchmark.inspectMachine());
    await page.screenshot({ path: `${output}/settled.png` });
    if (configuration.capture === "correctness" && process.env.BENCH_CONTROLS !== "0") {
      result.pixelControl = await page.evaluate(() => window.renderBenchmark.pixelControl());
      for (const [name, data] of Object.entries(result.pixelControl.images))
        await writeFile(`${output}/control_${name}.png`, Buffer.from(data.split(",")[1], "base64"));
      delete result.pixelControl.images;
      result.lifecycle = await bounded(page.evaluate(() => window.renderBenchmark.lifecycleControl()), 45000, "native lifecycle");
    }
  })(), (seconds + 75) * 1000, "entire benchmark");
} catch (error) {
  (measured ? controlErrors : errors).push(error.stack);
  await log(`ERROR ${error.stack}`);
  if (measured) result.lifecycle ??= { status: "fail", reason: error.message };
  else result = page ? await bounded(page.evaluate(() => window.renderBenchmark?.stop()), 3000, "salvage")
    .catch(() => ({ samples: progress })) : result;
} finally {
  // Only the private benchmark browser closes; existing services remain running.
  if (browser) await bounded(browser.close(), 5000, "close private benchmark browser").catch(e => errors.push(e.message));
}
const after = await provenance();
await writeFile(`${output}/provenance-after.json`, JSON.stringify(after, null, 2));
result ??= { samples: progress };
Object.assign(result, {
  schemaVersion: 3, scene, constraints, wallMs: performance.now() - started,
  capture: configuration.capture, configurationLabel: configuration.configuration,
  errors: [...(result.errors ?? []), ...errors],
  controlErrors,
  runtimeLoad: { before: runtimeLoadBefore, after: { loadAverage: os.loadavg(), freeMemory: os.freemem() },
    qualification: "Shared VM load is not isolated; software-GPU timings remain diagnostics." },
  provenanceStable: before.sourceHash === after.sourceHash && before.sha === after.sha &&
    JSON.stringify(before.dependencies) === JSON.stringify(after.dependencies),
  provenance: { sha: before.sha, sourceHash: before.sourceHash, endSourceHash: after.sourceHash,
    servedVerified, sourceIdentity: bundle.sourceIdentity, manifestHash: bundle.manifestHash,
    sourceRef: bundle.sourceRef, patchHash: bundle.patchHash, sourceMode: bundle.sourceMode,
    frozenRoot: root, sourceHashes: before.hashes,
    harnessHash: hash(JSON.stringify(Object.entries(before.hashes).filter(([name]) => name.startsWith("test/")))),
    dependencies: before.dependencies },
  host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(),
    node: process.version, viewport, browserArgs: args },
  measurementScope: {
    durationSeconds: seconds,
    capture: configuration.capture, configuration: configuration.configuration,
    timer: "performance.now() since benchmark module execution; gameStartMs records actual Game.start entry; never clamped Game.elapsed",
    observerPolicy: configuration.heavyCensus ? "CPU-heavy correctness census; frame timings are observer-influenced, not a clean performance trial" :
      "No census/raycast/readback/screenshot in timed path; bounded constant-size edit publication checks and scalar telemetry measured separately",
    scheduling: "actual Game.start + normal RAF; native generation; no readiness drains",
    route: `${scene}: native collision-safe ${scenes[scene].spawnOrigin ? "pinned origin" : "spawn"}; stationary 4s; paid near edit; trusted mouse +60,+15; W 3s; inverse pan; settle`,
    seedVersion: scenes[scene],
    stockFixture: "2 stone in Survival inventory; one atomically debited block placement, no authored terrain",
    editLatency: "editMs applies only to clean transaction/publication; correctness physical proof is observer-influenced",
    correctnessProofMs: constraints.correctnessProofMs,
    timings: "CPU wall time including driver submissions; update/mesh/draw can nest; not GPU timer queries",
    uploads: "copy bytes, GL bufferData/bufferSubData bytes and mask uploads measured; other texture uploads unavailable",
    coverage: "all-section mounted/layer-compatible freshness by Chebyshev ring; sparse fallback ground rays are not continuous horizon proof",
    visuals: "sparse loaded opaque-cube surface rays + post-measurement A/B/A native-hidden pixels; no continuous no-flicker claim",
  },
});
result.evaluation = evaluateRun(result, constraints);
result.statistics = {
  frames: summarize(result.frameIntervals ?? []),
  timings: Object.fromEntries(Object.entries(result.timings ?? {}).map(([k, v]) => [k, summarize(v)])),
  longTasks: summarize((result.longTasks ?? []).map(t => t.durationMs)),
  observationGapsMs: summarize((result.samples ?? []).slice(1).map((s, i) => s.ms - result.samples[i].ms)),
  preconditionObserverMs: summarize((result.preconditionChecks ?? []).map(p => p.observerMs)),
  uncertainty: "Thresholds are observation-time upper bounds, not exact publication times. Correctness observers/screenshots perturb RAF; no overhead subtraction is claimed.",
};
result.performanceQualified = timingQualified(result, constraints);
result.timingQualification = result.performanceQualified ? "clean-instrumented-diagnostic-not-hardware-qualification" :
  "unqualified-for-speed-comparison";
result.infrastructureFailure = !servedVerified || result.ready !== true;
const witnesses = (result.samples ?? []).flatMap(sample => (sample.surfaces ?? [])
  .filter(surface => surface.witness).map(surface => ({
    frame: sample.frame, startupWallMs: sample.ms, phase: sample.phase,
    cameraPosition: sample.position, yaw: sample.yaw, pitch: sample.pitch,
    gameElapsedSeconds: sample.gameElapsedSeconds, fog: sample.fog, lod: sample.lod, surface,
  })));
await writeFile(`${output}/witnesses.json`, JSON.stringify({
  schemaVersion: 1, provenance: result.provenance, scene, route: scenes[scene],
  capture: configuration, witnesses,
  ownershipWitnesses: (result.samples ?? []).flatMap(sample => (sample.mask?.witnesses ?? [])
    .map(witness => ({ frame: sample.frame, startupWallMs: sample.ms, ...witness }))),
  ownershipWitnessesOmitted: (result.samples ?? []).reduce((n, sample) => n + (sample.mask?.witnessesOmitted ?? 0), 0),
  unavailable: witnesses.length ? null : configuration.heavyCensus ? "No classified witness in this bounded capture" : "Correctness census disabled for performance capture",
}, null, 2));
await writeFile(`${output}/run.json`, JSON.stringify(result, null, 2));
const latest = result.samples?.at(-1);
const summary = [
  `Renderer benchmark: ${scene} / ${scenes[scene].seed} v${scenes[scene].version}`,
  `Capture=${configuration.capture}; configuration=${configuration.configuration}; experimentalPageLocalUpdates=${result.settings?.limits?.experimentalPageLocalUpdates ?? false}`,
  `SHA ${before.sha}; source SHA-256 ${before.sourceHash}; stable=${result.provenanceStable}`,
  `GPU ${result.machine?.renderer ?? "unavailable"}; ${result.evaluation.hardwareQualification}`,
  `Samples ${result.samples?.length ?? 0}; frames ${result.statistics.frames.samples}`,
  `Frame ms p50=${result.statistics.frames.p50} p95=${result.statistics.frames.p95} p99=${result.statistics.frames.p99} max=${result.statistics.frames.max}`,
  `First useful fresh R1 ms: ${result.evaluation.usefulMs ?? (result.evaluation.nativeEvidenceStatus === "observed" ? "unreached" : "unavailable")}`,
  `Paid edit physical proof observation ms (observer-influenced; bound=${constraints.correctnessProofMs}ms): ${result.edit?.visibleMs ?? "unreached/unavailable"}`,
  `Paid edit transaction/publication ms: ${result.edit?.transactionMs ?? "unavailable"} / ${result.edit?.publicationMs ?? "unavailable"}; far-loading=${result.edit?.farStillLoading ?? false}`,
  `Last fog near/far: ${latest?.fog.near ?? "unavailable"} / ${latest?.fog.far ?? "unavailable"}`,
  `Last full native radius: ${latest?.native.available === false ? "unavailable" : latest?.native.fullRadius ?? "unavailable"}; fallback effective radius: ${latest?.lod.effectiveRadius ?? "unavailable"}`,
  ...result.evaluation.thresholds.map(t => `${t.blocks} blocks: full native=${t.fullNativeMs ?? (configuration.heavyCensus ? "unreached" : "unavailable")}ms; sparse fallback+fog=${t.sampledFallbackMs ?? (configuration.heavyCensus ? "unreached" : "unavailable")}ms; fog only=${t.fogVisibilityMs ?? "unreached"}ms`),
  `Hard constraints: ${result.evaluation.hardStatus}`,
  `Timing qualification: ${result.timingQualification}`,
  ...result.evaluation.hard.map(g => `  ${g.status}: ${g.name}; actual=${g.actual ?? "unavailable"} limit=${g.limit ?? "n/a"}`),
  `Pixel control: ${result.pixelControl?.status ?? "unavailable"}; lifecycle: ${result.lifecycle?.status ?? "unavailable"}. No continuous no-flicker claim.`,
  `Observer p95=${result.statistics.timings.observer?.p95 ?? "unavailable"}ms; edit observer p95=${result.statistics.timings.editObserver?.p95 ?? "unavailable"}ms; max sampling gap=${result.statistics.observationGapsMs.max ?? "unavailable"}ms.`,
  `Scene camera-region precondition=${result.scenePrecondition?.passed ?? "not applicable"}; witness count=${witnesses.length}.`,
].join("\n") + "\n";
await writeFile(`${output}/summary.txt`, summary);
await log(summary);
await writeFile(`${output}/run.log`, logLines.join("\n") + "\n");
await writeFile(`${output}/samples.jsonl`, (result.samples ?? progress).map(s => JSON.stringify(s)).join("\n") + "\n");
await mkdir(artifactOutput);
for (const name of await readdir(output)) await writeFile(`${artifactOutput}/${name}`, await readFile(`${output}/${name}`));
console.log(`Artifacts: ${artifactOutput}`);
process.exitCode = exitCodeFor(result, { diagnosticOnly: process.env.BENCH_DIAGNOSTIC_ONLY === "1" });
