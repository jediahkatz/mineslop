import { setTimeout as delay } from "node:timers/promises";
import { bounded, traversalPlan } from "./input.mjs";
import { streamingWithinBudget } from "./mesh-budget.js";
import { distance } from "./statistics.js";

export function assertion(report, name, passed, evidence = {}) {
  const entry = { name, status: passed ? "passed" : "failed", evidence };
  report.assertions.push(entry);
  console.log(`[${entry.status}] ${name}`);
  return passed;
}

function warning(report, name, evidence) {
  report.warnings.push({ name, evidence });
  console.warn(`[warning] ${name}`);
}

async function settle(input) {
  await input.release();
  return input.until(
    (state) =>
      Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) < 0.025,
    "Released movement settles"
  );
}

async function mainMenu(input) {
  for (let step = 0; step < 5; step++) {
    if (
      (await input.page.locator(".menu-screen").getAttribute("data-page")) ===
      "main"
    )
      return;
    await input.click(".menu-back-button");
  }
  throw new Error("Could not return to the main game menu");
}

async function startPlaying(input) {
  if ((await input.state()).paused) {
    await mainMenu(input);
    await input.click(".play-button");
  }
  return input.until(
    (state) => state.active && state.enabled,
    "Entering the world"
  );
}

export async function verifyNativeMouse(input, report) {
  await startPlaying(input);
  let before = await input.state();
  if (!before.locked) {
    await delay(1600);
    await input.click("#game canvas");
    await delay(1600);
  }
  // Place the physical input cursor near the middle before bounded yaw sweeps.
  await input.moveTo(
    input.config.viewport.width / 2,
    input.config.viewport.height / 2
  );
  await input.frames();
  before = await input.state();
  await input.moveBy(60, 12);
  let after;
  let reason = null;
  try {
    after = await input.until(
      (state) =>
        state.locked &&
        Math.abs(state.camera.yaw - before.camera.yaw) > 0.01 &&
        Math.abs(state.camera.pitch - before.camera.pitch) > 0.002,
      "Native pointer-lock yaw and pitch response",
      4000
    );
  } catch (failure) {
    reason = failure.message;
    after = await input.state();
  }
  const mousePixels = {
    x: after.inputs.mousePixels.x - before.inputs.mousePixels.x,
    y: after.inputs.mousePixels.y - before.inputs.mousePixels.y,
  };
  const nativePassed =
    after.locked &&
    Math.abs(after.camera.yaw - before.camera.yaw) > 0.01 &&
    Math.abs(after.camera.pitch - before.camera.pitch) > 0.002 &&
    mousePixels.x > 0 &&
    mousePixels.y > 0;
  report.mouse = {
    mode: nativePassed ? "native-mouse" : "arrow-fallback",
    nativePassed,
    pointerLockBefore: before.locked,
    pointerLockAfter: after.locked,
    cameraYawDelta: after.camera.yaw - before.camera.yaw,
    cameraPitchDelta: after.camera.pitch - before.camera.pitch,
    trustedMovementPixels: mousePixels,
    reason: nativePassed
      ? null
      : (reason ?? "Native mouse deltas did not reach the camera"),
  };
  if (nativePassed || input.config.requireNativeMouse)
    assertion(
      report,
      "Native pointer lock and mouse yaw/pitch",
      nativePassed,
      report.mouse
    );
  else
    warning(
      report,
      "Native pointer-lock mouse look failed; Arrow-key look is used and is NOT native-mouse proof",
      report.mouse
    );
  input.lookMode = report.mouse.mode;
  await startPlaying(input);
}

