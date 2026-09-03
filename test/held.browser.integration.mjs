// Parent-run acceptance; NEVER starts a server or changes production files.
// VOXELCRAFT_TEST_URL=http://127.0.0.1:<isolated-port>/[mineslop/] \
// VOXELCRAFT_HELD_BUILD_LABEL=<frozen-label> node --test test/held.browser.integration.mjs
// Logs: a new /tmp/mineslop-held-browser-*/acceptance.json (also on failure).
// Optional VOXELCRAFT_HELD_LOG_ROOT=/opt/cursor/artifacts.
// Testing strategy: actual Game/World/ItemUse + trusted browser transport, finite
// authored prerequisites, after-frame transforms and independent timing/resource
// assertions. Unit tests own exact 30/60/144 Hz partitions; no natural-FPS claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCKS } from "../src/blocks.js";
import { FOOD_USE_SECONDS, BOW_DRAW_SECONDS, SHIELD_RAISE_SECONDS } from "../src/item-use.js";
import { getItem } from "../src/items.js";
import {
  heldBrowserConfig as config, heldBrowserURL, installHeldBrowserFixture,
} from "./held-browser-fixture.mjs";
import { chromeExecutable } from "./realtime/config.mjs";

const url = heldBrowserURL(process.env.VOXELCRAFT_TEST_URL);
const expectedBuild = process.env.VOXELCRAFT_HELD_BUILD_LABEL;
const logRoot = resolve(process.env.VOXELCRAFT_HELD_LOG_ROOT ?? "/tmp");
if (!isAbsolute(process.env.VOXELCRAFT_HELD_LOG_ROOT ?? "/tmp") ||
  (logRoot !== "/tmp" && logRoot !== "/opt/cursor/artifacts" &&
    !logRoot.startsWith("/opt/cursor/artifacts/")))
  throw new Error("Held evidence must use /tmp or an absolute /opt/cursor/artifacts directory");
const actionMs = 8000, startupMs = 60000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const near = (a, b, label, epsilon = 1e-7) =>
  assert.ok(Number.isFinite(a) && Math.abs(a - b) <= epsilon, `${label}: ${a} vs ${b}`);
const pointNear = (a, b, label, epsilon = 1e-7) => {
  for (const axis of ["x", "y", "z"]) near(a[axis], b[axis], `${label}.${axis}`, epsilon);
};
const pose = (hand) => [hand.position, hand.rotation, hand.scale, hand.itemRotation, hand.itemScale];
const count = (state, id) => [...state.owned.slots, state.owned.offhand, state.owned.cursor,
  ...state.owned.craftingGrid, ...Object.values(state.owned.equipment)]
  .reduce((total, stack) => total + (stack?.id === id ? stack.count : 0), 0);
const relevantInput = (record, type, code) => record.inputs.find((input) =>
  input.type === type && (typeof code === "number" ? input.button === code : input.code === code) &&
  input.after);
const channelNames = ["walk", "mining", "food", "bow", "shield", "charge", "equip", "strike"];

