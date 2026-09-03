import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { chromeExecutable } from "../realtime/config.mjs";
import { CAPTURE_KIND, SURFACES } from "./coverage.js";
import { sheetPlan } from "./plan.js";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const { values } = parseArgs({
  options: {
    group: { type: "string" },
    ids: { type: "string" },
    set: { type: "string" },
    page: { type: "string" },
    labels: { type: "string" },
    light: { type: "string" },
    seed: { type: "string" },
    output: { type: "string" },
    url: { type: "string" },
  },
});
const plan = sheetPlan(values);
const base = new URL(values.url ?? process.env.MINESLOP_BLOCK_ART_URL ?? "http://127.0.0.1:5176");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
  throw new Error("Review URL must be HTTP(S) without credentials");
const url = new URL("/test/block-art-review/index.html", base);
for (const [key, value] of Object.entries(plan.selection))
  if (value !== null) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
const fingerprint = await sourceFingerprint();
const browser = await chromium.launch({
  executablePath: await chromeExecutable(process.env.CHROME_BIN),
  headless: true,
  args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1536, height: 1100 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(
    `${request.url()}: ${request.failure()?.errorText}`,
  ));
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() =>
    window.__mineslopBlockArtReview?.ready || window.__mineslopBlockArtReview?.error);
  assert.equal(await page.evaluate(() => window.__mineslopBlockArtReview.error), null);
  const snapshot = await page.evaluate(() => window.__mineslopBlockArtReview.snapshot());
  assert.equal(snapshot.kind, CAPTURE_KIND);
  assert.equal(snapshot.build.sourceFingerprint, fingerprint, "Build is stale; rebuild before capture");
  assert.deepEqual(snapshot.selection, plan.selection);
  assert.deepEqual(snapshot.cases.map(({ id, key }) => ({ id, key })),
    plan.cases.map(({ id, key }) => ({ id, key })));
  for (const entry of snapshot.cases) {
    assert.deepEqual(entry.surfaces, SURFACES);
    assert.equal(entry.frames.length, 3);
    for (const frame of entry.frames) {
      assert.equal(frame.glError, 0);
      assert.equal(frame.contextLost, false);
      assert.equal(frame.failedPrograms, 0);
    }
    for (const shape of entry.shapes) {
      if (shape.link) assert.equal(shape.link.valid, true, `Broken multipart ${entry.id}/${entry.key}`);
      if (shape.attachment) assert.equal(shape.attachment.valid, true, `Unsupported attachment ${entry.id}/${entry.key}`);
    }
  }
  assert.deepEqual(errors, []);
  const png = await page.locator("#review").screenshot({ animations: "disabled" });
  assert.equal(await sourceFingerprint(), fingerprint, "Source changed during capture");
  assert.deepEqual(errors, []);
  // Write only successful, actual captures. Never overwrite immutable artifacts.
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = resolve(values.output ??
    `/opt/cursor/artifacts/mineslop_block_art_${stamp}_${randomUUID()}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const report = {
    kind: CAPTURE_KIND,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    browser: browser.version(),
    url: url.href,
    artifact: {
      path: "sheet.png",
      sha256: createHash("sha256").update(png).digest("hex"),
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    },
    snapshot,
    errors,
    // Deliberately never called "passed" or "approved".
    visualReview: "unreviewed",
  };
  await writeFile(resolve(output, "sheet.png"), png, { flag: "wx" });
  await writeFile(resolve(output, "capture.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    output, cases: snapshot.cases.map(({ id, key, token }) => ({ id, key, token })),
    sourceFingerprint: fingerprint, visualReview: "unreviewed",
  }, null, 2));
} finally {
  // Only this runner's disposable browser is closed; the existing server is untouched.
  await browser.close();
}
