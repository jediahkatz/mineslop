// Opt-in real-game regression. Serve a frozen build of test/realtime on a fresh
// numeric-loopback port, then set VOXELCRAFT_TEST_URL explicitly. This file never
// starts a server or uses a shared browser profile. Setup is labeled separately
// from trusted Play/F5/V/Escape/Save/Respawn inputs and real AI/fall simulation.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  HURT_MAX_FLASH,
  HURT_MAX_ROLL,
  HURT_SECONDS,
} from "../src/hurt-feedback.js";
import {
  hurtEncounterConfig,
  installHurtEncounterFixture,
  installHurtReloadObserver,
} from "./hurt-survival-encounter.browser-fixture.mjs";
import { chromeExecutable } from "./realtime/config.mjs";

const configuredUrl = process.env.VOXELCRAFT_TEST_URL;
if (!configuredUrl)
  throw new Error(
    "Set VOXELCRAFT_TEST_URL to a fresh, isolated frozen realtime server"
  );
const base = new URL(configuredUrl);
const protectedPorts = new Set(["5173", "5280", "5290", "5297", "5311"]);
if (
  !["http:", "https:"].includes(base.protocol) ||
  !["127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  !base.port ||
  protectedPorts.has(base.port)
)
  throw new Error(
    "VOXELCRAFT_TEST_URL requires an explicit numeric-loopback port; never use 5173/5280/5290/5297/5311"
  );
const url = new URL("/test/realtime/index.html", base);
url.searchParams.set("quality", "low");
url.searchParams.set("seed", "cedar-valley");

function near(actual, expected, message, tolerance = 0.000002) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} versus ${expected}`
  );
}

function samePhysicalAim(
  state,
  reference,
  { falling = false, camera = true } = {}
) {
  assert.equal(
    state.yaw,
    reference.yaw,
    "render feedback never writes physical yaw"
  );
  assert.equal(
    state.pitch,
    reference.pitch,
    "render feedback never writes physical pitch"
  );
  assert.deepEqual(
    state.forward,
    reference.forward,
    "the physical forward ray is unchanged"
  );
  for (const axis of ["x", "z"]) {
    near(
      state.position[axis],
      reference.position[axis],
      `physical feet ${axis}`
    );
    near(state.eye[axis], reference.eye[axis], `physical eye ${axis}`);
  }
  if (!falling) near(state.eye.y, reference.eye.y, "standing physical eye");
  near(
    state.eye.y - state.position.y,
    reference.eye.y - reference.position.y,
    "eye height remains physical, including during a real fall"
  );
  if (camera) {
    state.quaternion.forEach((value, i) =>
      near(
        value,
        reference.quaternion[i],
        "camera quaternion has no hurt-roll drift",
        1e-12
      )
    );
    if (!falling)
      for (const axis of ["x", "y", "z"])
        near(
          state.cameraPosition[axis],
          reference.cameraPosition[axis],
          `render eye ${axis}`
        );
  }
}

function assertObservations(observed, { footing = true } = {}) {
  assert.equal(observed.error, null);
  assert.ok(observed.frames.length > 0, "real rendered frames were observed");
  assert.equal(
    observed.stableIndicator,
    true,
    "one stable real HUD node is reused"
  );
  assert.equal(
    observed.summary.unexplainedPulses,
    0,
    "no pulse appears without health loss"
  );
  assert.ok(
    observed.inputs.every((input) => input.trusted),
    "no synthetic DOM input"
  );
  for (const frame of observed.frames) {
    assert.equal(frame.mode, "survival");
    assert.equal(
      frame.main?.id,
      hurtEncounterConfig.sword.id,
      "the held item stays nonempty"
    );
    assert.equal(frame.flying, false, "Survival gravity is never bypassed");
    assert.equal(frame.gpu.contextLost, false);
    assert.equal(frame.gpu.badPrograms, 0);
    assert.ok(
      frame.gpu.draws > 0 && frame.gpu.valid,
      "the real GPU receives a scene projection"
    );
    assert.ok(
      frame.gpu.projectionError < 0.00001,
      "GPU projection belongs to the real game camera"
    );
    assert.equal(
      frame.gpu.cpuOffAxis,
      0,
      "the CPU projection is restored after every draw"
    );
    assert.ok(Math.abs(frame.gpu.roll) <= HURT_MAX_ROLL + 0.00001);
    assert.ok(frame.remaining >= 0 && frame.remaining <= HURT_SECONDS);
    assert.ok(
      frame.flash.opacity >= 0 && frame.flash.opacity <= HURT_MAX_FLASH
    );
    if (footing)
      assert.equal(
        frame.supportIntact,
        true,
        "natural footing/headroom remain unedited"
      );
  }
}

function healthLosses(observed) {
  let before = observed.initial;
  return observed.frames.flatMap((after) => {
    const loss = after.health < before.health ? [{ before, after }] : [];
    before = after;
    return loss;
  });
}

function assertRealHurt(observed, { kind = "mob", motion = true } = {}) {
  assertObservations(observed);
  const losses = healthLosses(observed).filter(({ after }) => !after.dead);
  assert.ok(losses.length > 0, "a real, nonlethal health loss occurred");
  assert.ok(
    losses.some(({ after }) => after.active && after.flash.visible),
    "health loss reaches a visible screen-edge flash in a rendered frame"
  );
  for (const { before, after } of losses) {
    assert.equal(
      after.otherNearbyHostiles,
      0,
      "no other hostile contaminates damage provenance"
    );
    assert.ok(after.remaining > 0);
    if (kind === "mob") {
      assert.equal(before.health - after.health, hurtEncounterConfig.damage);
      assert.ok(
        after.mob?.attacking && after.mob.cooldown > 0,
        "the real hostile attacked"
      );
      assert.ok(after.mob.distance <= after.mob.reach + 0.2);
      assert.equal(
        after.grounded,
        true,
        "this is a mob hit, not environmental falling"
      );
    } else {
      assert.equal(after.mob, null);
      assert.equal(before.grounded, false);
      assert.ok(before.velocityY < 0, "gravity accelerated the actual Player");
      assert.equal(
        after.grounded,
        true,
        "real landing, not a direct health call"
      );
    }
  }
  const flashes = observed.frames.filter(
    (frame) => frame.active && frame.flash.visible
  );
  for (const frame of flashes) {
    assert.match(frame.flash.background, /radial-gradient/);
    assert.equal(frame.flash.pointerEvents, "none");
    assert.ok(frame.flash.width >= frame.flash.viewport[0] * 0.95);
    assert.ok(frame.flash.height >= frame.flash.viewport[1] * 0.95);
    assert.equal(frame.reducedMotion, !motion);
  }
  if (motion)
    assert.ok(
      flashes.some((frame) => Math.abs(frame.gpu.roll) > 0.001),
      "a nonzero roll reaches actual GPU uniforms while physical pose stays unchanged"
    );
  else
    assert.ok(
      flashes.every((frame) => Math.abs(frame.gpu.roll) < 1e-7),
      "reduced-motion color feedback uploads an unrolled GPU projection"
    );
  const stable = observed.frames.filter(
    (frame) =>
      frame.active &&
      frame.perspective === "first" &&
      (kind === "fall" || frame.grounded)
  );
  assert.ok(stable.length > 0);
  for (const frame of stable)
    samePhysicalAim(frame, stable[0], { falling: kind === "fall" });
  return losses;
}

function assertQuietPaused(observed) {
  const paused = observed.frames.filter((frame) => frame.paused && !frame.dead);
  assert.ok(
    paused.length >= 2,
    "the paused overlay was rendered more than once"
  );
  const last = paused.at(-1);
  const tail = paused.filter((frame) => frame.frame >= last.frame - 2);
  for (const frame of tail) {
    assert.equal(frame.simulating, false);
    assert.equal(frame.remaining, 0);
    assert.equal(frame.flash.visible, false);
    assert.equal(frame.flash.opacity, 0);
    assert.equal(frame.avatar.tint, 0);
    near(frame.gpu.roll, 0, "paused render has no roll", 1e-7);
    assert.equal(frame.health, last.health);
    assert.equal(
      frame.simulationTime,
      last.simulationTime,
      "pause freezes active simulation time"
    );
  }
}

const redBias = ([r, g, b]) => r - (g + b) / 2;

test("real incoming hits, fall, F5 tint, shields, reduced motion and lifecycle resets", {
  timeout: 240000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    reducedMotion: "no-preference",
    serviceWorkers: "block",
  });
  const blockedOrigins = [];
  await context.route("**/*", (route) => {
    const requested = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(requested.protocol) &&
      requested.origin !== url.origin
    ) {
      if (blockedOrigins.length < 8) blockedOrigins.push(requested.origin);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  // A frozen host has no HMR/socket traffic. Do not even connect to an accidental
  // shared dev-server websocket (HTTP routing does not intercept WebSockets).
  await context.routeWebSocket("**/*", (socket) => {
    if (blockedOrigins.length < 8) blockedOrigins.push(socket.url());
    socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const recordError = (message) => {
    if (errors.length < 32) errors.push(message);
  };
  page.on("pageerror", (error) => recordError(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") recordError(message.text());
  });
  const read = () => page.evaluate(() => window.__voxelHurtRegression.read());
  const begin = (label) =>
    page.evaluate((value) => window.__voxelHurtRegression.begin(value), label);
  const end = () => page.evaluate(() => window.__voxelHurtRegression.end());
  let phase = "frozen host startup";

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
      "use a frozen production build, not HMR"
    );
    assert.equal(state.renderer.contextLost, false);
    assert.ok(state.view.visibleChunkGroups > 0);
    assert.deepEqual(
      errors,
      [],
      "startup errors are real failures, never hidden by setup"
    );
    return state;
  };
  const prepare = async (kind = "mob") => {
    const fixture = await page.evaluate(
      (value) => window.__voxelHurtRegression.prepare({ kind: value }),
      kind
    );
    assert.equal(fixture.autoSpawn, true, "normal spawning remains enabled");
    assert.equal(fixture.entityCount, kind === "mob" ? 1 : 0);
    assert.equal(fixture.supportColumns, 49);
    const state = await read();
    assert.equal(state.paused, true);
    assert.equal(state.supportIntact, true);
    assert.equal(state.health, 20);
    assert.equal(state.remaining, 0);
    assert.equal(state.main.id, hurtEncounterConfig.sword.id);
    t.diagnostic(`CONTROLLED SETUP ONLY ${JSON.stringify(fixture)}`);
    return fixture;
  };
  const enter = async ({ airborne = false } = {}) => {
    await page.locator(".play-button").click();
    await page.waitForFunction((allowAirborne) => {
      const game = window.__voxelBot.game;
      return (
        game.active &&
        !game.playing &&
        game.player.enabled &&
        (allowAirborne || game.player.grounded)
      );
    }, airborne);
  };
  const draws = async (count = 4) => {
    const before = await page.evaluate(
      () => window.__voxelBot.game.graphics.renderer.info.render.frame
    );
    await page.waitForFunction(
      ({ before, count }) =>
        window.__voxelBot.game.graphics.renderer.info.render.frame >=
        before + count,
      { before, count }
    );
  };
  const pause = async () => {
    assert.equal(
      await page.evaluate(() => window.__voxelBot.game.overlayOpen),
      false
    );
    if (!(await page.evaluate(() => window.__voxelBot.game.paused)))
      await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return game.paused && !game.player.enabled && !game.closingScreens;
    });
    await draws();
  };
  const waitSummary = async (key, count = 1, timeout = 15000) => {
    await page.waitForFunction(
      ({ key, count }) => {
        const observed = window.__voxelHurtRegression.observations();
        return observed.error || observed.summary[key] >= count;
      },
      { key, count },
      { timeout }
    );
    assert.equal(
      await page.evaluate(
        () => window.__voxelHurtRegression.observations().error
      ),
      null
    );
  };
  const report = (name, observed, details = {}) =>
    t.diagnostic(
      `PASS ${name} ${JSON.stringify({
        frames: observed.frames.length,
        ...observed.summary,
        ...details,
      })}`
    );

  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
    const initial = await ready();
    t.diagnostic(
      `FROZEN HOST ${JSON.stringify({
        origin: url.origin,
        build: initial.build,
        renderer: initial.renderer.renderer,
        softwareRenderer: initial.renderer.softwareRenderer,
      })}`
    );
    await page.locator(".settings-toggle").click();
    await page.locator(".controls-settings-button").click();
    await page.locator("#input-mode-setting").selectOption("remote");
    await page.locator(".menu-back-button").click();
    await page.locator(".menu-back-button").click();
    await page.evaluate(installHurtEncounterFixture, hurtEncounterConfig);

    phase =
      "two genuine incoming mob hits, finite flash and unchanged physical aim";
    await prepare();
    await begin(phase);
    await enter();
    await waitSummary("visibleLosses", 2);
    await pause();
    const hits = await end();
    const losses = assertRealHurt(hits);
    assert.ok(losses.length >= 2);
    assert.ok(
      hits.frames.some(
        (frame) =>
          frame.frame > losses[0].after.frame &&
          frame.frame < losses[1].after.frame &&
          frame.active &&
          frame.remaining === 0 &&
          !frame.flash.visible
      ),
      "the first pulse decays before a separate real attack refreshes it"
    );
    assertQuietPaused(hits);
    report("mob source -> committed health -> DOM flash/GPU roll", hits, {
      health: hits.current.health,
      peakGpuRoll: Math.max(
        ...hits.frames.map((frame) => Math.abs(frame.gpu.roll))
      ),
    });

    phase = "actual F5 avatar tint, GPU pixel readback and perspective cleanup";
    await prepare();
    await begin(phase);
    await enter();
    const aimBeforeF5 = await read();
    await page.keyboard.press("F5");
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return game.player.perspective === "back" && game.playerVisual.visible;
    });
    await waitSummary("tintedFrames");
    // F5 is a real lifecycle reset. Do not retain a rolled matrix or tint on
    // the front view, or a hidden avatar batch after returning to first person.
    await page.keyboard.press("F5");
    await page.waitForFunction(() => {
      const state = window.__voxelHurtRegression.read();
      return (
        state.perspective === "front" &&
        state.avatar.tint === 0 &&
        state.remaining === 0
      );
    });
    samePhysicalAim(await read(), aimBeforeF5, { camera: false });
    await page.keyboard.press("F5");
    await page.waitForFunction(() => {
      const state = window.__voxelHurtRegression.read();
      return (
        state.perspective === "first" &&
        !state.avatar.visible &&
        state.remaining === 0
      );
    });
    await pause();
    const avatar = await end();
    assertRealHurt(avatar);
    assertQuietPaused(avatar);
    assert.equal(
      avatar.inputs.filter(
        (input) => input.type === "keydown" && input.code === "F5"
      ).length,
      3
    );
    const backFrames = avatar.frames.filter(
      (frame) => frame.active && frame.perspective === "back"
    );
    for (const frame of backFrames) samePhysicalAim(frame, backFrames[0]);
    const quiet = backFrames.filter(
      (frame) => frame.avatar.tint === 0 && frame.avatar.pixel
    );
    const tinted = backFrames.filter(
      (frame) => frame.avatar.tint > 0.1 && frame.avatar.pixel
    );
    assert.ok(
      quiet.length > 0 && tinted.length > 0,
      "both normal and hurt avatar pixels were drawn"
    );
    const baselineBias =
      quiet.reduce((sum, frame) => sum + redBias(frame.avatar.pixel.rgb), 0) /
      quiet.length;
    const peak = tinted.reduce((best, frame) =>
      redBias(frame.avatar.pixel.rgb) > redBias(best.avatar.pixel.rgb)
        ? frame
        : best
    );
    assert.ok(
      redBias(peak.avatar.pixel.rgb) - baselineBias > 8,
      "actual blue-trouser GPU pixels become redder; DOM flash is excluded from canvas readback"
    );
    assert.equal(
      new Set(backFrames.map((frame) => frame.avatar.batch)).size,
      1,
      "hits reuse one avatar batch"
    );
    assert.ok(
      backFrames.every(
        (frame) => frame.avatar.parts > 0 && frame.avatar.parts <= 48
      )
    );
    report("trusted F5 and rendered avatar hurt tint", avatar, {
      quietRedBias: baselineBias,
      hurtRgb: peak.avatar.pixel.rgb,
      hurtRedBias: redBias(peak.avatar.pixel.rgb),
    });

    phase = "full frontal shield blocks cause wear but no health loss or hurt";
    await prepare();
    await begin(phase);
    await enter();
    await page.keyboard.down("v");
    await page.waitForFunction(
      () => window.__voxelBot.game.useActions.use.blocking
    );
    await waitSummary("shieldWear", 2);
    await pause(); // A real menu cancels held shield use, even before key release.
    await page.keyboard.up("v");
    const shield = await end();
    assertObservations(shield);
    assertQuietPaused(shield);
    assert.equal(shield.summary.healthLosses, 0);
    assert.equal(shield.summary.flashFrames, 0);
    assert.ok(
      shield.frames.every(
        (frame) => frame.health === 20 && frame.remaining === 0
      )
    );
    assert.ok(shield.frames.every((frame) => Math.abs(frame.gpu.roll) < 1e-7));
    assert.ok(
      shield.inputs.some(
        (input) => input.code === "KeyV" && input.type === "keydown"
      )
    );
    const wear =
      hurtEncounterConfig.shield.durability - shield.current.offhand.durability;
    const wearPerHit = Math.ceil(hurtEncounterConfig.damage) + 1;
    assert.ok(wear >= 2 * wearPerHit && wear % wearPerHit === 0);
    assert.deepEqual(shield.current.main, shield.initial.main);
    assert.equal(shield.current.useActive, false);
    assert.ok(
      shield.frames.some(
        (frame) =>
          frame.blocking && frame.mob?.attacking && frame.mob.cooldown > 0
      )
    );
    report("real shield blocks without hurt feedback", shield, {
      shieldWear: wear,
    });

    phase = "physical fall into unmodified generated terrain";
    await prepare("fall");
    await begin(phase);
    await enter({ airborne: true });
    await waitSummary("visibleLosses");
    await page.waitForFunction(() => {
      const state = window.__voxelHurtRegression.read();
      return state.grounded && state.health < 20 && state.remaining === 0;
    });
    await pause();
    const fall = await end();
    assertRealHurt(fall, { kind: "fall" });
    assertQuietPaused(fall);
    assert.equal(fall.summary.healthLosses, 1);
    assert.ok(fall.initial.position.y - fall.current.position.y > 6.5);
    report("real gravity/landing -> health -> finite flash", fall, {
      health: fall.current.health,
    });

    phase = "browser reduced-motion preference keeps color without GPU roll";
    await page.emulateMedia({ reducedMotion: "reduce" });
    await prepare();
    await begin(phase);
    await enter();
    await waitSummary("visibleLosses");
    await pause();
    const reduced = await end();
    assertRealHurt(reduced, { motion: false });
    assertQuietPaused(reduced);
    const savedHealth = reduced.current.health;
    assert.ok(savedHealth > 0 && savedHealth < 20);
    report("reduced-motion real hit retains color only", reduced, {
      health: savedHealth,
    });

    phase = "trusted Save World and real reload of genuinely reduced health";
    await page.locator(".world-settings-button").click();
    await page.locator(".save-button").click();
    // HUD polling may normalize the completed save's UI state back to "idle".
    // Wait for the actual operation and enabled control, not a transient badge.
    await page.waitForFunction(
      () =>
        !document.querySelector(".save-button").disabled &&
        window.__voxelBot.game.storageStatus === "Saved on this device"
    );
    assert.notEqual(
      await page.locator(".storage-status").getAttribute("data-state"),
      "error"
    );
    assert.match(await page.locator(".storage-status").innerText(), /saved/i);
    const saved = await page.evaluate(async () => {
      const snapshot = await window.__voxelBot.game.archive.storage.load();
      return { health: snapshot?.gameplay.health, seed: snapshot?.world.seed };
    });
    assert.equal(
      saved.health,
      savedHealth,
      "persist the actual hit result, not a fabricated health snapshot"
    );
    assert.equal(saved.seed, "cedar-valley");
    await page.evaluate(() => window.__voxelHurtRegression.dispose());
    await page.addInitScript(installHurtReloadObserver);
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await ready();
    await page.waitForFunction(() => window.__voxelHurtReloadProof?.done);
    const boot = await page.evaluate(() => window.__voxelHurtReloadProof);
    assert.equal(boot.error, null);
    assert.equal(boot.sawReducedHealth, true);
    assert.equal(
      boot.maxRemaining,
      0,
      "loading reduced health never starts a hurt pulse"
    );
    assert.equal(
      boot.maxOpacity,
      0,
      "no load-time edge flash, including before ready"
    );
    assert.deepEqual(boot.anomalies, []);
    await page.evaluate(installHurtEncounterFixture, hurtEncounterConfig);
    assert.equal((await read()).health, savedHealth);
    await begin("unmodified reduced-health reload, pause and resume");
    await draws();
    await enter();
    const resumedAt = (await read()).simulationTime;
    await page.waitForFunction(
      (at) => window.__voxelBot.game.wildlife.clock - at >= 0.4,
      resumedAt
    );
    await pause();
    const reload = await end();
    assertObservations(reload, { footing: false });
    assertQuietPaused(reload);
    assert.ok(
      reload.frames.every(
        (frame) => frame.health === savedHealth && frame.remaining === 0
      )
    );
    assert.equal(reload.summary.flashFrames, 0);
    report("actual saved-health reload does not replay damage", reload, {
      boot,
    });

    phase = "genuine hostile death clears the current hurt pulse";
    await prepare();
    await begin(phase);
    await enter();
    await page
      .locator(".death-overlay")
      .waitFor({ state: "visible", timeout: 30000 });
    await draws();
    const dead = await read();
    assert.equal(dead.health, 0);
    assert.equal(dead.dead, true);
    assert.equal(dead.remaining, 0);
    assert.equal(dead.flash.visible, false);
    const death = await end();
    assertObservations(death);
    const lethal = healthLosses(death).find(({ after }) => after.dead);
    assert.ok(lethal, "a real lethal attack must precede respawn");
    // Later AI substeps correctly stop attacking a dead player. The newly
    // consumed attack cooldown, actual health loss and sole nearby hostile
    // establish this source without requiring a stale `attacking` flag.
    assert.ok(lethal.after.mob.cooldown > lethal.before.mob.cooldown);
    assert.equal(
      lethal.before.health - lethal.after.health,
      Math.min(lethal.before.health, hurtEncounterConfig.damage)
    );
    assert.equal(lethal.after.otherNearbyHostiles, 0);
    assert.equal(lethal.after.grounded, true);
    assert.equal(lethal.after.remaining, 0);
    report("real lethal damage clears the pulse", death);

    // Death has stopped simulation. A separate bounded observer can now cover
    // asynchronous respawn/loading without spending the encounter's frame budget.
    phase = "trusted Respawn, paused menu and resumed new life";
    await begin(phase);
    await page.locator(".respawn-button").click();
    await page.waitForFunction(
      () => {
        const game = window.__voxelBot.game;
        return (
          !game.building &&
          !game.gameplay.dead &&
          game.gameplay.health === 20 &&
          game.paused &&
          !game.player.enabled
        );
      },
      undefined,
      { timeout: 30000 }
    );
    await draws();
    await enter();
    await draws();
    await pause();
    const life = await end();
    assertObservations(life, { footing: false });
    assertQuietPaused(life);
    assert.equal(
      life.initial.dead,
      true,
      "no fixture reset manufactures the new life"
    );
    const newLife = life.frames.filter(
      (frame) => !frame.dead && frame.health === 20
    );
    assert.ok(
      newLife.some((frame) => frame.active),
      "the respawned player really resumed play"
    );
    for (const frame of life.frames) {
      assert.equal(frame.remaining, 0);
      assert.equal(frame.flash.visible, false);
      near(frame.gpu.roll, 0, "death/respawn render has no stale roll", 1e-7);
    }
    report("real death/respawn clears transient hurt state", life);
    const inputs = await page.evaluate(() => window.__voxelBot.state().inputs);
    assert.ok(inputs.trusted > 0);
    assert.equal(inputs.untrusted, 0);
    assert.deepEqual(blockedOrigins, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => {
        const helper = window.__voxelHurtRegression;
        const observed = helper?.observations();
        return {
          hostError: window.__voxelBot?.error,
          fixture: helper?.fixture,
          current: helper?.read(),
          summary: observed?.summary,
          observationError: observed?.error,
          lastFrames: observed?.frames.slice(-5),
          reload: window.__voxelHurtReloadProof,
        };
      })
      .catch(() => null);
    t.diagnostic(
      `FAILED ${phase}: ${JSON.stringify({ errors, blockedOrigins, diagnostic })}`
    );
    throw error;
  } finally {
    await page
      .evaluate(() => window.__voxelHurtRegression?.dispose())
      .catch(() => {});
  }
});
