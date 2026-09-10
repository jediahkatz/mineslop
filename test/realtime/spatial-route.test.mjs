import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import { SPATIAL32, Spatial32Guard, planSpatial32, setupKeys, sourceReader } from "./spatial-route.js";
import { readConfig } from "./config.mjs";
import { ViewDiagnostics } from "./view-diagnostics.js";
import { traverseSpatial32 } from "./spatial-route.mjs";
import { BotMetrics } from "./metrics.js";

// Optional frozen source root for evidence replay; ordinary CPU regressions use
// the checkout. These detached fixtures never control a browser or live world.
const root = process.env.MINESLOP_REPLAY_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const source = (name) => new URL(`src/${name}`, pathToFileURL(`${root.replace(/\/$/, "")}/`));
const { Player } = await import(source("player.js"));
const { createGenerator, CHUNK_SIZE, WORLD_HEIGHT } = await import(source("terrain.js"));
const { bodyBox, boxCollides, moveBody, visitWorldBoxes } = await import(source("collision.js"));

let generated;
function seedWorld() {
  if (generated) return generated;
  const generator = createGenerator("cedar-valley", "overworld", 3), chunks = new Map();
  for (let cx = 16; cx <= 18; cx++)
    for (let cz = 24; cz <= 28; cz++)
      chunks.set(`${cx},${cz}`, generator.generateChunk(cx, cz));
  generated = {
    seed: "cedar-valley", dimension: "overworld", generatorVersion: 3,
    minY: 0, maxY: WORLD_HEIGHT, chunks,
    isLoaded: (x, z) => chunks.has(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`),
    get(x, y, z) {
      if (y < 0 || y >= WORLD_HEIGHT) return 0;
      const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
      return chunks.get(`${cx},${cz}`)?.blocks[
        y * CHUNK_SIZE ** 2 + (z - cz * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE
      ] ?? 0;
    },
    ensureArea() { assert.fail("CPU replay must not request terrain"); },
    getSpawn() { assert.fail("CPU replay must not recover/reset a pose"); },
  };
  return generated;
}

function replayPlayer(t, position, world = seedWorld()) {
  const document = new EventTarget(), element = new EventTarget();
  document.defaultView = new EventTarget();
  document.hidden = false;
  element.ownerDocument = document;
  element.dataset = {};
  element.closest = () => null;
  document.pointerLockElement = element;
  const camera = new THREE.PerspectiveCamera(75);
  const player = new Player(camera, world, element, { inputMode: "native" });
  // Fixture initialization only. All subsequent replay motion is Player.update.
  player.setPosition(position);
  player.flying = true;
  player.enabled = true;
  t.after(() => player.dispose());
  const down = (code, at = 1000) => player._onKeyDown({
    code, timeStamp: at, target: element, repeat: false, preventDefault() {},
  });
  const up = (code) => player._onKeyUp({ code });
  return { player, world, camera, document, element, down, up };
}

test("v2 held Space hits generated leaves at y=61 while the Player remains airborne without overlap", (t) => {
  const world = seedWorld(), stopped = { x: 268.7, y: 59.2, z: 421.3 };
  const contacts = [];
  visitWorldBoxes(world, [268.39, 59.2, 420.99, 269.01, 61.1, 421.61], "collision",
    ({ x, y, z, cell, frontier }) => contacts.push({ x, y, z, id: cell?.id, frontier: !!frontier }));
  assert.equal(boxCollides(world, bodyBox(stopped)), false);
  const swept = moveBody(world, stopped, { x: 0, y: 1, z: 0 }, { stepHeight: 0 });
  assert.equal(swept.blocked.y, true);
  assert.deepEqual(swept.position, stopped);
  const f = replayPlayer(t, { ...stopped, y: 56 });
  f.down("Space");
  for (let frame = 0; frame < 200; frame++) f.player.update(0.1, { recoverFromVoid: false });
  assert.ok(Math.abs(f.player.position.y - stopped.y) < 1e-9);
  assert.equal(f.player.velocity.y, 0);
  assert.equal(f.player.flying, true);
  assert.equal(f.player.grounded, false);
  assert.ok(contacts.some((entry) => entry.id === 21 && entry.y === 61));
  assert.ok(contacts.every((entry) => !entry.frontier));
  t.diagnostic(JSON.stringify({ sourceRoot: root, scope: "frozen seeded CPU geometry and actual Player, not browser input",
    stopped, contacts, after200Updates: f.player.position.toArray(), velocity: f.player.velocity.toArray() }));
});

test("the v2 y=65 plateau can land a flying Player and disable flight by the production rule", (t) => {
  const f = replayPlayer(t, { x: 268.8157272435075, y: 65.05, z: 433.70102120714336 });
  f.down("ShiftLeft");
  for (let frame = 0; frame < 10; frame++) f.player.update(0.1, { recoverFromVoid: false });
  assert.equal(f.player.position.y, 65);
  assert.equal(f.player.flying, false);
  assert.equal(f.player.grounded, true);
  t.diagnostic(`CPU descent at recorded v2 plateau: y=${f.player.position.y}, flying=${f.player.flying}, grounded=${f.player.grounded}`);
});

test("CPU survey declares the initial 32-block northbound corridor and vertical takeoff feasibility", (t) => {
  const world = seedWorld(), start = { x: 277.5, y: 58.599900295879046, z: 446.5 };
  let top = -1;
  for (let z = 398; z <= 447; z++)
    for (let x = 260; x <= 294; x++) {
      assert.equal(world.isLoaded(x, z), true);
      for (let y = WORLD_HEIGHT - 1; y > top; y--)
        if (world.get(x, y, z)) { top = y; break; }
    }
  const target = top + 3;
  const ascent = moveBody(world, start, { x: 0, y: target - start.y, z: 0 }, { stepHeight: 0 });
  t.diagnostic(JSON.stringify({ sourceRoot: root, start, length: 32, yaw: 0, pitch: -0.42,
    surveyedTop: top, targetFeet: target, ascent }));
  assert.equal(ascent.blocked.y, false);
  assert.ok(Math.abs(ascent.position.y - target) < 1e-9);
});

test("the opt-in version fixes all physical tolerances and finite budgets before a run", () => {
  assert.deepEqual(SPATIAL32, {
    mode: "spatial-32-v1", label: "generated-terrain-spatial-32-v1",
    seed: "cedar-valley", generatorVersion: 3, startX: 277.5, startZ: 446.5,
    length: 32, yaw: 0, pitch: -0.42, positionTolerance: 0.02,
    angleTolerance: 0.01, setupBand: 0.5, relayBand: 0.2, altitudeBand: 0.55,
    setupLeadSeconds: 0.2,
    stationarySpeed: 0.025, quietFrames: 4, clearance: 1,
    lateral: 0.4, speedLimit: 8.01, overshoot: 0.81, brakeTail: 3.5,
    setupMs: 60000, measuredMs: 45000, cleanupMs: 10000,
    maxFrames: 4096, maxControlTicks: 512, maxRecords: 128,
    preflightCells: 200000, frameCells: 2048,
  });
  assert.equal(Object.isFrozen(SPATIAL32), true);
});

test("read-only preflight pins the whole corridor plus menu/braking apron, including trees", () => {
  const world = seedWorld(), before = [...world.chunks.values()].map((c) => c.blocks.slice());
  const plan = planSpatial32(Object.freeze({ ...world }), { x: 277.5, y: 58.6, z: 446.5 });
  assert.deepEqual(plan.bounds, { minX: 260, maxX: 295, minZ: 398, maxZ: 448 });
  assert.equal(plan.profile.length, 1750);
  assert.equal(plan.highestOccupiedY, 76);
  assert.equal(plan.targetFeet, 79);
  assert.ok(plan.cellReads <= SPATIAL32.preflightCells);
  assert.deepEqual([...world.chunks.values()].map((c) => c.blocks), before);
  assert.throws(() => planSpatial32({ ...world, isLoaded: () => false },
    { x: 277.5, y: 58.6, z: 446.5 }), /unloaded/);
  assert.throws(() => planSpatial32(world, { x: 268.7, y: 59.2, z: 421.3 }), /start/);
});

function routeFixture(t, { y = 79, world = seedWorld(), prepare = true, install = true } = {}) {
  const f = replayPlayer(t, { x: 277.5, y, z: 446.5 }, world);
  f.player.pitch = -0.42;
  f.player.update(0.001);
  let now = 0, starts = 0, stops = 0;
  const game = {
    player: f.player, world, active: true, paused: false, overlayOpen: false, failed: false,
    gameplay: { mode: "creative", dead: false }, graphics: { camera: f.camera },
    frame(dt) { f.player.update(dt, { recoverFromVoid: false }); return "original-return"; },
  };
  const guard = new Spatial32Guard(game, {
    hidden: () => f.document.hidden, clock: () => now,
    onStart: () => starts++, onStop: () => stops++,
  });
  if (install) guard.install();
  if (prepare) guard.prepare();
  return {
    ...f, game, guard,
    advance(dt = 0.1, wallMs = dt * 1000) { now += wallMs; return game.frame(dt); },
    now: () => now,
    counts: () => ({ starts, stops }),
    ready() {
      for (let n = 0; n < SPATIAL32.quietFrames; n++) game.frame(0.1);
      assert.equal(guard.status().ready, true);
      guard.begin();
    },
  };
}

test("four real frame endpoints, not repeated status polls, establish a stationary airborne start", (t) => {
  const f = routeFixture(t);
  for (let n = 0; n < 100; n++) assert.equal(f.guard.status().ready, false);
  for (let n = 0; n < 3; n++) f.advance();
  assert.equal(f.guard.status().ready, false);
  assert.equal(f.advance(), "original-return");
  assert.equal(f.guard.status().ready, true);
  f.guard.begin();
  assert.deepEqual(f.counts(), { starts: 1, stops: 0 });
  assert.throws(() => f.guard.begin(), /once/);
});

for (const dt of [1 / 60, 1 / 20, 0.1, 0.42]) {
  test(`native-intent Player replay completes the same 32-block cut at dt=${dt}, then brakes without recovery`, (t) => {
    const f = routeFixture(t);
    f.ready();
    f.down("KeyW");
    for (let n = 0; n < 1000 && f.guard.status().phase === "measured"; n++) f.advance(dt);
    assert.equal(f.guard.status().phase, "braking");
    const cut = f.guard.results().endpoint;
    assert.ok(cut.progress >= 32 && cut.progress <= 32.81);
    f.up("KeyW");
    for (let n = 0; n < 1000 && f.guard.status().phase === "braking"; n++) f.advance(dt);
    assert.equal(f.guard.status().phase, "complete");
    assert.equal(f.guard.results().failure, null);
    assert.deepEqual(f.counts(), { starts: 1, stops: 1 });
    assert.equal(f.player.flying, true);
    assert.equal(f.player._keys.size, 0);
    assert.equal(f.player.pitch, -0.42);
    t.diagnostic(JSON.stringify({ dt, cut, end: f.player.position.toArray(),
      scope: "CPU Player dynamics only; not native browser delivery or GPU acceptance" }));
  });
}

for (const [name, inject] of [
  ["flight loss", (f) => { f.player.flying = false; }],
  ["pointer lock loss", (f) => { f.document.pointerLockElement = null; }],
  ["hidden page", (f) => { f.document.hidden = true; }],
  ["pause", (f) => { f.game.paused = true; }],
  ["wrong pitch", (f) => { f.player.pitch += 0.011; }],
  ["altitude drift", (f) => { f.player.position.y += 0.551; }],
  ["lateral drift", (f) => { f.player.position.x += 0.401; }],
  ["unexpected Space", (f) => f.down("Space")],
]) {
  test(`one frame of ${name} latches a failure which later healthy frames cannot erase`, (t) => {
    const f = routeFixture(t);
    f.ready();
    inject(f);
    f.advance();
    const failure = structuredClone(f.guard.results().failure);
    assert.equal(f.guard.status().phase, "failed");
    assert.ok(failure);
    // Fault-injection fixture restoration must not requalify a failed attempt.
    f.player.position.set(277.5, 79, 446.5);
    f.player.velocity.set(0, 0, 0);
    f.player.flying = true;
    f.player.grounded = false;
    f.player.pitch = -0.42;
    f.up("Space");
    f.document.pointerLockElement = f.element;
    f.document.hidden = false;
    f.game.paused = false;
    for (let n = 0; n < 5; n++) f.advance();
    assert.equal(f.guard.snapshot().flying, true);
    assert.equal(f.guard.snapshot().locked, true);
    assert.equal(f.guard.snapshot().hidden, false);
    assert.deepEqual(f.guard.results().failure, failure);
    assert.deepEqual(f.counts(), { starts: 1, stops: 1 });
  });
}

test("a bounded setup relay only chooses vertical native holds and never a measured correction", () => {
  const state = (y, vy = 0) => ({ position: { y }, velocity: { y: vy } });
  assert.deepEqual(setupKeys(state(75), 79), ["Space"]);
  assert.deepEqual(setupKeys(state(80), 79), ["ShiftLeft"]);
  assert.deepEqual(setupKeys(state(79), 79), []);
  assert.deepEqual(setupKeys(state(78.6, 5.6), 79), []);
  assert.deepEqual(setupKeys(state(80, 5.6), 79), [], "coast before considering a reverse hold");
  assert.deepEqual(setupKeys({ ...state(78.1, 5.6), keys: ["Space"] }, 79), [], "release leads delayed observations");
  assert.throws(() => setupKeys(state(NaN), 79), /finite/);
});

for (const dt of [1 / 60, 0.1, 0.42]) {
  for (const delayFrames of [0, 1, 2]) {
    test(`seeded Player setup converges within budget, dt=${dt}, delayed intent=${delayFrames} frames`, (t) => {
      const f = routeFixture(t, { y: 58.6 }), pending = [];
      let lastSpace = -Infinity, wall = 1000;
      for (let n = 0; n < SPATIAL32.maxControlTicks && !f.guard.status().ready &&
          f.guard.status().phase === "setup"; n++) {
        pending.push(setupKeys(f.guard.snapshot(), 79));
        if (pending.length > delayFrames) {
          const wanted = new Set(pending.shift());
          // Same fresh-Space cooldown as RealInputs; these are detached handler
          // calls, not DOM events or evidence of browser delivery.
          if (wanted.has("Space") && !f.player._keys.has("Space") && wall - lastSpace <= 400)
            wanted.delete("Space");
          for (const key of f.player._keys) if (!wanted.has(key)) f.up(key);
          for (const key of wanted) if (!f.player._keys.has(key)) {
            f.down(key, wall);
            if (key === "Space") lastSpace = wall;
          }
        }
        f.advance(dt);
        wall += dt * 1000;
      }
      if (!f.guard.status().ready) f.guard.fail("cap", "setup control-tick cap");
      for (const key of f.player._keys) f.up(key);
      assert.equal(f.player._keys.size, 0);
      assert.equal(f.guard.status().ready, true);
      assert.ok(Math.abs(f.player.position.y - 79) <= SPATIAL32.setupBand);
      assert.ok(Math.abs(f.player.velocity.y) < SPATIAL32.stationarySpeed);
      t.diagnostic(JSON.stringify({ dt, delayFrames, phase: f.guard.status().phase,
        ready: f.guard.status().ready, position: f.player.position.toArray(),
        failure: f.guard.results().failure }));
    });
  }
}

test("the historical config remains default and the hit-section observer is separately opt-in", () => {
  const original = readConfig([], {});
  assert.equal(original.routeMode, undefined);
  assert.equal(new URL(original.url).searchParams.has("routeMode"), false);
  const explicit = readConfig(["--route-mode", "wall-time-v1"], {});
  assert.equal(explicit.url, original.url);
  const spatial = readConfig(["--route-mode", "spatial-32-v1"], {});
  assert.equal(spatial.routeMode, SPATIAL32.mode);
  assert.equal(new URL(spatial.url).searchParams.get("routeMode"), SPATIAL32.mode);
  assert.equal(spatial.viewDiagnostics, false);
  assert.equal(new URL(spatial.url).searchParams.has("viewDiagnostics"), false);
  const diagnostic = readConfig(["--route-mode", "spatial-32-v1", "--view-diagnostics"], {});
  assert.equal(diagnostic.viewDiagnostics, true);
  assert.throws(() => readConfig(["--route-mode", "spatial-128"], {}), /route-mode/);
  assert.throws(() => readConfig(["--route-mode", "spatial-32-v1", "--seed", "different"], {}), /cedar-valley/);
  const observer = new ViewDiagnostics({}, { sample: () => ({ scope: "CPU diagnostic stub" }) });
  observer.reset(SPATIAL32.label);
  observer.record({ terrainRaysHit: 1 }, {});
  assert.equal(observer.results().observations.length, 0);
  observer.record({ terrainRaysHit: 0 }, {});
  assert.equal(observer.results().version, 2);
  assert.equal(observer.results().observations.length, 1);
  observer.stop();
  observer.record({ terrainRaysHit: 0 }, {});
  assert.equal(observer.results().observations.length, 1);
});

test("source reads are capped exactly, read-only, and unknown cells are not promoted to air", () => {
  let calls = 0;
  const world = Object.freeze({
    ...seedWorld(), get(x, y, z) { calls++; return seedWorld().get(x, y, z); },
  });
  const source = sourceReader(world, SPATIAL32.frameCells);
  for (let n = 0; n < SPATIAL32.frameCells; n++) source.getCell(277, 79, 446);
  assert.throws(() => source.getCell(277, 79, 446), /cap/);
  assert.equal(calls, SPATIAL32.frameCells);
  assert.equal(source.reads, SPATIAL32.frameCells);
  assert.throws(() => sourceReader({ ...world, getCell: () => null }, 1).getCell(277, 79, 446), /unknown/);
});

test("premature measurement, setup deadlines and missing source readiness stay failed without rearming", (t) => {
  const premature = routeFixture(t);
  assert.throws(() => premature.guard.begin(), /converged/);
  for (let n = 0; n < 5; n++) premature.advance();
  assert.equal(premature.guard.status().phase, "failed");
  assert.throws(() => premature.guard.begin(), /once/);
  const timed = routeFixture(t, { y: 58.6 });
  timed.advance(0.1, SPATIAL32.setupMs);
  assert.equal(timed.guard.results().failure.kind, "timeout");
  assert.equal(timed.counts().starts, 0);
  const missing = routeFixture(t, { world: { ...seedWorld(), isLoaded: () => false } });
  assert.equal(missing.guard.status().phase, "source-wait");
  missing.advance(0.1, SPATIAL32.setupMs);
  missing.guard.prepare();
  assert.equal(missing.guard.status().phase, "failed");
  assert.match(missing.guard.results().firstSourceUnknown.message, /unloaded/);
  assert.throws(() => missing.guard.prepare(), /cannot reset/);
});

test("a transient missing corridor chunk is unknown and latched even when restored before the next poll", (t) => {
  let loaded = true;
  const f = routeFixture(t, { world: { ...seedWorld(), isLoaded: (x, z) => loaded && seedWorld().isLoaded(x, z) } });
  f.ready();
  loaded = false;
  f.advance();
  loaded = true;
  f.advance();
  const result = f.guard.results();
  assert.equal(result.failure.kind, "unknown");
  assert.equal(result.failure.state.clearance, "unknown");
  assert.equal(result.phase, "failed");
  assert.equal(f.counts().stops, 1);
});

test("a new overhead cell is a latched clearance failure, not a zero-miss success", (t) => {
  let obstructed = false;
  const world = { ...seedWorld(), get(x, y, z) {
    return obstructed && x === 277 && y === 81 && z === 446 ? 21 : seedWorld().get(x, y, z);
  } };
  const f = routeFixture(t, { world });
  f.ready();
  obstructed = true;
  f.advance();
  obstructed = false;
  f.advance();
  assert.equal(f.guard.status().phase, "failed");
  assert.equal(f.guard.results().failure.state.clearance, "blocked");
});

test("an unknown flight-state flag is not treated as false even if physics repairs it in the same frame", (t) => {
  const f = routeFixture(t);
  f.ready();
  f.player.grounded = undefined;
  f.advance();
  assert.equal(f.player.grounded, false);
  assert.equal(f.guard.results().failure.kind, "unknown");
  assert.match(f.guard.results().failure.message, /grounded/);
});

test("no W delivery, early W release, overshoot and a late braking release all fail with the original cut retained", (t) => {
  const stalled = routeFixture(t);
  stalled.ready();
  stalled.advance(0.1, SPATIAL32.measuredMs);
  assert.equal(stalled.guard.results().failure.kind, "timeout");
  assert.equal(stalled.guard.results().endpoint, null);
  const released = routeFixture(t);
  released.ready();
  released.down("KeyW");
  released.advance();
  released.up("KeyW");
  released.advance();
  assert.match(released.guard.results().failure.message, /forward input lost/);
  const overshot = routeFixture(t);
  overshot.ready();
  overshot.player.position.z -= SPATIAL32.length + SPATIAL32.overshoot + 0.001;
  overshot.advance();
  assert.match(overshot.guard.results().failure.message, /overshoot/);
  const late = routeFixture(t);
  late.ready();
  late.down("KeyW");
  while (late.guard.status().phase === "measured") late.advance();
  const endpoint = structuredClone(late.guard.results().endpoint);
  for (let n = 0; n < 10; n++) late.advance();
  assert.equal(late.guard.status().phase, "failed");
  assert.match(late.guard.results().failure.message, /braking tail/);
  assert.deepEqual(late.guard.results().endpoint, endpoint);
  assert.equal(late.counts().stops, 1);
});

test("frame and retention caps cannot silently turn an incomplete route into success", (t) => {
  const capped = routeFixture(t);
  capped.ready();
  for (let n = 0; n < SPATIAL32.maxFrames; n++) capped.advance(0.000001, 0);
  assert.equal(capped.guard.results().failure.kind, "cap");
  assert.equal(capped.guard.results().framesMeasured, SPATIAL32.maxFrames);
  const retained = routeFixture(t);
  retained.ready();
  retained.down("KeyW");
  while (retained.guard.status().phase === "measured") retained.advance();
  retained.up("KeyW");
  while (retained.guard.status().phase === "braking") retained.advance(0.001, 1);
  assert.equal(retained.guard.results().phase, "complete");
  assert.equal(retained.guard.results().records.length, SPATIAL32.maxRecords);
  assert.ok(retained.guard.results().droppedRecords > 0);
  assert.ok(retained.guard.results().maxCellReads <= SPATIAL32.frameCells);
});

test("the real BotMetrics includes the boundary render, then freezes before native braking frames", (t) => {
  const world = { ...seedWorld(), _nextRequestId: 0, _requests: new Map(), _inFlight: new Map(), dirtyChunks: new Set() };
  const f = routeFixture(t, { world, install: false });
  f.game.currentTime = 0.36;
  f.game.graphics.chunks = new Map();
  f.game.graphics.renderer = {
    getPixelRatio: () => 1,
    info: { render: { calls: 1, triangles: 1 }, memory: { geometries: 1, textures: 1 } },
  };
  const original = f.game.frame;
  f.game.frame = (dt) => { original(dt); f.game.currentTime += Math.min(dt, 0.1) / 1200; };
  const metrics = new BotMetrics(f.game, { clock: f.now, eventTarget: f.document });
  f.guard.onStart = () => metrics.reset(SPATIAL32.label);
  let cut;
  f.guard.onStop = () => { cut = metrics.results({ stop: true }); };
  f.guard.install();
  f.ready();
  f.down("KeyW");
  while (f.guard.status().phase === "measured") f.advance();
  assert.deepEqual(cut.movement.end, f.guard.results().endpoint.position);
  assert.equal(cut.frames.callbacks, f.guard.results().framesMeasured);
  assert.ok(cut.clock.simulatedSeconds > 4);
  f.up("KeyW");
  while (f.guard.status().phase === "braking") f.advance();
  assert.deepEqual(metrics.results(), cut);
  assert.notDeepEqual(f.guard.results().end.position, cut.movement.end);
});

// Actual Player and guard, but a scripted transport/metrics adapter: this tests
// controller decisions and cleanup, not trusted browser input or rendered pixels.
function controllerFixture(t, { reportFailure = false, setupFailure = false, measuredFailure = false } = {}) {
  const f = routeFixture(t, { y: 58.6, prepare: false }), events = [], held = new Set();
  f.player.flying = false;
  let lastSpace = -Infinity, throwReport = reportFailure;
  const result = {
    frames: { active: 41, paused: 0, unloadedPlayer: 0 },
    inputs: { trusted: 1, untrusted: 0 }, latency: { keyToMotionMs: { samples: 1 } },
    view: { samples: 77, terrainVisible: 27, terrainVisibleFraction: 27 / 77 },
    maxima: { triangles: 1, cachedChunks: 15, requestedChunks: 0, inFlightChunks: 0,
      retainedChunkMeshes: 1, visibleChunkMeshes: 1, drawnChunkMeshes: 1 },
    clock: { available: true, discontinuities: 0, simulationRate: 1 },
  };
  const transport = {
    prepare: () => {
      if (setupFailure) f.guard.fail("test", "scripted setup failure");
      return setupFailure ? f.guard.status() : f.guard.prepare();
    },
    begin: () => { events.push({ type: "begin" }); return f.guard.begin(); },
    fail: (message) => f.guard.fail("controller", message),
    results: () => {
      if (throwReport) { throwReport = false; throw new Error("scripted report failure"); }
      return f.guard.results();
    },
  };
  const snapshot = () => ({
    ...f.guard.snapshot(), ready: true, failed: false, error: null,
    seed: "cedar-valley", quality: "medium", syntheticFixture: null,
    dimension: "overworld", generatorVersion: 3, renderer: { scope: "CPU stub" },
    world: { renderedChunks: 1, renderRadius: 3 }, spatialRoute: f.guard.status(),
  });
  const input = {
    lookMode: "native-mouse", config: { timeoutMs: 20000, seed: "cedar-valley", quality: "medium" },
    async state() { f.advance(); return snapshot(); },
    async frames(n) { for (let i = 0; i < n; i++) f.advance(); return snapshot(); },
    async down(key) {
      if (held.has(key)) return;
      events.push({ type: "down", key, phase: f.guard.status().phase });
      held.add(key);
      f.down(key, f.now() + 1000);
      if (key === "Space") lastSpace = f.now();
    },
    async release() {
      events.push({ type: "release", phase: f.guard.status().phase });
      for (const key of held) f.up(key);
      held.clear();
    },
    async doubleTap(key, options) {
      events.push({ type: "doubleTap", key, options });
      f.down(key, f.now() + 1000); f.up(key); f.down(key, f.now() + 1001);
      lastSpace = f.now();
      await input.frames(options.holdSecondFrames);
      f.up(key);
    },
    async steer(state, yaw, pitch) {
      events.push({ type: "steer", phase: f.guard.status().phase });
      f.player._onMouseMove({ movementX: (state.yaw - yaw) / 0.002, movementY: (state.pitch - pitch) / 0.002 });
      return [];
    },
    async setHeld(keys) {
      const wanted = new Set(keys);
      if (wanted.has("Space") && !held.has("Space") && f.now() - lastSpace <= 400) wanted.delete("Space");
      for (const key of held) if (!wanted.has(key)) { f.up(key); held.delete(key); }
      for (const key of wanted) await input.down(key);
    },
    async until(predicate, description, timeout) {
      const deadline = f.now() + timeout;
      while (f.now() < deadline) {
        if (measuredFailure && f.guard.status().phase === "measured") f.guard.fail("test", "scripted measurement failure");
        const state = await input.state();
        if (predicate(state)) return state;
      }
      throw new Error(`${description} timed out in CPU transport`);
    },
    page: { async evaluate(callback, argument) {
      return structuredClone(runInNewContext(`(${callback.toString()})(argument)`, {
        argument, window: { __voxelBot: { spatialRoute: transport, metrics: { results: () => result } } },
      }, { timeout: 1000 }));
    } },
  };
  return { ...f, input, events, held };
}

test("controller uses one takeoff and one measured W hold; legacy 27/77 still fails even after a valid route", async (t) => {
  const f = controllerFixture(t), report = { assertions: [], warnings: [] };
  await traverseSpatial32(f.input, report);
  assert.equal(report.spatialRoute.phase, "complete");
  assert.equal(report.spatialSetup.takeoffGestures, 1);
  assert.equal(report.assertions.find((a) => a.name.startsWith("Terrain remains")).status, "failed");
  const measured = f.events.filter((e) => e.phase === "measured");
  assert.deepEqual(measured, [{ type: "down", key: "KeyW", phase: "measured" }]);
  assert.equal(f.events.filter((e) => e.type === "doubleTap").length, 1);
  assert.equal(f.held.size, 0);
});

for (const failure of ["setupFailure", "measuredFailure", "reportFailure"]) {
  test(`controller releases native key ownership after ${failure} without another takeoff or reset`, async (t) => {
    const f = controllerFixture(t, { [failure]: true }), report = { assertions: [], warnings: [] };
    await assert.rejects(traverseSpatial32(f.input, report), /scripted/);
    assert.equal(f.held.size, 0);
    assert.equal(f.player._keys.size, 0);
    assert.ok(f.events.filter((e) => e.type === "doubleTap").length <= 1);
    assert.equal(f.events.at(-1).type, "release");
  });
}
