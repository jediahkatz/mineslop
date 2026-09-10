// Explicit frozen main-app host only; run under the parent VM's GPU lease.
// NEARBY_RENDER_URL=http://127.0.0.1:5183/mineslop/ node --test test/render-mode.browser.integration.mjs
// Automated UI/resource/save proof, not a frame-time or lighting qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { ITEM } from "../src/items.js";
import { RENDER_DISTANCE_KEY } from "../src/render-distance-preferences.js";
import { RENDER_MODE_KEY } from "../src/render-mode-preferences.js";
import { parseWorldFile } from "../src/storage.js";
import { verifyAquaticExports } from "./aquatic-browser-verify.mjs";
import {
  approachNativeAquatic, checkedAquaticArchive, freezeAquaticResources,
  nativeAquaticResources,
} from "./native-aquatic-resource-fixture.js";
import { chromeExecutable } from "./realtime/config.mjs";

assert.ok(process.env.NEARBY_RENDER_URL, "Supply an isolated frozen main-app URL");
const url = new URL(process.env.NEARBY_RENDER_URL);
assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
  url.port && !url.username && !url.password && !url.search && !url.hash &&
  !url.pathname.includes("/test/"), "Use an explicit loopback main-app origin");
const viewport = { width: 1100, height: 800 };
const legacyDistance = " \n12 ";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const withoutFluidResidency = (saved) => ({
  ...saved,
  fluids: {
    ...saved.fluids,
    dimensions: saved.fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  },
});