function assertObservation(record) {
  assert.equal(record.status, "complete", record.error ?? record.reason);
  assert.equal(record.error, null);
  assert.equal(record.overflow, false);
  assert.equal(record.reason, "release-or-cancel-plus-350ms");
  assert.ok(record.frames.length > 1 && record.frames.length <= config.limits.frames);
  assert.ok(record.trigger?.trusted, "window starts on accepted, trusted input");
  assert.ok(record.releasedAt >= record.startedAt);
  assert.ok(record.inputs.length && record.inputs.every((input) => input.trusted),
    "native isTrusted witnesses, not dispatchEvent");
  const resources = { main: new Set(), offhand: new Set() };
  for (const state of record.frames) {
    assert.ok(Object.values(state.owners).every(Boolean), "real owners and unchanged methods");
    assert.equal(state.mode, "survival");
    assert.equal(state.inputMode, "remote");
    assert.equal(state.failed, false);
    assert.equal(state.health, 20, "the sealed room protects an unhealed fresh life");
    assert.equal(state.dead, false);
    assert.equal(state.flying, false);
    assert.equal(state.autoSpawn, true, "wildlife/AI remain enabled");
    assert.equal(state.geometryIntact, true, "no native or authored cell was removed");
    assert.equal(state.targetCell.id, config.obsidian);
    assert.equal(state.gpu.contextLost, false);
    assert.equal(state.gpu.badPrograms, 0);
    assert.ok(state.gpu.calls > 0 && state.gpu.triangles > 0, "real scene reaches WebGL");
    for (const name of ["main", "offhand"]) {
      const hand = state[name], motion = hand.motion;
      resources[name].add(JSON.stringify(hand.resources));
      assert.equal(hand.visible, state.active && state.hudVisible &&
        state.perspective === "first" && (name === "main" || Boolean(hand.id)));
      assert.equal(motion.miningRequested, false, "the caller lease is consumed once");
      for (const channel of channelNames)
        for (const field of ["lead", "value"])
          assert.ok(Number.isFinite(motion[channel][field]) &&
            motion[channel][field] >= 0 && motion[channel][field] <= 1);
      const tangent = Math.tan(state.projection.fov * Math.PI / 360);
      near(hand.position.z, -motion.pose.depth, "rendered hand depth");
      near(hand.position.x, motion.pose.x * motion.pose.depth * tangent * state.projection.aspect,
        "rendered horizontal anchor");
      near(hand.position.y, motion.pose.y * motion.pose.depth * tangent, "rendered vertical anchor");
      near(hand.rotation.x, motion.pose.rx, "rendered pitch is the composed motion");
      if (!hand.visible) {
        assert.equal(hand.drawn, false);
        for (const channel of channelNames) assert.equal(motion[channel].value, 0);
        assert.equal(motion.miningActive, false);
      }
    }
  }
  for (const name of ["main", "offhand"]) assert.equal(resources[name].size, 1);
  for (let i = 1; i < record.frames.length; i++) {
    const before = record.frames[i - 1], after = record.frames[i];
    assert.equal(after.frame, before.frame + 1, "one sample per completed Game frame");
    assert.ok(after.draw > before.draw);
    const dt = after.elapsed - before.elapsed;
    assert.ok(dt > 0 && dt <= 0.100000001, "actual bounded Game dt, never fake rAF");
    if (before.simulating === after.simulating)
      near(after.simulationTime - before.simulationTime, after.simulating ? dt : 0,
        "the real wildlife clock follows the real simulation");
  }
}

function assertStationary(record, otherHand) {
  const initial = record.initial;
  for (const state of record.frames) {
    pointNear(state.position, initial.position, "held animation cannot move the body", 0.002);
    pointNear(state.eye, initial.eye, "held animation cannot move the physical eye", 0.002);
    pointNear(state.forward, initial.forward, "physical aiming direction");
    near(state.yaw, initial.yaw, "yaw");
    near(state.pitch, initial.pitch, "pitch");
    if (otherHand)
      for (let i = 0; i < pose(initial[otherHand]).length; i++)
        pointNear(pose(state[otherHand])[i], pose(initial[otherHand])[i],
          "inactive hand remains unchanged", 0.0005);
  }
}

function assertInstantPose(input, label) {
  assert.ok(input?.trusted && input.after, `${label} needs a real handled input`);
  assert.equal(input.after.frame, input.before.frame, "synchronous input boundary");
  assert.equal(input.after.elapsed, input.before.elapsed, "input does not advance time");
  assert.deepEqual(pose(input.after.main), pose(input.before.main), `${label}: main pose cannot snap`);
  assert.deepEqual(pose(input.after.offhand), pose(input.before.offhand), `${label}: offhand cannot snap`);
  pointNear(input.after.position, input.before.position, `${label}: physical body`);
  pointNear(input.after.forward, input.before.forward, `${label}: physical aim`);
}

