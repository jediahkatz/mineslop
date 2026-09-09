// Opt-in automated main-app acceptance; no test entry, Game globals, injected
// action calls, camera writes, edited deadlines or access to an existing profile.
// AQUATIC_RESOURCE_URL=http://127.0.0.1:5182/mineslop/ node --test test/aquatic-resource.browser.integration.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium } from "playwright";
import { ITEM } from "../src/items.js";
import { parseWorldFile } from "../src/storage.js";
import { verifyAquaticExports } from "./aquatic-browser-verify.mjs";
import {
  approachNativeAquatic, checkedAquaticArchive, freezeAquaticResources,
  nativeAquaticResources,
} from "./native-aquatic-resource-fixture.js";
import { chromeExecutable } from "./realtime/config.mjs";

assert.ok(process.env.AQUATIC_RESOURCE_URL, "Supply an isolated frozen main-app preview URL");
const url = new URL(process.env.AQUATIC_RESOURCE_URL);
assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  url.port && !url.username && !url.password && !url.search && !url.hash &&
  !url.pathname.includes("/test/"), "Only a loopback main application is allowed");
const viewport = { width: 1100, height: 800 };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const withoutFluidResidency = (saved) => ({
  ...saved,
  fluids: {
    ...saved.fluids,
    dimensions: saved.fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  },
});

