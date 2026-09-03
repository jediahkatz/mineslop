// Opt-in, after the parent checkpoint only:
// VOXELCRAFT_TEST_URL=http://127.0.0.1:5503 node --test test/fps.browser.integration.mjs
// Optional VOXELCRAFT_FPS_PIXEL_RATIO=0.5 requests fixed DPR. Only warmed A/B
// windows verify the pin; imports can recreate the renderer afterward.
// Requires a fresh frozen test/realtime build, not Vite/HMR. This test starts no
// server and never connects to an existing browser or persistent profile.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { observeFpsWindow, readFpsPixelRatio } from "./fps-browser-fixture.mjs";
import { completedFpsImport } from "./fps-import-completion.mjs";
import { chromeExecutable } from "./realtime/config.mjs";
import { summarize } from "./realtime/statistics.js";

if (!process.env.VOXELCRAFT_TEST_URL)
  throw new Error(
    "Set VOXELCRAFT_TEST_URL to an isolated frozen realtime host"
  );
const base = new URL(process.env.VOXELCRAFT_TEST_URL);
const protectedPorts = new Set([
  "5173",
  "5280",
  "5290",
  "5297",
  "5311",
  "5352",
  "5363",
  "5487",
  "5488",
  "5491",
]);
if (
  !["http:", "https:"].includes(base.protocol) ||
  !["127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  !base.port ||
  protectedPorts.has(base.port)
)
  throw new Error(
    "Use an explicit numeric-loopback port, never a protected/shared game origin"
  );
const url = new URL("/test/realtime/index.html", base);
url.searchParams.set("quality", "low");
url.searchParams.set("seed", "cedar-valley");
// Validate before launching Chrome; the existing realtime driver owns the pin.
const requestedPixelRatio = readFpsPixelRatio(
  process.env.VOXELCRAFT_FPS_PIXEL_RATIO
);
if (requestedPixelRatio !== null)
  url.searchParams.set("pixelRatio", String(requestedPixelRatio));
const viewport = { width: 1100, height: 800 };
const expectedDrawingBuffer =
  requestedPixelRatio === null
    ? null
    : {
        width: Math.floor(viewport.width * requestedPixelRatio),
        height: Math.floor(viewport.height * requestedPixelRatio),
      };
const abResolutionLabel =
  requestedPixelRatio === null
    ? "production-adaptive"
    : `test-only fixed DPR ${requestedPixelRatio}`;
const expectedBuild = process.env.VOXELCRAFT_FPS_BUILD_LABEL;
const viewKey = "voxelcraft-view-v1";
const expectedControls = { inputMode: "remote", mouseSensitivity: 1 };
const nearPosition = (a, b) =>
  Math.hypot(...a.map((value, index) => value - b[index])) < 0.01;

function assertPortable(save) {
  assert.equal(save.version, 3);
  assert.doesNotMatch(
    JSON.stringify(save),
    /"(?:viewPreferences|showFps|guiScale|fullbrightInspection|controlPreferences)"\s*:/,
    "exported world data must not contain browser/device preferences"
  );
}

function assertWindow(observed, enabled, { fixedScene = true } = {}) {
  assert.equal(
    observed.reason,
    "deadline",
    "observation ended at its real deadline"
  );
  assert.equal(
    observed.overflow,
    false,
    "finite observation buffers did not overflow"
  );
  assert.ok(
    observed.frames >= 2 && observed.intervals.length > 0,
    "multiple actual renderer draws are required; this is coverage, not an FPS budget"
  );
  assert.ok(observed.intervals.every((ms) => Number.isFinite(ms) && ms > 0));
  for (const name of [
    "contextLosses",
    "inactiveFrames",
    "hiddenFrames",
    "failedFrames",
    "noDrawFrames",
    "samplerDisagreements",
    "hudDisagreements",
    "preferenceChanges",
    "attributeMutations",
    "nonTextMutations",
    "hudElementAdditions",
    "hudElementRemovals",
    "redundantTextBatches",
    "coalescedTextBatches",
  ])
    assert.equal(observed[name], 0, `${name} during a steady gameplay window`);
  assert.equal(
    observed.sameNode,
    true,
    "one compact node survives the entire window"
  );
  assert.equal(observed.sameWorldAndRenderer, true);
  for (const gpu of [observed.initialGpu, observed.finalGpu]) {
    assert.equal(gpu.contextLost, false);
    assert.equal(gpu.badPrograms, 0);
    assert.ok(
      gpu.calls > 0 && gpu.triangles > 0,
      "the scene still reaches WebGL"
    );
  }
  for (const state of [observed.initial, observed.final]) {
    assert.equal(state.active, true);
    assert.equal(state.simulating, true);
    assert.equal(state.hidden, false);
    assert.equal(state.showFps, enabled);
    assert.equal(state.compactHidden, !enabled);
    assert.equal(state.hudHidden, false);
    assert.equal(state.debugHidden, true);
  }
  assert.notEqual(
    observed.final.time,
    observed.initial.time,
    "world time advances naturally"
  );
  assert.ok(observed.final.wildlifeClock > observed.initial.wildlifeClock);
  // A window can begin partway through a 500 ms sample; allow that boundary.
  // Identical rounded samples may correctly produce NO writes while enabled.
  const budget = Math.ceil(observed.elapsedMs / 500) + 1;
  assert.ok(
    observed.sampleChanges <= budget,
    "sampling is bounded near twice per second"
  );
  if (enabled) {
    assert.ok(
      observed.textMutations <= budget,
      `${observed.textMutations} text mutations exceed the ${budget} window bound`
    );
    assert.ok(observed.textMutations <= observed.sampleChanges + 1);
  } else {
    assert.equal(
      observed.textMutations,
      0,
      "disabled sampling performs zero text mutations"
    );
    assert.equal(observed.final.compactText, observed.initial.compactText);
  }
  if (fixedScene) {
    assert.ok(
      observed.maxPositionDelta < 0.01,
      "the measured player stays in place"
    );
    assert.equal(
      observed.maxAimDelta,
      0,
      "the measured camera direction stays fixed"
    );
  }
}

// Cold WebGL generation, two real reloads and two imports are integration work.
// Every wait/window is finite; shared SwiftShader timing is never a pass budget.
test("compact FPS real UI, device persistence and bounded off/on/off overhead", {
  timeout: 300000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    acceptDownloads: true,
  });
  const blocked = [];
  const errors = [];
  const warnings = [];
  const failedRequests = [];
  const remember = (list, value) => {
    if (list.length < 32) list.push(value);
  };
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(request.protocol) &&
      request.origin !== url.origin
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
  page.setDefaultNavigationTimeout(60000);
  page.on("pageerror", (error) => remember(errors, error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" ||
      /GL_INVALID_|GL_OUT_OF_MEMORY|CONTEXT_LOST_WEBGL|WebGL.*context lost|Shader Error/i.test(
        text
      )
    )
      remember(errors, text);
    else if (message.type() === "warning") remember(warnings, text);
  });
  page.on("requestfailed", (request) =>
    remember(failedRequests, {
      url: request.url(),
      failure: request.failure()?.errorText,
    })
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      remember(failedRequests, {
        url: response.url(),
        status: response.status(),
      });
  });
  let phase = "startup";
  const report = {
    status: "incomplete",
    url: url.href,
    browser: browser.version(),
    expectedBuild: expectedBuild ?? null,
    windows: [],
    imports: [],
    comparisonResolution: {
      mode:
        requestedPixelRatio === null
          ? "production-adaptive"
          : "test-only-fixed-dpr",
      requestedPixelRatio,
      expectedDrawingBuffer,
      scope: "warmed A/B/A2 only",
    },
    limitations: [
      "Real RAF intervals after completed draws, not GPU-completion or input-to-photon timings.",
      "The frozen realtime host already has dormant metrics wrappers; this test adds no method wrappers and never starts its metrics recorder.",
      "Observers read JS state/text and drawing-buffer dimensions; no layout reads, pixel readbacks, DOM writes, fake clocks or synthetic game state.",
      "Observer work is included in the frame intervals. rafObserverCpuMs covers only the RAF callback body, excluding dispatch and MutationObserver callbacks.",
      "Fixed camera/terrain during A/B; world time and wildlife continue normally.",
      requestedPixelRatio === null
        ? "No pixelRatio override: production adaptive resolution continues normally."
        : `Test-only pixelRatio=${requestedPixelRatio} uses the existing realtime driver; warmed A/B/A2 must retain the requested DPR and identical drawing buffers.`,
      "Imports may recreate the renderer. Post-import/reload windows are behavior checks, not pinned A/B comparisons.",
      "FPS/mean/p95 are descriptive on a shared VM, especially SwiftShader. No absolute FPS or timing-ratio pass gates.",
    ],
  };
  const ready = async () => {
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    const state = await page.evaluate(() =>
      window.__voxelBot.state({ renderer: true })
    );
    assert.equal(new URL(page.url()).origin, url.origin);
    assert.equal(state.error, null);
    assert.equal(
      state.build.production,
      true,
      "HMR/dev servers are not valid evidence"
    );
    if (expectedBuild !== undefined)
      assert.equal(state.build.label, expectedBuild);
    assert.equal(state.paused, true);
    assert.equal(state.renderer.contextLost, false);
    assert.ok(state.view.visibleChunkGroups > 0);
    assert.equal(await page.locator(".game-hud > .compact-fps").count(), 1);
    assert.deepEqual(errors, []);
    return { build: state.build, renderer: state.renderer };
  };
  const mainMenu = async () => {
    if (await page.locator(".menu-screen").isHidden()) {
      await page.keyboard.press("Escape");
      await page.locator(".menu-screen").waitFor({ state: "visible" });
    }
    for (
      let depth = 0;
      depth < 4 &&
      (await page.locator(".menu-screen").getAttribute("data-page")) !== "main";
      depth++
    )
      await page.locator(".menu-back-button").click();
    assert.equal(
      await page.locator(".menu-screen").getAttribute("data-page"),
      "main"
    );
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return (
        game.paused && !game.closingScreens && !document.pointerLockElement
      );
    });
  };
  const settings = async (section = "video") => {
    await mainMenu();
    if (section === "world")
      await page.locator(".world-settings-button").click();
    else {
      await page.locator(".settings-toggle").click();
      await page.locator(`.${section}-settings-button`).click();
    }
    await page
      .locator(`[data-menu-page="${section}"]`)
      .waitFor({ state: "visible" });
  };
  const enter = async () => {
    await mainMenu();
    await page.locator(".play-button").click();
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return (
        game.active && game.simulating && game.player.enabled && !game.playing
      );
    });
  };
  const setFps = async (enabled) => {
    await settings();
    await page.locator("#show-fps-setting").setChecked(enabled);
    await page.waitForFunction(
      (value) => window.__voxelBot.game.viewPreferences.showFps === value,
      enabled
    );
  };
  const preferences = () =>
    page.evaluate(() => {
      const game = window.__voxelBot.game;
      return {
        view: { ...game.viewPreferences },
        stored: JSON.parse(localStorage.getItem("voxelcraft-view-v1")),
        controls: { ...game.controlPreferences },
        storedControls: JSON.parse(
          localStorage.getItem("voxelcraft-controls-v1")
        ),
        fullbright: game.graphics.fullbrightInspection,
        guiScale: document.querySelector("#ui").dataset.guiScale,
        fpsKeys: Object.keys(localStorage).filter((key) =>
          /"showFps"\s*:/.test(localStorage.getItem(key))
        ),
      };
    });
  const assertPreferences = async (expected) => {
    const actual = await preferences();
    assert.deepEqual(actual.view, expected);
    assert.deepEqual(actual.stored, expected);
    assert.deepEqual(actual.controls, expectedControls);
    assert.deepEqual(actual.storedControls, expectedControls);
    assert.equal(actual.fullbright, expected.fullbrightInspection);
    assert.equal(actual.guiScale, String(expected.guiScale));
    assert.deepEqual(
      actual.fpsKeys,
      [viewKey],
      "FPS is only a view preference"
    );
    assert.equal(
      await page.locator("#show-fps-setting").isChecked(),
      expected.showFps
    );
  };
  const positiveDisplay = async () => {
    const handle = await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      const compact = document.querySelector(".compact-fps").textContent;
      const debug = document.querySelector(
        ".debug-overlay .fps-indicator"
      ).textContent;
      const match = /^(\d+) FPS$/.exec(compact);
      return (
        match &&
        Number(match[1]) > 0 &&
        Number(match[1]) === Math.round(game.fps) &&
        game.fps === game.frameRate.fps &&
        debug.toUpperCase() === compact && { compact, debug, sample: game.fps }
      );
    });
    try {
      return await handle.jsonValue();
    } finally {
      await handle.dispose();
    }
  };
  let compactHandle;
  const retainNode = async () => {
    await compactHandle?.dispose();
    compactHandle = await page.locator(".compact-fps").elementHandle();
    assert.ok(compactHandle);
  };
  const sameNode = async () => {
    assert.equal(
      await compactHandle.evaluate(
        (node) =>
          node.isConnected &&
          node === document.querySelector(".game-hud > .compact-fps") &&
          document.querySelectorAll(".compact-fps").length === 1
      ),
      true,
      "toggles/import reuse the existing node; only a real reload creates a new document"
    );
  };
  const measure = async (
    label,
    enabled,
    durationMs = 6000,
    fixedScene = true
  ) => {
    phase = label;
    const observed = await page.evaluate(observeFpsWindow, { durationMs });
    const { intervals, ...counts } = observed;
    const timing = summarize(intervals);
    report.windows.push({
      label,
      ...counts,
      mutationBudget: enabled ? Math.ceil(observed.elapsedMs / 500) + 1 : 0,
      mutationsPerSecond: (observed.textMutations * 1000) / observed.elapsedMs,
      timing: {
        intervals: timing.samples,
        fps: timing.samples ? (1000 * timing.samples) / timing.total : null,
        meanFrameMs: timing.mean,
        p95FrameMs: timing.p95,
      },
    });
    assertWindow(observed, enabled, { fixedScene });
    await sameNode();
    return observed;
  };
  const exportSave = async () => {
    await settings("world");
    await page.locator(".save-button").click();
    await page.waitForFunction(() => {
      const status = document.querySelector(".storage-status");
      return (
        !document.querySelector(".save-button").disabled &&
        status.dataset.state === "success" &&
        /saved/i.test(status.textContent)
      );
    });
    const downloading = page.waitForEvent("download");
    await page.locator(".export-button").click();
    const download = await downloading;
    assert.equal(await download.failure(), null);
    const stream = await download.createReadStream();
    assert.ok(stream);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      assert.ok(
        bytes <= 32 * 1024 * 1024,
        "this unedited fixture export stays bounded"
      );
      chunks.push(chunk);
    }
    const save = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assertPortable(save);
    return save;
  };
  const importSave = async (save, importedFps) => {
    await settings("world");
    const beforeImport = await page.evaluateHandle(() => {
      const game = window.__voxelBot.game;
      return {
        game,
        world: game.world,
        storage: game.storage,
        revision: game.storage.revision,
      };
    });
    // Unknown portable fields are deliberately hostile to the device's choices.
    // Only the downloaded JSON copy changes; the live game is changed by Import.
    const portable = {
      ...save,
      showFps: importedFps,
      guiScale: 1,
      fullbrightInspection: false,
      viewPreferences: {
        showFps: importedFps,
        guiScale: 1,
        fullbrightInspection: false,
      },
      controlPreferences: { inputMode: "native", mouseSensitivity: 3 },
    };
    let confirmations = 0;
    page.once("dialog", async (dialog) => {
      confirmations++;
      await dialog.accept();
    });
    try {
      await page.locator(".import-file").setInputFiles({
        name: `fps-device-isolation-${importedFps}.voxelcraft.json`,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(portable)),
      });
      const completion = await page.waitForFunction(
        completedFpsImport,
        beforeImport,
        { timeout: 60000 }
      );
      try {
        assert.equal(confirmations, 1);
        report.imports.push({
          importedFps,
          confirmations,
          ...(await completion.jsonValue()),
        });
        await sameNode();
      } finally {
        await completion.dispose();
      }
    } finally {
      await beforeImport.dispose();
    }
  };

  try {
    await page.goto(url.href, { waitUntil: "load" });
    report.host = await ready();
    await retainNode();
    assert.deepEqual((await preferences()).view, {
      fullbrightInspection: false,
      guiScale: "auto",
      showFps: false,
    });
    assert.equal(
      (await preferences()).stored,
      null,
      "a fresh context has no view record"
    );
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    await settings("controls");
    await page.locator("#input-mode-setting").selectOption("remote");
    await settings();
    assert.equal(await page.locator("#show-fps-setting").isChecked(), false);
    assert.match(
      await page.locator('label[for="show-fps-setting"]').innerText(),
      /Show FPS/
    );
    await page.locator("#gui-scale-setting").selectOption("2");
    await page.locator("#fullbright-inspection-setting").check();
    await page.locator("#show-fps-setting").check();
    await assertPreferences({
      fullbrightInspection: true,
      guiScale: 2,
      showFps: true,
    });
    await page.locator("#show-fps-setting").uncheck();
    await assertPreferences({
      fullbrightInspection: true,
      guiScale: 2,
      showFps: false,
    });
    await page.locator("#fullbright-inspection-setting").uncheck();
    await assertPreferences({
      fullbrightInspection: false,
      guiScale: 2,
      showFps: false,
    });
    await sameNode();
    await enter();
    await page.waitForFunction(
      () => {
        const game = window.__voxelBot.game;
        return (
          game.player.grounded &&
          Math.abs(game.player.velocity.y) < 0.001 &&
          game.world._requests.size === 0 &&
          game.world._inFlight.size === 0 &&
          game.world.dirtyChunks.size === 0
        );
      },
      undefined,
      { timeout: 60000 }
    );
    await measure("warmup (not A/B)", false, 4000);

    const warmedScene = await page.evaluateHandle(() => {
      const game = window.__voxelBot.game;
      return {
        world: game.world,
        graphics: game.graphics,
        renderer: game.graphics.renderer,
      };
    });
    try {
      const offBefore = await measure(
        `A: off, warmed fixed scene (${abResolutionLabel})`,
        false
      );
      await setFps(true);
      await enter();
      assert.equal(await page.locator(".compact-fps").isVisible(), true);
      report.normalDisplay = await positiveDisplay();
      const on = await measure(
        `B: on, same fixed scene (${abResolutionLabel})`,
        true
      );
      await setFps(false);
      await enter();
      const offAfter = await measure(
        `A2: off, same fixed scene (${abResolutionLabel})`,
        false
      );
      if (requestedPixelRatio !== null) {
        // Check both endpoints and every observed change, only for warmed A/B.
        // Renderer recreation during later imports must not imply a new pin.
        for (const sample of [offBefore, on, offAfter]) {
          assert.ok(sample.resolution.length > 0);
          for (const { pixelRatio, width, height } of [
            sample.initial.resolution,
            ...sample.resolution,
            sample.final.resolution,
          ]) {
            assert.equal(
              pixelRatio,
              requestedPixelRatio,
              "warmed A/B retains the requested fixed DPR"
            );
            assert.deepEqual(
              { width, height },
              expectedDrawingBuffer,
              "warmed A/B retains identical requested drawing-buffer dimensions"
            );
          }
        }
      }
      for (const sample of [on, offAfter]) {
        assert.ok(
          nearPosition(sample.initial.position, offBefore.initial.position)
        );
        assert.equal(sample.initial.yaw, offBefore.initial.yaw);
        assert.equal(sample.initial.pitch, offBefore.initial.pitch);
        assert.equal(sample.initial.quality, offBefore.initial.quality);
        assert.equal(sample.initial.seed, offBefore.initial.seed);
        assert.equal(sample.initial.dimension, offBefore.initial.dimension);
        assert.equal(
          sample.initial.fullbrightInspection,
          offBefore.initial.fullbrightInspection
        );
        assert.equal(sample.initial.guiScale, offBefore.initial.guiScale);
      }
      assert.equal(
        await warmedScene.evaluate((before) => {
          const game = window.__voxelBot.game;
          return (
            game.world === before.world &&
            game.graphics === before.graphics &&
            game.graphics.renderer === before.renderer
          );
        }),
        true,
        "menu toggles cannot replace the warmed world or renderer between A/B windows"
      );
    } finally {
      await warmedScene.dispose();
    }

    phase = "F1/F3 and passive compact display";
    await setFps(true);
    await enter();
    await positiveDisplay();
    assert.equal(await page.locator(".debug-overlay").isVisible(), false);
    // One-shot geometry inspection is OUTSIDE every measurement window.
    report.geometry = await page.locator(".compact-fps").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewport: [innerWidth, innerHeight],
        pointerEvents: style.pointerEvents,
        whiteSpace: style.whiteSpace,
        position: style.position,
        tabIndex: node.tabIndex,
        ariaLive: node.getAttribute("aria-live"),
      };
    });
    const shape = report.geometry;
    assert.ok(shape.x >= 0 && shape.x < shape.viewport[0] / 4);
    assert.ok(shape.y >= 0 && shape.y < shape.viewport[1] / 4);
    assert.ok(shape.width > 0 && shape.width < 160);
    assert.ok(shape.height > 0 && shape.height < 64);
    assert.equal(shape.pointerEvents, "none");
    assert.equal(shape.whiteSpace, "nowrap");
    assert.equal(shape.position, "absolute");
    assert.equal(shape.tabIndex, -1);
    assert.equal(shape.ariaLive, "off");
    await page.keyboard.press("F1");
    assert.equal(await page.locator(".game-hud").isVisible(), false);
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    assert.equal(await compactHandle.evaluate((node) => node.hidden), false);
    await page.keyboard.press("F1");
    assert.equal(await page.locator(".compact-fps").isVisible(), true);
    await page.keyboard.press("F3");
    assert.equal(
      await page.locator(".debug-overlay .fps-indicator").isVisible(),
      true
    );
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    assert.equal(await compactHandle.evaluate((node) => node.hidden), false);
    report.debugDisplay = await positiveDisplay();
    await page.keyboard.press("F1");
    assert.equal(await page.locator(".debug-overlay").isVisible(), false);
    await page.keyboard.press("F1");
    assert.equal(await page.locator(".debug-overlay").isVisible(), true);
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    await page.keyboard.press("F3");
    assert.equal(await page.locator(".compact-fps").isVisible(), true);
    await assertPreferences({
      fullbrightInspection: false,
      guiScale: 2,
      showFps: true,
    });
    await sameNode();

    // Trusted input still drives the real Player. No camera/state writes.
    const yaw = await page.evaluate(() => window.__voxelBot.game.player.yaw);
    await page.keyboard.down("ArrowRight");
    try {
      await page.waitForFunction(
        (before) => Math.abs(window.__voxelBot.game.player.yaw - before) > 0.05,
        yaw
      );
    } finally {
      await page.keyboard.up("ArrowRight");
    }
    await positiveDisplay();

    phase = "export and real reload with FPS enabled";
    await settings();
    await page.locator("#gui-scale-setting").selectOption("3");
    await page.locator("#fullbright-inspection-setting").check();
    const persistedOn = {
      fullbrightInspection: true,
      guiScale: 3,
      showFps: true,
    };
    await assertPreferences(persistedOn);
    const exported = await exportSave();
    await page.reload({ waitUntil: "load" });
    report.reloadOn = await ready();
    await retainNode();
    await assertPreferences(persistedOn);
    await enter();
    assert.equal(await page.locator(".compact-fps").isVisible(), true);
    await positiveDisplay();

    phase = "import cannot turn off FPS or overwrite other device choices";
    await importSave(exported, false);
    await assertPreferences(persistedOn);
    await enter();
    assert.equal(await page.locator(".compact-fps").isVisible(), true);
    await positiveDisplay();
    assertPortable(await exportSave());

    phase = "disabled preference resists an imported opt-in";
    await setFps(false);
    const persistedOff = { ...persistedOn, showFps: false };
    await assertPreferences(persistedOff);
    await importSave(exported, true);
    await assertPreferences(persistedOff);
    await enter();
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    await measure("off after import (not A/B)", false, 2500, false);
    await page.keyboard.press("F3");
    assert.equal(
      await page.locator(".debug-overlay .fps-indicator").isVisible(),
      true
    );
    await page.waitForFunction(() =>
      /^[1-9]\d* fps$/.test(
        document.querySelector(".debug-overlay .fps-indicator").textContent
      )
    );
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    await page.keyboard.press("F3");
    await exportSave();
    await page.reload({ waitUntil: "load" });
    report.reloadOff = await ready();
    await retainNode();
    await assertPreferences(persistedOff);
    await enter();
    assert.equal(await page.locator(".compact-fps").isVisible(), false);
    await measure("off after real reload (not A/B)", false, 2500, false);

    phase = "final console/network/GPU health";
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    assert.deepEqual(failedRequests, []);
    report.adaptiveResolutionChanged =
      new Set(
        report.windows
          .slice(1, 4)
          .flatMap((window) =>
            [
              window.initial.resolution,
              ...window.resolution,
              window.final.resolution,
            ].map(
              ({ pixelRatio, width, height }) =>
                `${pixelRatio}/${width}/${height}`
            )
          )
      ).size > 1;
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = { phase, message: error.message };
    throw error;
  } finally {
    console.log(
      JSON.stringify(
        { ...report, errors, warnings, blocked, failedRequests },
        null,
        2
      )
    );
  }
});
