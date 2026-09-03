// Opt-in trusted-browser integration: node --test test/controls.browser.integration.mjs
// Isolated profile, real app + test-only realtime entry, no camera-probe dependency.
// CDP does not reproduce X11/VNC pointer warps; repeat the OS test for that path.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const url = new URL(
  "test/realtime/index.html?quality=low&seed=cedar-valley",
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/"
).href;
const near = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-7,
    `${message}: ${actual} != ${expected}`
  );

// Cold browser/WebGL world generation is integration work, not a unit test.
test("trusted browser Native/Remote controls, menu lifecycle and device preferences", {
  timeout: 120000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const ready = async () => {
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    assert.equal(await page.evaluate(() => window.__voxelBot.error), null);
  };
  const snap = () =>
    page.evaluate(() => {
      const game = window.__voxelBot.game;
      return {
        yaw: game.player.yaw,
        pitch: game.player.pitch,
        cameraYaw: game.graphics.camera.rotation.y,
        cameraPitch: game.graphics.camera.rotation.x,
        locked: game.player.locked,
        pointerLock: Boolean(document.pointerLockElement),
        active: game.active,
        enabled: game.player.enabled,
        paused: game.paused,
        inputMode: game.player.inputMode,
        mouseSensitivity: game.player.mouseSensitivity,
        position: game.player.position.toArray(),
        eye: game.player.eyePosition.toArray(),
        height: game.player.height,
        flying: game.player.flying,
        sprinting: game.player.sprinting,
        sneaking: game.player.sneaking,
        perspective: game.player.perspective,
        heldAction: game.heldAction,
        useHeld: game.useActions.held,
        useSource: game.useActions.source,
        miningKey: game.miningKey,
        miningProgress: game.miningProgress,
        menuPage: document.querySelector(".menu-screen").dataset.page,
        hudVisible: game.ui.isHudVisible,
        debugVisible: game.ui.isDebugVisible,
        keys: [...game.player._keys],
        frame: window.__voxelBot.state().frame,
      };
    });
  const frames = async (count = 2) => {
    const before = (await snap()).frame;
    await page.waitForFunction(
      ({ before, count }) => window.__voxelBot.state().frame >= before + count,
      { before, count }
    );
  };
  const mainMenu = async () => {
    while (
      (await page.locator(".menu-screen").getAttribute("data-page")) !== "main"
    )
      await page.locator(".menu-back-button").click();
  };
  const enter = async () => {
    await mainMenu();
    await page.locator(".play-button").click();
    await page.waitForFunction(
      () => window.__voxelBot.game.active && !window.__voxelBot.game.playing
    );
  };
  const pause = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => window.__voxelBot.game.paused && !document.pointerLockElement
    );
  };
  const doubleSpace = async () => {
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
  };
  const settings = async (section = "controls") => {
    await mainMenu();
    if (section === "world")
      await page.locator(".world-settings-button").click();
    else {
      await page.locator(".settings-toggle").click();
      await page.locator(`[data-menu-target="${section}"]`).click();
    }
  };
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await ready();
  assert.equal((await snap()).inputMode, "native");
  assert.equal((await snap()).mouseSensitivity, 1);
  await settings("world");
  await page.locator('.mode-picker [data-mode="creative"]').click();
  await enter();
  await page.waitForFunction(() => window.__voxelBot.game.player.locked);
  await page.mouse.move(350, 300);
  const nativeBefore = await snap();
  await page.mouse.move(750, 300);
  await frames();
  const nativeAfter = await snap();
  near(nativeAfter.yaw - nativeBefore.yaw, -0.8, "Native 400px flick");
  assert.equal(nativeAfter.locked, true);
  console.log(
    `Native: 400px -> ${nativeAfter.yaw - nativeBefore.yaw} rad, actual capture=${nativeAfter.locked}`
  );

  await doubleSpace();
  await page.waitForFunction(() => window.__voxelBot.game.player.flying);
  await page.keyboard.down("Space");
  await frames(16);
  await page.keyboard.down("Space"); // Chromium marks the held-key press repeat.
  await frames(2);
  await page.keyboard.up("Space");
  assert.equal((await snap()).flying, true);
  await page.keyboard.down("ShiftLeft");
  await page.waitForFunction(
    () => window.__voxelBot.game.player.velocity.y < 0
  );
  assert.equal((await snap()).sneaking, false, "Shift descends during flight");
  await page.keyboard.up("ShiftLeft");
  // Windowed Ctrl-before-W is a browser close-tab chord without keyboard lock.
  await page.keyboard.down("KeyW");
  await page.keyboard.down("ControlLeft");
  await page.waitForFunction(() => window.__voxelBot.game.player.sprinting);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ControlLeft");
  await page.keyboard.press("f");
  assert.equal(
    (await snap()).flying,
    true,
    "F swaps hands without ending flight"
  );
  await page.waitForFunction(() => {
    const v = window.__voxelBot.game.player.velocity;
    return Math.hypot(v.x, v.y, v.z) < 0.001;
  });
  await page.mouse.down({ button: "left" });
  await page.mouse.down({ button: "right" });
  assert.equal((await snap()).heldAction, null);
  assert.equal((await snap()).useHeld, true);
  assert.equal((await snap()).useSource, "mouse");
  await page.mouse.up({ button: "right" });
  assert.equal((await snap()).heldAction, "mine");
  assert.equal((await snap()).useHeld, false);
  await page.mouse.up({ button: "left" });
  assert.equal((await snap()).miningKey, "");
  assert.equal((await snap()).miningProgress, 0);
  const perspectiveStart = await snap();
  for (const perspective of ["back", "front", "first"]) {
    await page.keyboard.press("F5");
    await frames();
    const state = await snap();
    assert.equal(state.perspective, perspective);
    near(state.yaw, perspectiveStart.yaw, "F5 preserves yaw");
    near(state.pitch, perspectiveStart.pitch, "F5 preserves pitch");
    assert.ok(
      Math.hypot(
        ...state.position.map(
          (value, index) => value - perspectiveStart.position[index]
        )
      ) < 0.01,
      "changing the camera does not move the player"
    );
  }
  await doubleSpace();
  await page.waitForFunction(
    () =>
      !window.__voxelBot.game.player.flying &&
      window.__voxelBot.game.player.grounded
  );
  const standing = await snap();
  await page.keyboard.down("ShiftLeft");
  await frames();
  const sneaking = await snap();
  assert.equal(sneaking.sneaking, true);
  assert.ok(sneaking.height < standing.height);
  assert.ok(
    sneaking.eye[1] - sneaking.position[1] <
      standing.eye[1] - standing.position[1]
  );
  await page.keyboard.up("ShiftLeft");
  await frames();
  assert.equal((await snap()).sneaking, false);
  console.log(
    "Java controls: double-Space flight, held-key repeat suppression, Shift descent/sneak, Ctrl boost, F swap, F5 first/back/front with stable player pose."
  );

  await pause();
  await settings();
  // Focus-only setup puts the real keyboard target outside #ui. Navigation
  // still uses trusted browser keys, not synthetic DOM key dispatch.
  await page.evaluate(() => document.activeElement?.blur());
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("#ui").contains(document.activeElement)
    ),
    false
  );
  await page.keyboard.press("Escape");
  assert.equal((await snap()).menuPage, "options");
  assert.equal((await snap()).paused, true);
  await page.keyboard.press("Escape");
  assert.equal((await snap()).menuPage, "main");
  assert.equal((await snap()).paused, true);
  const menuState = await snap();
  for (const [key, property] of [
    ["F1", "hudVisible"],
    ["F3", "debugVisible"],
  ]) {
    await page.keyboard.press(key);
    assert.equal((await snap())[property], !menuState[property]);
    await page.keyboard.press(key);
    assert.equal((await snap())[property], menuState[property]);
  }
  await page.keyboard.press("F5");
  await frames();
  assert.equal((await snap()).perspective, menuState.perspective);
  assert.equal((await snap()).menuPage, "main");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__voxelBot.game.active);
  await pause();
  await settings();
  await page.locator("#input-mode-setting").selectOption("remote");
  assert.match(
    await page.locator("#input-mode-help").innerText(),
    /RIGHT-DRAG.*RIGHT-CLICK.*window edges/
  );
  await enter();
  assert.equal((await snap()).locked, false);
  assert.equal(
    await page
      .locator("#game canvas")
      .evaluate((node) => getComputedStyle(node).cursor),
    "grab"
  );
  assert.equal(await page.locator(".hotbar-look-hint").isVisible(), false);
  await page.keyboard.press("F3");
  assert.equal(await page.locator(".hotbar-look-hint").isVisible(), true);
  assert.equal(await page.locator(".hotbar-edge-hint").isVisible(), true);
  await page.keyboard.press("F3");
  await page.mouse.move(250, 250);
  const before = await snap();
  await page.mouse.down({ button: "right" });
  for (let x = 252; x <= 650; x += 2) await page.mouse.move(x, 250);
  await frames();
  const horizontal = await snap();
  near(horizontal.yaw - before.yaw, -0.8, "Remote slow absolute drag");
  assert.equal(
    horizontal.heldAction,
    null,
    "Remote look must never hold place"
  );
  assert.equal(horizontal.pointerLock, false);
  assert.equal(
    await page.locator("#game canvas").getAttribute("data-looking"),
    "true"
  );
  for (let y = 252; y <= 350; y += 2) await page.mouse.move(650, y);
  await frames();
  near((await snap()).pitch - before.pitch, -0.2, "Remote vertical drag");
  for (let y = 348; y >= 250; y -= 2) await page.mouse.move(650, y);
  for (let x = 648; x >= 250; x -= 2) await page.mouse.move(x, 250);
  await page.mouse.up({ button: "right" });
  await frames();
  const reversed = await snap();
  near(reversed.yaw, before.yaw, "Remote horizontal reversal");
  near(reversed.pitch, before.pitch, "Remote vertical reversal");
  near(reversed.cameraYaw, reversed.yaw, "Rendered yaw");
  near(reversed.cameraPitch, reversed.pitch, "Rendered pitch");
  console.log(
    `Remote: 400px -> ${horizontal.yaw - before.yaw} rad, vertical 100px -> -0.2 rad, reversal residual=${reversed.yaw - before.yaw}, capture=${reversed.pointerLock}`
  );

  await page.mouse.down({ button: "left" });
  await page.mouse.down({ button: "right" });
  await page.mouse.move(300, 250);
  assert.equal((await snap()).heldAction, "mine");
  await page.mouse.up({ button: "right" });
  assert.equal((await snap()).heldAction, "mine");
  await page.mouse.up({ button: "left" });
  assert.equal((await snap()).heldAction, null);
  await page.keyboard.down("v");
  assert.equal((await snap()).useHeld, true);
  assert.equal((await snap()).useSource, "remote-key");
  await page.keyboard.up("v");
  assert.equal((await snap()).useHeld, false);
  await page.keyboard.down("w");
  await frames(4);
  assert.ok((await snap()).keys.includes("KeyW"));
  await page.keyboard.down("v");
  await page.mouse.down({ button: "right" });
  await page.keyboard.press("e");
  await page.waitForFunction(() => window.__voxelBot.game.overlayOpen);
  assert.equal((await snap()).enabled, false);
  assert.equal((await snap()).useHeld, false);
  assert.deepEqual((await snap()).keys, []);
  await page.keyboard.up("w");
  await page.keyboard.up("v");
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("e");
  await page.waitForFunction(
    () => window.__voxelBot.game.active && !window.__voxelBot.game.playing
  );
  const afterInventory = await snap();
  assert.equal(afterInventory.useHeld, false);
  await page.mouse.move(700, 300);
  near(
    (await snap()).yaw,
    afterInventory.yaw,
    "Inventory resumes without a stale drag"
  );

  await pause();
  await settings();
  // A trusted keyboard edit exercises the range's normal input callback.
  await page.locator("#mouse-sensitivity-setting").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  assert.equal((await snap()).mouseSensitivity, 0.3);
  assert.equal(
    await page.locator("#mouse-sensitivity-value").innerText(),
    "0.30×"
  );
  const preferences = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("voxelcraft-controls-v1"))
  );
  assert.deepEqual(preferences, { inputMode: "remote", mouseSensitivity: 0.3 });
  // Save/import run only within this disposable profile. A portable world may
  // carry unknown fields; none may override the browser's control preferences.
  const save = await page.evaluate(async () => {
    const game = window.__voxelBot.game;
    await game.save();
    return game.snapshot();
  });
  assert.equal("controlPreferences" in save, false);
  await page.reload({ waitUntil: "load" });
  await ready();
  assert.equal((await snap()).inputMode, "remote");
  assert.equal((await snap()).mouseSensitivity, 0.3);
  await settings("world");
  save.controlPreferences = { inputMode: "native", mouseSensitivity: 3 };
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".import-file").setInputFiles({
    name: "controls-do-not-travel.voxelcraft.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(save)),
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".storage-status")?.dataset.state === "success" &&
      !window.__voxelBot.game.building
  );
  assert.equal((await snap()).inputMode, "remote");
  assert.equal((await snap()).mouseSensitivity, 0.3);
  await enter();
  await page.mouse.move(300, 300);
  const sensitiveBefore = await snap();
  await page.mouse.down({ button: "right" });
  await page.mouse.move(400, 350);
  await page.mouse.up({ button: "right" });
  near(
    (await snap()).yaw - sensitiveBefore.yaw,
    -0.06,
    "Restored sensitivity yaw"
  );
  near(
    (await snap()).pitch - sensitiveBefore.pitch,
    -0.03,
    "Restored sensitivity pitch"
  );
  await pause();
  await settings();
  await page.locator("#input-mode-setting").selectOption("native");
  await enter();
  await page.waitForFunction(() => window.__voxelBot.game.player.locked);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Java movement/perspectives, independent Native mine/use, Remote V + drag-look, E/Esc lifecycle, modal reserved keys, sensitivity, reload, import isolation, and return to Native capture."
  );
});
