// Opt-in real UI/WebGL integration; always launches a disposable browser/profile.
// node --test test/inspection.browser.integration.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { VIEW_PREFERENCES_KEY } from "../src/view-preferences.js";
import { chromeExecutable } from "./realtime/config.mjs";

const url = new URL(
  "/test/realtime/index.html?quality=low&seed=cedar-valley",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173"
);

// Real WebGL caves and repeated import/reload require an integration timeout.
test("Fullbright inspection illuminates a real cave and stays a browser-only preference", {
  timeout: 180000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const ready = async () => {
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
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
    await page.locator(".main-menu-stack").waitFor({ state: "visible" });
  };
  const settings = async (pageName = "video") => {
    await mainMenu();
    if (pageName === "world") {
      await page.locator(".world-settings-button").click();
      return;
    }
    await page.locator(".settings-toggle").click();
    await page.locator(`.${pageName}-settings-button`).click();
  };
  const enabled = () =>
    page.evaluate(() => window.__voxelBot.game.graphics.fullbrightInspection);
  const settled = () =>
    page.waitForFunction(
      () => {
        const game = window.__voxelBot.game;
        return (
          !game.building &&
          !game.transitionGate.busy &&
          game.world._requests.size === 0 &&
          game.world._inFlight.size === 0 &&
          game.world.dirtyChunks.size === 0
        );
      },
      undefined,
      { timeout: 60000 }
    );
  const importSave = async (save) => {
    await settings("world");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".import-file").setInputFiles({
      name: "inspection-isolated.voxelcraft.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(save)),
    });
    await page.waitForFunction(
      () =>
        document.querySelector(".storage-status")?.dataset.state ===
          "success" &&
        !window.__voxelBot.game.building &&
        !window.__voxelBot.game.transitionGate.busy,
      undefined,
      { timeout: 60000 }
    );
    await settled();
  };
  const unchangedState = () =>
    page.evaluate(() => {
      const game = window.__voxelBot.game;
      const save = game.snapshot();
      return {
        world: save.world,
        player: save.player,
        gameplay: save.gameplay,
        time: save.time,
        quality: save.quality,
        paused: game.paused,
        renderRadius: game.graphics.renderRadius,
        fogRange: [game.graphics.scene.fog.near, game.graphics.scene.fog.far],
        geometry: [...game.graphics.chunks.values()]
          .flatMap((group) => group.children.map((mesh) => mesh.geometry.uuid))
          .sort(),
      };
    });
  const illumination = () =>
    page.evaluate(() => {
      const { graphics } = window.__voxelBot.game;
      return {
        ambient: graphics.atmosphere.inspectionLight.intensity,
        sun: graphics.atmosphere.sunlight.intensity,
        hemi: graphics.atmosphere.hemi.intensity,
        shadows: graphics.renderer.shadowMap.enabled,
        localLights: graphics.localLights.map((light) => ({
          visible: light.visible,
          intensity: light.intensity,
        })),
      };
    });
  const sampleCave = () =>
    page.evaluate(() => {
      const { graphics } = window.__voxelBot.game;
      const gl = graphics.renderer.getContext();
      const width = Math.floor(gl.drawingBufferWidth / 2);
      const height = Math.floor(gl.drawingBufferHeight / 2);
      const pixels = new Uint8Array(width * height * 4);
      const samples = {};
      // Read the real cave in six directions with a cloned camera. No player,
      // terrain, lights or live camera change; DOM overlays are excluded.
      const camera = graphics.camera.clone();
      try {
        for (const [name, direction] of Object.entries({
          east: [1, 0, 0],
          west: [-1, 0, 0],
          ceiling: [0, 1, 0],
          floor: [0, -1, 0],
          south: [0, 0, 1],
          north: [0, 0, -1],
        })) {
          camera.lookAt(
            camera.position
              .clone()
              .add(camera.position.clone().set(...direction))
          );
          graphics.renderer.render(graphics.scene, camera);
          gl.readPixels(
            Math.floor(gl.drawingBufferWidth / 4),
            Math.floor(gl.drawingBufferHeight / 4),
            width,
            height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels
          );
          const luminances = [];
          let sum = 0;
          for (let i = 0; i < pixels.length; i += 16) {
            const value =
              pixels[i] * 0.2126 +
              pixels[i + 1] * 0.7152 +
              pixels[i + 2] * 0.0722;
            sum += value;
            luminances.push(value);
          }
          luminances.sort((a, b) => a - b);
          samples[name] = {
            mean: sum / luminances.length,
            contrast:
              luminances[Math.floor(luminances.length * 0.9)] -
              luminances[Math.floor(luminances.length * 0.1)],
          };
        }
      } finally {
        graphics.render();
      }
      return samples;
    });

  await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
  await ready();
  await settings();
  const toggle = page.locator("#fullbright-inspection-setting");
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await enabled(), false);
  assert.equal(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      VIEW_PREFERENCES_KEY
    ),
    null
  );
  assert.match(
    await page
      .locator('label[for="fullbright-inspection-setting"]')
      .innerText(),
    /Fullbright Inspection/
  );
  assert.match(
    await page.locator("#fullbright-inspection-help").innerText(),
    /without changing time or placed lights.*not world saves/s
  );

  // Use the seed's real biome locator and normal import/landing path, not a
  // synthetic hollow box or any file/profile from the user's running browser.
  const caveSave = await page.evaluate(() => {
    const game = window.__voxelBot.game;
    const point = game.world.locateBiome(
      "dripstone_caves",
      game.player.position
    );
    if (!point) throw new Error("Could not locate the real dripstone cave");
    const save = game.snapshot();
    save.player = { ...point, yaw: 0, pitch: -0.12, flying: false };
    save.time = 0.5;
    return save;
  });
  await importSave(caveSave);
  const cave = await page.evaluate(() => {
    const { graphics, player, world } = window.__voxelBot.game;
    return {
      biome: world.getBiome(
        player.position.x,
        player.position.z,
        player.position.y
      ).id,
      underground: graphics.atmosphere.underground,
      position: player.position.toArray(),
      colliding: window.__voxelBot.state().colliding,
      edits: world.edits.size,
    };
  });
  assert.equal(cave.biome, "dripstone_caves");
  assert.equal(cave.underground, true);
  assert.equal(cave.colliding, false);
  assert.equal(cave.edits, 0, "the test inspects unmodified generated terrain");
  assert.equal(await enabled(), false);
  const before = await unchangedState();
  const natural = await sampleCave();
  const naturalLight = await illumination();
  assert.equal(naturalLight.ambient, 0);
  assert.equal(naturalLight.sun, 0);
  assert.equal(naturalLight.hemi, 0.05);
  assert.equal(naturalLight.shadows, false);
  assert.deepEqual(
    naturalLight.localLights.map((light) => light.visible),
    [true, false]
  );
  await settings();
  await toggle.check();
  assert.equal(await enabled(), true);
  assert.equal(
    await page
      .locator("#fullbright-inspection-badge")
      .evaluate((node) => node.hidden),
    false
  );
  assert.deepEqual(await unchangedState(), before);
  const bright = await sampleCave();
  for (const direction of Object.keys(natural)) {
    assert.ok(
      bright[direction].mean > natural[direction].mean * 2 &&
        bright[direction].mean > natural[direction].mean + 15,
      `${direction} remains dark: ${JSON.stringify({ natural: natural[direction], bright: bright[direction] })}`
    );
  }
  for (const direction of ["ceiling", "floor"])
    assert.ok(
      bright[direction].contrast > 5,
      `${direction}: visible rock detail, not just bright fog`
    );
  assert.deepEqual(await illumination(), {
    ambient: Math.PI,
    sun: 0,
    hemi: 0,
    shadows: false,
    localLights: [
      { visible: false, intensity: 0 },
      { visible: false, intensity: 0 },
    ],
  });
  await toggle.uncheck();
  assert.equal(await enabled(), false);
  assert.equal(
    await page
      .locator("#fullbright-inspection-badge")
      .evaluate((node) => node.hidden),
    true
  );
  assert.deepEqual(await unchangedState(), before);
  assert.deepEqual(await illumination(), naturalLight);
  const restored = await sampleCave();
  for (const direction of Object.keys(natural))
    assert.ok(
      Math.abs(restored[direction].mean - natural[direction].mean) < 3,
      `${direction}: natural darkness did not return`
    );
  console.log(JSON.stringify({ cave, natural, fullbright: bright, restored }));

  await toggle.check();
  for (const quality of ["high", "medium", "low"]) {
    await page.locator("#quality-setting").selectOption(quality);
    await settled();
    assert.equal(await enabled(), true);
    assert.equal(await toggle.isChecked(), true);
    const light = await illumination();
    assert.equal(light.ambient, Math.PI);
    assert.equal(light.shadows, false);
    assert.ok(
      light.localLights.every((source) => !source.visible && !source.intensity)
    );
  }
  assert.ok(
    await page.evaluate(async () => (await window.__voxelBot.game.save()).ok)
  );
  await settings("world");
  const downloadEvent = page.waitForEvent("download");
  await page.locator(".export-button").click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal("viewPreferences" in exported, false);
  assert.equal("fullbrightInspection" in exported, false);
  assert.equal(
    JSON.stringify(exported).includes("fullbrightInspection"),
    false
  );
  await page.reload({ waitUntil: "load" });
  await ready();
  await settings();
  assert.equal(
    await enabled(),
    true,
    "a fresh renderer applies the saved browser choice"
  );
  assert.equal(await toggle.isChecked(), true);
  assert.deepEqual(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)),
      VIEW_PREFERENCES_KEY
    ),
    { fullbrightInspection: true, guiScale: "auto", showFps: false }
  );
  exported.viewPreferences = { fullbrightInspection: false };
  exported.fullbrightInspection = false;
  await importSave(exported);
  assert.equal(
    await enabled(),
    true,
    "imported world fields cannot override the browser"
  );
  assert.equal(await toggle.isChecked(), true);

  // Travel keeps the renderer; Generate replaces it. Both must keep the choice.
  await settings("world");
  await page.locator("#dimension-setting").selectOption("nether");
  await page.waitForFunction(
    () =>
      window.__voxelBot.game.world.dimension === "nether" &&
      !window.__voxelBot.game.building &&
      !window.__voxelBot.game.transitionGate.busy,
    undefined,
    { timeout: 60000 }
  );
  assert.equal(await enabled(), true);
  assert.equal(await toggle.isChecked(), true);
  await settings("world");
  await page.locator(".new-world-button").click();
  await page.locator("#world-seed").fill("inspection-preference-reload");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".generate-button").click();
  await page.waitForFunction(
    () =>
      window.__voxelBot.game.world.seed === "inspection-preference-reload" &&
      !window.__voxelBot.game.building &&
      !window.__voxelBot.game.transitionGate.busy,
    undefined,
    { timeout: 60000 }
  );
  assert.equal(await enabled(), true);
  assert.equal(await toggle.isChecked(), true);
  await settings("controls");
  await page.locator("#input-mode-setting").selectOption("remote");
  await mainMenu();
  await page.locator(".play-button").click();
  const runningTime = await page.evaluate(
    () => window.__voxelBot.game.currentTime
  );
  await page.waitForFunction(
    (time) =>
      window.__voxelBot.game.currentTime > time &&
      window.__voxelBot.game.simulating,
    runningTime
  );
  await page.keyboard.press("Escape");
  await settings();
  await toggle.uncheck();
  await page.reload({ waitUntil: "load" });
  await ready();
  await settings();
  assert.equal(
    await enabled(),
    false,
    "natural lighting also persists when switched off"
  );
  assert.equal(await toggle.isChecked(), false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: six real cave views brighten, OFF restores darkness; clock/pose/voxels/meshes stay intact; quality, travel, reload and import/generate preserve the browser choice; exports exclude it."
  );
});