async function warmupFlight(input, report) {
  let state = await input.state();
  if (state.flying) {
    await input.doubleTap("Space");
    await input.until(
      (next) => !next.flying,
      "Creative double-Space disables flight"
    );
  }
  await input.doubleTap("Space", { holdSecondFrames: 2 });
  state = await input.until(
    (next) => next.flying && !next.grounded,
    "Creative double-Space enables flight"
  );
  assertion(
    report,
    "Creative flight toggles through two fresh Space presses",
    state.allowFlight && state.flying && !state.grounded,
    { holdSecondFrames: 2, grounded: state.grounded, position: state.position }
  );
  const facingDeadline = performance.now() + 6000;
  while (performance.now() < facingDeadline) {
    state = await input.state();
    if (Math.abs(state.yaw) < 0.02 && Math.abs(state.pitch + 0.42) < 0.02)
      break;
    let lookKeys = [];
    if (input.lookMode === "native-mouse") {
      await input.moveBy(
        Math.max(-60, Math.min(60, state.yaw / 0.002)),
        Math.max(-30, Math.min(30, (state.pitch + 0.42) / 0.002))
      );
    } else lookKeys = await input.steer(state, 0, -0.42);
    await input.setHeld(lookKeys);
    await input.frames(1);
  }
  state = await input.state();
  if (Math.abs(state.yaw) >= 0.03 || Math.abs(state.pitch + 0.42) >= 0.03)
    throw new Error(
      `Native input could not align the repeatable route: yaw=${state.yaw}, pitch=${state.pitch}`
    );
  const deadline = performance.now() + 1800;
  // Normalize through real mouse input; pointer-lock recenter timing must not
  // select a different route or view in an A/B performance comparison.
  const anchorYaw = 0;
  while (performance.now() < deadline) {
    state = await input.state({ planning: true });
    const plan = traversalPlan(state, 0, anchorYaw);
    const lookKeys = await input.steer(state, anchorYaw, plan.pitch);
    // Warm shader programs and gain initial clearance, outside the benchmark.
    await input.setHeld(
      [
        ...(state.position.y < plan.targetAltitude ? ["Space"] : []),
        ...lookKeys,
      ],
      { flight: true }
    );
    await delay(input.config.tickMs);
  }
  await settle(input);
  const aligned = await input.state();
  assertion(
    report,
    "Benchmark starts on the repeatable northbound route",
    Math.abs(Math.atan2(Math.sin(aligned.yaw), Math.cos(aligned.yaw))) < 0.03,
    { yaw: aligned.yaw, pitch: aligned.pitch }
  );
}

