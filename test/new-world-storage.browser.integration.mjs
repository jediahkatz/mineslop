// Real IndexedDB context-loss proof; no UI/GPU interaction or shared profile.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { chromeExecutable } from "./realtime/config.mjs";

test("closing a tab inside replacement activation preserves the complete old IndexedDB archive", { timeout: 60000 }, async (t) => {
  const server = await createServer({
    configFile: false, root: process.cwd(), base: "/",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "storage-context-loss-proof",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/__storage-proof") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(`<script type="module">
            import { WorldStorage } from "/src/storage.js";
            window.storage = new WorldStorage({name: "isolated-new-world-proof"});
            window.records = async () => {
              const {metadata, chunks} = await storage.readRecords();
              return JSON.stringify({metadata, chunks});
            };
          </script>`);
        });
      },
    }],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__storage-proof`;
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!window.storage);
  const before = await page.evaluate(async () => {
    // Archive fixture only. This is not a Survival/resource acceptance claim.
    await storage.save({
      version: 3, world: { version: 3, seed: "precious-world", generatorVersion: 3,
        dimension: "overworld", edits: [["overworld", 5, 20, 6, 7, 0, 0]] },
      quality: "low", soundEnabled: false, time: 0.62,
    });
    localStorage.setItem("voxelcraft-world-v1", "untouched legacy bytes");
    localStorage.setItem("mineslop-proof-preferences", "untouched device preferences");
    return records();
  });
  const debuggerSession = await context.newCDPSession(page);
  await debuggerSession.send("Debugger.enable");
  const paused = new Promise((resolve) => debuggerSession.once("Debugger.paused", resolve));
  const operation = page.evaluate(async () => {
    const candidate = {
      version: 3, world: { version: 3, seed: "candidate", generatorVersion: 7,
        dimension: "overworld", edits: [] },
      quality: "low", soundEnabled: false,
    };
    await storage.replace(candidate, () => {
      // Stop with the old chunks cleared and new metadata queued, before the
      // transaction may commit. Context destruction must abort, not publish.
      debugger;
    });
  }).catch(() => {});
  await paused;
  await page.close({ runBeforeUnload: false });
  await operation;
  const reloaded = await context.newPage();
  await reloaded.goto(url);
  await reloaded.waitForFunction(() => !!window.storage);
  const after = await reloaded.evaluate(async () => ({
    records: await records(), archive: await storage.load(),
    legacy: localStorage.getItem("voxelcraft-world-v1"),
    preferences: localStorage.getItem("mineslop-proof-preferences"),
  }));
  assert.equal(after.records, before, "metadata/revision/timestamp/chunks survive abrupt context loss byte-for-byte");
  assert.equal(after.archive.world.seed, "precious-world");
  assert.equal(after.legacy, "untouched legacy bytes");
  assert.equal(after.preferences, "untouched device preferences");
});