function assertMining(record, { reduced = false, hidden = false } = {}) {
  assertObservation(record);
  assertStationary(record, hidden ? null : "offhand");
  const input = relevantInput(record, "mousedown", 0);
  assertInstantPose(input, "mining press");
  assert.equal(input.after.main.id, config.pickaxe);
  near(input.after.miningDuration,
    BLOCKS[config.obsidian].hardness * 5 / getItem(config.pickaxe).speed,
    "wooden pickaxe retains the existing insufficient-tier obsidian duration");
  assert.ok(input.after.miningDuration >= 30, "obsidian is deliberately not a fast-break target");
  assert.deepEqual(record.current.owned, record.initial.owned, "unfinished mining pays no tool wear/loot");
  let previous = input.after;
  const pitches = [], deltas = [];
  for (const state of record.frames) {
    if (state.heldAction === "mine" && state.miningProgress > 0) {
      assert.equal(state.target.id, config.obsidian);
      assert.ok(state.target.distance > 0 && state.target.distance < 3, "actual physical ray within 3m");
      if (previous.heldAction === "mine") {
        near(state.miningProgress - previous.miningProgress,
          (state.elapsed - previous.elapsed) / state.miningDuration,
          "one unaccelerated mining progress increment per Game frame");
      }
      assert.ok(state.miningProgress < 1, "the obsidian remains intact");
      if (state.main.visible) {
        assert.equal(state.main.motion.miningActive, true, "real caller renews explicit miningActive");
        assert.equal(state.offhand.motion.miningActive, false);
        if (state.main.motion.mining.value > 0.9) pitches.push(state.main.rotation.x);
      }
    }
    deltas.push(state.frameTime - previous.frameTime);
    previous = state;
  }
  if (reduced) {
    for (const state of record.frames) {
      assert.equal(state.main.reducedMotion, true);
      near(state.main.rotation.x, 0.15, "reduced motion removes decorative mining");
      near(state.main.motion.pose.y, -0.75, "reduced motion removes decorative bob/equip");
    }
  } else if (!hidden) {
    assert.ok(new Set(pitches.map((pitch) => pitch.toFixed(4))).size >= 6,
      "sustained accepted mining produces changing rendered pitches");
    const directions = pitches.slice(1).map((pitch, i) =>
      Math.abs(pitch - pitches[i]) > 0.005 ? Math.sign(pitch - pitches[i]) : 0).filter(Boolean);
    const turns = directions.slice(1).filter((direction, i) => direction !== directions[i]).length;
    assert.ok(turns >= 3, "repeated strokes, not one angle held until release");
  }
  return { observedFrameMs: { min: Math.min(...deltas), max: Math.max(...deltas) },
    distinctPitches: new Set(pitches.map((pitch) => pitch.toFixed(4))).size };
}

