import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const prefix = "/voxelcraft/";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
};

// No root assets or SPA fallback: an incorrect Vite base must fail here.
async function serveBuild(t) {
  const root = resolve(dist);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname
      );
      if (!pathname.startsWith(prefix)) throw new Error("Outside project path");
      const file = resolve(root, pathname.slice(prefix.length) || "index.html");
      if (!file.startsWith(`${root}${sep}`)) throw new Error("Outside build");
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}

function readSavedWorld(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open("voxelcraft-worlds", 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("worlds", "readonly");
      const reading = transaction.objectStore("worlds").get("active");
      reading.onsuccess = () => resolve(reading.result ?? null);
      reading.onerror = () => reject(reading.error);
      transaction.oncomplete = () => db.close();
    };
  }));
}

async function waitForSave(page, revision = null) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const saved = await readSavedWorld(page);
    // WorldStorage uses opaque random revision tokens, not an ordered counter.
    if (typeof saved?.revision === "string" && saved.revision !== revision)
      return saved;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("The real game did not commit a new IndexedDB save");
}

test("production entrypoints, font and worker use the Pages project prefix", async () => {
  const html = await readFile(resolve(dist, "index.html"), "utf8");
  assert.doesNotMatch(html, /\/@vite\/|\/src\/main\.js|__voxelBot/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith(".js")));
  assert.ok(assets.some((asset) => asset.endsWith(".css")));
  assert.ok(assets.includes(`${prefix}favicon.svg`));
  for (const asset of assets) {
    assert.ok(asset.startsWith(prefix), `Incorrect project asset URL: ${asset}`);
    const content = await readFile(resolve(dist, asset.slice(prefix.length)));
    assert.ok(content.length > 0, `Missing build asset: ${asset}`);
    if (asset.endsWith(".css")) {
      assert.match(content.toString(), /\/voxelcraft\/fonts\/Monocraft-Regular\.ttf/);
    }
    if (asset.endsWith(".js")) {
      assert.match(content.toString(), /\/voxelcraft\/assets\/terrain\.worker-[^"']+\.js/);
    }
  }
});

test("Pages-path production game loads a worker and preserves a real save on reload", {
  timeout: 180000,
}, async (t) => {
  const url = await serveBuild(t);
  const browser = await chromium.launch({
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 640 },
    serviceWorkers: "block",
  });
  t.after(() => browser.close());
  const page = await context.newPage();
  const failures = [];
  const workers = [];
  const requests = new Set();
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("requestfailed", (request) => failures.push(
    `${request.url()}: ${request.failure()?.errorText}`
  ));
  page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
    requests.add(response.url());
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".play-button").waitFor({ state: "visible", timeout: 90000 });
  assert.ok(workers.some((worker) =>
    worker.startsWith(`${url}assets/terrain.worker-`)
  ), "The real production terrain worker starts under the Pages path");
  assert.equal(await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "Voxelcraft"');
  }), true);
  assert.equal(await page.locator("#game canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    return !!gl && !gl.isContextLost() && canvas.width > 0 && canvas.height > 0;
  }), true, "The game owns a live WebGL2 canvas");

  // Select remote controls through the real UI in this disposable profile.
  await page.locator(".settings-toggle").click();
  await page.locator(".controls-settings-button").click();
  await page.locator("#input-mode-setting").selectOption("remote");
  await page.locator(".menu-back-button").click();
  await page.locator(".menu-back-button").click();
  await page.locator(".play-button").click();
  await page.locator(".menu-screen").waitFor({ state: "hidden" });
  const before = await readSavedWorld(page);
  await page.keyboard.down("ArrowRight");
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const frame = () => ++frames === 10 ? resolve() : requestAnimationFrame(frame);
    requestAnimationFrame(frame);
  }));
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("KeyP");
  const saved = await waitForSave(page, before?.revision ?? null);
  await page.keyboard.press("Escape");
  const preferences = await page.evaluate(() =>
    localStorage.getItem("voxelcraft-controls-v1")
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".play-button").waitFor({ state: "visible", timeout: 90000 });
  await page.locator(".world-settings-button").click();
  await page.locator(".save-button").click();
  const restored = await waitForSave(page, saved.revision);
  assert.equal(restored.snapshot.world.seed, saved.snapshot.world.seed);
  assert.equal(restored.snapshot.world.generatorVersion, saved.snapshot.world.generatorVersion);
  assert.equal(restored.snapshot.player.yaw, saved.snapshot.player.yaw);
  assert.equal(restored.snapshot.gameplay.health, saved.snapshot.gameplay.health);
  assert.equal(await page.evaluate(() =>
    localStorage.getItem("voxelcraft-controls-v1")
  ), preferences);
  assert.deepEqual(failures, []);
  for (const request of requests)
    assert.ok(request.startsWith(url), `Request escaped the Pages path: ${request}`);
  t.diagnostic(`${requests.size} project-path resources; native terrain worker; WebGL2; saved camera, world, health and controls survive reload.`);
});
