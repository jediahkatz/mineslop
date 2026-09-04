// Final acceptance requires a frozen source+test checkpoint, not a moving checkout.
// Against that checkpoint's local Vite server, from the same frozen test tree:
// BOAT_SURVIVAL_URL=http://127.0.0.1:5317/mineslop/ mise exec node@22.14.0 -- node --test test/boat-survival.browser.integration.mjs
// This is automated browser acceptance, not the parent's separate manual GUI proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { boatSeat } from "../src/boat-definitions.js";
import { ITEM } from "../src/items.js";
import { chromeExecutable } from "./realtime/config.mjs";
import { planNaturalPlankRecipes, resourceCounts } from "./realtime/survival.mjs";
import { angular, NativeSurvival, ownedCounts, same } from "./boat-survival/input.mjs";
import { cellKey, center, horizontal } from "./boat-survival/planning.js";
import {
  COAST_HULL_TURN, DRIVEN_HULL_TURN, turnFollowEvidence, YAW_TOLERANCE,
} from "./boat-survival/yaw-follow.mjs";

const seed = process.env.BOAT_SURVIVAL_SEED ?? "boat-survival-6";
assert.ok(process.env.BOAT_SURVIVAL_URL, "Set BOAT_SURVIVAL_URL to an isolated frozen local Vite host");
const base = new URL(process.env.BOAT_SURVIVAL_URL);
assert.ok(["http:", "https:"].includes(base.protocol) &&
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
  base.port && !base.username && !base.password && !base.search && !base.hash,
  "Use an explicit loopback host and port without credentials or query overrides");
if (!base.pathname.endsWith("/")) base.pathname += "/";
const url = new URL("test/boat-survival/index.html", base).href;
const sourceFiles = [
  "src/game.js", "src/player.js", "src/boats.js", "src/boat-definitions.js",
  "src/boat-physics.js", "src/game-vehicle-services.js", "src/game-vehicle-integration.js",
  "src/recipes.js", "src/wood-recipes.js", "src/ui/inventory.js", "src/ui/recipe-book.js",
  "test/boat-survival/bootstrap.js", "test/boat-survival/input.mjs",
  "test/boat-survival/planning.js", "test/boat-survival/yaw-follow.mjs",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) =>
  [file, digest(await readFile(new URL(`../${file}`, import.meta.url)))])));
const viewport = { width: 960, height: 600 };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const speed = (boat) => Math.hypot(boat.vx, boat.vy, boat.vz);
const viewReceipt = (state) => ({
  yaw: state.yaw, pitch: state.pitch, hullYaw: state.hullYaw,
  cameraYaw: state.cameraYaw, cameraPitch: state.cameraPitch,
  cameraForward: state.cameraForward,
  relativeViewYaw: state.relativeViewYaw, relativeCameraYaw: state.relativeCameraYaw,
});
const renderedViewMatchesPlayer = (state) =>
  [state.cameraYaw, state.cameraPitch, state.cameraForward?.x,
    state.cameraForward?.y, state.cameraForward?.z].every(Number.isFinite) &&
  Math.abs(angular(state.cameraYaw, state.yaw)) < YAW_TOLERANCE &&
  Math.abs(state.cameraPitch - state.pitch) < YAW_TOLERANCE;
const receipts = (state) => ({
  documentId: state.documentId, frame: state.frame, position: state.position,
  eye: state.eye, camera: state.camera, ...viewReceipt(state),
  seed: state.seed, generatorVersion: state.generatorVersion, mode: state.mode,
  slots: state.slots, cursor: state.cursor, offhand: state.offhand,
  equipment: state.equipment, craftingGrid: state.craftingGrid,
  selected: state.selected, inventory: ownedCounts(state), cells: state.cells,
  boats: state.boats, pickups: state.pickups, overflow: state.overflow,
  mount: state.mount, seated: state.seated, clock: state.clock,
  storageRevision: state.storageRevision, inputs: state.inputs,
});
const controlSample = (state) => {
  const boat = state.boat ?? state.boats[0];
  return {
    frame: state.frame, position: state.position, eye: state.eye, camera: state.camera,
    ...viewReceipt(state), boat, hullYaw: boat.yaw,
  };
};
const appendFrames = (samples, state) => {
  // Include the host's bounded post-render frame history, not just the two
  // endpoints: a double application followed by a correction must still fail.
  for (const frame of [...state.frames, state]) {
    if (frame.frame <= samples.at(-1).frame) continue;
    assert.ok(samples.length < 1024, "control observation stays bounded");
    samples.push(controlSample(frame));
  }
};

