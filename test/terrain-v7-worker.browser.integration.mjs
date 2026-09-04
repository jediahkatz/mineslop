// PARENT RUN ONLY. Never starts a server, edits source, or reuses a profile.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { chromeExecutable } from "./realtime/config.mjs";
import { assertV7BrowserBuild, readV7BrowserHost, v7BuiltScripts, V7_BROWSER_SOURCE } from "./terrain-v7-browser-host.js";

const base = readV7BrowserHost(process.env.VOXELCRAFT_TEST_URL);
const url = new URL("/test/terrain-v7-worker.html", base);
const label = process.env.VOXELCRAFT_NATIVE_V7_BUILD_LABEL;
assert.ok(label, "Set the exact compiled VOXELCRAFT_NATIVE_V7_BUILD_LABEL");

test("frozen v7 real module-worker/fallback and native Game staging preserve versions", { timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage"],
  });
  t.after(() => browser.close()); // Only this test's new ephemeral process.
  const context = await browser.newContext({ serviceWorkers: "block" });
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] });
  const blocked = [], errors = [], workers = [], network = [];
  let overflow = false;
  const remember = (list, value) => { if (list.length < 32) list.push(value); else overflow = true; };
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if (["http:", "https:"].includes(target.protocol) &&
        (target.origin !== base.origin || (target.href !== url.href && !/^\/assets\/[^/]+\.js$/.test(target.pathname)))) {
      remember(blocked, target.href); return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => { remember(blocked, socket.url()); socket.close(); });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => remember(errors, error.message));
  page.on("console", (message) => { if (message.type() === "error") remember(errors, message.text()); });
  page.on("requestfailed", (request) => remember(network, { url: request.url(), error: request.failure()?.errorText }));
  page.on("response", (response) => { if (response.status() >= 400) remember(network, { url: response.url(), status: response.status() }); });
  page.on("worker", (worker) => remember(workers, worker.url()));
  const preflight = await context.request.get(url.href, { timeout: 15000, maxRedirects: 0 });
  let html;
  try {
    assert.equal(preflight.status(), 200, "frozen fixture must not redirect");
    html = await preflight.text();
    assert.ok(Buffer.byteLength(html) <= 65536);
  } finally { await preflight.dispose(); }
  const scripts = v7BuiltScripts(html, base);
  const response = await page.goto(url.href, { waitUntil: "load", timeout: 30000 });
  assert.equal(response.status(), 200);
  assert.equal(response.request().redirectedFrom(), null);
  assert.equal(page.url(), url.href);
  assert.equal(await response.text(), html);
  await page.waitForFunction(() => typeof window.__v7NativeBrowser?.run === "function");
  const build = await page.evaluate(() => window.__v7NativeBrowser.build);
  assertV7BrowserBuild(build, V7_BROWSER_SOURCE, label);
  assert.deepEqual(await page.locator("script").evaluateAll((nodes) => nodes.map((node) => node.src)), scripts);
  const result = await page.evaluate(() => window.__v7NativeBrowser.run());
  assert.deepEqual(result.cases.map(({ label }) => label),
    ["pillar0", "pillar5", "bowl", "shipwreck", "nether_fortress"]);
  assert.ok(result.cases.every((row) => row.worldMainThreadChunks === 0 &&
    row.fallbackChunks === 4 && row.cacheReload && row.cellsPerChunk === (row.spec.maxY - row.spec.minY) * 256));
  assert.deepEqual(result.cases[0].guards, [
    { replay: "stale-epoch-and-unknown-id", admitted: 1, fallback: false },
    { replay: "foreign-v6", admitted: 1, fallback: true },
  ]);
  assert.deepEqual(result.staging.map(({ version }) => version), [3, 7, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(result.staging.every((row) => row.chunks === 49 && row.worker));
  assert.deepEqual(result.staging.slice(0, 2).map((row) => [row.dimension, row.spec.minY, row.spec.maxY]),
    [["overworld", 0, 96], ["overworld", -64, 320]]);
  assert.equal(workers.length, 21, "ten transport workers, two replay guards, nine native staging workers");
  for (const worker of workers) {
    const address = new URL(worker);
    assert.equal(address.origin, base.origin);
    assert.match(address.pathname, /^\/assets\/[^/]+\.js$/);
    assert.equal(address.search, ""); assert.equal(address.hash, "");
  }
  assert.deepEqual(await page.evaluate(() => window.__v7NativeBrowser.build), build);
  assert.equal(context.pages().length, 1);
  assert.equal(overflow, false);
  assert.deepEqual(blocked, []); assert.deepEqual(network, []); assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify({
    proof: "v7-real-module-worker-world-fallback-game-staging",
    host: { url: url.href, build, htmlSha256: createHash("sha256").update(html).digest("hex"),
      scripts, workers, browser: browser.version() },
    ...result,
  }));
});