test("main-app input acquires a native cod and preserves actual exported owners across reload and import", {
  timeout: 180000,
}, async (t) => {
  const proof = await nativeAquaticResources(t);
  const target = await approachNativeAquatic(proof, "cod");
  await freezeAquaticResources(proof);
  const { text, saved } = checkedAquaticArchive(proof);
  assert.equal(target.mob.health, 3);
  assert.deepEqual(saved.world.edits, []);
  const output = await mkdtemp(join(tmpdir(), "mineslop-aquatic-browser-"));
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    // Software rendering is sufficient for input/ownership assertions. No
    // hardware frame pacing, lighting or renderer qualification is implied.
    args: ["--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, acceptDownloads: true,
    ...(process.env.AQUATIC_RESOURCE_RECORD === "1"
      ? { recordVideo: { dir: output, size: viewport } } : {}),
  });
  t.after(async () => { await context.close(); await browser.close(); });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  const page = await context.newPage();
  const errors = [], scripts = new Set();
  const report = {
    status: "running", url: url.href, output, viewport,
    setup: ["native v4 cedar-valley terrain and normal population", "supplied plain iron sword",
      "staged underwater starting approach"],
    method: "automated main-app controls and downloaded files; no Game state/action access",
    checkpoints: [],
  };
  const recordingStart = performance.now();
  let stage = "initial load";
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.add(response.url());
  });

  const ready = async () => {
    await page.locator(".play-button").waitFor({ state: "visible", timeout: 70000 });
    await page.waitForFunction(() => !document.querySelector(".play-button")?.disabled);
    assert.equal(await page.locator("#ui").getAttribute("data-menu"), "open");
  };
  const mainMenu = async () => {
    for (let step = 0; step < 3; step++) {
      if (await page.locator(".menu-screen").getAttribute("data-page") === "main") return;
      await page.locator(".menu-back-button").click();
    }
    assert.equal(await page.locator(".menu-screen").getAttribute("data-page"), "main");
  };
  const worldMenu = async () => {
    await mainMenu();
    await page.locator(".world-settings-button").click();
  };
  const importFile = async (contents) => {
    await worldMenu();
    const choosing = page.waitForEvent("filechooser"), confirming = page.waitForEvent("dialog");
    await page.locator(".import-button").click();
    await (await choosing).setFiles({
      name: "native-aquatic-resource.voxelcraft.json", mimeType: "application/json",
      buffer: Buffer.from(contents),
    });
    const dialog = await confirming;
    assert.equal(dialog.type(), "confirm");
    assert.match(dialog.message(), /Replace the active world/);
    await dialog.accept();
    await ready();
    await page.waitForFunction(() =>
      document.querySelector(".storage-status")?.dataset.state === "success");
  };
  const exportFile = async (label) => {
    await worldMenu();
    const downloading = page.waitForEvent("download");
    await page.locator(".export-button").click();
    const download = await downloading, stream = await download.createReadStream();
    assert.equal(await download.failure(), null);
    assert.ok(stream);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const contents = Buffer.concat(chunks).toString("utf8"), parsed = parseWorldFile(contents);
    assert.deepEqual(parsed, JSON.parse(contents), `${label}: lossless export parsing`);
    const path = join(output, `${label}.voxelcraft.json`);
    await writeFile(path, contents, { flag: "wx" });
    report.checkpoints.push({ label, path, sha256: hash(contents) });
    await mainMenu();
    return { text: contents, saved: parsed };
  };

  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 70000 });
    await ready();
    stage = "browser-local options";
    await page.locator(".settings-toggle").click();
    await page.locator(".controls-settings-button").click();
    await page.locator("#input-mode-setting").selectOption("remote");
    await page.locator(".menu-back-button").click();
    await page.locator(".video-settings-button").click();
    await page.locator("#quality-setting").selectOption("low");
    await page.locator("#render-distance-setting").focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#render-distance-setting").inputValue(), "2");
    assert.equal(await page.locator("#fullbright-inspection-setting").isChecked(), false);
    await mainMenu();

    stage = "native checkpoint import";
    await importFile(text);
    const initial = await exportFile("initial");
    assert.deepEqual(withoutFluidResidency(initial.saved), withoutFluidResidency(saved),
      "normal import cannot alter any supplied owner, resource, pose or clock");
    assert.ok([...scripts].some((script) => new URL(script).pathname.includes("/assets/")),
      "the actual compiled main entry must run");
    assert.ok([...scripts].every((script) => !new URL(script).pathname.includes("/test/")),
      "no privileged test entry may be loaded");

    stage = "one primary strike and physical collection";
    report.inputStartSeconds = (performance.now() - recordingStart) / 1000;
    await page.locator(".play-button").click();
    await page.locator(".menu-screen").waitFor({ state: "hidden" });
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    const acquired = page.locator(`.hotbar-slot[data-item="${ITEM.RAW_COD}"]`);
    await page.keyboard.down("w");
    try {
      // Observe the HUD, not a presumed frame rate or a synthetic game clock.
      await acquired.waitFor({ state: "attached", timeout: 3000 });
    } finally {
      await page.keyboard.up("w");
    }
    await delay(150);
    assert.equal(await acquired.count(), 1, "one short input sequence must acquire the cod");
    assert.equal(await acquired.getAttribute("data-count"), "1", "the actual HUD shows one collected cod");
    report.pickupScreenshot = join(output, "native_cod_collected.png");
    await page.screenshot({ path: report.pickupScreenshot });
    await page.keyboard.press("Escape");
    await page.locator(".menu-screen").waitFor({ state: "visible" });
    report.inputEndSeconds = (performance.now() - recordingStart) / 1000;

    stage = "actual save and collected export";
    await worldMenu();
    await page.locator(".save-button").click();
    await page.waitForFunction(() =>
      document.querySelector(".storage-status")?.dataset.state === "success");
    await mainMenu();
    const collected = await exportFile("collected");
    verifyAquaticExports(initial.saved, collected.saved);

    stage = "cold page reload before Play";
    await page.reload({ waitUntil: "load", timeout: 70000 });
    await ready();
    const cold = await exportFile("cold");
    verifyAquaticExports(initial.saved, collected.saved, { restored: [cold.saved] });

    stage = "normal file restore before Play";
    await importFile(collected.text);
    const imported = await exportFile("imported");
    report.results = verifyAquaticExports(initial.saved, collected.saved, {
      restored: [cold.saved, imported.saved],
    });
    assert.deepEqual(errors, []);
    report.status = "PASS";
    report.scripts = [...scripts];
    report.video = await page.video()?.path() ?? null;
    report.limitations = "Automated input/save proof with supplied starting equipment and approach; not manual OS input, unaided acquisition or renderer/performance acceptance.";
    t.diagnostic(JSON.stringify(report));
  } catch (error) {
    report.status = "FAIL";
    report.failure = { stage, message: error.message, pageErrors: errors };
    await page.keyboard.up("w").catch(() => {});
    if (await page.locator(".menu-screen").isHidden().catch(() => false))
      await page.keyboard.press("Escape").catch(() => {});
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    t.diagnostic(JSON.stringify(report));
    throw error;
  } finally {
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
});