test("native finite Survival acquires a boat, drives it and restores actual browser saves", {
  timeout: 600000,
}, async (t) => {
  assert.ok(seed.length > 0 && seed.length <= 80);
  const expectedSources = await sourceHashes();
  const output = await mkdtemp(join(tmpdir(), "mineslop-boat-survival-"));
  const report = {
    status: "running", seed, url, viewport, output,
    sourceHashes: expectedSources, loadedDocuments: [],
    methodology: {
      host: "Actual VoxelGame with production canvas, styles, constructor and start defaults",
      profile: "New isolated Playwright BrowserContext; no imported storage state",
      generation: "Native v3; seed chosen only through the ordinary New World UI",
      planning: "Bounded read-only queries of already admitted actual World voxels",
      actions: "Trusted Playwright keyboard/mouse only; no state assignment or direct action calls",
      clock: "Unmodified ordinary 1200-second day",
      camera: "Actual render camera matrixWorld negative-Z forward; no player-yaw substitution",
      steering: "Driven and released A/D frames must apply canonical hull yaw once to player and camera",
      scope: "Automated acceptance; manual GUI proof is a separate parent task",
    },
    checks: [], walks: [], mining: [], crafting: [], controls: [], reloads: [], pageErrors: [],
  };
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  assert.deepEqual(await context.storageState({ indexedDB: true }), { cookies: [], origins: [] });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  const bot = new NativeSurvival(page, report, viewport);
  const observe = () => bot.read();
  const softCheck = (name, passed, evidence) => {
    // Continue gathering acquisition/reload evidence, but NEVER turn a camera
    // failure green. Every failed check fails this test at the final assertion.
    report.checks.push({ name, passed, evidence });
  };
  const ready = async () => {
    await page.waitForFunction(() => {
      const state = window.__boatSurvival?.read();
      return state?.ready || state?.error;
    }, undefined, { timeout: 70000 });
    const state = await observe();
    const served = await page.evaluate(async (files) => Object.fromEntries(await Promise.all(
      files.map(async (file) => [file,
        (await import(new URL(`../../${file}?raw`, location.href))).default])
    )), sourceFiles);
    const actual = Object.fromEntries(Object.entries(served).map(([file, text]) => [file, digest(text)]));
    assert.deepEqual(actual, expectedSources, "The browser must run the same frozen controls, crafting and observer code");
    report.loadedDocuments.push({ documentId: state.documentId, sourceHashes: actual });
    return state;
  };
  const recordControl = (name, keys, seconds, before, after, samples) => {
    appendFrames(samples, after);
    assert.ok(samples.length >= 3, "control evidence spans real advancing frames");
    const cameraDeltaError = distance(
      minus(after.camera, before.camera), minus(after.position, before.position)
    );
    const maximumSeatError = Math.max(...samples.map((sample) =>
      distance(sample.position, boatSeat(sample.boat))));
    const maximumEyeError = Math.max(...samples.map((sample) =>
      distance(sample.camera, sample.eye)));
    softCheck(`${name}: translational rider-seat and camera-eye follow`,
      maximumSeatError < 0.04 && maximumEyeError < 0.04 && cameraDeltaError < 0.04,
      { maximumSeatError, maximumEyeError, cameraDeltaError });
    report.controls.push({ name, keys, seconds, before: receipts(before), after: receipts(after), samples });
    return { before, after, samples };
  };
  const drive = async (keys, seconds, name) => {
    await bot.stage(name);
    const before = await bot.read(true);
    const samples = [controlSample(before)];
    try {
      await bot.input.setHeld(keys);
      await bot.poll(name, (state) => {
        appendFrames(samples, state);
        return state.elapsed - before.elapsed >= seconds;
      }, 18000, true);
    } finally {
      await bot.input.release();
    }
    const after = await bot.read(true);
    return recordControl(name, keys, seconds, before, after, samples);
  };
  const settleBoat = async (name, before) => {
    await bot.stage(name);
    // drive() already released every key. Reuse its exact endpoint so no
    // unobserved gap can hide a key-up/coasting discontinuity.
    const samples = [controlSample(before)];
    const after = await bot.poll("Released boat coasts to rest", (state) => {
      appendFrames(samples, state);
      return state.boats.length === 1 && speed(state.boats[0]) < 0.07 &&
        Math.abs(state.boats[0].turnVelocity) < 0.04;
    }, 20000, true);
    return recordControl(name, [], after.elapsed - before.elapsed, before, after, samples);
  };
  const saveReload = async (label, expected, seated) => {
    await bot.stage(label);
    const before = await bot.read(true);
    await bot.input.press("KeyP");
    const saved = await bot.poll("P completes a new actual browser archive write", (s) =>
      s.storageRevision !== before.storageRevision &&
      s.toast === "World saved on this device", 15000, true);
    bot.resources(expected, `${label}: P preserves finite resources`, saved);
    // "Saved" is transient while real simulation publishes new changes.
    // Inspect the actual committed IndexedDB record, not a dirty-status race.
    const committed = await page.evaluate((cells) => window.__boatSurvival.archive(cells), bot.cells);
    bot.check(`${label}: P commits a new real IndexedDB revision`,
      committed && committed.revision !== before.storageRevision &&
      Number.isFinite(committed.updatedAt), { revision: committed?.revision });
    bot.check(`${label}: committed storage contains the exact finite inventory`,
      same(ownedCounts(committed.gameplay), resourceCounts(expected)), {
        actual: ownedCounts(committed.gameplay), expected,
      });
    bot.check(`${label}: committed storage contains one boat and the intended passenger`,
      committed.boats.length === 1 &&
      committed.boats[0].passengers.includes("player") === seated);
    for (const cell of bot.cells.slice(0, -1))
      bot.check(`${label}: edited cell ${cellKey(cell)} is really stored`,
        committed.cells[cellKey(cell)] === saved.cells[cellKey(cell)]);
    if (seated)
      bot.check(`${label}: the stored player pose belongs to its stored hull seat`,
        distance(committed.player, boatSeat(committed.boats[0])) < 0.001);
    await bot.input.press("Escape");
    await bot.poll("Escape opens the real pause menu", (s) => !s.active && !s.enabled);
    await bot.input.click(".save-and-quit-button");
    await page.locator(".play-button").filter({ hasText: "Play World" }).waitFor({ state: "visible" });
    const title = await bot.poll("Save and Quit finishes", (s) =>
      !s.active && s.storageStatus === "Saved on this device");
    await page.reload({ waitUntil: "load", timeout: 70000 });
    const restored = await ready();
    bot.check(`${label}: a new document loads the real archive`, restored.documentId !== title.documentId);
    for (const field of ["seed", "generatorVersion", "dimension", "mode", "selected",
      "slots", "cursor", "offhand", "equipment", "craftingGrid", "cells"])
      bot.check(`${label}: restores ${field}`, same(restored[field], title[field]), {
        before: title[field], after: restored[field],
      });
    bot.resources(expected, `${label}: no item duplication after reload`, restored);
    bot.check(`${label}: one boat survives with the same recovery stack and passengers`,
      restored.boats.length === 1 && restored.boats[0].id === title.boats[0].id &&
      same(restored.boats[0].stack, title.boats[0].stack) &&
      same(restored.boats[0].passengers, title.boats[0].passengers), {
        before: title.boats, after: restored.boats,
      });
    bot.check(`${label}: restores the actual boat position and heading`,
      distance(restored.boats[0], title.boats[0]) < 0.02 &&
      Math.abs(angular(restored.boats[0].yaw, title.boats[0].yaw)) < 0.01, {
        before: title.boats[0], after: restored.boats[0],
      });
    bot.check(`${label}: passenger ownership restores before Play`,
      restored.seated === seated && Boolean(restored.mount) === seated, {
        seated: restored.seated, mount: restored.mount,
      });
    softCheck(`${label}: first initialized view does not snap`,
      distance(restored.position, title.position) < 0.05 &&
      distance(restored.camera, restored.eye) < 0.04 &&
      Math.abs(angular(restored.yaw, title.yaw)) < 0.015 &&
      Math.abs(restored.pitch - title.pitch) < 0.015 &&
      renderedViewMatchesPlayer(title) && renderedViewMatchesPlayer(restored) &&
      Math.abs(angular(restored.cameraYaw, title.cameraYaw)) < 0.015 &&
      Math.abs(restored.cameraPitch - title.cameraPitch) < 0.015, {
        before: { position: title.position, camera: title.camera, ...viewReceipt(title) },
        initialized: restored.initialPose,
      });
    await bot.input.click(".play-button");
    await bot.lock();
    const active = await bot.poll("First real active frame after reload", (s) => s.firstActivePose !== null, 5000, true);
    const first = active.firstActivePose;
    softCheck(`${label}: Play resumes without a first-frame pose or look jump`,
      distance(first.position, restored.position) < 0.08 &&
      distance(first.camera, first.eye) < 0.04 &&
      Math.abs(angular(first.yaw, restored.yaw)) < 0.015 &&
      Math.abs(first.pitch - restored.pitch) < 0.015 &&
      renderedViewMatchesPlayer(first) &&
      Math.abs(angular(first.cameraYaw, restored.cameraYaw)) < 0.015 &&
      Math.abs(first.cameraPitch - restored.cameraPitch) < 0.015, {
        initialized: restored.initialPose, firstActive: first,
      });
    if (seated) {
      softCheck(`${label}: restored camera starts on the actual hull seat`,
        distance(first.position, boatSeat(first.boat)) < 0.04, {
          position: first.position, expectedSeat: boatSeat(first.boat),
        });
      softCheck(`${label}: first view retains the saved free-look offset`,
        Math.abs(angular(restored.relativeViewYaw, title.relativeViewYaw)) < 0.015 &&
        Math.abs(angular(first.relativeViewYaw, title.relativeViewYaw)) < 0.015 &&
        Math.abs(angular(restored.relativeCameraYaw, title.relativeCameraYaw)) < 0.015 &&
        Math.abs(angular(first.relativeCameraYaw, title.relativeCameraYaw)) < 0.015, {
          title: viewReceipt(title), initialized: viewReceipt(restored),
          firstActive: viewReceipt(first),
        });
    }
    report.reloads.push({
      label, committed, saved: receipts(saved), title: receipts(title), restored: receipts(restored),
      firstActive: first,
    });
    return active;
  };

  try {
    await page.goto(url, { waitUntil: "load", timeout: 70000 });
    const initial = await ready();
    report.defaultInitialization = receipts(initial);
    bot.check("fresh production defaults are Survival, cedar-valley and native v3",
      initial.mode === "survival" && initial.seed === "cedar-valley" &&
      initial.generatorVersion === 3 && initial.quality === "medium" &&
      !initial.flying && !initial.allowFlight && !initial.active, {
        seed: initial.seed, mode: initial.mode, generatorVersion: initial.generatorVersion,
        quality: initial.quality, position: initial.position,
      });
    const starter = [{ id: ITEM.APPLE, count: 4 }];
    bot.resources(starter, "untouched Survival begins with only four starter apples", initial);
    bot.check("fresh context has no edits, boats or loose supplies",
      initial.edits.length === 0 && initial.boats.length === 0 &&
      initial.pickups.length === 0 && initial.overflow.length === 0);
    if (seed !== "cedar-valley") {
      await bot.stage("choose-native-seed-through-real-menu");
      await bot.input.click(".world-settings-button");
      await bot.input.click(".new-world-button");
      await bot.input.click("#world-seed");
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(seed);
      page.once("dialog", (dialog) => dialog.accept());
      await bot.input.click(".generate-button");
      await bot.poll("Ordinary new-world generation", (s) => s.ready && s.seed === seed, 70000);
    }
    await bot.input.click(".play-button");
    await bot.lock();
    await bot.input.press("Digit9"); // Actual empty hotbar selection; starter apples stay untouched.
    const native = await bot.poll("Native spawn settles", (s) => s.grounded && !s.colliding, 10000, true);
    report.nativeInitialization = receipts(native);
    bot.resources(starter, "UI-created native world still has only its starter apples", native);
    bot.check("UI-created native world has no prior edits or boats",
      native.generatorVersion === 3 && native.edits.length === 0 && native.boats.length === 0);
    const startAt = performance.now(), startClock = native.clock.day + native.clock.time;
    await bot.stage("read-only-tree-route");
    const tree = await page.evaluate(() => window.__boatSurvival.tree());
    report.tree = tree;
    bot.cells = [...tree.trunk];
    await bot.walk(tree.route, "walk-native-spawn-to-tree");
    let expected = resourceCounts(starter);
    for (const cell of tree.trunk) {
      const mined = await bot.mine(cell);
      expected = resourceCounts([...expected, { id: cell.id, count: 1 }]);
      bot.check("each naturally removed log remains owned or in a real retained drop",
        same(resourceCounts([...ownedCounts(mined), ...mined.pickups, ...mined.overflow]), expected), {
          expected, inventory: ownedCounts(mined), pickups: mined.pickups, overflow: mined.overflow,
        });
    }
    await bot.walk([tree.approach, tree.pickup], "walk-to-real-log-pickups");
    const collected = await bot.poll("Collect exactly three matching real logs", (s) =>
      same(ownedCounts(s), expected) && s.pickups.length === 0 && s.overflow.length === 0, 7000, true);
    bot.resources(expected, "three matching natural logs plus all four starter apples", collected);
    await bot.walk([tree.pickup, tree.approach], "walk-back-out-of-trunk");
    await bot.stage("read-only-shore-route");
    const shore = await page.evaluate(() => window.__boatSurvival.shore());
    report.shore = shore;
    bot.cells.push(shore.table, shore.support);
    await bot.walk(shore.route, "walk-natural-tree-to-shore");
    await bot.inventory(true);
    for (const recipe of planNaturalPlankRecipes(expected))
      expected = await bot.craft(recipe, expected);
    bot.resources([...starter, { id: tree.family.planks, count: 12 }],
      "three family logs produce exactly twelve matching planks");
    expected = await bot.craft("crafting_table", expected);
    await bot.equip(BLOCK.CRAFTING_TABLE);
    await bot.stage("place-owned-table-on-natural-shore");
    const ground = await bot.aim(shore.groundAim, shore.support);
    bot.check("table is placed against actual natural ground top", ground.target.normal.y === 1);
    await bot.tapRight();
    const table = await bot.poll("Real crafting table appears", (s) =>
      s.cells[cellKey(shore.table)] === BLOCK.CRAFTING_TABLE, 7000, true);
    expected = resourceCounts([...expected, { id: BLOCK.CRAFTING_TABLE, count: -1 }]);
    bot.resources(expected, "placing one table consumes exactly one table", table);
    bot.check("table support remains natural", table.cells[cellKey(shore.support)] === shore.support.id);
    const boatRecipe = `${tree.family.key}_boat`;
    await bot.inventory(true);
    await bot.book();
    const personal = await bot.read();
    bot.check("E is still a personal 2x2 grid beside a table",
      personal.craftingSize === 2 && personal.inventoryScreen === "inventory");
    bot.check("a boat cannot be crafted in the personal grid",
      await page.locator(`[data-recipe="${boatRecipe}"]`).isDisabled());
    await bot.inventory(false);
    await bot.aim(center(shore.table), shore.table);
    await bot.tapRight();
    await bot.poll("RMB opens the real placed 3x3 workbench", (s) =>
      s.overlayOpen && s.craftingSize === 3 && s.inventoryScreen === "crafting");
    expected = await bot.craft(boatRecipe, expected);
    bot.resources([...starter, { id: tree.family.planks, count: 3 }, { id: tree.family.boat, count: 1 }],
      "one table and one boat leave exactly three spare planks");
    await bot.equip(tree.family.boat);
    await bot.stage("place-one-owned-boat-in-natural-open-water");
    await bot.aim(shore.waterAim);
    await bot.tapRight();
    const placed = await bot.poll("One native boat is placed and rendered", (s) =>
      s.boats.length === 1 && s.renderedBoatParts > 0, 7000, true);
    expected = resourceCounts([...expected, { id: tree.family.boat, count: -1 }]);
    bot.resources(expected, "boat placement consumes exactly one owned boat", placed);
    bot.check("placement does not also mount or duplicate the item", !placed.seated && !placed.mount);
    report.placement = receipts(placed);
    const hull = placed.boats[0];
    await bot.aim({ x: hull.x, y: hull.y + 0.3, z: hull.z });
    await bot.poll("Crosshair targets the real hull", (s) => s.vehicleTarget?.id === hull.id, 5000, true);
    await bot.stage("separate-right-click-mounts-real-hull");
    await bot.tapRight();
    const mounted = await bot.poll("Player is the committed boat passenger", (s) =>
      s.seated && s.mount?.id === hull.id && s.boats[0].passengers[0] === "player", 7000, true);
    bot.resources(expected, "mounting neither consumes nor grants items", mounted);
    await bot.stage("mouse-look-remains-independent-of-hull");
    await bot.input.moveBy(-160, -40);
    const looked = await bot.poll("Native mouse changes look", (s) =>
      Math.abs(angular(s.yaw, mounted.yaw)) > 0.2 && renderedViewMatchesPlayer(s), 5000, true);
    bot.check("native mouse look never steers the boat",
      Math.abs(angular(looked.boats[0].yaw, mounted.boats[0].yaw)) < 0.003, {
        viewDelta: angular(looked.yaw, mounted.yaw),
        hullDelta: angular(looked.boats[0].yaw, mounted.boats[0].yaw),
      });
    softCheck("native mouse changes actual camera yaw/pitch and free-look offset",
      Math.abs(angular(looked.cameraYaw, mounted.cameraYaw) -
        angular(looked.yaw, mounted.yaw)) < YAW_TOLERANCE &&
      Math.abs((looked.cameraPitch - mounted.cameraPitch) -
        (looked.pitch - mounted.pitch)) < YAW_TOLERANCE &&
      Math.abs(angular(looked.relativeViewYaw, mounted.relativeViewYaw)) > 0.2 &&
      Math.abs(looked.pitch - mounted.pitch) > 0.04, {
        before: viewReceipt(mounted), after: viewReceipt(looked),
      });
    report.mouseLook = { before: receipts(mounted), after: receipts(looked) };
    const forward = await drive(["KeyW"], 1.1, "W-propels-hull-forward");
    bot.check("W moves the actual hull several blocks",
      horizontal(forward.before.boats[0], forward.after.boats[0]) > 2, {
        distance: horizontal(forward.before.boats[0], forward.after.boats[0]),
      });
    await settleBoat("W-released-coasting", forward.after);
    const reverse = await drive(["KeyS"], 1.1, "S-propels-hull-backward");
    const heading = reverse.before.boats[0].yaw;
    const displacement = minus(reverse.after.boats[0], reverse.before.boats[0]);
    bot.check("S reverses relative to hull heading",
      displacement.x * -Math.sin(heading) + displacement.z * -Math.cos(heading) < -0.8);
    await settleBoat("S-released-coasting", reverse.after);
    for (const [key, sign] of [["KeyA", 1], ["KeyD", -1]]) {
      const turn = await drive([key], 0.55, `${key}-steers-hull-and-view-once`);
      const driven = turnFollowEvidence(turn.samples, {
        direction: sign, minimumHullTurn: DRIVEN_HULL_TURN,
      });
      softCheck(`${key}: nonzero hull yaw follows once in player/rendered view, preserving offset/pitch`,
        driven.passed, driven);
      const coast = await settleBoat(`${key}-released-coasting`, turn.after);
      const released = turnFollowEvidence(coast.samples, {
        direction: sign, minimumHullTurn: COAST_HULL_TURN,
      });
      softCheck(`${key}: released hull rotation still follows once, preserving offset/pitch`,
        released.passed, released);
    }
    const seated = await bot.read(true);
    await bot.input.press("Space");
    await bot.input.press("ControlLeft");
    const safe = await bot.read(true);
    bot.check("seated jump/sprint keys cannot enable flight or leave the seat",
      safe.seated && !safe.flying && !safe.allowFlight &&
      distance(safe.position, seated.position) < 0.08);
    await saveReload("seated-save-quit-reload-play", expected, true);
    await bot.stage("shift-dismounts-with-a-safe-physical-exit");
    await bot.input.down("ShiftLeft");
    let exited;
    try {
      exited = await bot.poll("Shift releases the committed passenger", (s) => !s.seated && !s.mount, 7000, true);
    } finally {
      await bot.input.up("ShiftLeft");
    }
    bot.check("dismount keeps one intact unoccupied boat and a clear live player",
      exited.boats.length === 1 && exited.boats[0].passengers.every((value) => value === null) &&
      !exited.colliding && !exited.dead && exited.air >= 18, {
        position: exited.position, boat: exited.boats[0], air: exited.air, colliding: exited.colliding,
      });
    await bot.poll("Safe exit settles on ground or at the water surface", (s) =>
      !s.colliding && (s.grounded || s.fluid.waterImmersion > 0) &&
      Math.abs(s.velocity.y) < 0.2, 10000, true);
    const final = await saveReload("dismounted-save-quit-reload-play", expected, false);
    bot.resources([...starter, { id: tree.family.planks, count: 3 }],
      "final archive preserves four apples and exactly three spare planks", final);
    bot.check("final resources have no loose or overflow duplicates",
      final.pickups.length === 0 && final.overflow.length === 0);
    bot.check("only three natural log removals and one table placement were authored",
      final.edits.length === 4 && tree.trunk.every((cell) => final.cells[cellKey(cell)] === BLOCK.AIR) &&
      final.cells[cellKey(shore.table)] === BLOCK.CRAFTING_TABLE);
    const simulatedSeconds = (final.clock.day + final.clock.time - startClock) * 1200;
    const wallSeconds = (performance.now() - startAt) / 1000;
    bot.check("ordinary world time advances without a speed-up or clock rewrite",
      final.clock.daySeconds === 1200 && simulatedSeconds > 0 && simulatedSeconds <= wallSeconds + 0.25,
      { simulatedSeconds, wallSeconds });
    bot.check("every observed document receives only trusted browser inputs",
      [report.reloads[0].title.inputs, report.reloads[1].title.inputs, final.inputs]
        .every((inputs) => inputs.trusted > 0 && inputs.untrusted === 0));
    bot.check("actual game reports no browser runtime exceptions", report.pageErrors.length === 0, report.pageErrors);
    const failures = report.checks.filter((check) => !check.passed);
    assert.deepEqual(failures, [], "strict camera-follow/reload expectations must all pass");
    assert.deepEqual(await sourceHashes(), expectedSources, "Source must not change during native acceptance");
    report.final = receipts(final);
    report.status = "passed";
    await page.screenshot({ path: join(output, "native-survival-restored.png") });
    console.log("PASS: native acquisition 3 logs → 12 planks → table + boat + 3 spare; once-only driven/coasting hull-player-camera yaw; independent mouse look; seated and dismounted browser reloads.");
  } catch (error) {
    report.status = "failed";
    report.failure = { phase: bot.phase, message: error.message, stack: error.stack };
    report.lastObserved = bot.last;
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    await bot.input.release().catch(() => {});
    await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native Survival report: ${join(output, "report.json")}`);
  }
});