export async function traverseTerrain(input, report) {
  await warmupFlight(input, report);
  let state = await input.state({ planning: true, renderer: true });
  report.renderer = state.renderer;
  report.world = {
    seed: state.seed,
    quality: state.quality,
    dimension: state.dimension,
    renderRadius: state.world.renderRadius,
  };
  assertion(
    report,
    "Requested real generated world is active",
    state.seed === input.config.seed &&
      state.quality === input.config.quality &&
      state.mode === "creative" &&
      !state.syntheticFixture &&
      state.world.renderedChunks > 0,
    report.world
  );
  const anchorYaw = 0;
  report.world.routeStart = {
    position: state.position,
    yaw: state.yaw,
    pitch: state.pitch,
  };
  let planning = state.planning;
  await input.page.evaluate(() =>
    window.__voxelBot.metrics.reset("generated-terrain-traversal")
  );
  const started = performance.now();
  const deadline = started + input.config.durationSeconds * 1000;
  let nextTick = started;
  let nextProgress = started;
  let lastProgress = { now: started, frame: state.frame };
  let tick = 0;
  report.traversalProgress = [];
  try {
    while (performance.now() < deadline) {
      state = await input.state({ planning: tick % 5 === 0 });
      planning = state.planning ?? planning;
      state.planning = planning;
      if (!state.active || state.dead || state.hidden || !state.enabled)
        throw new Error("Traversal lost active controls or page visibility");
      if (input.lookMode === "native-mouse" && !state.locked)
        throw new Error(
          "Native pointer lock was lost during the measured traversal"
        );
      if (
        ![state.position.x, state.position.y, state.position.z].every(
          Number.isFinite
        )
      )
        throw new Error("Traversal produced non-finite player coordinates");
      const now = performance.now();
      const seconds = (now - started) / 1000;
      const plan = traversalPlan(state, seconds, anchorYaw);
      const lookKeys = await input.steer(state, plan.yaw, plan.pitch);
      await input.setHeld([...plan.keys, ...lookKeys], { flight: true });
      if (now >= nextProgress) {
        const live = state.live;
        const fps =
          (1000 * (state.frame - lastProgress.frame)) /
          Math.max(1, now - lastProgress.now);
        const progress = {
          seconds,
          recentFps: tick ? fps : null,
          lastFrameMs: live.lastFrameMs,
          position: state.position,
          targetAltitude: plan.targetAltitude,
          distance: live.distance,
          chunksCrossed: live.chunksCrossed,
          cache: state.world.chunks,
          requests: state.world.requests,
          inFlight: state.world.inFlight,
          locked: state.locked,
          timeOfDay: state.timeOfDay,
        };
        report.traversalProgress.push(progress);
        console.log(
          `[terrain ${seconds.toFixed(1)}s] ` +
            `${tick ? fps.toFixed(1) : "warming"} FPS, ` +
            `${live.distance.toFixed(1)} blocks, ${live.chunksCrossed} chunk crossings, ` +
            `cache ${state.world.chunks}, requests ${state.world.requests}/${state.world.inFlight}`
        );
        lastProgress = { now, frame: state.frame };
        nextProgress = now + 1000;
      }
      tick++;
      nextTick = Math.max(nextTick + input.config.tickMs, performance.now());
      await delay(Math.max(0, nextTick - performance.now()));
    }
  } finally {
    report.terrain = await input.page.evaluate(() =>
      window.__voxelBot.metrics.results({ stop: true })
    );
    report.terrain.controlTicks = tick;
    report.terrain.nodeElapsedMs = performance.now() - started;
    await input.release();
  }
  const result = report.terrain;
  const radius = report.world.renderRadius;
  assertion(
    report,
    "Day/night clock does not accelerate against wall time",
    result.clock.available &&
      result.clock.discontinuities === 0 &&
      result.clock.simulationRate > 0 &&
      result.clock.simulationRate < 1.05,
    result.clock
  );
  if (result.clock.simulationRate < 0.95)
    warning(
      report,
      "Long frames lose more than 5% of simulation time",
      result.clock
    );
  assertion(
    report,
    "Real input moves across generated chunks",
    result.movement.horizontalDistance >
      (input.config.durationSeconds >= 15 ? 16 : 2) &&
      (input.config.durationSeconds < 15 || result.movement.chunksCrossed > 0),
    result.movement
  );
  assertion(
    report,
    "Traversal stays active and on loaded terrain",
    result.frames.active > 1 &&
      result.frames.paused === 0 &&
      result.frames.unloadedPlayer === 0,
    {
      activeFrames: result.frames.active,
      pausedFrames: result.frames.paused,
      unloadedPlayerFrames: result.frames.unloadedPlayer,
    }
  );
  assertion(
    report,
    "Native DOM movement events reach real player updates",
    result.inputs.trusted > 0 &&
      result.inputs.untrusted === 0 &&
      result.latency.keyToMotionMs.samples > 0,
    { inputs: result.inputs, keySamples: result.latency.keyToMotionMs.samples }
  );
  assertion(
    report,
    "Terrain remains in the rendered view, not blank sky",
    result.view.samples > 0 &&
      result.view.terrainVisibleFraction >= 0.4 &&
      result.maxima.triangles > 0,
    result.view
  );
  assertion(
    report,
    "Streaming cache and generation work remain bounded",
    streamingWithinBudget(result.maxima, radius),
    result.maxima
  );
  if (input.lookMode === "native-mouse")
    assertion(
      report,
      "Continuous native mouse sweeps update the camera",
      result.latency.mouseToCameraMs.samples > 1 &&
        result.inputs.mousePixels.x > 20 &&
        result.inputs.mousePixels.y > 0,
      {
        samples: result.latency.mouseToCameraMs.samples,
        pixels: result.inputs.mousePixels,
      }
    );
  else
    assertion(
      report,
      "Explicit Arrow fallback updates the camera",
      result.latency.arrowToCameraMs.samples > 0,
      {
        samples: result.latency.arrowToCameraMs.samples,
        nativeMouseProof: false,
      }
    );
}

function withinMenuClearance(state, clearance) {
  const { position, flying, grounded } = state;
  const { bounds, targetAltitude } = clearance;
  return flying && !grounded && Number.isFinite(position.y) &&
    position.y >= targetAltitude &&
    position.x >= bounds.minX + 1 && position.x <= bounds.maxX - 1 &&
    position.z >= bounds.minZ + 1 && position.z <= bounds.maxZ - 1;
}

