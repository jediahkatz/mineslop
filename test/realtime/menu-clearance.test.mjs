import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bodyBox, boxCollides, moveBody, visitWorldBoxes } from "../../src/collision.js";
import { createGenerator, CHUNK_SIZE, WORLD_HEIGHT } from "../../src/terrain.js";
import { checkMenus, prepareMenuControls } from "./scenarios.mjs";

// CPU geometry replay of the completed cedar-valley menu timeout. No browser,
// Player, gameplay state, edited terrain, or synthesized input events are used.
const stopped = Object.freeze({ x: 271.7, y: 58, z: 406.3 });
const yaw = -0.03;
const forward = Object.freeze({
  x: -Math.sin(yaw) * 0.2,
  y: 0,
  z: -Math.cos(yaw) * 0.2,
});

function generatedWorld() {
  const generator = createGenerator("cedar-valley", "overworld", 3);
  const chunks = new Map();
  for (const cx of [16, 17])
    for (const cz of [24, 25, 26])
      chunks.set(`${cx},${cz}`, generator.generateChunk(cx, cz));
  return Object.freeze({
    dimension: "overworld",
    generatorVersion: 3,
    minY: 0,
    maxY: WORLD_HEIGHT,
    isLoaded: (x, z) =>
      chunks.has(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`),
    get(x, y, z) {
      const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
      return chunks.get(`${cx},${cz}`)?.blocks[
        y * CHUNK_SIZE ** 2 + (z - cz * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE
      ] ?? 0;
    },
  });
}

test("the recorded menu endpoint blocks fresh W against generated solid faces without overlap", (t) => {
  const world = generatedWorld();
  const overlap = boxCollides(world, bodyBox(stopped));
  const contacts = [];
  visitWorldBoxes(world, [271.3, 58, 405.6, 272.2, 59.8, 406.7], "collision",
    ({ x, y, z, cell, frontier }) => contacts.push({ x, y, z, id: cell?.id, frontier: !!frontier }));
  const swept = moveBody(world, stopped, forward);
  const lifted = moveBody(world, stopped, { x: 0, y: 21, z: 0 }, { stepHeight: 0 });
  const cleared = moveBody(world, lifted.position, forward, { stepHeight: 0 });
  assert.equal(overlap, false, "colliding=false means no overlap, not a clear movement path");
  assert.ok(contacts.some(({ x, y, z, id }) => x === 271 && y === 58 && z === 405 && id === 12));
  assert.ok(contacts.some(({ x, y, z, id }) => x === 272 && y === 58 && z === 406 && id === 12));
  assert.ok(contacts.every(({ frontier }) => !frontier));
  assert.deepEqual(swept.position, stopped);
  assert.equal(swept.blocked.x, true);
  assert.equal(swept.blocked.z, true);
  assert.equal(swept.grounded, true);
  assert.equal(swept.stepped, 0);
  assert.equal(lifted.blocked.y, false);
  assert.equal(cleared.blocked.x, false);
  assert.equal(cleared.blocked.z, false);
  assert.ok(Math.hypot(cleared.position.x - stopped.x, cleared.position.z - stopped.z) > 0.15);
  t.diagnostic(JSON.stringify({ scope: "CPU generated collision geometry only", stopped, swept, lifted, cleared }));
});

const snapshot = (position, values = {}) => Object.freeze({
  position: Object.freeze({ ...position }),
  velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
  active: true, enabled: true, allowFlight: true, locked: true,
  grounded: false, flying: true, colliding: false, overlayOpen: false, paused: false,
  timeOfDay: 0.38, wildlifeClock: 30, health: 20, hunger: 20,
  keys: Object.freeze([]),
  ...values,
});
const elevated = Object.freeze({ ...stopped, y: 79.4 });
const takeoffTrace = () => [
  snapshot(stopped, { grounded: true, flying: false }),
  snapshot({ ...stopped, y: 58.5 }),
  snapshot({ ...stopped, y: 79.1 }, { keys: ["Space"] }),
  snapshot(elevated),
];

// Scripted observations test the harness's decisions, not browser delivery or
// Player physics. The real read-only clearance callback executes in a VM with
// generated cells; all other observations are immutable CPU trace data.
function scriptedInput(observations, world = generatedWorld()) {
  const pending = [...observations], events = [], held = new Set();
  const initialPosition = observations[0].position;
  const next = () => {
    assert.ok(pending.length, "unexpected extra observation");
    const observation = pending.shift();
    if (observation instanceof Error) throw observation;
    return observation;
  };
  const input = {
    config: { timeoutMs: 20000 },
    lookMode: "native-mouse",
    page: {
      async evaluate(callback) {
        return structuredClone(runInNewContext(`"use strict"; (${callback.toString()})()`, {
          window: Object.freeze({
            __voxelBot: Object.freeze({
              game: Object.freeze({ world, player: Object.freeze({ position: initialPosition }) }),
              metrics: Object.freeze({
                reset(label) { events.push({ type: "metrics-reset", label }); },
                results(options) {
                  events.push({ type: "metrics-results", options });
                  return { scope: "CPU scripted observations only" };
                },
              }),
            }),
          }),
        }, { timeout: 1000 }));
      },
    },
    async state() { return next(); },
    async until(predicate, description, timeout = input.config.timeoutMs) {
      events.push({ type: "until", description, timeout });
      while (pending.length) {
        const state = next();
        if (predicate(state)) return state;
      }
      throw new Error(`${description} timed out in the CPU trace`);
    },
    async frames(count) {
      events.push({ type: "frames", count });
      return next();
    },
    async doubleTap(key, options) { events.push({ type: "doubleTap", key, options }); },
    async down(key, options) { events.push({ type: "down", key, options }); held.add(key); },
    async press(key) { events.push({ type: "press", key }); },
    async click(selector) { events.push({ type: "click", selector }); },
    async release() {
      events.push({ type: "release", keys: [...held] });
      held.clear();
    },
  };
  return { input, events, pending, held };
}
const reportFor = () => ({ assertions: [], warnings: [] });

test("menu setup scans a bounded complete loaded footprint and uses one physical-takeoff gesture plus one ascent hold", async (t) => {
  const generated = generatedWorld();
  let columns = 0, cells = 0;
  const f = scriptedInput(takeoffTrace(), Object.freeze({
    ...generated,
    isLoaded(x, z) { columns++; return generated.isLoaded(x, z); },
    get(x, y, z) { cells++; return generated.get(x, y, z); },
  }));
  const report = reportFor();
  const clearance = await prepareMenuControls(f.input, report);
  assert.equal(columns, 625);
  assert.ok(cells <= 625 * WORLD_HEIGHT);
  assert.equal(clearance.highestOccupiedY, 76);
  assert.equal(clearance.targetAltitude, 79);
  assert.deepEqual(clearance.bounds, { minX: 259, maxX: 284, minZ: 394, maxZ: 419 });
  assert.deepEqual(f.events.filter(({ type }) => type === "doubleTap"), [
    { type: "doubleTap", key: "Space", options: { holdSecondFrames: 2 } },
  ]);
  assert.deepEqual(f.events.filter(({ type }) => type === "down"), [
    { type: "down", key: "Space", options: { flight: true } },
  ]);
  assert.ok(f.events.filter(({ type }) => type === "until").every(({ timeout }) => timeout === 20000));
  assert.ok(!f.events.some(({ type }) => type === "metrics-reset"));
  assert.equal(report.menuSetup.takeoffGestures, 1);
  assert.equal(report.menuSetup.ascentHolds, 1);
  assert.equal(report.assertions[0].status, "passed");
  assert.equal(f.held.size, 0);
  assert.equal(f.pending.length, 0);
  t.diagnostic(JSON.stringify({ scope: "CPU harness setup decisions only", columns, cells, clearance, limits: report.menuSetup.limits }));
});

test("already clear flight is retained without another toggle, ascent, or descent", async () => {
  const ready = snapshot({ ...stopped, y: 84 });
  const f = scriptedInput([ready, ready, ready]);
  const report = reportFor();
  await prepareMenuControls(f.input, report);
  assert.equal(report.menuSetup.targetAltitude, 79);
  assert.equal(report.menuSetup.takeoffGestures, 0);
  assert.equal(report.menuSetup.ascentHolds, 0);
  assert.ok(!f.events.some(({ type }) => ["doubleTap", "down", "press"].includes(type)));
  assert.equal(f.pending.length, 0);
});

test("already clear flight tolerates sub-threshold settling drift without adding correction input", async () => {
  const before = snapshot({ ...stopped, y: 84.0024 }, { velocity: { x: 0, y: -0.02, z: 0 } });
  const after = snapshot({ ...stopped, y: 84.0012 }, { velocity: { x: 0, y: -0.003, z: 0 } });
  const f = scriptedInput([before, before, after]);
  const report = reportFor();
  let failure;
  try { await prepareMenuControls(f.input, report); } catch (error) { failure = error; }
  assert.ifError(failure);
  assert.ok(!f.events.some(({ type }) => ["doubleTap", "down", "press"].includes(type)));
  assert.equal(report.assertions[0].status, "passed");
});

test("a missing column fails before flight input rather than presuming empty space or generating terrain", async () => {
  const f = scriptedInput([takeoffTrace()[0]], Object.freeze({
    ...generatedWorld(),
    isLoaded: () => false,
    get() { assert.fail("must not read an unloaded column"); },
  }));
  await assert.rejects(prepareMenuControls(f.input, reportFor()), /loaded column/);
  assert.ok(!f.events.some(({ type }) => ["doubleTap", "down"].includes(type)));
  assert.equal(f.held.size, 0);
});

for (const phase of ["takeoff", "ascent"]) {
  test(`failed ${phase} is not retried and releases owned inputs`, async () => {
    const trace = takeoffTrace().slice(0, phase === "takeoff" ? 1 : 2);
    const failure = new Error(`${phase} timed out`);
    const f = scriptedInput([...trace, failure]);
    await assert.rejects(prepareMenuControls(f.input, reportFor()), failure);
    assert.equal(f.events.filter(({ type }) => type === "doubleTap").length, 1);
    assert.equal(f.events.filter(({ type }) => type === "down").length, phase === "takeoff" ? 0 : 1);
    assert.equal(f.events.at(-1).type, "release");
    assert.equal(f.held.size, 0);
  });
}

test("loss of flight during ascent fails immediately without an automatic re-toggle", async () => {
  const f = scriptedInput([
    ...takeoffTrace().slice(0, 2),
    snapshot(stopped, { flying: false, grounded: true }),
  ]);
  await assert.rejects(prepareMenuControls(f.input, reportFor()), /lost active flight/);
  assert.equal(f.events.filter(({ type }) => type === "doubleTap").length, 1);
  assert.equal(f.held.size, 0);
});

test("menu assertions cannot begin if setup settles outside its verified footprint", async () => {
  const f = scriptedInput([
    ...takeoffTrace().slice(0, 3),
    snapshot({ ...elevated, x: 284 }),
  ]);
  const report = reportFor();
  await assert.rejects(prepareMenuControls(f.input, report), /clearance setup failed/);
  assert.equal(report.assertions[0].status, "failed");
  assert.ok(!f.events.some(({ type }) => type === "metrics-reset"));
  assert.equal(f.held.size, 0);
});

function menuTrace({ finalDistance = 0.2, fault } = {}) {
  const trace = takeoffTrace();
  const active = (steps, values) => snapshot({ ...elevated, z: elevated.z - steps * 0.2 }, values);
  let steps = 0;
  for (const closingKey of ["KeyE", "Escape"]) {
    trace.push(active(steps), active(++steps, { keys: ["KeyW"] }));
    const opened = active(steps, { overlayOpen: true, active: false, enabled: false });
    const frozen = fault === "inventory-held-keys" && closingKey === "KeyE"
      ? { ...opened, keys: ["KeyW", "KeyD"] }
      : fault === "inventory-drift" && closingKey === "KeyE"
        ? { ...opened, position: { ...opened.position, x: opened.position.x + 0.01 } }
        : opened;
    trace.push(opened, opened, frozen, active(steps), active(steps));
    trace.push(active(++steps, { keys: ["KeyW"] }), active(steps));
  }
  trace.push(active(steps), active(++steps, { keys: ["KeyW"] }));
  const paused = active(steps, { paused: true, active: false, enabled: false });
  const frozen = fault === "pause-clock" ? { ...paused, wildlifeClock: 31 } : paused;
  trace.push(paused, paused, frozen, active(steps));
  trace.push(active(steps, fault === "resume-stuck-key" ? { keys: ["KeyD"] } : {}));
  trace.push(snapshot(
    { ...elevated, z: elevated.z - steps * 0.2 - finalDistance }, { keys: ["KeyW"] }
  ));
  return trace;
}

test("all menu checks run after setup, with no recovery input between resume and fresh W", async () => {
  const f = scriptedInput(menuTrace());
  const report = reportFor();
  await checkMenus(f.input, report);
  assert.equal(report.assertions.length, 10);
  assert.ok(report.assertions.every(({ status }) => status === "passed"));
  const resetAt = f.events.findIndex(({ type }) => type === "metrics-reset");
  assert.ok(resetAt > f.events.findIndex(({ type }) => type === "doubleTap"));
  assert.ok(!f.events.slice(resetAt).some(({ key }) => key === "Space"));
  assert.equal(f.events.filter(({ type, key }) => type === "down" && key === "KeyW").length, 6);
  const resumeAt = f.events.findIndex(({ type }) => type === "click");
  assert.deepEqual(f.events.slice(resumeAt + 1).filter(({ type }) =>
    ["down", "press", "doubleTap", "click"].includes(type)), [
    { type: "down", key: "KeyW", options: undefined },
  ]);
  assert.equal(f.events.filter(({ type, keys }) =>
    type === "release" && keys.includes("KeyW") && keys.includes("KeyD")).length, 3);
  assert.equal(f.events.at(-2).type, "metrics-results");
  assert.equal(f.events.at(-1).type, "release");
  assert.equal(f.held.size, 0);
  assert.equal(f.pending.length, 0);
});

for (const [fault, assertionName] of [
  ["inventory-held-keys", "Inventory ignores held W/D (KeyE close)"],
  ["inventory-drift", "Inventory ignores held W/D (KeyE close)"],
  ["pause-clock", "Pause freezes position, world time, wildlife clock, and vitals"],
  ["resume-stuck-key", "Resume has no stuck movement keys"],
]) {
  test(`the independent ${fault} assertion still rejects its failing observation`, async () => {
    const f = scriptedInput(menuTrace({ fault }));
    const report = reportFor();
    await checkMenus(f.input, report);
    assert.equal(report.assertions.find(({ name }) => name === assertionName)?.status, "failed");
    assert.equal(f.held.size, 0);
  });
}

test("post-resume fresh W still requires more than 0.15 horizontal blocks and cleans up on failure", async () => {
  const f = scriptedInput(menuTrace({ finalDistance: 0.14 }));
  const report = reportFor();
  await assert.rejects(checkMenus(f.input, report), /Fresh W input moves the player timed out/);
  assert.equal(report.assertions.find(({ name }) => name === "Resume has no stuck movement keys")?.status, "passed");
  assert.ok(!report.assertions.some(({ name }) => name === "Fresh W works after pause/resume"));
  assert.equal(f.events.at(-2).type, "metrics-results");
  assert.equal(f.events.at(-1).type, "release");
  assert.equal(f.held.size, 0);
});
