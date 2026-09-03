// PARENT-RUN CHECKPOINT ONLY: build test/native-v4-worker.html as a Vite entry,
// freeze that output, then serve it on a NEW isolated numeric-loopback port.
// Required: VOXELCRAFT_TEST_URL=http://127.0.0.1:<fresh-port>/
// Optional: VOXELCRAFT_NATIVE_V4_BUILD_LABEL=<compile-time VITE_BENCHMARK_LABEL>
// No server startup, HMR, persistent profile, existing browser or source rewrites.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import {
  assertNativeV4FrozenBuild,
  nativeV4BuiltScripts,
  readNativeV4Host,
} from "./native-v4-browser-host.js";
import { firstNativeStructure } from "./native-v4-fixtures.js";
import { chromeExecutable } from "./realtime/config.mjs";

const base = readNativeV4Host(process.env.VOXELCRAFT_TEST_URL);
const url = new URL("/test/native-v4-worker.html", base);
const expectedBuild = process.env.VOXELCRAFT_NATIVE_V4_BUILD_LABEL;

// This isolated compiled page never opens Game, imports a save or contacts a
// shared origin. All worker/fallback plane comparisons run inside the build.
test("actual browser module workers and worker-disabled native Worlds agree in all dimensions and at a natural structure", {
  timeout: 120000, // Seven bounded cases, each using real World worker, fallback and direct packet paths.
}, async (t) => {
  const cases = [];
  for (const dimension of ["overworld", "nether", "end"])
    for (const [cx, cz] of [
      [-1, -1],
      [WORLD_MIN / 16, WORLD_MAX / 16 - 1],
    ])
      cases.push({ seed: "native-v4-browser-transport", dimension, cx, cz });
  const { generator, descriptor } = firstNativeStructure("shipwreck");
  const marker = descriptor.markers.find((entry) => entry.type === "container");
  assert.ok(marker);
  cases.push({
    seed: generator.seed,
    dimension: generator.dimension,
    cx: Math.floor(marker.position.x / 16),
    cz: Math.floor(marker.position.z / 16),
    structureId: descriptor.id,
  });
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  t.after(() => browser.close()); // Only this test's fresh browser, never an existing profile.
  const context = await browser.newContext({ serviceWorkers: "block" });
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] });
  const blocked = [];
  const errors = [];
  const network = [];
  const workers = [];
  let overflow = false;
  const remember = (list, value) => {
    if (list.length < 32) list.push(value);
    else overflow = true;
  };
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(request.protocol) &&
      (request.origin !== url.origin ||
        (request.href !== url.href && !request.pathname.startsWith("/assets/")))
    ) {
      remember(blocked, request.href);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    remember(blocked, socket.url());
    socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  page.on("pageerror", (error) =>
    remember(errors, error.stack ?? error.message)
  );
  page.on("console", (message) => {
    if (message.type() === "error") remember(errors, message.text());
  });
  page.on("requestfailed", (request) =>
    remember(network, {
      url: request.url(),
      error: request.failure()?.errorText,
    })
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      remember(network, { url: response.url(), status: response.status() });
  });
  page.on("worker", (worker) => remember(workers, worker.url()));

  // A non-redirecting read inspects the actual served HTML BEFORE it can execute.
  const preflight = await context.request.get(url.href, {
    timeout: 15000,
    maxRedirects: 0,
  });
  let html;
  try {
    assert.equal(
      preflight.status(),
      200,
      "the frozen fixture must exist without a redirect"
    );
    html = await preflight.text();
    assert.ok(Buffer.byteLength(html) <= 65536);
  } finally {
    await preflight.dispose();
  }
  const scripts = nativeV4BuiltScripts(html, base);
  const response = await page.goto(url.href, { waitUntil: "load" });
  assert.equal(response?.status(), 200);
  assert.equal(response.request().redirectedFrom(), null);
  assert.equal(page.url(), url.href);
  assert.equal(
    await response.text(),
    html,
    "navigation must load the inspected frozen document"
  );
  await page.waitForFunction(
    () => typeof window.__nativeV4Transport?.run === "function"
  );
  const build = await page.evaluate(() => window.__nativeV4Transport.build);
  assertNativeV4FrozenBuild(build, expectedBuild);
  assert.deepEqual(
    await page
      .locator("script")
      .evaluateAll((nodes) => nodes.map((node) => node.src)),
    scripts
  );
  const results = await page.evaluate(
    (input) => window.__nativeV4Transport.run(input),
    cases
  );
  assert.equal(results.length, cases.length);
  assert.ok(results.every((entry) => entry.workerMainThreadGenerations === 0));
  assert.ok(
    results.every(
      (entry) => entry.cellsCompared === (entry.maxY - entry.minY) * 256
    )
  );
  assert.ok(
    results.every((entry) => entry.sections === (entry.maxY - entry.minY) / 16)
  );
  assert.ok(
    results.at(-1).structures.some((entry) => entry.id === descriptor.id)
  );
  assert.equal(
    workers.length,
    cases.length * 2,
    "one genuine World worker and one direct module worker per case"
  );
  for (const worker of workers) {
    const address = new URL(worker);
    assert.equal(address.origin, url.origin);
    assert.match(address.pathname, /^\/assets\/[^/]+\.js$/);
    assert.equal(address.search, "");
    assert.equal(address.hash, "");
  }
  assert.deepEqual(
    await page.evaluate(() => window.__nativeV4Transport.build),
    build
  );
  assert.equal(context.pages().length, 1);
  assert.equal(overflow, false, "no silently truncated browser diagnostics");
  assert.deepEqual(blocked, []);
  assert.deepEqual(network, []);
  assert.deepEqual(errors, []);
  t.diagnostic(
    JSON.stringify({
      proof: "native-v4-default-factory-browser-worker-and-fallback-transport",
      performanceCertification: false,
      host: {
        url: url.href,
        build,
        expectedBuild: expectedBuild ?? null,
        htmlSha256: createHash("sha256").update(html).digest("hex"),
        scripts,
        workers,
        browser: browser.version(),
      },
      results,
    })
  );
});
