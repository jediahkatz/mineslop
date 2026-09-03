// Opt-in real rendered VoxelGame regression, using trusted Chromium input.
// Requires a separately built/served frozen test/realtime entry on a fresh port.
// No server startup, shared browser/profile, save import, or synthetic DOM fixture.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { MELEE_COOLDOWN_SECONDS } from "../src/combat-feedback.js";
import { rayBoxDistance } from "../src/mob-navigation.js";
import {
  BOW_CLOCK_ROUNDOFF_SECONDS,
  hasFullBowDraw,
} from "./combat-bow-timing.mjs";
import {
  endermanCombatConfig,
  installEndermanCombatFixture,
} from "./combat-enderman.browser-fixture.mjs";
import { chromeExecutable } from "./realtime/config.mjs";

const configuredUrl = process.env.VOXELCRAFT_TEST_URL;
if (!configuredUrl)
  throw new Error(
    "VOXELCRAFT_TEST_URL is required; serve the frozen realtime entry on a fresh isolated port"
  );
const base = new URL(configuredUrl);
const protectedPorts = new Set(["5173", "5280", "5290", "5297"]);
if (
  !["http:", "https:"].includes(base.protocol) ||
  !["127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  !base.port ||
  protectedPorts.has(base.port)
)
  throw new Error(
    "VOXELCRAFT_TEST_URL must use an explicit loopback test port, never protected ports 5173, 5280, 5290 or 5297"
  );
const url = new URL("/test/realtime/index.html", base);
url.searchParams.set("quality", "low");
url.searchParams.set("seed", "cedar-valley");
const center = { x: 550, y: 380 };
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const cellPosition = ({ x, y, z }) => ({ x, y, z });
const gapTolerance = 0.07;

function aimGeometry(state, part = "level") {
  const target =
    part === "head"
      ? state.mob.head
      : { ...state.mob.position, y: state.eye.y };
  const dx = target.x - state.eye.x;
  const dy = target.y - state.eye.y;
  const dz = target.z - state.eye.z;
  const direction = {
    x: -Math.sin(state.yaw) * Math.cos(state.pitch),
    y: Math.sin(state.pitch),
    z: -Math.cos(state.yaw) * Math.cos(state.pitch),
  };
  return {
    direction,
    along: dx * direction.x + dy * direction.y + dz * direction.z,
    lateral: Math.abs(dx * Math.cos(state.yaw) - dz * Math.sin(state.yaw)),
    miss: Math.hypot(
      dy * direction.z - dz * direction.y,
      dz * direction.x - dx * direction.z,
      dx * direction.y - dy * direction.x
    ),
    yawDelta: wrap(state.yaw - Math.atan2(-dx, -dz)),
    pitchDelta: state.pitch - Math.atan2(dy, Math.hypot(dx, dz)),
  };
}

function assertBodyInReach(state) {
  const distance = rayBoxDistance(
    state.eye,
    aimGeometry(state).direction,
    state.mob.position,
    state.mob.radius,
    state.mob.height,
    3
  );
  assert.ok(
    distance !== null && distance > 0 && distance <= 3,
    `the physical ray enters a body ahead within Survival reach (${distance}); an eye inside the body is not gap evidence`
  );
  return distance;
}

function ownershipAfter(
  ownership,
  { swordWear = 0, bowWear = 0, arrows = 0 } = {}
) {
  const expected = structuredClone(ownership);
  expected.slots[0].durability -= swordWear;
  expected.slots[1].durability -= bowWear;
  expected.slots[2].count -= arrows;
  return expected;
}

function assertGap(state, fixture, { rear = true } = {}) {
  assert.equal(
    state.active,
    true,
    "encounter is active, not a paused domain call"
  );
  assert.equal(state.mode, "survival");
  assert.equal(state.grounded, true);
  assert.equal(state.flying, false);
  assert.ok(Math.abs(state.pitch) < 0.01, "physical eye aim is level");
  const { along, lateral } = aimGeometry(state);
  assert.ok(along > 0, "the Enderman is ahead, not behind the eye ray");
  assert.ok(
    lateral < gapTolerance,
    `aim remains on the body centerline (${lateral} blocks)`
  );
  assertBodyInReach(state);
  assert.equal(
    state.precise,
    null,
    "precise model-part targeting still misses the central gap"
  );
  assert.equal(
    state.melee,
    fixture.id,
    "only melee acquires the continuous Enderman body"
  );
  assert.equal(
    state.mob.lookingAt,
    false,
    "level-eye melee is not a head stare"
  );
  if (rear) {
    assert.equal(state.block?.id, fixture.rear.id);
    assert.deepEqual(cellPosition(state.block), cellPosition(fixture.rear));
  }
  assert.equal(
    state.supportIntact,
    true,
    "the generated footing is still unmodified"
  );
}

// World generation, actual software WebGL and browser input are integration work.
test("Survival Enderman gap melee, recharge and held input preserve precise bow/use/stare and cover", {
  timeout: 180000,
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
    serviceWorkers: "block",
  });
  // Also refuse a redirect/subresource request to another game origin. This
  // guard only permits/aborts real network traffic; it never fulfills a response.
  await context.route("**/*", (route) => {
    const requested = new URL(route.request().url());
    return ["http:", "https:"].includes(requested.protocol) &&
      requested.origin !== url.origin
      ? route.abort("blockedbyclient")
      : route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const read = () => page.evaluate(() => window.__voxelCombatRegression.read());
  const evidence = () =>
    page.evaluate(() => window.__voxelCombatRegression.observations());
  const begin = (label) =>
    page.evaluate(
      (value) => window.__voxelCombatRegression.begin(value),
      label
    );
  const end = () => page.evaluate(() => window.__voxelCombatRegression.end());
  const indicator = page.locator(".combat-indicator");
  let phase = "startup";
  let bowReleases = [];
  let chestReleases = [];
  const prepare = async (options) => {
    const fixture = await page.evaluate(
      (value) => window.__voxelCombatRegression.prepare(value),
      options
    );
    assert.equal(
      fixture.autoSpawn,
      true,
      "normal spawning and AI remain enabled"
    );
    t.diagnostic(`SETUP ONLY ${JSON.stringify(fixture)}`);
    return fixture;
  };
  const enter = async () => {
    await page.locator(".play-button").click();
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return (
        game.active &&
        !game.playing &&
        game.player.enabled &&
        game.player.grounded
      );
    });
  };
  const pause = async () => {
    if (await page.evaluate(() => window.__voxelBot.game.overlayOpen)) {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !window.__voxelBot.game.overlayOpen);
    }
    if (!(await page.evaluate(() => window.__voxelBot.game.paused)))
      await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const game = window.__voxelBot.game;
      return game.paused && !game.player.enabled && !game.closingScreens;
    });
  };
  const gap = async (fixture) => {
    await page.waitForFunction(
      (id) => {
        const game = window.__voxelBot.game;
        return (
          game.active &&
          game.meleeTarget?.entity.id === id &&
          game.mobTarget === null
        );
      },
      fixture.id,
      { timeout: 5000 }
    );
    const state = await read();
    assertGap(state, fixture);
    return state;
  };

  // Keep a real Remote drag open between corrections; recenter only at an edge.
  // The moving target needs the same world-space gap as assertGap, not a fixed
  // 0.006-radian accuracy that becomes arbitrarily tight as it approaches us.
  // No pose writes, AI/clock changes, retries of the encounter or extra attacks.
  const aim = async (part = "level", onAligned = null) => {
    let dragging = false;
    let cursor = { ...center };
    const trace = { part, samples: [] };
    const sample = async () => {
      const state = await read();
      assert.ok(
        state.active && state.mob,
        "a live encounter is required to aim"
      );
      const geometry = aimGeometry(state, part);
      trace.samples.push({
        frame: state.frame,
        simulationTime: state.simulationTime,
        eye: state.eye,
        mob: state.mob.position,
        yaw: state.yaw,
        pitch: state.pitch,
        cursor: { ...cursor },
        ...geometry,
      });
      return { state, geometry };
    };
    const aligned = ({ state, geometry }) =>
      geometry.along > 0 &&
      (part === "level"
        ? geometry.lateral < gapTolerance && Math.abs(state.pitch) <= 0.004
        : geometry.miss < gapTolerance);
    try {
      // Inspect the result of the eighth correction too, without a ninth move.
      for (let corrections = 0; corrections <= 8; corrections++) {
        let current = await sample();
        if (aligned(current)) {
          // Bow release stays in this gesture, without release/recenter/frame
          // round-trips first. Its actual trusted-event geometry is asserted.
          await onAligned?.();
          return;
        }
        if (corrections === 8) break;
        const pixels = ({ state, geometry }) => {
          const scale = 0.002 * state.mouseSensitivity;
          return {
            x: Math.round(
              Math.max(-450, Math.min(450, geometry.yawDelta / scale))
            ),
            y: Math.round(
              Math.max(-300, Math.min(300, geometry.pitchDelta / scale))
            ),
          };
        };
        let delta = pixels(current);
        if (
          !dragging ||
          cursor.x + delta.x < 100 ||
          cursor.x + delta.x > 1000 ||
          cursor.y + delta.y < 80 ||
          cursor.y + delta.y > 680
        ) {
          if (dragging) await page.mouse.up({ button: "right" });
          await page.mouse.move(center.x, center.y);
          await page.mouse.down({ button: "right" });
          dragging = true;
          // Cross the real threshold once so release cannot become a use tap.
          cursor = { x: center.x + 8, y: center.y };
          await page.mouse.move(cursor.x, cursor.y);
          // Setup advanced real AI and yaw: never steer from the earlier sample.
          current = await sample();
          delta = pixels(current);
        }
        cursor = {
          x: Math.max(100, Math.min(1000, cursor.x + delta.x)),
          y: Math.max(80, Math.min(680, cursor.y + delta.y)),
        };
        await page.mouse.move(cursor.x, cursor.y);
      }
      throw new Error(
        `Could not frame the moving Enderman's ${part} within eight real corrections`
      );
    } finally {
      if (dragging) await page.mouse.up({ button: "right" });
      t.diagnostic(`AIM ${JSON.stringify(trace)}`);
    }
  };

  try {
    await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
    assert.equal(new URL(page.url()).origin, url.origin);
    await page.waitForFunction(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      { timeout: 60000 }
    );
    const initial = await page.evaluate(() =>
      window.__voxelBot.state({ renderer: true })
    );
    assert.equal(initial.error, null);
    assert.equal(
      initial.build.production,
      true,
      "run the frozen build, not an HMR development server"
    );
    assert.equal(initial.renderer.contextLost, false);
    assert.ok(
      initial.view.visibleChunkGroups > 0,
      "the real generated world is rendered"
    );
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
    await page.evaluate(installEndermanCombatFixture, endermanCombatConfig);

    phase = "melee, immediate refusal, natural readiness and holding";
    const encounter = await prepare();
    await enter();
    await aim();
    const baseline = await gap(encounter);
    assert.equal(baseline.hand.id, endermanCombatConfig.sword);
    assert.equal(baseline.feedback.ready, true);
    await indicator.waitFor({ state: "visible" });
    await begin("trusted iron-sword clicks and hold");
    // One browser command delivers two fresh presses without assertion/network
    // round-trips in between. Capture the actual accepted/rejected game times;
    // no exact 0.49/0.51 boundary or wall-clock scheduling claim belongs here.
    await page.mouse.dblclick(center.x, center.y, { delay: 0 });
    let observed = await evidence();
    assert.equal(observed.presses.length, 2);
    const [first, early] = observed.presses;
    assert.ok(
      first.trusted && early.trusted,
      "both attacks use trusted browser mouse events"
    );
    assertGap(first.after, encounter);
    assert.equal(first.after.mob.health, first.before.mob.health - 6);
    assert.equal(first.after.hand.durability, first.before.hand.durability - 1);
    assert.deepEqual(
      first.after.ownership,
      ownershipAfter(first.before.ownership, { swordWear: 1 }),
      "a real sword hit spends one wear, not finite inventory resources"
    );
    const interval = early.after.elapsed - first.after.lastAction;
    assert.ok(
      interval >= 0 && interval < MELEE_COOLDOWN_SECONDS,
      `immediate-press precondition missed under browser scheduling (${interval}s); no clock manipulation is allowed`
    );
    assert.equal(early.after.melee, encounter.id);
    assert.equal(early.after.precise, null);
    assert.equal(early.after.mob.health, first.after.mob.health);
    assert.deepEqual(early.after.ownership, first.after.ownership);
    assert.equal(early.after.lastAction, first.after.lastAction);
    assert.equal(early.after.feedback.blockedReason, "cooldown");
    await page.waitForFunction(() =>
      window.__voxelCombatRegression
        .observations()
        .frames.some(
          (frame) =>
            frame.indicator?.visible &&
            frame.indicator.phase === "cooldown" &&
            frame.indicator.blocked === "cooldown" &&
            frame.indicator.value >= 0 &&
            frame.indicator.value < 100 &&
            /too early/.test(frame.indicator.text)
        )
    );
    await page.waitForFunction((id) => {
      const state = window.__voxelCombatRegression.read();
      return (
        state.active &&
        state.melee === id &&
        state.feedback.ready &&
        state.indicator.visible &&
        state.indicator.phase === "ready" &&
        state.indicator.value === 100 &&
        state.indicator.blocked === ""
      );
    }, encounter.id);
    await page.mouse.down({ button: "left" });
    observed = await evidence();
    assert.equal(observed.presses.length, 3);
    const fresh = observed.presses[2];
    assert.equal(fresh.trusted, true);
    assert.equal(fresh.after.melee, encounter.id);
    assert.equal(fresh.after.precise, null);
    assert.ok(
      fresh.after.elapsed - first.after.lastAction >= MELEE_COOLDOWN_SECONDS
    );
    assert.equal(fresh.after.mob.health, first.after.mob.health - 6);
    assert.equal(fresh.after.hand.durability, first.after.hand.durability - 1);
    const heldAt = fresh.after.simulationTime;
    await page.waitForFunction((at) => {
      const game = window.__voxelBot.game;
      return game.active && game.wildlife.clock - at >= 1.2;
    }, heldAt);
    await page.mouse.up({ button: "left" });
    observed = await end();
    const heldFrames = observed.frames.filter(
      (frame) => frame.simulationTime >= heldAt && frame.held === "mine"
    );
    assert.ok(
      heldFrames.some(
        (frame) =>
          frame.melee === encounter.id &&
          frame.feedback.ready &&
          frame.elapsed - fresh.after.lastAction > MELEE_COOLDOWN_SECONDS
      ),
      "holding crosses readiness with a live melee target; this is not a vacuous no-target hold"
    );
    assert.ok(
      heldFrames.every((frame) => frame.mob?.health === fresh.after.mob.health)
    );
    assert.equal(observed.current.mob.health, baseline.mob.health - 12);
    assert.deepEqual(
      observed.current.ownership,
      ownershipAfter(baseline.ownership, { swordWear: 2 }),
      "holding never auto-attacks, consumes items, or wears the sword again"
    );
    assert.ok(observed.frames.every((frame) => frame.miningProgress === 0));
    assert.ok(
      observed.frames.every(
        (frame) => frame.rear?.id === endermanCombatConfig.dirt
      )
    );
    assert.deepEqual(observed.current.rear, baseline.rear);
    assert.equal(observed.current.supportIntact, true);
    assert.equal(observed.current.held, null);
    assert.ok(
      observed.current.mob.angry > 0,
      "real retaliation AI remains live after damage"
    );
    assert.equal(observed.current.dead, false);
    assert.equal(
      observed.current.acknowledgedAt,
      early.after.elapsed,
      "held frames cannot queue new refusals"
    );
    const refusals = observed.frames.filter(
      (frame) => frame.indicator?.blocked === "cooldown"
    );
    assert.ok(refusals.length > 0);
    assert.ok(
      refusals.every(
        (frame) => frame.elapsed - early.after.elapsed < MELEE_COOLDOWN_SECONDS
      )
    );
    assert.equal(observed.current.indicator.blocked, "");
    assert.equal(observed.overflow, 0);
    assert.equal(observed.stableHudNodes, true);
    assert.equal(observed.hotbarChildChanges, 0);
    assert.equal(observed.indicatorChildChanges, 0);
    // The existing 0.2s HUD cadence updates this unchanged XP meter twice.
    // Extra tolerance covers the boundary, but not a full-HUD render per frame.
    const elapsed = observed.current.elapsed - observed.initial.elapsed;
    assert.ok(
      observed.fullHudMeterWrites <= 2 * (Math.ceil(elapsed / 0.2) + 2),
      `combat caused excess full-HUD churn: ${observed.fullHudMeterWrites} meter writes over ${elapsed}s`
    );
    t.diagnostic(
      `PASS melee ${JSON.stringify({
        damage: 12,
        swordWear: 2,
        immediateInterval: interval,
        heldSimulationSeconds: observed.current.simulationTime - heldAt,
        rearDirt: observed.current.rear.id,
        observedFrames: observed.frames.length,
        fullHudMeterWrites: observed.fullHudMeterWrites,
        boundedRefusalFrames: refusals.length,
      })}`
    );

    phase = "F1 and pause-menu indicator visibility";
    await indicator.waitFor({ state: "visible" });
    await page.keyboard.press("F1");
    assert.equal(await indicator.isHidden(), true);
    await page.keyboard.press("F1");
    await indicator.waitFor({ state: "visible" });
    await pause();
    assert.equal(await indicator.isHidden(), true);
    assert.equal((await read()).feedback.visible, false);

    phase = "precise bow miss and non-stare at level eye height";
    const bowEncounter = await prepare();
    await enter();
    await page.keyboard.press("2");
    await aim();
    const bowBefore = await gap(bowEncounter);
    assert.equal(bowBefore.hand.id, endermanCombatConfig.bow);
    await begin("real bow draw/release through the model gap");
    await page.keyboard.down("v");
    await page.waitForFunction(() => {
      const use = window.__voxelBot.game.useActions.use;
      return use.kind === "bow" && use.progress === 1;
    });
    await aim("level", () => page.keyboard.up("v"));
    const bow = await end();
    bowReleases = bow.releases;
    assert.equal(bow.overflow, 0);
    assert.equal(bow.releases.length, 1);
    const release = bow.releases[0];
    assert.equal(release.trusted, true);
    assert.equal(release.before.use.active, true);
    assert.equal(release.before.use.kind, "bow");
    assert.equal(release.before.use.progress, 1);
    // Wandering changes the bearing. The static rear-block regression is still
    // asserted in melee, initial bow framing and chest use; it is not a moving
    // backstop. Validate the actual release ray, not a stale pre-release frame.
    assertGap(release.before, bowEncounter, { rear: false });
    assert.equal(
      release.precise,
      null,
      "the fresh full-range bow query misses rendered parts at trusted release"
    );
    assert.equal(release.after.use.active, false);
    const shotDistance = Math.hypot(
      release.shotEnd.x - release.before.eye.x,
      release.shotEnd.y - release.before.eye.y,
      release.shotEnd.z - release.before.eye.z
    );
    assert.ok(
      shotDistance > assertBodyInReach(release.before),
      "the actual shot travels beyond the continuous melee body's entry"
    );
    assert.equal(release.after.mob.health, release.before.mob.health);
    assert.equal(
      bow.current.mob.health,
      bowBefore.mob.health,
      "the melee-only volume never intercepts an arrow"
    );
    assert.deepEqual(
      bow.current.ownership,
      ownershipAfter(bowBefore.ownership, { bowWear: 1, arrows: 1 }),
      "an actual bow release consumes one arrow and one bow wear"
    );
    assert.deepEqual(bow.current.rear, bowBefore.rear);
    assert.equal(bow.current.supportIntact, true);
    const bowClock = {
      provenance: "BROWSER OBSERVATION; NOT THE DERIVED NUMERIC CASE",
      initial: bow.initial.simulationTime,
      current: bow.current.simulationTime,
      simulationDelta: bow.current.simulationTime - bow.initial.simulationTime,
      releaseUse: release.before.use,
      allowanceSeconds: BOW_CLOCK_ROUNDOFF_SECONDS,
    };
    assert.ok(
      hasFullBowDraw(bowClock.initial, bowClock.current, bowClock.releaseUse),
      `Exact full bow charge and one simulation second (bounded roundoff only): ${JSON.stringify(bowClock)}`
    );
    assert.ok(
      bow.frames.some(
        (frame) =>
          frame.indicator?.visible && frame.indicator.phase === "using-item"
      )
    );
    assert.ok(
      bow.frames.every(
        (frame) =>
          frame.mob &&
          !frame.mob.lookingAt &&
          frame.mob.lookTimer === 0 &&
          frame.mob.angry === 0
      )
    );
    t.diagnostic(
      `PASS precise bow ${JSON.stringify({
        trusted: release.trusted,
        drawSimulationSeconds:
          release.before.simulationTime - bow.initial.simulationTime,
        clockCheck: bowClock,
        release: {
          frame: release.before.frame,
          eye: release.before.eye,
          mob: release.before.mob.position,
          ...aimGeometry(release.before),
          bodyDistance: assertBodyInReach(release.before),
          precise: release.precise,
          melee: release.before.melee,
          block: release.before.block,
        },
        shotDistance,
        damage: bowBefore.mob.health - bow.current.mob.health,
        bowWear: bowBefore.hand.durability - bow.current.hand.durability,
        arrows:
          bowBefore.ownership.slots[2].count -
          bow.current.ownership.slots[2].count,
        rearIntact: true,
        supportIntact: bow.current.supportIntact,
      })}`
    );
    await pause();

    phase = "precise right-click through the gap";
    const chestEncounter = await prepare({ rear: "chest" });
    await enter();
    // The initial level look belongs to paused setup, not active turning while
    // the mob can leave the fixed chest ray. Keep every gap/rear precondition.
    const chestBefore = await gap(chestEncounter);
    await begin("real right-click opens the rear chest");
    await page.mouse.click(center.x, center.y, { button: "right" });
    const chest = await end();
    chestReleases = chest.rightReleases;
    assert.equal(chest.overflow, 0);
    assert.equal(chest.rightReleases.length, 1);
    const rightRelease = chest.rightReleases[0];
    assert.equal(rightRelease.trusted, true);
    assert.equal(rightRelease.button, 2);
    assertGap(chest.initial, chestEncounter);
    assertGap(rightRelease.before, chestEncounter);
    assert.equal(
      rightRelease.precise,
      null,
      "the fresh Survival-range model-part query misses at trusted RMB release"
    );
    assert.equal(rightRelease.before.container.open, false);
    assert.equal(rightRelease.before.indicator.visible, true);
    assert.equal(rightRelease.after.frame, rightRelease.before.frame);
    assert.equal(
      rightRelease.after.simulationTime,
      rightRelease.before.simulationTime
    );
    assert.equal(rightRelease.after.yaw, rightRelease.before.yaw);
    assert.equal(rightRelease.after.pitch, rightRelease.before.pitch);
    assert.equal(
      rightRelease.after.container.open,
      true,
      "the actual release handler opens the chest synchronously, without polling"
    );
    assert.equal(rightRelease.after.container.kind, "chest");
    const opened = rightRelease.after.container.hit;
    assert.equal(opened.id, endermanCombatConfig.chest);
    assert.deepEqual(cellPosition(opened), cellPosition(chestEncounter.rear));
    assert.deepEqual(chest.current.container, rightRelease.after.container);
    assert.equal(
      rightRelease.after.indicator.visible,
      false,
      "the same trusted release hides the indicator before another frame"
    );
    assert.equal(rightRelease.after.feedback.visible, false);
    assert.equal(rightRelease.before.mob.health, chestBefore.mob.health);
    assert.deepEqual(rightRelease.before.ownership, chestBefore.ownership);
    assert.equal(rightRelease.after.mob.health, rightRelease.before.mob.health);
    assert.deepEqual(
      rightRelease.after.ownership,
      rightRelease.before.ownership,
      "opening the real chest preserves every finite inventory stack and wear"
    );
    assert.equal(chest.current.mob.health, chestBefore.mob.health);
    assert.deepEqual(chest.current.ownership, chestBefore.ownership);
    assert.deepEqual(chest.current.rear, chestBefore.rear);
    assert.equal(chest.current.supportIntact, true);
    assert.equal(
      await indicator.isHidden(),
      true,
      "real container menus hide the indicator"
    );
    t.diagnostic(
      `CHEST RELEASE ${JSON.stringify({
        provenance: "BROWSER OBSERVATION OF PAUSED-AUTHORED CHEST ENCOUNTER",
        initialLook: chestEncounter.initialLook,
        trusted: rightRelease.trusted,
        button: rightRelease.button,
        eventTimestamp: rightRelease.eventTimestamp,
        beforeFrame: rightRelease.before.frame,
        afterFrame: rightRelease.after.frame,
        eye: rightRelease.before.eye,
        mob: rightRelease.before.mob.position,
        ...aimGeometry(rightRelease.before),
        bodyDistance: assertBodyInReach(rightRelease.before),
        precise: rightRelease.precise,
        melee: rightRelease.before.melee,
        authoredChest: chestEncounter.rear,
        block: rightRelease.before.block,
        opened,
        healthBefore: rightRelease.before.mob.health,
        healthAfter: rightRelease.after.mob.health,
        ownershipBefore: rightRelease.before.ownership,
        ownershipAfter: rightRelease.after.ownership,
        indicatorBefore: rightRelease.before.indicator,
        indicatorAfter: rightRelease.after.indicator,
      })}`
    );
    t.diagnostic(
      "PASS precise use: trusted right-click opens the actual rear chest without attacking or spending supplies."
    );
    await pause();

    phase = "precise head stare before cover";
    const coverEncounter = await prepare({ distance: 2.95 });
    await enter();
    await aim();
    await gap(coverEncounter);
    await begin("real mouse aim acquires the rendered head");
    await aim("head");
    await page.waitForFunction(
      (id) => {
        const state = window.__voxelCombatRegression.read();
        return (
          state.precise === id && state.mob.lookingAt && state.mob.lookTimer > 0
        );
      },
      coverEncounter.id,
      { timeout: 5000 }
    );
    const head = await end();
    assert.equal(head.overflow, 0);
    assert.equal(head.current.precise, coverEncounter.id);
    assert.equal(head.current.mob.lookingAt, true);
    // Only positive head acquisition is asserted, not aggro/teleport balance.
    await pause();

    phase = "real stone cover blocks melee and the precise head ray";
    await page.evaluate(() => window.__voxelCombatRegression.addCover());
    await enter();
    await aim();
    await page.waitForFunction(
      (stone) => {
        const state = window.__voxelCombatRegression.read();
        return (
          state.active &&
          state.block?.id === stone &&
          state.melee === null &&
          state.precise === null
        );
      },
      endermanCombatConfig.stone,
      { timeout: 5000 }
    );
    await begin("trusted click and head look against real cover");
    await page.mouse.click(center.x, center.y);
    let covered = await evidence();
    assert.equal(covered.presses.length, 1);
    const blocked = covered.presses[0];
    assert.equal(blocked.trusted, true);
    assertBodyInReach(blocked.before);
    assert.equal(blocked.after.melee, null);
    assert.equal(blocked.after.precise, null);
    assert.equal(blocked.after.mob.health, blocked.before.mob.health);
    assert.deepEqual(blocked.after.ownership, blocked.before.ownership);
    await aim("head");
    await page.waitForFunction(
      (stone) => {
        const state = window.__voxelCombatRegression.read();
        return (
          state.pitch > 0.2 &&
          state.block?.id === stone &&
          state.precise === null &&
          state.melee === null &&
          !state.mob.lookingAt &&
          state.mob.lookTimer === 0
        );
      },
      endermanCombatConfig.stone,
      { timeout: 5000 }
    );
    covered = await end();
    assert.equal(covered.overflow, 0);
    assert.equal(covered.current.mob.health, covered.initial.mob.health);
    assert.deepEqual(covered.current.ownership, covered.initial.ownership);
    assert.ok(
      covered.current.cover.every((id) => id === endermanCombatConfig.stone)
    );
    assert.equal(covered.current.supportIntact, true);
    t.diagnostic(
      "PASS cover: an in-reach, previously acquired Enderman takes no damage/wear through real stone; its head ray is occluded."
    );
    await pause();

    const rendered = await page.evaluate(() => {
      const { graphics, wildlife } = window.__voxelBot.game;
      return {
        lost: graphics.renderer.getContext().isContextLost(),
        badPrograms: graphics.renderer.info.programs.filter(
          (program) => program.diagnostics?.runnable === false
        ).length,
        draws: graphics.renderer.info.render.calls,
        mobParts: wildlife.mesh.count,
        inputs: window.__voxelBot.state().inputs,
      };
    });
    assert.equal(rendered.lost, false);
    assert.equal(rendered.badPrograms, 0);
    assert.ok(rendered.draws > 0 && rendered.mobParts > 0);
    assert.ok(rendered.inputs.trusted > 0);
    assert.equal(rendered.inputs.untrusted, 0);
    assert.deepEqual(errors, []);
    t.diagnostic(
      `PASS real renderer and trusted controls ${JSON.stringify(rendered)}`
    );
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => {
        const fixture = window.__voxelCombatRegression;
        const observed = fixture?.observations();
        return fixture
          ? {
              fixture: fixture.fixture,
              current: fixture.read(),
              presses: observed?.presses,
              releases: observed?.releases,
              rightReleases: observed?.rightReleases,
              lastFrames: observed?.frames.slice(-8),
            }
          : { error: window.__voxelBot?.error };
      })
      .catch(() => null);
    t.diagnostic(
      `FAILED ${phase}: ${JSON.stringify({ errors, diagnostic, bowReleases, chestReleases })}`
    );
    throw error;
  } finally {
    await page
      .evaluate(() => window.__voxelCombatRegression?.dispose())
      .catch(() => {});
  }
});
