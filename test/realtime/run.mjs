import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { chromeExecutable, readConfig, usage } from "./config.mjs";
import { bounded, RealInputs } from "./input.mjs";
import {
  assertion,
  checkMenus,
  checkSurvivalFixture,
  traverseTerrain,
  verifyNativeMouse,
} from "./scenarios.mjs";
import { evaluateBudgets } from "./statistics.js";
import { runNaturalSurvival } from "./survival.mjs";

async function run(config) {
  const started = performance.now();
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    config,
    environment: {
      platform: platform(),
      architecture: arch(),
      node: process.version,
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    methodology: {
      application:
        "Actual VoxelGame, World, Player, GameRenderer, Wildlife, and archive",
      isolation:
        "New headless browser process and non-persistent Playwright context; no shared IndexedDB, localStorage, or manual-GUI profile",
      inputs:
        "Trusted Chromium keyboard/mouse input via Playwright/CDP; no dispatchEvent, direct motion writes, fake RAF, or accelerated game clock",
      benchmark:
        "Continuous real generated terrain; measurements exclude warmup and synthetic fixture setup",
      frameClock:
        "Unclamped requestAnimationFrame timestamps; FPS is not the in-game smoothed HUD value",
      cpuClock:
        "Synchronous inclusive performance.now() timings, including nested instrumentation overhead; not GPU-completion times",
      inputClock:
        "DOM capture to actual player/camera update, not OS-to-DOM or input-to-photon latency",
      thresholdPolicy:
        "Performance is reported for every renderer. Only explicitly configured budgets fail performance.",
    },
    assertions: [],
    warnings: [],
    errors: [],
    pageErrors: [],
    pageErrorCount: 0,
    consoleErrors: [],
    failedRequests: [],
  };
  let browser;
  let context;
  let input;
  let stage = "browser-startup";
  try {
    const executablePath = await chromeExecutable(config.chromeBin);
    // Allow Chrome's software fallback, but do not force a GPU/ANGLE backend.
    const args = ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"];
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args,
      timeout: 60000,
    });
    report.browser = {
      version: browser.version(),
      executablePath,
      headless: true,
      additionalLaunchArguments: args,
    };
    context = await browser.newContext({
      viewport: config.viewport,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    page.on("pageerror", (error) => {
      report.pageErrorCount++;
      if (report.pageErrors.length < 100)
        report.pageErrors.push({ message: error.message, stack: error.stack });
    });
    page.on("crash", () =>
      report.errors.push({ stage, message: "Headless renderer crashed" })
    );
    page.on("console", (message) => {
      if (message.type() === "error" && report.consoleErrors.length < 100)
        report.consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      if (report.failedRequests.length < 100)
        report.failedRequests.push({
          url: request.url(),
          error: request.failure()?.errorText ?? "unknown",
        });
    });
    stage = "loading-real-game";
    console.log(`[start] ${config.url}`);
    await page.goto(config.url, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 120000 }
    );
    input = new RealInputs(page, config);
    const initial = await input.state({ renderer: true });
    if (!initial.ready || initial.error)
      throw new Error(initial.error ?? "Driver not ready");
    report.initial = initial;
    report.renderer = initial.renderer;
    report.browser.userAgent = await page.evaluate(() => navigator.userAgent);
    report.loadElapsedMs = performance.now() - started;
    try {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const info = await bounded(
          cdp.send("SystemInfo.getInfo"),
          5000,
          "Reading GPU information"
        );
        report.browser.gpu = {
          devices: info.gpu.devices,
          featureStatus: info.gpu.featureStatus,
          auxAttributes: info.gpu.auxAttributes,
        };
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      report.warnings.push({
        name: "CDP GPU details unavailable",
        evidence: error.message,
      });
    }
    stage = "native-mouse-verification";
    await verifyNativeMouse(input, report);
    stage = "generated-terrain-traversal";
    await traverseTerrain(input, report);
    if (config.screenshot) {
      stage = "optional-generated-terrain-capture";
      await mkdir(dirname(config.screenshot), { recursive: true });
      await page.screenshot({ path: config.screenshot });
      report.screenshot = {
        path: config.screenshot,
        label:
          "Automated real generated-terrain view after the benchmark; no synthetic fixture",
      };
    }
    stage = "inventory-and-pause-controls";
    await checkMenus(input, report);
    if (config.naturalSurvival) {
      stage = "natural-survival-progression";
      await runNaturalSurvival(input, report);
    }
    if (config.syntheticControls) {
      stage = "synthetic-survival-controls";
      await checkSurvivalFixture(input, report);
    }
    report.final = await input.state({ renderer: true });
    stage = "complete";
  } catch (error) {
    report.errors.push({ stage, message: error.message, stack: error.stack });
    console.error(`[failed] ${stage}: ${error.message}`);
  } finally {
    if (input) {
      report.inputCommands = input.counts;
      try {
        report.lastObserved = await bounded(input.state(), 5000, "Final state");
        await bounded(input.release(), 5000, "Release bot inputs");
      } catch (error) {
        report.warnings.push({
          name: "Final input cleanup",
          evidence: error.message,
        });
      }
    }
    // Only the harness-owned isolated context/process is closed. The Vite server
    // and any existing manual QA browser are neither attached to nor touched.
    if (context) {
      try {
        await bounded(context.close(), 10000, "Closing isolated context");
      } catch (error) {
        report.warnings.push({
          name: "Context cleanup",
          evidence: error.message,
        });
      }
    }
    if (browser) {
      try {
        await bounded(browser.close(), 10000, "Closing harness browser");
      } catch (error) {
        report.warnings.push({
          name: "Browser cleanup",
          evidence: error.message,
        });
      }
    }
  }
  if (report.initial?.ready)
    assertion(report, "No uncaught page errors", report.pageErrorCount === 0, {
      count: report.pageErrorCount,
      errors: report.pageErrors,
    });
  report.performanceBudgets = evaluateBudgets(report.terrain, config.budgets);
  const functionalFailure =
    report.errors.length > 0 ||
    report.assertions.some((entry) => entry.status === "failed");
  const performanceFailure = report.performanceBudgets.some(
    (budget) => !budget.passed
  );
  const incompleteCoverage = report.assertions.some(
    (entry) => entry.status === "skipped"
  );
  report.status = functionalFailure
    ? "failed"
    : performanceFailure
      ? "performance-budget-failed"
      : report.warnings.length || incompleteCoverage
        ? "passed-with-warnings"
        : "passed";
  report.elapsedMs = performance.now() - started;
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(
    config.output,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  const frames = report.terrain?.frames;
  const format = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
  console.log(
    `[${report.status}] FPS ${format(frames?.fps.average)}, ` +
      `frame p95/p99 ${format(frames?.intervalMs.p95)}/${format(frames?.intervalMs.p99)} ms, ` +
      `mouse ${report.mouse?.mode ?? "not-tested"}, ` +
      `software renderer ${report.renderer?.softwareRenderer ?? "unknown"}`
  );
  console.log(`JSON report: ${config.output}`);
  process.exitCode = functionalFailure ? 1 : performanceFailure ? 2 : 0;
}

try {
  const config = readConfig();
  if (config.help) console.log(usage);
  else await run(config);
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
