// Opt-in real-input acceptance against an isolated frozen production build.
// VOXELCRAFT_TEST_URL=http://127.0.0.1:<fresh-port> node --test test/pearls.browser.integration.mjs
// Optional: VOXELCRAFT_PEARLS_BUILD_LABEL=<VITE_BENCHMARK_LABEL>
// Optional: VOXELCRAFT_PEARLS_CAPTURE_DIR=/opt/cursor/artifacts
// Capture writes a NEW directory only after the primary test passes: the actual
// BEFORE-THROW save plus provenance/manifest, never a patched successful outcome.
// No server startup, persistent profile, HMR, source instrumentation or fake time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  PEARL_AIR_DRAG,
  PEARL_COLLISION_OFFSET,
  PEARL_GRAVITY,
  PEARL_RADIUS,
  PEARL_SPEED,
  PEARL_STEP_SECONDS,
} from "../src/pearl-physics.js";
import { nextPearlRandom, PEARL_COOLDOWN_SECONDS } from "../src/pearl-save.js";
import { PLAYER_WIDTH } from "../src/player.js";
import { PEARL_TELEPORT_DAMAGE } from "../src/player-projectiles.js";
import {
  installPearlBrowserFixture,
  installPearlReloadObserver,
  pearlBrowserConfig as config,
} from "./pearls-browser-fixture.mjs";
import { chromeExecutable } from "./realtime/config.mjs";

if (!process.env.VOXELCRAFT_TEST_URL)
  throw new Error(
    "Set VOXELCRAFT_TEST_URL to a fresh isolated frozen realtime host"
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
  "5503",
  "5504",
  "5505",
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
    "Use an explicit fresh numeric-loopback port, never a protected/shared origin"
  );
const url = new URL("/test/realtime/index.html", base);
url.searchParams.set("quality", "low");
url.searchParams.set("seed", "cedar-valley");
const expectedBuild = process.env.VOXELCRAFT_PEARLS_BUILD_LABEL;
const captureRoot = process.env.VOXELCRAFT_PEARLS_CAPTURE_DIR;
if (
  captureRoot !== undefined &&
  (!isAbsolute(captureRoot) ||
    (resolve(captureRoot) !== "/opt/cursor/artifacts" &&
      !resolve(captureRoot).startsWith("/opt/cursor/artifacts/")))
)
  throw new Error(
    "Optional pearl captures must use an absolute directory under /opt/cursor/artifacts"
  );