test("Nearby UI preserves extended preferences and native Survival resources through switches, reload and import", {
  timeout: 240000,
}, async (t) => {
  const proof = await nativeAquaticResources(t);
  await approachNativeAquatic(proof, "cod");
  await freezeAquaticResources(proof);
  const source = checkedAquaticArchive(proof);
  // Graphics quality is an existing world-save field; the new mode/distance
  // preferences are browser-local. Import must preserve this distinction.
  const sourceQuality = source.saved.quality;
  assert.equal(sourceQuality, "low");
  const output = await mkdtemp(join(tmpdir(), "mineslop-nearby-browser-"));
  const executablePath = await chromeExecutable(process.env.CHROME_BIN);
  const browser = await chromium.launch({
    executablePath, headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  let context;
  t.after(async () => { await context?.close(); await browser.close(); });
  context = await browser.newContext({
    viewport, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: "block",
    ...(process.env.NEARBY_RENDER_RECORD === "1"
      ? { recordVideo: { dir: output, size: viewport } } : {}),
  });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  await context.addInitScript(({ origin, key, value }) => {
    if (location.origin === origin && localStorage.getItem(key) === null)
      localStorage.setItem(key, value);
  }, { origin: url.origin, key: RENDER_DISTANCE_KEY, value: legacyDistance });
  const recordingStart = performance.now();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [], scripts = new Set(), requests = [];
  const report = {
    status: "running", url: url.href, output, viewport, executablePath,
    method: "compiled main app, trusted browser inputs and actual downloaded saves; no Game globals",
    setup: ["native v4 cedar-valley terrain and population", "supplied plain iron sword",
      "authored initial underwater approach", "fresh context with legacy distance bytes only"],
    settings: [], checkpoints: [],
  };
  let stage = "load";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" ||
        /GL_INVALID_|GL_OUT_OF_MEMORY|CONTEXT_LOST_WEBGL|Shader Error/.test(message.text()))
      errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.add(response.url());
    if (response.status() >= 400) requests.push({ url: response.url(), status: response.status() });
  });
  await context.route("**/*", (route) => {
    const requested = new URL(route.request().url());
    if (["http:", "https:"].includes(requested.protocol) && requested.origin !== url.origin) {
      requests.push({ url: requested.href, blocked: true });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });

  const ready = async () => {
    await page.locator(".play-button").waitFor({ state: "visible", timeout: 70000 });
    await page.waitForFunction(() => !document.querySelector(".play-button")?.disabled);
    assert.equal(await page.locator("#ui").getAttribute("data-menu"), "open");
  };
  const mainMenu = async () => {
    for (let step = 0; step < 4; step++) {
      if (await page.locator(".menu-screen").getAttribute("data-page") === "main") return;
      await page.locator(".menu-back-button").click();
    }
    assert.equal(await page.locator(".menu-screen").getAttribute("data-page"), "main");
  };
  const settings = async (section) => {
    await mainMenu();
    if (section === "world") await page.locator(".world-settings-button").click();
    else {
      await page.locator(".settings-toggle").click();
      await page.locator(`.${section}-settings-button`).click();
    }
    await page.locator(`[data-menu-page="${section}"]`).waitFor({ state: "visible" });
  };
  const preferences = () => page.evaluate(({ distanceKey, modeKey }) => ({
    distance: localStorage.getItem(distanceKey),
    mode: localStorage.getItem(modeKey),
    controls: localStorage.getItem("voxelcraft-controls-v1"),
    view: localStorage.getItem("voxelcraft-view-v1"),
  }), { distanceKey: RENDER_DISTANCE_KEY, modeKey: RENDER_MODE_KEY });
  const assertSettings = async (mode, radius, quality = "medium") => {
    assert.equal(await page.locator("#render-mode-setting").inputValue(), mode);
    assert.equal(await page.locator("#render-distance-setting").inputValue(), String(radius));
    assert.equal(await page.locator("#render-distance-setting").getAttribute("max"),
      mode === "nearby" ? "4" : "12");
    assert.equal(await page.locator("#render-distance-value").textContent(), `${radius} chunks (${radius * 16} blocks)`);
    assert.equal(await page.locator("#quality-setting").inputValue(), quality);
    assert.equal(await page.locator("#fullbright-inspection-setting").isChecked(), false);
    const stored = await preferences();
    assert.equal(stored.distance, legacyDistance, "Nearby, mode and quality changes retain legacy bytes");
    report.settings.push({ mode, radius, quality, stored,
      elapsedSeconds: (performance.now() - recordingStart) / 1000 });
  };
  const setDistance = async (radius) => {
    await page.locator("#render-distance-setting").focus();
    await page.keyboard.press("Home");
    for (let step = 2; step < radius; step++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Tab");
  };
  const exportFile = async (label) => {
    await settings("world");
    const downloading = page.waitForEvent("download");
    await page.locator(".export-button").click();
    const download = await downloading, stream = await download.createReadStream();
    assert.equal(await download.failure(), null);
    assert.ok(stream);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert.ok(bytes <= 32 * 1024 * 1024);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    // Keep the actual download inspectable even when export validation fails.
    const path = join(output, `${label}.voxelcraft.json`);
    await writeFile(path, text, { flag: "wx" });
    report.checkpoints.push({ label, path, sha256: hash(text) });
    const saved = parseWorldFile(text);
    assert.deepEqual(saved, JSON.parse(text), "normal export parsing is lossless");
    assert.doesNotMatch(text, /"(?:renderModePreferences|renderSettings|nearbyRadius|renderDistance)"\s*:/,
      "device rendering preferences do not enter world files");
    await mainMenu();
    return { text, saved };
  };
  const importFile = async (text) => {
    await settings("world");
    const choosing = page.waitForEvent("filechooser"), confirming = page.waitForEvent("dialog");
    await page.locator(".import-button").click();
    await (await choosing).setFiles({
      name: "nearby-native-resources.voxelcraft.json", mimeType: "application/json",
      buffer: Buffer.from(text),
    });
    const dialog = await confirming;
    assert.equal(dialog.type(), "confirm");
    assert.match(dialog.message(), /Replace the active world/);
    await dialog.accept();
    await ready();
    // HUD refresh can replace the transient success toast with the durable
    // saved/idle label. The action's busy gate and subsequent exact export,
    // not that toast's lifetime, establish completed and lossless import.
    const status = await page.evaluate(() => ({
      busy: document.querySelector(".menu-screen")?.getAttribute("aria-busy"),
      state: document.querySelector(".storage-status")?.dataset.state,
      text: document.querySelector(".storage-status")?.textContent,
    }));
    assert.equal(status.busy, "false");
    assert.ok(status.state === "success" ||
      (status.state === "idle" && status.text === "Saved on this device"), JSON.stringify(status));
  };
  const save = async () => {
    await settings("world");
    await page.locator(".save-button").click();
    await page.waitForFunction(() => {
      const button = document.querySelector(".save-button");
      return button && !button.disabled &&
        document.querySelector(".menu-screen")?.getAttribute("aria-busy") === "false";
    });
    // Like import, save completion survives the HUD's success-to-idle update.
    // Cold reload and exact exported ownership below remain the persistence proof.
    const status = await page.locator(".storage-status").evaluate((node) => ({
      state: node.dataset.state, text: node.textContent,
    }));
    assert.ok(status.state === "success" ||
      (status.state === "idle" && status.text === "Saved on this device"), JSON.stringify(status));
    await mainMenu();
  };
  const trackingHud = () => page.evaluate(() => new Promise((resolve, reject) => {
    // Observe two real RAF callbacks after a drag, never advance the game's clock.
    // A stalled/hidden page fails this observation instead of extending pickup.
    let raf, firstFrame, remaining = 2;
    const timer = setTimeout(() => {
      cancelAnimationFrame(raf);
      reject(new Error("Tracking HUD did not receive two animation frames"));
    }, 3000);
    const frame = (at) => {
      if (--remaining) { firstFrame = at; raf = requestAnimationFrame(frame); return; }
      clearTimeout(timer);
      const $ = (selector) => document.querySelector(selector);
      const combat = $(".combat-indicator"), canvas = $("canvas[data-input-mode]");
      resolve({
        at: performance.now(), frameMs: at - firstFrame,
        focused: document.hasFocus(), visibility: document.visibilityState,
        menuHidden: $(".menu-screen")?.hidden, overlay: $("#ui")?.dataset.overlay,
        mode: canvas?.dataset.inputMode, looking: canvas?.dataset.looking,
        target: $(".target-label")?.textContent,
        combat: { hidden: combat?.hidden, phase: combat?.dataset.phase, blocked: combat?.dataset.blocked },
        coordinates: ["x", "y", "z"].map((axis) => $(`[data-coordinate="${axis}"]`)?.textContent),
      });
    };
    raf = requestAnimationFrame(frame);
  }));

  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 70000 });
    await ready();
    report.settingsStartedSeconds = (performance.now() - recordingStart) / 1000;
    await settings("video");
    await assertSettings("nearby", 3);
    assert.equal((await preferences()).mode, null, "default loading is read-only");
    assert.ok([...scripts].some((script) => new URL(script).pathname.includes("/assets/")));
    assert.ok([...scripts].every((script) => !new URL(script).pathname.includes("/test/")));

    stage = "preset and independent distance controls";
    for (const [quality, radius] of [["low", 2], ["high", 4], ["medium", 3]]) {
      await page.locator("#quality-setting").selectOption(quality);
      await assertSettings("nearby", radius, quality);
      assert.equal((await preferences()).mode, null, "quality changes do not pin distance");
    }
    await setDistance(2);
    await assertSettings("nearby", 2);
    await page.locator("#quality-setting").selectOption("high");
    await assertSettings("nearby", 2, "high");
    await page.locator("#quality-setting").selectOption("medium");
    await page.locator("#render-mode-setting").selectOption("extended");
    await assertSettings("extended", 12);
    await page.locator("#render-mode-setting").selectOption("nearby");
    await assertSettings("nearby", 2);
    await setDistance(3);
    await assertSettings("nearby", 3);
    report.settingsScreenshot = join(output, "nearby_options.png");
    await page.screenshot({ path: report.settingsScreenshot });
    report.settingsFinishedSeconds = (performance.now() - recordingStart) / 1000;
    await settings("controls");
    await page.locator("#input-mode-setting").selectOption("remote");
    const acceptedPreferences = await preferences();

    stage = "native source import and paused mode round trip";
    await importFile(source.text);
    const initial = await exportFile("initial");
    assert.deepEqual(withoutFluidResidency(initial.saved), withoutFluidResidency(source.saved));
    await settings("video");
    await assertSettings("nearby", 3, sourceQuality);
    await page.locator("#render-mode-setting").selectOption("extended");
    await assertSettings("extended", 12, sourceQuality);
    await page.locator("#render-mode-setting").selectOption("nearby");
    await assertSettings("nearby", 3, sourceQuality);
    assert.deepEqual(await preferences(), acceptedPreferences);
    const switched = await exportFile("switched");
    assert.deepEqual(withoutFluidResidency(switched.saved), withoutFluidResidency(initial.saved),
      "render-only switching does not change native resource owners, world edits, pose or clocks");

    stage = "trusted Remote tracking, primary strike and swimming pickup";
    report.inputStartedSeconds = (performance.now() - recordingStart) / 1000;
    await page.locator(".play-button").click();
    await page.locator(".menu-screen").waitFor({ state: "hidden" });
    const acquired = page.locator(`.hotbar-slot[data-item="${ITEM.RAW_COD}"]`);
    // Close on the fleeing fish before attacking: melee reach alone does not
    // put a sinking item inside the feet's collection volume. Only live HUD
    // observations authorize the strike; the imported aim is a starting point.
    const offsets = [-32, 16];
    const x = viewport.width / 2, centerY = viewport.height / 2;
    const initialFeetCell = Math.floor(initial.saved.player.y);
    report.tracking = { offsets, maxObservations: 8, samples: [], firstContact: null, strike: null };
    let offsetIndex = 0, y = centerY;
    let nextY = centerY - offsets[0], inputFailure;
    try {
      await page.keyboard.down("w");
      await page.keyboard.down("ControlLeft");
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "right" });
      for (let observation = 0; observation < report.tracking.maxObservations; observation++) {
        if (nextY !== y) { await page.mouse.move(x, nextY); y = nextY; }
        const hud = await trackingHud();
        report.tracking.samples.push({ observation, offsetIndex, x, y, hud });
        assert.ok(hud.focused && hud.visibility === "visible" && hud.menuHidden &&
          !hud.overlay && hud.mode === "remote" && hud.looking === "true",
          "Tracking requires active, focused Remote drag input");
        assert.ok(Number.isFinite(hud.frameMs) && hud.frameMs > 0 &&
          hud.coordinates.slice(1).every((value) =>
            typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))),
          "Tracking requires finite RAF timing and numeric public Y/Z coordinates");
        const ready = hud.combat.hidden === false && hud.combat.phase === "ready" && !hud.combat.blocked;
        const z = Number(hud.coordinates[2]);
        // The label and per-frame combat indicator refresh independently. Either
        // can mark first contact; both must agree before the eventual strike.
        if (ready || hud.target === "Targeted block: Cod")
          report.tracking.firstContact ??= { observation, z, x, y, hud };
        if (ready && hud.target === "Targeted block: Cod") {
          // Coordinates are floored. Crossing two displayed cells guarantees
          // more than one full block of forward approach after first contact.
          if (report.tracking.firstContact.z - z >= 2) {
            // Click at the current drag point: recentering with RMB still held
            // would undo the live aiming adjustment. LMB and Remote look coexist.
            report.tracking.strike = { observation, x, y, hud };
            await page.mouse.click(x, y);
            break;
          }
        }
        if (report.tracking.firstContact) {
          // Follow downward as the sprint closes the horizontal gap. RAF pace
          // only scales real mouse movement; it never advances the game clock.
          const followPixels = Math.max(4, Math.min(40, hud.frameMs * 0.4));
          nextY = Math.min(viewport.height - 16, y + followPixels);
        } else {
          // Buoyancy raises the physical eye as the swimmer surfaces. Use the
          // public height cell to choose the shallow or steeper search angle.
          offsetIndex = Number(hud.coordinates[1]) <= initialFeetCell ? 1 : 0;
          nextY = centerY - offsets[offsetIndex];
        }
      }
      assert.ok(report.tracking.strike, "No close live Cod/ready target within eight tracking observations");
      // No retargeting, extra strike or intervening UI wait after this shot.
      await acquired.waitFor({ state: "attached", timeout: 3000 });
    } catch (error) {
      inputFailure = error;
      throw error;
    } finally {
      const released = await Promise.allSettled([
        page.keyboard.up("w"), page.keyboard.up("ControlLeft"),
        page.mouse.up({ button: "left" }), page.mouse.up({ button: "right" }),
      ]);
      const releaseErrors = released.filter((result) => result.status === "rejected");
      if (releaseErrors.length) {
        const errors = releaseErrors.map((result) => result.reason);
        if (inputFailure) errors.unshift(inputFailure);
        throw new AggregateError(errors,
          `${inputFailure ? `${inputFailure.message}; ` : ""}Native tracking input release failed`);
      }
    }
    assert.equal(await acquired.getAttribute("data-count"), "1");
    await page.locator('.experience-track[aria-valuetext="Level 0 · 1 / 7 XP · 6 XP to level 1"]')
      .waitFor({ state: "attached", timeout: 3000 });
    report.pickupScreenshot = join(output, "nearby_native_cod_pickup.png");
    await page.screenshot({ path: report.pickupScreenshot });
    await page.keyboard.press("Escape");
    await page.locator(".menu-screen").waitFor({ state: "visible" });
    report.inputFinishedSeconds = (performance.now() - recordingStart) / 1000;
    await save();
    const collected = await exportFile("collected");
    verifyAquaticExports(initial.saved, collected.saved);
    assert.deepEqual(await preferences(), acceptedPreferences);

    stage = "cold page reconstruction and explicit extended preference restoration";
    await page.reload({ waitUntil: "load", timeout: 70000 });
    await ready();
    assert.deepEqual(await preferences(), acceptedPreferences);
    await settings("video");
    await assertSettings("nearby", 3, sourceQuality);
    await page.locator("#render-mode-setting").selectOption("extended");
    await assertSettings("extended", 12, sourceQuality);
    await page.locator("#render-mode-setting").selectOption("nearby");
    await assertSettings("nearby", 3, sourceQuality);
    const cold = await exportFile("cold");
    verifyAquaticExports(initial.saved, collected.saved, { restored: [cold.saved] });

    stage = "ordinary file import preserves rendering choices and collected owners";
    await importFile(collected.text);
    assert.deepEqual(await preferences(), acceptedPreferences);
    await settings("video");
    await assertSettings("nearby", 3, sourceQuality);
    const imported = await exportFile("imported");
    report.resources = verifyAquaticExports(initial.saved, collected.saved, { restored: [cold.saved, imported.saved] });

    // All exact paused-state comparisons precede this ordinary continuation.
    // Show that the restored resources are usable in the running game too.
    stage = "rendered restored Survival continuation";
    report.restoredStartedSeconds = (performance.now() - recordingStart) / 1000;
    await page.locator(".play-button").click();
    await page.locator(".menu-screen").waitFor({ state: "hidden" });
    assert.equal(await page.locator(`.hotbar-slot[data-item="${ITEM.RAW_COD}"]`).getAttribute("data-count"), "1");
    await page.locator('.experience-track[aria-valuetext="Level 0 · 1 / 7 XP · 6 XP to level 1"]')
      .waitFor({ state: "visible", timeout: 3000 });
    report.restoredScreenshot = join(output, "nearby_restored_survival.png");
    await page.screenshot({ path: report.restoredScreenshot });
    await page.keyboard.press("Escape");
    await page.locator(".menu-screen").waitFor({ state: "visible" });
    report.restoredFinishedSeconds = (performance.now() - recordingStart) / 1000;
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    report.status = "PASS";
    report.scripts = [...scripts];
    report.video = await page.video()?.path() ?? null;
    report.limitations = "Supplied native encounter/gear; not from-zero progression, frame pacing, rendered geometry completeness or manual desktop input.";
    t.diagnostic(JSON.stringify(report));
  } catch (error) {
    report.status = "FAIL";
    report.failure = { stage, message: error.message, errors, requests };
    await page.keyboard.up("w").catch(() => {});
    await page.keyboard.up("ControlLeft").catch(() => {});
    await page.mouse.up({ button: "left" }).catch(() => {});
    await page.mouse.up({ button: "right" }).catch(() => {});
    if (report.tracking) {
      try {
        // Do not retry the strike or movement. Freeze the failed state with
        // ordinary Escape before screenshot/export; retain the original failure.
        page.setDefaultTimeout(10000);
        if (await page.locator(".menu-screen").isHidden()) await page.keyboard.press("Escape");
        await page.locator(".menu-screen").waitFor({ state: "visible", timeout: 10000 });
        await exportFile("failure-paused");
      } catch (diagnosticError) {
        report.diagnosticFailure = diagnosticError.message;
      }
    }
    report.video = await page.video()?.path() ?? null;
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    t.diagnostic(JSON.stringify(report));
    throw error;
  } finally {
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
});