export async function prepareMenuControls(input, report) {
  const started = performance.now();
  const before = await settle(input);
  if (!before.active || !before.enabled || !before.allowFlight)
    throw new Error("Menu clearance setup requires active Creative controls");
  const clearance = await bounded(input.page.evaluate(() => {
    const { player, world } = window.__voxelBot.game;
    const x = Math.floor(player.position.x), z = Math.floor(player.position.z);
    const bounds = { minX: x - 12, maxX: x + 13, minZ: z - 12, maxZ: z + 13 };
    let highestOccupiedY = world.minY - 1;
    // Read every column, including trees and water, without generating or editing
    // cells. A one-block horizontal margin and two blocks above occupied cells
    // keep the player body clear, including shapes taller than their owner cell.
    for (let px = bounds.minX; px < bounds.maxX; px++)
      for (let pz = bounds.minZ; pz < bounds.maxZ; pz++) {
        if (!world.isLoaded(px, pz))
          throw new Error(`Menu clearance needs a loaded column at ${px},${pz}`);
        for (let y = world.maxY - 1; y > highestOccupiedY; y--)
          if (world.get(px, y, pz) !== 0) {
            highestOccupiedY = y;
            break;
          }
      }
    return {
      bounds, columns: 25 * 25, highestOccupiedY,
      targetAltitude: highestOccupiedY + 3,
    };
  }), input.config.timeoutMs, "Read loaded menu clearance");
  report.menuSetup = {
    label: "unmeasured-native-menu-clearance",
    measurement: "Before both inventory/pause assertions and their metrics; excluded from traversal",
    ...clearance,
    before: { position: before.position, flying: before.flying, grounded: before.grounded },
    limits: { takeoffGestures: 1, holdSecondFrames: 2, ascentHolds: 1, waitTimeoutMs: input.config.timeoutMs },
    takeoffGestures: 0,
    ascentHolds: 0,
  };
  try {
    if (!before.flying) {
      report.menuSetup.takeoffGestures++;
      await input.doubleTap("Space", { holdSecondFrames: 2 });
    }
    const airborne = await input.until(
      (state) => state.flying && !state.grounded,
      "Menu setup takes off through native double-Space"
    );
    if (airborne.position.y < clearance.targetAltitude) {
      report.menuSetup.ascentHolds++;
      await input.down("Space", { flight: true });
      await input.until(
        (state) => {
          if (!state.active || !state.enabled || !state.flying)
            throw new Error("Menu clearance ascent lost active flight");
          return state.position.y >= clearance.targetAltitude;
        },
        "Native Space reaches the menu clearance altitude"
      );
    }
  } finally {
    await input.release();
    report.menuSetup.elapsedMs = performance.now() - started;
  }
  const ready = await settle(input);
  report.menuSetup.elapsedMs = performance.now() - started;
  report.menuSetup.after = {
    position: ready.position, velocity: ready.velocity, flying: ready.flying,
    grounded: ready.grounded, keys: ready.keys,
  };
  if (!assertion(report, "Menu checks start stationary in verified terrain clearance",
    ready.active && ready.enabled && !ready.colliding && ready.keys.length === 0 &&
      (input.lookMode !== "native-mouse" || ready.locked) &&
      withinMenuClearance(ready, clearance), report.menuSetup))
    throw new Error("Native menu clearance setup failed");
  return clearance;
}

async function moveForward(input, baseline, clearance) {
  if (!withinMenuClearance(baseline, clearance))
    throw new Error("Fresh W baseline left the prepared menu clearance");
  await input.down("KeyW");
  return input.until(
    (state) => {
      if (!withinMenuClearance(state, clearance))
        throw new Error("Fresh W movement left the prepared menu clearance");
      return distance(state.position, baseline.position, true) > 0.15;
    },
    "Fresh W input moves the player"
  );
}