// A wall flight takes about twelve 20 Hz steps, shield raising 0.25s, and shared
// cooldown 1s. Eight seconds allows cold software-GL scheduling, not extra game
// time. Startup/reload have their existing 60s terrain/worker budget separately.
const actionMs = 8000;
const startupMs = 60000;
assert.equal(
  config.pearl,
  300,
  "use the existing ender pearl, not an expansion placeholder"
);
assert.equal(
  PEARL_TELEPORT_DAMAGE,
  5,
  "the browser contract is exactly five health"
);
assert.equal(
  PEARL_COOLDOWN_SECONDS,
  1,
  "both hands share the existing one-second cooldown"
);
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} versus ${expected}`
  );
const pointNear = (actual, expected, label, tolerance = 1e-6) => {
  for (const axis of ["x", "y", "z"])
    near(actual[axis], expected[axis], `${label}.${axis}`, tolerance);
};
const ownedOnly = ({ slots, offhand, cursor, equipment, craftingGrid }) => ({
  slots,
  offhand,
  cursor,
  equipment,
  craftingGrid,
});
const shotId = (input) => input.before.packet.nextId;
const acceptedInputs = (observed) =>
  observed.inputs.filter(
    (input) =>
      input.type === "keydown" &&
      input.code === "KeyV" &&
      input.after &&
      input.after.packet.nextId === input.before.packet.nextId + 1
  );

function assertObserved(observed, { geometry = true } = {}) {
  assert.ok(observed);
  assert.equal(observed.error, null);
  assert.ok(
    observed.frames.length > 0,
    "observe actual completed renderer frames"
  );
  assert.ok(
    observed.inputs.every((input) => input.trusted),
    "real Chromium input, never DOM dispatch"
  );
  assert.equal(
    observed.current.packet.nextId - observed.initial.packet.nextId,
    acceptedInputs(observed).length,
    "no hidden, repeated-held or synthetic throws"
  );
  const resources = new Set();
  for (const state of [
    observed.initial,
    ...observed.frames,
    observed.current,
  ]) {
    assert.ok(
      Object.values(state.owners).every(Boolean),
      "actual Player/World/Gameplay/coordinator/scene owners"
    );
    assert.equal(state.failed, false);
    assert.equal(state.inputMode, "remote");
    assert.equal(
      state.autoSpawn,
      true,
      "normal wildlife simulation remains enabled"
    );
    assert.deepEqual(state.observerErrors, []);
    assert.equal(
      state.chunkRequestBridge,
      "undefined",
      "this host does not grant projectile chunk tickets"
    );
    if (geometry) assert.equal(state.geometryIntact, true);
    const gpu = state.gpu;
    assert.equal(gpu.contextLost, false);
    assert.equal(gpu.contextLosses, 0);
    assert.equal(gpu.badPrograms, 0);
    assert.equal(gpu.error, 0);
    assert.deepEqual(gpu.errors, []);
    assert.equal(gpu.errorOverflow, false);
    assert.ok(
      gpu.calls > 0 && gpu.triangles > 0,
      "the real scene reaches WebGL"
    );
    assert.equal(gpu.sharedGeometry, true);
    assert.ok(gpu.history <= config.maxPearls);
    assert.ok(gpu.maxHistory <= config.trailPoints);
    if (gpu.resources) resources.add(JSON.stringify(gpu.resources));
    if (gpu.pearls) {
      assert.equal(gpu.pearls.capacity, config.maxPearls);
      assert.equal(gpu.trails.capacity, config.maxPearls * config.trailPoints);
      assert.equal(gpu.pearls.count, state.packet.projectiles.length);
      assert.ok(gpu.trails.count <= config.maxPearls * config.trailPoints);
      assert.ok(gpu.pearls.finite && gpu.trails.finite);
    }
  }
  assert.ok(
    resources.size <= 1,
    "each host reuses two meshes/materials and one geometry"
  );
}

function assertThrow(input, hand, { creative = false } = {}) {
  assert.ok(input, "a trusted KeyV event must admit a throw");
  const { before, after } = input;
  assert.equal(input.trusted, true);
  assert.equal(input.repeat, false);
  assert.equal(before.active, true);
  assert.equal(before.mode, creative ? "creative" : "survival");
  assert.equal(
    before.mobTarget,
    false,
    "no entity interaction steals the physical use action"
  );
  assert.equal(before.grounded, true);
  assert.equal(before.flying, false);
  assert.equal(before[hand === "main" ? "main" : "offhand"].id, config.pearl);
  assert.ok(before.packet.cooldown <= 1e-9);
  assert.equal(after.packet.nextId, before.packet.nextId + 1);
  assert.equal(
    after.packet.randomState,
    nextPearlRandom(before.packet.randomState)
  );
  assert.equal(after.packet.cooldown, PEARL_COOLDOWN_SECONDS);
  assert.equal(after.packet.life, before.packet.life);
  assert.equal(
    after.packet.projectiles.length,
    before.packet.projectiles.length + 1
  );
  const projectile = after.packet.projectiles.find(
    ({ id }) => id === shotId(input)
  );
  assert.ok(projectile);
  assert.equal(projectile.ownerId, after.packet.ownerId);
  assert.equal(projectile.life, after.packet.life);
  assert.equal(projectile.dimension, before.dimension);
  assert.equal(projectile.age, 0);
  assert.equal(projectile.wait, 0);
  assert.equal(projectile.spin, after.packet.randomState);
  pointNear(projectile.position, before.eye, "launch from the physical eye");
  const length = Math.hypot(...Object.values(before.forward));
  for (const axis of ["x", "y", "z"])
    near(
      projectile.velocity[axis],
      (before.forward[axis] / length) * PEARL_SPEED,
      `launch velocity.${axis}`
    );
  pointNear(after.position, before.position, "throw does not grant a teleport");
  assert.equal(
    after.frame,
    before.frame,
    "one synchronous trusted use-event boundary"
  );
  assert.equal(after.elapsed, before.elapsed);
  assert.equal(after.poseRevision, before.poseRevision);
  assert.equal(after.yaw, before.yaw);
  assert.equal(after.pitch, before.pitch);
  assert.equal(
    after.health,
    before.health,
    "throw does not prepay health damage"
  );
  const expected = structuredClone(before.ownership);
  if (!creative) {
    const stack =
      hand === "main" ? expected.slots[before.selected] : expected.offhand;
    stack.count--;
    if (!stack.count) {
      if (hand === "main") expected.slots[before.selected] = null;
      else expected.offhand = null;
    }
    expected.inventoryPearls--;
    expected.totalPearls--;
  }
  assert.deepEqual(
    after.ownership,
    expected,
    "exactly one finite pearl, no unrelated cost or wear"
  );
  return projectile;
}

/** Independent analytic oracle for this real, full-cube authored wall only.
 * It does not run domain step/impact/prepare methods or replace world geometry.
 */
function wallImpact(input, manifest) {
  const projectile = input.after.packet.projectiles.find(
    ({ id }) => id === shotId(input)
  );
  let p = { ...projectile.position },
    v = { ...projectile.velocity };
  const path = [{ position: p, velocity: v }];
  const face = manifest.origin.z + 1;
  for (let tick = 1; tick <= 24; tick++) {
    const end = Object.fromEntries(
      ["x", "y", "z"].map((axis) => [
        axis,
        p[axis] + v[axis] * PEARL_STEP_SECONDS,
      ])
    );
    assert.ok(
      Math.min(p.y, end.y) > manifest.origin.y + 1 + PEARL_RADIUS,
      "the finite fixture path clears the floor before its wall impact"
    );
    if (p.z >= face + PEARL_RADIUS && end.z <= face + PEARL_RADIUS) {
      const fraction = (face + PEARL_RADIUS - p.z) / (end.z - p.z);
      const y = p.y + (end.y - p.y) * fraction;
      assert.ok(y > manifest.origin.y + 1 && y < manifest.origin.y + 5);
      return {
        tick,
        seconds: tick * PEARL_STEP_SECONDS,
        path,
        position: {
          x: p.x + (end.x - p.x) * fraction,
          y,
          z: face + PLAYER_WIDTH / 2 + PEARL_COLLISION_OFFSET,
        },
      };
    }
    p = end;
    v = {
      x: v.x * PEARL_AIR_DRAG,
      y: v.y * PEARL_AIR_DRAG - PEARL_GRAVITY * PEARL_STEP_SECONDS,
      z: v.z * PEARL_AIR_DRAG,
    };
    path.push({ position: p, velocity: v });
  }
  assert.fail(
    "The actual physical launch did not reach the fixture wall within 24 fixed steps"
  );
}

function assertWallApproach(observed, input, expected, retirement) {
  const id = shotId(input);
  const states = [observed.initial, ...observed.frames, retirement.before];
  let moving = 0;
  for (const state of states) {
    const entry = state.packet.projectiles.find(
      (candidate) => candidate.id === id
    );
    if (!entry) continue;
    assert.equal(
      entry.wait,
      0,
      "loaded wall flight never waits at an unloaded frontier"
    );
    assert.equal(entry.life, input.before.packet.life);
    // A real reload creates a new World/epoch; only the current observation's
    // runtime epoch is stable. The projectile life/seed are the persisted IDs.
    assert.equal(
      state.epoch,
      observed.initial.epoch,
      "no travel/world replacement before collision"
    );
    const tick = Math.round(entry.age / PEARL_STEP_SECONDS);
    near(entry.age, tick * PEARL_STEP_SECONDS, "real fixed-step flight age");
    assert.ok(
      tick >= 0 && tick < expected.tick,
      "live record precedes the one wall collision"
    );
    pointNear(
      entry.position,
      expected.path[tick].position,
      "observed ballistic position"
    );
    pointNear(
      entry.velocity,
      expected.path[tick].velocity,
      "observed drag/gravity velocity"
    );
    if (tick > 0) moving++;
  }
  assert.ok(moving > 0, "a moving real flight approaches the authored wall");
  const last = retirement.before.packet.projectiles.find(
    (entry) => entry.id === id
  );
  assert.ok(last);
  assert.equal(
    retirement.after.frame,
    retirement.before.frame + 1,
    "retirement is observed between adjacent completed draws"
  );
  const dt = retirement.after.elapsed - retirement.before.elapsed;
  assert.ok(
    dt > 0 && dt <= 0.100000001,
    "one genuine Game frame, not a missed observation window"
  );
  const steps = Math.floor(
    (retirement.before.packet.accumulator + dt + 1e-9) / PEARL_STEP_SECONDS
  );
  const remaining = expected.tick - Math.round(last.age / PEARL_STEP_SECONDS);
  assert.ok(
    remaining > 0 && remaining <= steps,
    "retirement occurs on the predicted wall-arrival step, not an earlier unrelated cancellation"
  );
}

function assertFlight(observed, id, { pixels = true } = {}) {
  const frames = observed.frames.filter(
    (state) =>
      state.packet.projectiles.some(
        (entry) => entry.id === id && entry.age > 0
      ) &&
      state.gpu.pearls?.visible &&
      state.gpu.trails?.visible &&
      state.gpu.pearls.listed &&
      state.gpu.trails.listed &&
      state.gpu.pearls.linked &&
      state.gpu.trails.linked
  );
  assert.ok(
    frames.length > 0,
    "moving pearl AND trail enter the real scene's compiled GPU draw list"
  );
  for (const frame of frames) {
    const first = frame.packet.projectiles[0].position;
    for (const axis of ["x", "y", "z"])
      near(
        frame.gpu.pearls.firstPosition[axis],
        first[axis],
        `GPU instance follows committed flight.${axis}`,
        Math.max(1e-5, Math.abs(first[axis]) * 2 ** -22)
      );
  }
  if (pixels) {
    assert.ok(
      frames.some((state) =>
        state.gpu.pearls.samples.some((sample) => sample.matching > 0)
      ),
      "teal pearl pixels are present in the actual canvas"
    );
    assert.ok(
      frames.some((state) =>
        state.gpu.trails.samples.some((sample) => sample.matching > 0)
      ),
      "purple trail pixels are present in the actual canvas"
    );
  }
  return frames.length;
}

function assertImpact(
  observed,
  input,
  manifest,
  { creative = false, blocking = false, removed = [shotId(input)] } = {}
) {
  const records = observed.retirements.filter((entry) =>
    entry.ids.includes(shotId(input))
  );
  assert.equal(
    records.length,
    1,
    "one committed retirement, not repeated impact callbacks"
  );
  const impact = records[0],
    expected = wallImpact(input, manifest);
  assertWallApproach(observed, input, expected, impact);
  assert.deepEqual(
    [...impact.ids].sort((a, b) => a - b),
    [...removed].sort((a, b) => a - b)
  );
  pointNear(
    impact.after.position,
    expected.position,
    "the one fitting swept wall pose"
  );
  pointNear(
    impact.after.velocity,
    { x: 0, y: 0, z: 0 },
    "impact velocity reset"
  );
  assert.equal(impact.after.fallDistance, 0);
  assert.equal(impact.after.bob, 0);
  assert.equal(impact.after.jumpQueued, false);
  assert.equal(impact.after.moving, false);
  assert.equal(impact.after.sprinting, false);
  assert.equal(
    impact.after.grounded,
    false,
    "inspect the impact frame, before the next gravity/landing update"
  );
  assert.ok(impact.after.poseRevision > impact.before.poseRevision);
  assert.equal(impact.after.yaw, input.before.yaw);
  assert.equal(impact.after.pitch, input.before.pitch);
  assert.deepEqual(impact.after.forward, input.before.forward);
  near(
    impact.after.eye.y - impact.after.position.y,
    impact.after.eyeHeight,
    "physical eye follows new feet"
  );
  assert.equal(
    impact.before.health - impact.after.health,
    creative ? 0 : PEARL_TELEPORT_DAMAGE,
    "health delta uses adjacent actual committed observations, not an assumed starting health"
  );
  assert.deepEqual(
    impact.after.ownership,
    impact.before.ownership,
    "impact causes no second item cost or armor/shield wear"
  );
  assert.equal(impact.after.packet.projectiles.length, 0);
  assert.equal(impact.after.gpu.pearls.count, 0);
  assert.equal(impact.after.gpu.trails.count, 0);
  assert.equal(impact.after.gpu.history, 0);
  assert.equal(
    impact.after.nearbyHostiles,
    0,
    "no unrelated hostile damage source"
  );
  if (blocking) {
    assert.equal(impact.before.use.kind, "shield");
    assert.equal(impact.before.use.hand, "offhand");
    // Game advances held use before projectiles. The shield may finish raising
    // in this very frame; the committed hit must see it raised, not worn/reset.
    assert.equal(
      impact.after.use.blocking,
      true,
      "the real shield is raised at impact"
    );
  }
  if (!creative && !impact.after.dead) {
    assert.ok(impact.after.hurt.remaining > 0);
    assert.ok(
      impact.after.hurt.visible && impact.after.hurt.opacity > 0,
      "real onHurt reaches the real HUD"
    );
  } else {
    assert.equal(impact.after.hurt.remaining, 0);
    assert.equal(impact.after.hurt.visible, false);
  }
  assert.equal(observed.losses.length, creative ? 0 : 1);
  return impact;
}

async function withHost(t, run) {
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
  t.after(() => browser.close()); // Only this test's new browser; no shared process/profile.
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    serviceWorkers: "block",
    reducedMotion: "no-preference",
  });
  const errors = [],
    warnings = [],
    network = [],
    blocked = [];
  let overflow = false,
    phase = "frozen production preflight",
    build = null;
  const remember = (list, value) => {
    if (list.length < 32 && JSON.stringify(value).length < 16384)
      list.push(value);
    else overflow = true;
  };
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url());
    if (
      (["http:", "https:"].includes(request.protocol) &&
        request.origin !== url.origin) ||
      request.pathname.startsWith("/@vite/")
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
  page.setDefaultTimeout(actionMs);
  page.setDefaultNavigationTimeout(startupMs);
  page.on("pageerror", (error) =>
    remember(errors, error.stack ?? error.message)
  );
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
    remember(network, {
      url: request.url(),
      failure: request.failure()?.errorText,
    })
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      remember(network, { url: response.url(), status: response.status() });
  });
  const wait = async (predicate, value, timeout = actionMs) => {
    assert.equal(
      Object.prototype.toString.call(predicate),
      "[object Function]",
      "waitForFunction predicates must be synchronous; a Promise is truthy before its value resolves"
    );
    const result = await page.waitForFunction(predicate, value, { timeout });
    await result.dispose();
  };
  const waitForDeadSave = async (life) => {
    const deadline = Date.now() + 5000;
    let latest;
    for (let reads = 1; reads <= 8; reads++) {
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, "the death-save deadline must not be extended");
      let timer;
      try {
        latest = await Promise.race([
          page.evaluate(async () => {
            const game = window.__voxelBot.game;
            // Capture BEFORE the read: a commit during it must wake the next check.
            const revision = game.archive.storage.revision;
            const saved = await window.__voxelPearls.stored();
            return { revision, saved, failed: game.saveErrorReported === true };
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Death-save read exceeded its deadline")),
              remaining
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(
        latest.failed,
        false,
        "a failed save is not retried as pending"
      );
      const saved = latest.saved;
      if (
        saved.dead &&
        saved.health === 0 &&
        saved.packet.life === life &&
        saved.packet.projectiles.length === 0
      ) {
        t.diagnostic(
          `PASS committed death save ${JSON.stringify({
            reads,
            health: saved.health,
            dead: saved.dead,
            life: saved.packet.life,
            pending: saved.packet.projectiles.length,
          })}`
        );
        return saved;
      }
      const waitMs = deadline - Date.now();
      assert.ok(waitMs > 0, "death state must reach the committed archive");
      await wait(
        (revision) => {
          const game = window.__voxelBot.game;
          if (game.saveErrorReported) throw new Error("Death save failed");
          return game.archive.storage.revision !== revision;
        },
        latest.revision,
        waitMs
      );
    }
    assert.fail(
      `Death-save revisions exceeded the bounded read count: ${JSON.stringify(latest)}`
    );
  };
  const read = () => page.evaluate(() => window.__voxelPearls.read());
  const observed = () =>
    page.evaluate(() => window.__voxelPearls.observations());
  const begin = (label) => {
    phase = label;
    return page.evaluate((value) => window.__voxelPearls.begin(value), label);
  };
  const end = () => page.evaluate(() => window.__voxelPearls.end());
  const draws = async (count = 2) => {
    const before = await page.evaluate(
      () => window.__voxelBot.game.graphics.renderer.info.render.frame
    );
    await wait(
      ({ before, count }) =>
        window.__voxelBot.game.graphics.renderer.info.render.frame >=
        before + count,
      { before, count }
    );
  };
  const ready = async () => {
    await wait(
      () => window.__voxelBot?.ready || window.__voxelBot?.error,
      undefined,
      startupMs
    );
    const state = await page.evaluate(() =>
      window.__voxelBot.state({ renderer: true })
    );
    assert.equal(new URL(page.url()).origin, url.origin);
    assert.equal(state.error, null);
    assert.equal(
      state.build.production,
      true,
      "never run this regression under HMR"
    );
    if (expectedBuild !== undefined)
      assert.equal(state.build.label, expectedBuild);
    if (build)
      assert.deepEqual(
        state.build,
        build,
        "the frozen build cannot change across reload"
      );
    build ??= state.build;
    assert.equal(state.paused, true);
    assert.equal(
      state.syntheticFixture,
      null,
      "never use the driver's synthetic controls room"
    );
    assert.equal(
      state.live,
      null,
      "the existing realtime metrics recorder remains dormant"
    );
    assert.equal(state.renderer.contextLost, false);
    assert.ok(
      state.view.visibleChunkGroups > 0,
      "real generated terrain is rendered"
    );
    assert.equal(
      await page.evaluate(() => window.__voxelBot.game.world.generatorVersion),
      3,
      "this regression depends only on the existing v3 terrain/catalog"
    );
    assert.deepEqual(errors, []);
    return state;
  };
  const mainMenu = async () => {
    for (
      let depth = 0;
      depth < 3 &&
      (await page.locator(".menu-screen").getAttribute("data-page")) !== "main";
      depth++
    )
      await page.locator(".menu-back-button").click();
    assert.equal(
      await page.locator(".menu-screen").getAttribute("data-page"),
      "main"
    );
  };
  const pause = async () => {
    if (!(await page.evaluate(() => window.__voxelBot.game.paused)))
      await page.keyboard.press("Escape");
    await wait(() => {
      const game = window.__voxelBot.game;
      return game.paused && !game.player.enabled && !game.closingScreens;
    });
    await draws();
  };
  const enter = async ({ grounded = true } = {}) => {
    await mainMenu();
    await page.locator(".play-button").click();
    await wait((needGround) => {
      const game = window.__voxelBot.game;
      return (
        game.active &&
        game.simulating &&
        !game.playing &&
        game.player.enabled &&
        (!needGround || game.player.grounded)
      );
    }, grounded);
  };
  const throwReady = () =>
    wait(() => {
      const game = window.__voxelBot.game;
      return (
        game.active &&
        game.projectiles.cooldown <= 1e-9 &&
        game.elapsed - game.useActions.lastUse >= 0.2
      );
    });
  const stage = async (kind = "wall") => {
    const result = await page.evaluate(
      (value) => window.__voxelPearls.stage(value),
      kind
    );
    t.diagnostic(`AUTHORED PAUSED STANCE ${JSON.stringify(result)}`);
    return result;
  };
  const retirement = () =>
    wait(() => {
      const result = window.__voxelPearls.observations();
      if (result.error) throw new Error(result.error);
      return result.retirements.length > 0;
    });
  const finish = async () => {
    await pause();
    const result = await end();
    assertObserved(result);
    return result;
  };
  const save = async () => {
    await mainMenu();
    await page.locator(".world-settings-button").click();
    const revision = await page.evaluate(
      () => window.__voxelBot.game.archive.storage.revision
    );
    await page.locator(".save-button").click();
    await wait(
      (previous) => {
        const game = window.__voxelBot.game;
        return (
          !document.querySelector(".save-button").disabled &&
          game.storageStatus === "Saved on this device" &&
          game.archive.storage.revision !== previous
        );
      },
      revision,
      15000
    );
    assert.notEqual(
      await page.locator(".storage-status").getAttribute("data-state"),
      "error"
    );
    return page.evaluate(() => window.__voxelPearls.stored());
  };
  const checkClean = () => {
    assert.equal(
      overflow,
      false,
      "bounded diagnostic buffers did not overflow"
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    assert.deepEqual(blocked, []);
  };
  try {
    // Read the actual served HTML before loading it. Refuse dev/HMR markup
    // without executing it; redirects are disabled on this loopback-only GET.
    const response = await context.request.get(url.href, {
      timeout: 15000,
      maxRedirects: 0,
    });
    assert.equal(response.status(), 200);
    const html = await response.text();
    assert.ok(Buffer.byteLength(html) < 65536);
    assert.doesNotMatch(
      html,
      /\/@vite\/client|\/@react-refresh|src=["'][^"']*\/driver\.js/
    );
    assert.match(html, /<script[^>]*src=["'][^"']*\/assets\/[^"']+\.js/);
    await response.dispose();
    await page.goto(url.href, { waitUntil: "load" });
    const host = await ready();
    t.diagnostic(
      `FROZEN HOST ${JSON.stringify({ origin: url.origin, build, renderer: host.renderer, browser: browser.version() })}`
    );
    await page.locator(".settings-toggle").click();
    await page.locator(".controls-settings-button").click();
    await page.locator("#input-mode-setting").selectOption("remote");
    await mainMenu();
    await page.evaluate(installPearlBrowserFixture, { config });
    const manifest = await page.evaluate(() => window.__voxelPearls.prepare());
    await page.locator(".world-settings-button").click();
    await page.locator('.mode-picker [data-mode="survival"]').click();
    await wait(
      () =>
        window.__voxelBot.game.gameplay.mode === "survival" &&
        !window.__voxelBot.game.transitionGate.busy
    );
    await mainMenu();
    await wait(
      () => {
        const game = window.__voxelBot.game;
        return (
          game.world._requests.size === 0 &&
          game.world._inFlight.size === 0 &&
          game.world.dirtyChunks.size === 0
        );
      },
      undefined,
      15000
    );
    const initial = await read();
    assert.equal(initial.mode, "survival");
    assert.equal(initial.inputMode, "remote");
    assert.equal(initial.health, 20);
    assert.equal(initial.flying, false);
    assert.equal(initial.ownership.totalPearls, config.pearls.count);
    assert.deepEqual(initial.ownership.equipment, config.equipment);
    assert.deepEqual(initial.offhand, config.shield);
    assert.equal(initial.geometryIntact, true);
    t.diagnostic(
      `FINITE AUTHORED SETUP ${JSON.stringify({
        label: manifest.label,
        provenance: manifest.provenance,
        terrain: manifest.terrain,
        origin: manifest.origin,
        shooter: manifest.shooter,
        authoredBaseCells: manifest.authoredBaseCells,
        optionalCeilingCells: manifest.ceilingCells,
        setupReads: manifest.setupReads,
        searchCandidates: manifest.searchCandidates,
        supplies: manifest.supplies,
      })}`
    );
    await run({
      page,
      context,
      read,
      observed,
      begin,
      end,
      wait,
      waitForDeadSave,
      draws,
      ready,
      mainMenu,
      pause,
      enter,
      throwReady,
      stage,
      retirement,
      finish,
      save,
      manifest,
      setPhase: (value) => {
        phase = value;
      },
      checkClean,
      host: {
        build,
        renderer: host.renderer,
        browser: browser.version(),
        url: url.href,
      },
    });
    checkClean();
    const inputs = await page.evaluate(() => window.__voxelBot.state().inputs);
    assert.ok(inputs.trusted > 0);
    assert.equal(inputs.untrusted, 0);
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => {
        const helper = window.__voxelPearls;
        const result = helper?.observations();
        return {
          hostError: window.__voxelBot?.error,
          current: helper?.read(),
          observationError: result?.error,
          retirements: result?.retirements.slice(-2),
          inputs: result?.inputs.slice(-4),
          frames: result?.frames.slice(-3),
          reload: window.__voxelPearlReload,
        };
      })
      .catch(() => null);
    t.diagnostic(
      `FAILED ${phase} ${JSON.stringify({ errors, warnings, network, blocked, overflow, diagnostic })}`
    );
    throw error;
  } finally {
    await page.evaluate(() => window.__voxelPearls?.dispose()).catch(() => {});
  }
}

// Three real cold boots (initial + two reloads), GPU readbacks and actual IndexedDB.
test("real pearl/F5/shield impact and paid mid-flight/completed-impact save reload", {
  timeout: 210000,
}, async (t) => {
  await withHost(t, async (h) => {
    const { page, manifest } = h;
    const capture =
      captureRoot === undefined
        ? null
        : await page.evaluate(() => window.__voxelPearls.beforeThrowCapture());
    await h.enter();
    await h.throwReady();
    await assert.rejects(
      () => h.wait(async () => false),
      /must be synchronous/
    );
    await assert.rejects(
      () => page.evaluate(() => window.__voxelPearls.stored()),
      /End observation and pause/,
      "archive inspection must still refuse live gameplay"
    );
    await h.begin("F5 physical-eye pearl, real raised shield, atomic impact");
    await page.keyboard.press("F5");
    const back = await h.read();
    assert.equal(back.perspective, "back");
    assert.ok(
      Math.hypot(
        back.camera.x - back.eye.x,
        back.camera.y - back.eye.y,
        back.camera.z - back.eye.z
      ) > 1,
      "F5 render camera really differs from the physical launch eye"
    );
    await page.keyboard.down("v");
    await h.retirement();
    await page.keyboard.up("v");
    const first = await h.finish();
    const [firstInput] = acceptedInputs(first);
    assert.equal(acceptedInputs(first).length, 1);
    assertThrow(firstInput, "main");
    // Rear-view geometry can correctly occlude pearls behind the avatar.
    // Require actual canvas pixels in the first-person restored-flight leg.
    const f5DrawFrames = assertFlight(first, shotId(firstInput), {
      pixels: false,
    });
    const firstImpact = assertImpact(first, firstInput, manifest, {
      blocking: true,
    });
    assert.equal(firstImpact.after.perspective, "back");
    assert.equal(firstImpact.after.avatar.visible, true);
    const f5 = first.inputs.find(
      (input) => input.type === "keydown" && input.code === "F5"
    );
    assert.ok(f5?.trusted && f5.after);
    assert.equal(f5.before.perspective, "first");
    assert.equal(f5.after.perspective, "back");
    pointNear(
      f5.after.position,
      f5.before.position,
      "trusted F5 preserves feet"
    );
    pointNear(
      f5.after.eye,
      f5.before.eye,
      "trusted F5 preserves the physical eye"
    );
    assert.deepEqual(f5.after.forward, f5.before.forward);
    assert.equal(
      first.current.packet.nextId,
      firstInput.before.packet.nextId + 1
    );
    t.diagnostic(
      `PASS real F5 throw ${JSON.stringify({
        f5DrawFrames,
        damage: firstImpact.before.health - firstImpact.after.health,
        spent:
          first.initial.ownership.totalPearls -
          first.current.ownership.totalPearls,
        impact: firstImpact.after.position,
      })}`
    );

    await h.stage();
    await h.enter();
    await h.throwReady();
    await h.begin("already-paid moving pearl paused with real Escape");
    await page.keyboard.press("v");
    await h.wait(() => {
      const result = window.__voxelPearls.observations();
      if (result.error) throw new Error(result.error);
      return result.frames.some(
        (state) =>
          state.packet.projectiles.length === 1 &&
          state.packet.projectiles[0].age > 0 &&
          state.gpu.trails?.listed &&
          state.gpu.trails.count > 0
      );
    });
    await h.pause(); // If scheduling misses this checkpoint, FAIL; never stage a replacement flight.
    const flight = await h.end();
    assertObserved(flight);
    assert.equal(flight.retirements.length, 0);
    assert.equal(flight.losses.length, 0);
    const [paidInput] = acceptedInputs(flight);
    assert.equal(acceptedInputs(flight).length, 1);
    assertThrow(paidInput, "main");
    assertFlight(flight, shotId(paidInput), { pixels: false });
    const checkpoint = flight.current;
    assert.equal(checkpoint.packet.projectiles.length, 1);
    assert.ok(
      checkpoint.packet.projectiles[0].age > 0 &&
        checkpoint.packet.projectiles[0].age <=
          wallImpact(paidInput, manifest).seconds -
            4 * PEARL_STEP_SECONDS +
            1e-9,
      "the real paused checkpoint leaves four fixed steps for restored-flight rendering"
    );
    const pausedFrames = flight.frames.filter((state) => state.paused);
    assert.ok(pausedFrames.length >= 2);
    for (const state of pausedFrames)
      assert.deepEqual(
        state.packet,
        checkpoint.packet,
        "pause retains RNG, cooldown, accumulator and complete flight"
      );
    const saved = await h.save();
    assert.deepEqual(saved.packet, checkpoint.packet);
    assert.deepEqual(saved.owned, ownedOnly(checkpoint.ownership));
    assert.equal(saved.health, checkpoint.health);
    await page.evaluate(() => window.__voxelPearls.dispose());
    await page.addInitScript(installPearlReloadObserver);
    h.setPhase("real reload of the already-paid in-flight archive");
    await page.reload({ waitUntil: "load" });
    await h.ready();
    await h.wait(() => window.__voxelPearlReload?.done);
    const boot = await page.evaluate(() => window.__voxelPearlReload);
    assert.equal(boot.error, null);
    assert.deepEqual(boot.first.packet, saved.packet);
    assert.deepEqual(boot.last.packet, saved.packet);
    assert.equal(boot.maxHurt, 0);
    assert.equal(boot.maxOpacity, 0);
    assert.deepEqual(boot.changes, []);
    await page.evaluate(installPearlBrowserFixture, { config, manifest });
    const restored = await page.evaluate(() => window.__voxelPearls.snapshot());
    assert.deepEqual(
      restored,
      saved,
      "restore actual paid ownership/pose/health, not a manufactured snapshot"
    );
    await h.draws(4);
    const pausedReload = await h.read();
    assert.deepEqual(pausedReload.packet, saved.packet);
    assert.equal(
      pausedReload.perspective,
      "first",
      "the new Player uses the real first-person default"
    );

    await h.begin("real Play resumes the restored throw exactly once");
    await h.enter();
    await h.retirement();
    await h.wait(() => {
      const game = window.__voxelBot.game;
      return (
        game.player.grounded &&
        game.hurtFeedback.remaining === 0 &&
        game.projectiles.cooldown === 0
      );
    });
    const replay = await h.finish();
    assert.equal(acceptedInputs(replay).length, 0, "Play is not a new throw");
    const pixelFrames = assertFlight(replay, shotId(paidInput));
    const replayImpact = assertImpact(replay, paidInput, manifest);
    assert.equal(replayImpact.before.health, saved.health);
    assert.deepEqual(
      ownedOnly(replay.current.ownership),
      saved.owned,
      "reload never charges another pearl"
    );
    assert.equal(replay.current.packet.nextId, saved.packet.nextId);
    assert.equal(replay.current.packet.randomState, saved.packet.randomState);
    assert.equal(replay.current.packet.life, saved.packet.life);
    const completed = await h.save();
    assert.equal(completed.packet.projectiles.length, 0);
    assert.equal(completed.health, replayImpact.after.health);
    await page.evaluate(() => window.__voxelPearls.dispose());
    h.setPhase(
      "real reload after completed impact cannot replay teleport or hurt"
    );
    await page.reload({ waitUntil: "load" });
    await h.ready();
    await h.wait(() => window.__voxelPearlReload?.done);
    const completedBoot = await page.evaluate(() => window.__voxelPearlReload);
    assert.equal(completedBoot.error, null);
    assert.deepEqual(completedBoot.first.packet, completed.packet);
    assert.deepEqual(completedBoot.last.packet, completed.packet);
    assert.equal(completedBoot.maxHurt, 0);
    assert.equal(completedBoot.maxOpacity, 0);
    assert.deepEqual(completedBoot.changes, []);
    await page.evaluate(installPearlBrowserFixture, { config, manifest });
    assert.deepEqual(
      await page.evaluate(() => window.__voxelPearls.snapshot()),
      completed
    );
    await h.begin(
      "completed-impact reload remains quiet through real simulation"
    );
    await h.enter();
    const at = (await h.read()).simulationTime;
    await h.wait(
      (clock) => window.__voxelBot.game.wildlife.clock - clock >= 1.1,
      at
    );
    const quiet = await h.finish();
    assert.equal(quiet.retirements.length, 0);
    assert.equal(quiet.losses.length, 0);
    for (const state of quiet.frames) {
      assert.deepEqual(state.packet, completed.packet);
      assert.equal(state.health, completed.health);
      assert.equal(state.hurt.remaining, 0);
      assert.equal(state.hurt.visible, false);
      pointNear(
        state.position,
        completed.player,
        "no post-load re-teleport",
        0.002
      );
      assert.equal(state.yaw, completed.player.yaw);
      assert.equal(state.pitch, completed.player.pitch);
    }
    h.checkClean();
    t.diagnostic(
      `PASS paid-flight and completed-impact real reloads ${JSON.stringify({
        id: shotId(paidInput),
        savedAge: saved.packet.projectiles[0].age,
        savedCooldown: saved.packet.cooldown,
        savedHealth: saved.health,
        impactHealth: completed.health,
        nextId: completed.packet.nextId,
        pixelFrames,
      })}`
    );
    if (capture) {
      const text = JSON.stringify(capture.save, null, 2);
      assert.ok(Buffer.byteLength(text) <= config.limits.archiveBytes);
      await mkdir(resolve(captureRoot), { recursive: true });
      const directory = await mkdtemp(
        join(resolve(captureRoot), "pearls-before-throw-")
      );
      const captureManifest = {
        status: "primary-browser-test-passed",
        ...h.host,
        provenance: capture.provenance,
        setup: capture.manifest,
        saveSha256: createHash("sha256").update(text).digest("hex"),
        observed: {
          f5DrawFrames,
          pixelFrames,
          firstImpact: firstImpact.after.position,
          savedFlightReload: true,
          completedImpactReload: true,
        },
        limitations: [
          "Authored finite supplies/geometry/paused stances, not natural acquisition.",
          "Read-only rAF/input/GPU observations on the existing realtime host; no performance claim.",
          "The existing realtime host has dormant metrics wrappers; this test adds none and never starts that recorder.",
          "F5 proves physical-eye launch, scene resources and impact; first-person restored flight supplies pixel proof.",
          "This artifact contains BEFORE-THROW setup, not a successful outcome or a modified imported save.",
          "Parent performs the separate real GUI/video walkthrough.",
        ],
      };
      await writeFile(join(directory, "before-throw.voxelcraft.json"), text, {
        flag: "wx",
      });
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(captureManifest, null, 2),
        { flag: "wx" }
      );
      t.diagnostic(`READ-ONLY BEFORE-THROW CAPTURE ${directory}`);
    }
  });
});

// One real world, real F hand swaps, a six-cell blocked-pose control, and UI travel.
test("both pearl hands share cooldown; blocked pose, Creative immunity and pending travel cleanup", {
  timeout: 150000,
}, async (t) => {
  await withHost(t, async (h) => {
    const { page, manifest } = h;
    await h.enter();
    await h.throwReady();
    await h.begin(
      "main throw then actual offhand input during shared cooldown"
    );
    await page.keyboard.press("v");
    await page.keyboard.press("f"); // Real finite swap: remaining pearls -> offhand, shield -> slot 1.
    await page.keyboard.press("2"); // Empty main hand; the next use must reach the offhand.
    await h.wait(() => {
      const game = window.__voxelBot.game;
      return (
        game.projectiles.cooldown > 0.1 &&
        game.elapsed - game.useActions.lastUse >= 0.21
      );
    });
    await page.keyboard.press("v");
    await h.retirement();
    const shared = await h.finish();
    const presses = shared.inputs.filter(
      (input) => input.type === "keydown" && input.code === "KeyV"
    );
    assert.equal(presses.length, 2);
    assertThrow(presses[0], "main");
    const guard = presses[1];
    assert.equal(guard.trusted, true);
    assert.equal(guard.before.main, null);
    assert.equal(guard.before.offhand.id, config.pearl);
    assert.ok(guard.before.packet.cooldown > 0);
    assert.ok(
      guard.before.elapsed - guard.before.lastUse >= 0.2,
      "exercise the pearl pool's cooldown, not just GameUseActions' 0.2s throttle"
    );
    assert.equal(guard.after.lastUse, guard.before.elapsed);
    assert.ok(
      guard.after.lastUse > guard.before.lastUse,
      "the actual use dispatch ran"
    );
    assert.deepEqual(guard.after.packet, guard.before.packet);
    assert.deepEqual(guard.after.ownership, guard.before.ownership);
    assert.equal(guard.after.health, guard.before.health);
    assert.equal(acceptedInputs(shared).length, 1);
    assertFlight(shared, shotId(presses[0]), { pixels: false });
    assertImpact(shared, presses[0], manifest);

    await h.stage();
    await h.enter();
    await h.throwReady();
    await h.begin("real empty-main/offhand pearl after natural cooldown");
    await page.keyboard.press("v");
    await h.retirement();
    const offhand = await h.finish();
    const [offhandInput] = acceptedInputs(offhand);
    assert.equal(acceptedInputs(offhand).length, 1);
    assert.equal(offhandInput.before.main, null);
    assertThrow(offhandInput, "offhand");
    assertImpact(offhand, offhandInput, manifest);
    assertFlight(offhand, shotId(offhandInput), { pixels: false });

    await h.stage("blocked");
    await h.enter();
    await h.throwReady();
    await h.begin(
      "real swept collision with a body-blocked landing, no refund"
    );
    await page.keyboard.press("v");
    await h.retirement();
    const blocked = await h.finish();
    const [blockedInput] = acceptedInputs(blocked);
    assert.equal(acceptedInputs(blocked).length, 1);
    assertThrow(blockedInput, "offhand");
    const predicted = wallImpact(blockedInput, manifest);
    assert.ok(
      predicted.position.y + blockedInput.before.height > manifest.origin.y + 4,
      "the actual candidate body intersects the authored ceiling"
    );
    assert.ok(
      predicted.position.y + PEARL_RADIUS < manifest.origin.y + 4,
      "the pearl itself fits below the ceiling; this is a blocked BODY landing"
    );
    assert.equal(blocked.retirements.length, 1);
    const refused = blocked.retirements[0];
    assert.deepEqual(refused.ids, [shotId(blockedInput)]);
    assertWallApproach(blocked, blockedInput, predicted, refused);
    pointNear(
      refused.after.position,
      blockedInput.before.position,
      "blocked landing never relocates the Player"
    );
    assert.equal(refused.after.health, refused.before.health);
    assert.equal(blocked.losses.length, 0);
    assert.equal(refused.after.hurt.remaining, 0);
    assert.equal(refused.after.packet.life, blockedInput.before.packet.life);
    assert.deepEqual(
      refused.after.ownership,
      blockedInput.after.ownership,
      "a genuine blocked collision cannot refund the paid throw"
    );
    assert.equal(refused.after.gpu.pearls.count, 0);
    assert.equal(refused.after.gpu.trails.count, 0);
    assertFlight(blocked, shotId(blockedInput), { pixels: false });

    await h.stage("wall"); // Remove ONLY the six authored ceiling cells.
    await page.locator(".world-settings-button").click();
    await page.locator('.mode-picker [data-mode="creative"]').click();
    await h.wait(
      () =>
        window.__voxelBot.game.gameplay.mode === "creative" &&
        !window.__voxelBot.game.transitionGate.busy
    );
    await h.mainMenu();
    await h.enter();
    await page.keyboard.press("1"); // The explicitly authored Creative palette entry.
    await h.throwReady();
    await h.begin(
      "same real wall pose in Creative, without damage or finite cost"
    );
    await page.keyboard.press("v");
    await h.retirement();
    const creative = await h.finish();
    const [creativeInput] = acceptedInputs(creative);
    assert.equal(acceptedInputs(creative).length, 1);
    assertThrow(creativeInput, "main", { creative: true });
    assertImpact(creative, creativeInput, manifest, { creative: true });
    assertFlight(creative, shotId(creativeInput), { pixels: false });
    assert.deepEqual(creative.current.ownership, creative.initial.ownership);

    await h.stage("travel");
    await h.enter();
    await h.throwReady();
    await h.begin("real high pearl remains pending when the player pauses");
    await page.keyboard.press("v");
    await h.wait(() =>
      window.__voxelPearls
        .observations()
        .frames.some(
          (state) =>
            state.packet.projectiles.length === 1 &&
            state.packet.projectiles[0].age > 0
        )
    );
    const pending = await h.finish();
    const [pendingInput] = acceptedInputs(pending);
    assertThrow(pendingInput, "main", { creative: true });
    assert.equal(pending.current.packet.projectiles.length, 1);
    assert.equal(pending.retirements.length, 0);
    const beforeTravel = pending.current;
    await page.locator(".world-settings-button").click();
    await h.begin(
      "actual Return to Spawn owns cancellation of the old pending flight"
    );
    await page.locator(".spawn-button").click();
    await h.wait(
      (wildlifeIdentity) => {
        const state = window.__voxelPearls.read();
        return (
          state.paused &&
          !state.building &&
          state.packet.projectiles.length === 0 &&
          state.wildlifeIdentity !== wildlifeIdentity &&
          !window.__voxelBot.game.transitionGate.busy
        );
      },
      beforeTravel.wildlifeIdentity,
      15000
    );
    await h.draws();
    const travelled = await h.end();
    assertObserved(travelled);
    assert.ok(
      travelled.inputs.some((input) => input.type === "click" && input.trusted),
      "the actual UI, not projectile.cancel(), initiates travel"
    );
    assert.ok(
      Math.hypot(
        travelled.current.position.x - beforeTravel.position.x,
        travelled.current.position.z - beforeTravel.position.z
      ) > 1,
      "real travel reached a different location"
    );
    assert.equal(travelled.current.packet.life, beforeTravel.packet.life);
    assert.equal(travelled.current.packet.nextId, beforeTravel.packet.nextId);
    assert.equal(
      travelled.current.packet.randomState,
      beforeTravel.packet.randomState
    );
    assert.equal(travelled.current.packet.projectiles.length, 0);
    assert.equal(travelled.current.gpu.pearls.count, 0);
    assert.equal(travelled.current.gpu.trails.count, 0);
    assert.equal(travelled.current.gpu.history, 0);
    assert.equal(travelled.losses.length, 0);
    assert.deepEqual(travelled.current.ownership, beforeTravel.ownership);
    const travelSave = await page.evaluate(() => window.__voxelPearls.stored());
    assert.equal(travelSave.packet.life, beforeTravel.packet.life);
    assert.deepEqual(travelSave.packet.projectiles, []);
    await h.begin("real post-travel simulation cannot replay the old flight");
    await h.enter({ grounded: false });
    const at = (await h.read()).simulationTime;
    await h.wait(
      (clock) => window.__voxelBot.game.wildlife.clock - clock >= 1.1,
      at
    );
    const afterTravel = await h.finish();
    assert.equal(afterTravel.losses.length, 0);
    assert.equal(afterTravel.retirements.length, 0);
    assert.ok(
      afterTravel.frames.every((state) => state.packet.projectiles.length === 0)
    );
    t.diagnostic(
      `PASS both hands / shared cooldown / blocked pose / Creative / real travel ${JSON.stringify(
        {
          cooldownAtOffhandRefusal: guard.before.packet.cooldown,
          blockedId: shotId(blockedInput),
          creativeId: shotId(creativeInput),
          travelledPendingId: shotId(pendingInput),
          persistedLife: travelSave.packet.life,
        }
      )}`
    );
  });
});

// Death uses only genuine pearl collisions: three nonlethal hits, then a real
// lethal hit while a separately paid high-arc pearl is still in flight.
test("real lethal pearl clears another pending flight; UI respawn persists a new life", {
  timeout: 150000,
}, async (t) => {
  await withHost(t, async (h) => {
    const { page, manifest } = h;
    for (let hit = 0; hit < 3; hit++) {
      if (hit) await h.stage();
      await h.enter();
      await h.throwReady();
      await h.begin(
        `genuine pearl health loss ${hit + 1}, no health fixture/reset`
      );
      await page.keyboard.press("v");
      await h.retirement();
      const result = await h.finish();
      const [input] = acceptedInputs(result);
      assert.equal(acceptedInputs(result).length, 1);
      assertThrow(input, "main");
      const impact = assertImpact(result, input, manifest);
      assert.equal(impact.before.health, 20 - hit * PEARL_TELEPORT_DAMAGE);
      assert.equal(impact.after.health, 20 - (hit + 1) * PEARL_TELEPORT_DAMAGE);
    }
    assert.equal((await h.read()).health, PEARL_TELEPORT_DAMAGE);
    await h.stage("sky");
    await h.enter();
    await h.throwReady();
    await h.begin("paid high arc, trusted downward look, lethal second pearl");
    await page.keyboard.press("v");
    await h.throwReady(); // Real one-second pool cooldown, no timer/clock writes.
    const high = await h.read();
    assert.equal(high.packet.projectiles.length, 1);
    assert.ok(
      high.packet.projectiles[0].age >=
        PEARL_COOLDOWN_SECONDS - PEARL_STEP_SECONDS
    );
    assert.equal(high.packet.projectiles[0].wait, 0);
    // One deterministic real Remote drag. The 8px sideways detour makes this
    // a drag, never a use tap. No arbitrary convergence/retry loop or pose edit.
    const dy = Math.round(
      (high.pitch - config.wallPitch) / (0.002 * high.sensitivity)
    );
    assert.ok(dy > 8 && dy < 650);
    await page.mouse.move(550, 60);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(558, 60);
    await page.mouse.move(550, 60 + dy);
    await page.mouse.up({ button: "right" });
    const aimed = await h.read();
    near(
      aimed.pitch,
      config.wallPitch,
      "trusted physical downward aim",
      0.0011
    );
    near(aimed.yaw, high.yaw, "Remote detour returns actual yaw", 1e-8);
    assert.equal(aimed.health, PEARL_TELEPORT_DAMAGE);
    assert.equal(
      aimed.packet.projectiles.length,
      1,
      "the first real flight must still be pending"
    );
    assert.ok(
      aimed.packet.projectiles[0].age < 2.5,
      "do not mask a missed high-arc window with a replacement flight"
    );
    await page.keyboard.press("v");
    await page
      .locator(".death-overlay")
      .waitFor({ state: "visible", timeout: actionMs });
    await h.draws();
    const death = await h.end();
    assertObserved(death);
    assert.ok(
      death.inputs.filter(
        (input) =>
          input.type === "mousemove" && input.buttons === 2 && input.trusted
      ).length >= 2,
      "actual trusted right-drag, not a live pose edit"
    );
    const throws = acceptedInputs(death);
    assert.equal(throws.length, 2);
    assertThrow(throws[0], "main");
    assertThrow(throws[1], "main");
    assert.equal(throws[1].before.packet.projectiles.length, 1);
    assert.equal(throws[1].after.packet.projectiles.length, 2);
    const lethal = assertImpact(death, throws[1], manifest, {
      removed: [shotId(throws[0]), shotId(throws[1])],
    });
    assert.equal(lethal.before.health, PEARL_TELEPORT_DAMAGE);
    assert.equal(lethal.after.health, 0);
    assert.equal(lethal.after.dead, true);
    assert.equal(lethal.after.deathCause, "ender-pearl");
    assert.equal(lethal.after.packet.life, throws[1].before.packet.life + 1);
    assert.equal(death.current.enabled, false);
    assert.equal(death.current.simulating, false);
    assert.equal(death.current.ownership.totalPearls, config.pearls.count - 5);
    const deathGate = await page.evaluate(() => {
      const game = window.__voxelBot.game;
      return {
        dead: game.gameplay.dead,
        uiDead: game.ui.isDead,
        overlayOpen: game.overlayOpen,
        active: game.active,
        simulating: game.simulating,
        enabled: game.player.enabled,
        building: game.building,
        closingScreens: Boolean(game.closingScreens),
        observing: window.__voxelPearls.observations() !== null,
      };
    });
    assert.deepEqual(deathGate, {
      dead: true,
      uiDead: true,
      overlayOpen: true,
      active: false,
      simulating: false,
      enabled: false,
      building: false,
      closingScreens: false,
      observing: false,
    });
    t.diagnostic(`DEAD ARCHIVE GATE ${JSON.stringify(deathGate)}`);
    await assert.rejects(
      () => page.evaluate(() => window.__voxelPearls.stage("wall")),
      /setup cannot alter a live flight\/life/,
      "death inspection must not authorize a fixture pose/life mutation"
    );
    const deadSave = await h.waitForDeadSave(lethal.after.packet.life);
    assert.equal(deadSave.health, 0);
    assert.equal(deadSave.dead, true);
    assert.equal(deadSave.packet.life, lethal.after.packet.life);
    assert.deepEqual(deadSave.packet.projectiles, []);

    await h.begin(
      "actual Respawn button advances the saved life, not a fixture reset"
    );
    await page.locator(".respawn-button").click();
    await h.wait(
      () => {
        const game = window.__voxelBot.game;
        return (
          !game.building &&
          !game.gameplay.dead &&
          game.gameplay.health === 20 &&
          game.paused &&
          !game.player.enabled &&
          !game.transitionGate.busy
        );
      },
      undefined,
      15000
    );
    await h.draws();
    await h.enter();
    const at = (await h.read()).simulationTime;
    await h.wait(
      (clock) => window.__voxelBot.game.wildlife.clock - clock >= 0.8,
      at
    );
    const life = await h.finish();
    assert.equal(life.initial.dead, true);
    assert.equal(life.current.health, 20);
    assert.equal(life.current.packet.life, deadSave.packet.life + 1);
    assert.equal(life.current.packet.nextId, deadSave.packet.nextId);
    assert.equal(life.current.packet.randomState, deadSave.packet.randomState);
    assert.equal(life.losses.length, 0);
    assert.equal(life.retirements.length, 0);
    assert.deepEqual(ownedOnly(life.current.ownership), deadSave.owned);
    for (const state of life.frames) {
      assert.deepEqual(state.packet.projectiles, []);
      assert.equal(state.hurt.remaining, 0);
      assert.equal(state.hurt.visible, false);
    }
    const respawnSave = await h.save();
    assert.equal(respawnSave.packet.life, deadSave.packet.life + 1);
    assert.deepEqual(respawnSave.packet.projectiles, []);
    assert.equal(respawnSave.health, 20);
    t.diagnostic(
      `PASS genuine lethal hit / pending cleanup / UI respawn ${JSON.stringify({
        consumed: config.pearls.count - life.current.ownership.totalPearls,
        pendingId: shotId(throws[0]),
        lethalId: shotId(throws[1]),
        deathLife: deadSave.packet.life,
        respawnLife: respawnSave.packet.life,
      })}`
    );
  });
});