function assertUse(record, kind, handName, endingCode = "KeyV") {
  assertObservation(record);
  assertStationary(record, handName === "main" ? "offhand" : "main");
  const input = relevantInput(record, "keydown", "KeyV");
  assertInstantPose(input, `${kind} entry`);
  assert.equal(input.after.use.kind, kind);
  assert.equal(input.after.use.hand, handName);
  assert.equal(input.after.use.elapsed, 0);
  const active = record.frames.filter((state) => state.use.active && state.use.kind === kind);
  assert.ok(active.length >= 2, "actual held-use renderer frames");
  assert.ok(active[0][handName].motion[kind].value > 0 &&
    active[0][handName].motion[kind].value < 0.75,
  "even a 100ms first frame retains a visible entry transition");
  assert.ok(active.some((state) => state[handName].motion[kind].value > 0.9));
  assert.ok(active.some((state) => state[handName].drawn && state[handName].position.z > -0.8));
  const ending = relevantInput(record, endingCode === "KeyV" ? "keyup" : "keydown", endingCode);
  assertInstantPose(ending, `${kind} release/cancel`);
  assert.equal(ending.after.use.active, false, "only real input cancels/releases the gameplay owner");
  const tail = record.frames.find((state) => state.frame > ending.after.frame && !state.use.active);
  assert.ok(tail && tail[handName].motion[kind].value > 0 &&
    tail[handName].motion[kind].value < ending.before[handName].motion[kind].value,
  "visible release/cancel eases rather than snapping");
  let previous = input.after;
  for (const state of record.frames) {
    if (state.use.active && state.use.kind === kind && previous.use.active) {
      const duration = kind === "food" ? FOOD_USE_SECONDS : BOW_DRAW_SECONDS;
      const expected = Math.min(duration, previous.use.elapsed + state.elapsed - previous.elapsed);
      if (kind === "food" && count(state, config.apple) !== count(previous, config.apple)) {
        near(expected, FOOD_USE_SECONDS, "food cost happens only after the actual 1.6s cycle");
        assert.equal(count(previous, config.apple) - count(state, config.apple), 1);
        near(state.use.elapsed, 0, "the gameplay owner completes its food cycle");
      } else near(state.use.elapsed, expected, "visual smoothing never retimes ItemUse");
      near(state.use.progress, Math.min(1, state.use.elapsed /
        (kind === "shield" ? SHIELD_RAISE_SECONDS : duration)), "real ItemUse progress");
      if (kind === "shield")
        assert.equal(state.use.blocking, state.use.elapsed >= SHIELD_RAISE_SECONDS);
    }
    previous = state;
  }
  return { input, ending };
}

async function frozenPreflight(context) {
  const response = await context.request.get(url.href, { maxRedirects: 0, timeout: 15000 });
  assert.equal(response.status(), 200);
  const html = await response.text();
  await response.dispose();
  assert.ok(Buffer.byteLength(html) < 65536);
  assert.doesNotMatch(html, /\/@vite\/client|\/@react-refresh|src=["'][^"']*\/driver\.js/);
  const paths = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)]
    .map((match) => match[1]))];
  assert.ok(paths.length > 0 && paths.length <= 16, "compiled production entrypoints");
  const assets = [];
  for (const path of paths) {
    const asset = new URL(path, url);
    assert.equal(asset.origin, url.origin);
    assert.match(asset.pathname, /\/assets\/[^/]+\.js$/);
    const result = await context.request.get(asset.href, { maxRedirects: 0, timeout: 15000 });
    assert.equal(result.status(), 200);
    const body = await result.body();
    await result.dispose();
    assert.ok(body.length < 12 * 1024 * 1024);
    assets.push({ url: asset.href, bytes: body.length, sha256: sha(body) });
  }
  const sources = {};
  for (const file of ["held-motion.js", "held-item.js", "game.js", "effects.js",
    "game-controls.js", "game-use-actions.js", "item-use.js", "player.js"]) {
    const body = await readFile(new URL(`../src/${file}`, import.meta.url));
    assert.ok(body.length < 2 * 1024 * 1024);
    sources[file] = sha(body);
  }
  return { url: url.href, expectedBuild: expectedBuild ?? null, htmlSha256: sha(html), assets,
    localSourceSha256: sources,
    sourceNote: "Source hashes describe this test checkout; served asset hashes/build label describe the frozen host." };
}