export async function checkMenus(input, report) {
  // Traversal can land against solid terrain. Prepare once, before any overlay
  // opens; never insert recovery input between cancellation/resume assertions.
  const clearance = await prepareMenuControls(input, report);
  await input.page.evaluate(() =>
    window.__voxelBot.metrics.reset("generated-terrain-menu-controls")
  );
  try {
    for (const closingKey of ["KeyE", "Escape"]) {
      await moveForward(input, await input.state(), clearance);
      await input.press("KeyE");
      const opened = await input.until(
        (state) => state.overlayOpen,
        "E opens inventory"
      );
      await input.down("KeyD");
      await input.frames(3);
      await delay(450);
      const frozen = await input.state();
      assertion(
        report,
        `Inventory ignores held W/D (${closingKey} close)`,
        frozen.overlayOpen &&
          !frozen.enabled &&
          frozen.keys.length === 0 &&
          distance(opened.position, frozen.position) < 0.000001,
        { start: opened.position, end: frozen.position, keys: frozen.keys }
      );
      await input.release();
      await input.press(closingKey);
      const resumed = await input.until(
        (state) => state.active && !state.overlayOpen,
        `${closingKey} closes inventory`
      );
      const still = await input.frames(3);
      assertion(
        report,
        `Inventory close has no stuck movement (${closingKey})`,
        still.keys.length === 0 &&
          distance(resumed.position, still.position) < 0.03,
        { start: resumed.position, end: still.position, keys: still.keys }
      );
      const moving = await moveForward(input, still, clearance);
      assertion(
        report,
        `Movement resumes after ${closingKey} closes inventory`,
        distance(still.position, moving.position, true) > 0.15,
        { start: still.position, end: moving.position, keys: moving.keys }
      );
      await settle(input);
    }
    await moveForward(input, await input.state(), clearance);
    await input.down("ControlLeft");
    await input.press("Escape");
    const paused = await input.until(
      (state) => state.paused,
      "Escape opens pause menu"
    );
    await input.down("KeyD");
    await input.frames(3);
    await delay(450);
    const frozen = await input.state();
    assertion(
      report,
      "Pause freezes position, world time, wildlife clock, and vitals",
      frozen.paused &&
        distance(paused.position, frozen.position) < 0.000001 &&
        frozen.timeOfDay === paused.timeOfDay &&
        frozen.wildlifeClock === paused.wildlifeClock &&
        frozen.health === paused.health &&
        frozen.hunger === paused.hunger,
      {
        before: {
          position: paused.position,
          time: paused.timeOfDay,
          wildlife: paused.wildlifeClock,
        },
        after: {
          position: frozen.position,
          time: frozen.timeOfDay,
          wildlife: frozen.wildlifeClock,
        },
      }
    );
    await input.release();
    await input.click(".play-button");
    const resumed = await input.until(
      (state) => state.active,
      "Resume button starts controls"
    );
    const still = await input.frames(3);
    assertion(
      report,
      "Resume has no stuck movement keys",
      still.keys.length === 0 &&
        distance(resumed.position, still.position) < 0.03,
      {
        keys: still.keys,
        displacement: distance(resumed.position, still.position),
      }
    );
    const moving = await moveForward(input, still, clearance);
    assertion(
      report,
      "Fresh W works after pause/resume",
      distance(still.position, moving.position, true) > 0.15,
      { start: still.position, end: moving.position, keys: moving.keys }
    );
  } finally {
    report.menuControls = await input.page.evaluate(() =>
      window.__voxelBot.metrics.results({ stop: true })
    );
    await input.release();
  }
}