test("frozen real Game: trusted hand motion, use costs, caller timing and visibility gates", {
  timeout: 240000,
}, async (t) => {
  await mkdir(logRoot, { recursive: true });
  const logPath = join(await mkdtemp(join(logRoot, "mineslop-held-browser-")), "acceptance.json");
  const evidence = { status: "running", host: null, setup: null, cases: [], errors: [],
    warnings: [], network: [], blocked: [], diagnosticOverflow: false };
  let phase = "frozen preflight", page;
  const remember = (key, value) => {
    if (evidence[key].length >= 64 || JSON.stringify(value).length > 16384)
      evidence.diagnosticOverflow = true;
    else evidence[key].push(value);
  };
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN), headless: true,
    args: ["--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close()); // Only this newly created automated-test browser.
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 }, serviceWorkers: "block", reducedMotion: "no-preference",
  });
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url());
    if ((["http:", "https:"].includes(request.protocol) && request.origin !== url.origin) ||
      request.pathname.startsWith("/@vite/") || request.pathname.includes("/@vite/")) {
      remember("blocked", request.href);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    remember("blocked", socket.url());
    socket.close();
  });
  try {
    const provenance = await frozenPreflight(context);
    page = await context.newPage();
    page.setDefaultTimeout(actionMs);
    page.setDefaultNavigationTimeout(startupMs);
    page.on("pageerror", (error) => remember("errors", error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error" ||
        /GL_INVALID_|GL_OUT_OF_MEMORY|CONTEXT_LOST_WEBGL|Shader Error/.test(message.text()))
        remember("errors", message.text());
      else if (message.type() === "warning") remember("warnings", message.text());
    });
    page.on("requestfailed", (request) =>
      remember("network", { url: request.url(), failure: request.failure()?.errorText }));
    page.on("response", (response) => {
      if (response.status() >= 400)
        remember("network", { url: response.url(), status: response.status() });
    });
    const wait = async (predicate, value, timeout = actionMs) => {
      assert.equal(Object.prototype.toString.call(predicate), "[object Function]");
      const result = await page.waitForFunction(predicate, value, { timeout });
      await result.dispose();
    };
    const read = () => page.evaluate(() => window.__voxelHeld.read());
    const frames = async (count = 2) => {
      const before = await page.evaluate(() => window.__voxelBot.game.vehicleFrame);
      await wait(({ before, count }) => window.__voxelBot.game.vehicleFrame >= before + count,
        { before, count });
    };
    const idle = () => wait(() => {
      const { game } = window.__voxelBot;
      if (window.__voxelHeld.status().error) throw new Error(window.__voxelHeld.status().error);
      return !game.useActions.use.active && !game.useActions.held && !game.heldAction &&
        !game.player.moving && [game.effects, game.effects.offhand].every((view) =>
          view.motion.channels.every((channel) => channel.value < 0.0002));
    });
    const choose = async (slot) => {
      await page.keyboard.press(String(slot + 1));
      await idle();
      const state = await read();
      assert.equal(state.selected, slot);
      assert.equal(state.main.id, config.slots[slot]?.id ?? 0);
    };
    const enter = async () => {
      await page.locator(".play-button").click();
      await wait(() => {
        const game = window.__voxelBot.game;
        return game.active && game.player.enabled && !game.playing && game.player.grounded;
      });
      await idle();
    };
    const pause = async () => {
      await page.keyboard.press("Escape");
      await wait(() => {
        const game = window.__voxelBot.game;
        return game.paused && !game.player.enabled && !game.closingScreens;
      });
      await frames();
    };
    const arm = async (kind, label) => {
      phase = label;
      await page.evaluate(({ kind, label }) => window.__voxelHeld.arm(kind, label), { kind, label });
    };
    const finish = async () => {
      await wait(() => {
        const state = window.__voxelHeld.status();
        if (state.error) throw new Error(state.error);
        return state.status === "complete";
      });
      const record = await page.evaluate(() => window.__voxelHeld.result());
      // A 350ms wall-clock tail need not contain 350ms of capped visual dt on a
      // slow GPU. Observe natural subsequent frames; never extend/replay input.
      await idle();
      const settled = await read();
      evidence.cases.push({ label: phase, record, settled });
      assertObservation(record);
      t.diagnostic(`OBSERVED ${phase}: ${record.frames.length} real frames; health ${settled.health}`);
      return record;
    };
    const mineFor = (seconds) => wait(({ seconds, id }) => {
      const game = window.__voxelBot.game;
      return game.miningProgress * game.gameplay.miningDuration(id) >= seconds;
    }, { seconds, id: config.obsidian });
    const useFor = (seconds) => wait((seconds) =>
      window.__voxelBot.game.useActions.use.elapsed >= seconds, seconds);
    const startMine = async (label, seconds = 1.15) => {
      await choose(5);
      await page.mouse.move(550, 380);
      await arm("mining", label);
      await page.mouse.down({ button: "left" });
      await mineFor(seconds);
    };
    const releaseMine = async () => {
      await page.mouse.up({ button: "left" });
      return finish();
    };

    await page.goto(url.href, { waitUntil: "load" });
    await wait(() => window.__voxelBot?.ready || window.__voxelBot?.error, undefined, startupMs);
    const host = await page.evaluate(() => window.__voxelBot.state({ renderer: true }));
    assert.equal(host.error, null);
    assert.equal(host.build.production, true);
    if (expectedBuild !== undefined) assert.equal(host.build.label, expectedBuild);
    assert.equal(host.syntheticFixture, null, "do not call the driver's terrain-erasing controls fixture");
    assert.equal(host.live, null, "the host's metrics recorder stays dormant");
    assert.equal(host.paused, true);
    assert.equal(host.health, 20);
    assert.ok(host.view.visibleChunkGroups > 0, "the real generated world is rendered");
    assert.equal(await page.evaluate(() => typeof window.__mineslopHandProbe), "undefined",
      "this acceptance works without diagnostic hand instrumentation");
    evidence.host = { ...provenance, build: host.build, browser: browser.version(), renderer: host.renderer };
    t.diagnostic(`FROZEN HOST ${JSON.stringify(evidence.host)}`);
    await page.evaluate(() => window.__voxelBot.game.setControlPreferences({ inputMode: "remote" }));
    await page.locator(".world-settings-button").click();
    await page.locator('.mode-picker [data-mode="survival"]').click();
    await wait(() => window.__voxelBot.game.gameplay.mode === "survival" &&
      !window.__voxelBot.game.transitionGate.busy);
    await page.locator(".menu-back-button").click();
    await page.evaluate(installHeldBrowserFixture, { config, provenance: evidence.host });
    evidence.setup = await page.evaluate(() => window.__voxelHeld.prepare());
    t.diagnostic(`AUTHORED PREREQUISITES ${JSON.stringify({
      label: evidence.setup.label, disclosure: evidence.setup.disclosure,
      authoredCells: evidence.setup.authoredCells, search: evidence.setup.search,
      stance: evidence.setup.stance, target: evidence.setup.target,
    })}`);
    assert.ok(evidence.setup.changes.every((cell) =>
      cell.before.id === config.air && !cell.before.state && !cell.before.fluid));
    await wait(() => window.__voxelBot.game.world.dirtyChunks.size === 0, undefined, 15000);
    await enter();

    await startMine("sustained Survival mining and natural release expiry");
    const mining = await releaseMine();
    t.diagnostic(`PASS MINING ${JSON.stringify(assertMining(mining))}`);
    near(evidence.cases.at(-1).settled.main.rotation.x, 0.15, "mining expires to idle", 0.003);

    for (const handName of ["main", "offhand"]) {
      await choose(handName === "main" ? 1 : 0);
      await arm(`shield-${handName}`, `${handName} shield smooth entry/release`);
      await page.keyboard.down("v");
      await useFor(0.4);
      await page.keyboard.up("v");
      const record = await finish();
      assertUse(record, "shield", handName);
      assert.deepEqual(record.current.owned, record.initial.owned, "blocking empty air spends no shield");
      assert.ok(record.frames.some((state) => state.use.blocking));
    }

    await choose(2);
    await arm("food-main", "one actual food cycle then release");
    const apples = count(await read(), config.apple);
    await page.keyboard.down("v");
    await wait(({ apples, apple }) => window.__voxelBot.game.gameplay.count(apple) === apples - 1,
      { apples, apple: config.apple });
    await page.keyboard.up("v");
    const food = await finish();
    assertUse(food, "food", "main");
    const paidFood = structuredClone(food.initial.owned);
    paidFood.slots[2].count--;
    assert.deepEqual(food.current.owned, paidFood);
    assert.equal(food.current.hunger - food.initial.hunger, getItem(config.apple).food);

    await choose(2);
    await arm("food-main", "food cancellation by immediate empty-slot selection");
    await page.keyboard.down("v");
    await useFor(0.35);
    await page.keyboard.press("1");
    await page.keyboard.up("v");
    const foodCancel = await finish();
    const selection = assertUse(foodCancel, "food", "main", "Digit1").ending;
    assert.equal(selection.after.selected, 0);
    assert.equal(selection.after.main.id, 0, "asset identity changes in the real selection handler");
    assert.deepEqual(foodCancel.current.owned, foodCancel.initial.owned);
    assert.equal(foodCancel.current.hunger, foodCancel.initial.hunger);
    assert.ok(foodCancel.frames.some((state) => state.main.motion.equip.value > 0),
      "selection has a smooth visual pulse after immediate identity change");

    await choose(3);
    await arm("bow-main", "actual bow draw and paid release");
    await page.keyboard.down("v");
    await useFor(0.55);
    await page.keyboard.up("v");
    const bow = await finish();
    assertUse(bow, "bow", "main");
    const paidBow = structuredClone(bow.initial.owned);
    paidBow.slots[3].durability--;
    paidBow.slots[4].count--;
    assert.deepEqual(bow.current.owned, paidBow, "one arrow and one bow wear on genuine release");
    assert.equal(bow.current.hunger, bow.initial.hunger);

    await choose(3);
    await arm("bow-main", "bow cancellation by immediate shield selection");
    await page.keyboard.down("v");
    await useFor(0.4);
    await page.keyboard.press("2");
    await page.keyboard.up("v");
    const bowCancel = await finish();
    const bowSelection = assertUse(bowCancel, "bow", "main", "Digit2").ending;
    assert.equal(bowSelection.after.main.id, config.shield);
    assert.equal(bowSelection.after.selected, 1);
    assert.deepEqual(bowCancel.current.owned, bowCancel.initial.owned, "cancel never fires or spends ammo");

    await choose(0);
    await arm("walking", "trusted walking start/stop with natural inertial tail");
    await page.keyboard.down("d");
    await wait(() => window.__voxelBot.game.effects.motion.walk.value > 0.94);
    await page.keyboard.up("d");
    const walking = await finish();
    assert.ok(walking.frames.some((state) => state.moving && state.main.motion.walk.value > 0.9));
    assert.ok(walking.current.position.x - walking.initial.position.x > 0.2);
    assert.ok(walking.frames.some((state) => !state.keys.includes("KeyD") &&
      state.main.motion.walk.value > 0));
    assert.equal(evidence.cases.at(-1).settled.moving, false);
    assert.deepEqual(walking.current.owned, walking.initial.owned);
    for (const state of walking.frames) {
      near(state.yaw, walking.initial.yaw, "walking preserves physical yaw");
      near(state.pitch, walking.initial.pitch, "walking preserves physical pitch");
    }
    await pause();
    evidence.walkingRestage = await page.evaluate(() => window.__voxelHeld.stage());
    await enter();

    for (const key of ["F1", "F5"]) {
      await startMine(`${key} hides active motion; returning cannot replay a stale lease`, 0.4);
      await page.keyboard.press(key);
      await frames();
      const hidden = await read();
      assert.equal(hidden.main.visible, false);
      assert.equal(hidden.offhand.visible, false);
      const record = await releaseMine();
      assertMining(record, { hidden: true });
      const hideInput = relevantInput(record, "keydown", key);
      pointNear(hideInput.after.position, hideInput.before.position, "visibility shortcut preserves body");
      pointNear(hideInput.after.forward, hideInput.before.forward, "visibility shortcut preserves aim");
      if (key === "F5") {
        assert.equal(hidden.perspective, "back");
        await page.keyboard.press(key);
        await frames();
        const front = await read();
        assert.equal(front.perspective, "front");
        assert.equal(front.main.visible, false);
        evidence.cases.at(-1).front = front;
      }
      await page.keyboard.press(key);
      await frames();
      const returned = await read();
      assert.equal(returned.perspective, "first");
      assert.equal(returned.hudVisible, true);
      assert.equal(returned.main.visible, true);
      assert.equal(returned.main.motion.miningActive, false);
      near(returned.main.rotation.x, 0.15, "hidden motion is discarded");
      evidence.cases.at(-1).returned = returned;
    }

    await page.emulateMedia({ reducedMotion: "reduce" }); // Real browser preference, not motion-state writes.
    await startMine("live reduced-motion preference suppresses mining decoration", 0.65);
    assertMining(await releaseMine(), { reduced: true });
    await choose(1);
    await arm("shield-main", "reduced motion retains meaningful shield entry/release");
    await page.keyboard.down("v");
    await useFor(0.4);
    await page.keyboard.up("v");
    const reducedShield = await finish();
    assertUse(reducedShield, "shield", "main");
    assert.ok(reducedShield.frames.some((state) => state.main.reducedMotion &&
      state.main.motion.shield.value > 0.9 && state.main.position.z > -0.8));
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await choose(5);
    await pause();
    await arm("mining", "arm while paused, genuine mining, Escape cancellation, safe resume");
    await frames();
    const armed = await page.evaluate(() => window.__voxelHeld.status());
    assert.equal(armed.status, "armed");
    assert.equal(armed.frames, 0, "paused arming is not a fabricated gesture");
    await enter();
    assert.equal((await page.evaluate(() => window.__voxelHeld.status())).status, "armed");
    await page.mouse.move(550, 380);
    await page.mouse.down({ button: "left" });
    await mineFor(0.4);
    await pause();
    await page.mouse.up({ button: "left" });
    const paused = await finish();
    assertMining(paused, { hidden: true });
    assert.equal(paused.current.paused, true);
    await enter();
    await frames(3);
    const resumed = await read();
    assert.equal(resumed.heldAction, null);
    assert.equal(resumed.use.active, false);
    assert.equal(resumed.main.motion.miningActive, false);
    assert.equal(resumed.miningProgress, 0);
    near(resumed.main.rotation.x, 0.15, "resume does not replay pre-pause motion");
    evidence.cases.at(-1).resumed = resumed;
    await pause();
    assert.equal(evidence.diagnosticOverflow, false);
    assert.deepEqual(evidence.errors, []);
    assert.deepEqual(evidence.network, []);
    assert.deepEqual(evidence.blocked, []);
    const inputs = await page.evaluate(() => window.__voxelBot.state().inputs);
    assert.ok(inputs.trusted > 0);
    assert.equal(inputs.untrusted, 0);
    evidence.status = "passed";
    t.diagnostic(`PASS ${evidence.cases.length} finite real-Game gestures; ${inputs.trusted} trusted events`);
  } catch (error) {
    evidence.status = "failed";
    evidence.failure = { phase, message: error.stack ?? String(error) };
    evidence.last = await page?.evaluate(() => ({
      state: window.__voxelHeld?.read(), record: window.__voxelHeld?.result(),
      hostError: window.__voxelBot?.error,
    })).catch((failure) => ({ inspectionError: String(failure) }));
    t.diagnostic(`FAILED ${phase}: ${error.message}`);
    throw error;
  } finally {
    const text = JSON.stringify(evidence);
    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
      throw new Error("Held evidence exceeded its 64MiB cap; no success claimed");
    await writeFile(logPath, text, { flag: "wx" });
    t.diagnostic(`HELD ACCEPTANCE EVIDENCE ${logPath}`);
  }
});