export async function checkSurvivalFixture(input, report) {
  await settle(input);
  if (!(await input.state()).paused) await input.press("Escape");
  await input.until(
    (state) => state.paused,
    "Pause before synthetic fixture setup"
  );
  await mainMenu(input);
  await input.click(".world-settings-button");
  await input.click('button[data-mode="creative"]');
  await input.until(
    (state) => state.mode === "creative",
    "Creative setup for flight transition"
  );
  await startPlaying(input);
  if (!(await input.state()).flying)
    await input.doubleTap("Space", { holdSecondFrames: 2 });
  await input.until(
    (state) => state.flying,
    "Native double-Space enables flight before Survival transition"
  );
  await input.press("Escape");
  await input.until(
    (state) => state.paused,
    "Pause flying before ground fixture"
  );
  const fixture = await input.page.evaluate(() =>
    window.__voxelBot.fixture.prepareGround()
  );
  report.syntheticFixture = fixture;
  await mainMenu(input);
  await input.click(".world-settings-button");
  await input.click('button[data-mode="survival"]');
  const survival = await input.until(
    (state) => state.mode === "survival",
    "Switch to Survival"
  );
  assertion(
    report,
    "Survival mode disables active Creative flight",
    !survival.allowFlight && !survival.flying,
    {
      mode: survival.mode,
      flying: survival.flying,
      allowFlight: survival.allowFlight,
    }
  );
  await startPlaying(input);
  await input.until(
    (state) => state.grounded,
    "Standing on synthetic control floor"
  );
  await input.press("Digit9");
  await input.page.evaluate(() =>
    window.__voxelBot.metrics.reset("synthetic-survival-controls")
  );
  try {
    await input.doubleTap("Space");
    const afterDoubleSpace = await input.frames(2);
    assertion(
      report,
      "Double-Space cannot enable Survival flight",
      !afterDoubleSpace.flying && !afterDoubleSpace.allowFlight
    );
    await input.until(
      (state) => state.grounded,
      "The Survival double-tap jump lands"
    );
    const grounded = await input.state();
    await input.down("Space");
    const jumping = await input.until(
      (state) => state.position.y > grounded.position.y + 0.2,
      "Space triggers a ground jump"
    );
    await input.up("Space");
    assertion(
      report,
      "Space performs a real Survival ground jump",
      !jumping.flying && jumping.position.y > grounded.position.y + 0.2,
      { startY: grounded.position.y, observedY: jumping.position.y }
    );
    await input.until((state) => state.grounded, "Ground jump lands");
    let falling = false;
    await input.down("Space");
    const repeated = await input.until(
      (state) => {
        if (state.velocity.y < -0.5) falling = true;
        return falling && state.velocity.y > 2;
      },
      "Held Space starts another jump after landing",
      4000
    );
    await input.up("Space");
    assertion(
      report,
      "Held Space repeats a ground jump without extra key presses",
      !repeated.flying && repeated.velocity.y > 2,
      { position: repeated.position, velocity: repeated.velocity }
    );
    await input.until((state) => state.grounded, "Released held jump lands");
    await input.down("KeyW");
    await input.until(
      (state) => state.position.z <= fixture.collisionLimitZ + 0.015,
      "Walking to the synthetic dirt wall"
    );
    const stopped = await input.frames(3);
    assertion(
      report,
      "Held W stops at a solid wall without penetrating",
      stopped.position.z >= fixture.collisionLimitZ - 0.00001 &&
        Math.abs(stopped.velocity.z) < 0.005 &&
        !stopped.colliding,
      {
        position: stopped.position,
        velocity: stopped.velocity,
        limitZ: fixture.collisionLimitZ,
        colliding: stopped.colliding,
      }
    );
    await input.release();
    let beforeMining = await input.state();
    if (!beforeMining.locked) {
      await input.click("#game canvas");
      await delay(1600);
      beforeMining = await input.state();
    }
    if (!beforeMining.locked) {
      report.assertions.push({
        name: "Timed Survival mining through held native mouse button",
        status: "skipped",
        evidence: {
          reason:
            "Native pointer lock is unavailable; no synthetic mousedown is substituted",
        },
      });
      return;
    }
    const expected = beforeMining.syntheticFixture.miningSeconds;
    const started = performance.now();
    await input.mouseDown();
    const mined = await input.until(
      (state) => state.syntheticFixture.targetId === 0,
      "Holding native left mouse mines the target dirt block"
    );
    await input.mouseUp();
    const simulatedSeconds =
      ((mined.timeOfDay - beforeMining.timeOfDay + 1) % 1) * 1200;
    report.syntheticMining = {
      expectedSimulationSeconds: expected,
      observedSimulationSeconds: simulatedSeconds,
      wallMs: performance.now() - started,
      target: fixture.target,
      targetIdAfter: mined.syntheticFixture.targetId,
    };
    assertion(
      report,
      "Held native mouse performs timed Survival mining",
      Number.isFinite(expected) &&
        expected > 0 &&
        simulatedSeconds >= expected - 0.11 &&
        mined.syntheticFixture.targetId === 0,
      report.syntheticMining
    );
  } finally {
    report.survivalControls = await input.page.evaluate(() =>
      window.__voxelBot.metrics.results({ stop: true })
    );
    if (report.syntheticMining)
      assertion(
        report,
        "Survival mining has intermediate progress frames",
        report.survivalControls.mining.progressFrames > 0,
        report.survivalControls.mining
      );
    await input.release();
  }
}
