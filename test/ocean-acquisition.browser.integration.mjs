import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium } from "playwright";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { RealInputs } from "./realtime/input.mjs";
import { chromeExecutable } from "./realtime/config.mjs";
import { survivalAim } from "./realtime/survival.mjs";

// UI creation, chest use, mining, transfer, selection and saving use observed
// real browser input. Bounded locator discovery and long-distance Game teleport
// are privileged harness acceleration and are counted separately in receipts.
const SEED = "beached-map-640";
const viewport = { width: 1100, height: 760 };
const base = new URL(
  process.env.VOXELCRAFT_TEST_URL ?? "http://127.0.0.1:5173/mineslop/"
);
const url = new URL("test/ocean-acquisition/index.html", base).href;
const key = ({ x, y, z }) => `${x},${y},${z}`;
const center = ({ x, y, z }) => ({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
const angular = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

test("real UI acquires finite v7 shipwreck map and natural buried treasure across a cold reload", {
  timeout: 240000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const input = new RealInputs(page, { viewport, timeoutMs: 12000 });
  const read = () => page.evaluate(() => window.__oceanAcceptance.read());
  const poll = async (label, predicate, timeout = 15000) => {
    const until = performance.now() + timeout;
    let state;
    do {
      state = await read();
      if (state.error) throw new Error(state.error);
      if (predicate(state)) return state;
      await delay(35);
    } while (performance.now() < until);
    throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
  };
  const ready = async () => {
    await page.waitForFunction(
      () => window.__oceanAcceptance?.read().ready ||
        window.__oceanAcceptance?.read().error,
      undefined,
      { timeout: 70000 }
    );
    return poll("Game ready", (state) => state.ready);
  };
  const play = async () => {
    await input.click(".play-button");
    let state = await poll("Active game", (value) => value.active);
    if (!state.locked) {
      await delay(1100);
      await input.click("#game canvas");
      state = await poll("Pointer lock", (value) => value.active && value.locked);
    }
    return state;
  };
  const travel = async (which) => {
    await input.release();
    const result = await page.evaluate((name) =>
      window.__oceanAcceptance.travel(name), which);
    assert.equal(result.ok, true, result.message);
    await poll(`${which} travel menu`, (state) => state.paused && !state.active);
    return play();
  };
  const aim = async (point, expected) => {
    for (let attempts = 0; attempts < 300; attempts++) {
      const state = await read();
      if (
        state.target &&
        key(state.target) === key(expected) &&
        Math.abs(angular(survivalAim(state, point).yaw, state.yaw)) < 0.02
      )
        return state;
      const wanted = survivalAim(state, point);
      const dyaw = angular(wanted.yaw, state.yaw);
      const dpitch = wanted.pitch - state.pitch;
      if (Math.abs(dyaw) > 0.35 || Math.abs(dpitch) > 0.3) {
        await input.setHeld([
          ...(Math.abs(dyaw) > 0.35
            ? [dyaw > 0 ? "ArrowLeft" : "ArrowRight"]
            : []),
          ...(Math.abs(dpitch) > 0.3
            ? [dpitch > 0 ? "ArrowUp" : "ArrowDown"]
            : []),
        ]);
        await delay(25);
        await input.setHeld([]);
      } else {
        await input.steer(state, wanted.yaw, wanted.pitch);
        await delay(20);
      }
    }
    assert.fail(`Could not aim at ${key(expected)} from ${JSON.stringify(await read())}`);
  };
  const openContainer = async (marker) => {
    await aim(center(marker.position), marker.position);
    await input.mouseDown("right");
    await input.mouseUp("right");
    return poll("Natural container UI opens", (state) => state.containerOpen);
  };
  const transferAll = async () => {
    let moved = 0;
    while (true) {
      const slot = page.locator(
        '.settlement-chest [data-area="container"]:not([data-item="0"])'
      ).first();
      if (!(await slot.count())) break;
      await slot.click({ modifiers: ["Shift"] });
      moved++;
      assert.ok(moved <= 27);
    }
    assert.ok(moved > 0);
    return poll("Finite container transfer", (state) =>
      state.containerSlots.every((stack) => stack === null));
  };

  await page.goto(url, { waitUntil: "load", timeout: 70000 });
  const initial = await ready();
  assert.equal(initial.generatorVersion, 3);
  assert.equal(initial.mode, "survival");
  await input.click(".world-settings-button");
  await input.click(".new-world-button");
  await input.click("#world-seed");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(SEED);
  await page.locator("#world-generation").selectOption("7");
  page.once("dialog", (dialog) => dialog.accept());
  await input.click(".generate-button");
  const expanded = await poll(
    "Expanded v7 world created through UI",
    (state) => state.seed === SEED && state.generatorVersion === 7,
    70000
  );
  assert.equal(expanded.mode, "survival");
  assert.equal(expanded.routeAvailable, false);
  assert.deepEqual(expanded.privilegedActions, []);
  const route = await page.evaluate(() => window.__oceanAcceptance.discover());
  assert.equal(route.shipwreck.variant.startsWith("beached_"), true);
  assert.equal(route.chart.position.x, -262);
  assert.equal(route.chart.position.y, 69);
  assert.equal(route.chart.position.z, -93);
  assert.equal(route.mapped.id, route.treasure.id);
  assert.deepEqual(route.mapped.position, route.treasure.marker.position);

  await travel("chart");
  const openedChart = await openContainer(route.chart);
  assert.ok(openedChart.containerSlots.some((stack) => stack?.id === ITEM.TREASURE_MAP));
  const chartLoot = structuredClone(openedChart.containerSlots.filter(Boolean));
  const mapContainerIndex = openedChart.containerSlots.findIndex(
    (stack) => stack?.id === ITEM.TREASURE_MAP
  );
  const mapContainerSlot = page.locator(
    `.settlement-chest [data-area="container"][data-index="${mapContainerIndex}"]`
  );
  await mapContainerSlot.focus();
  await page.keyboard.press("Digit2");
  await poll("Map moves through the real slot UI to hotbar 2", (state) =>
    state.slots[1]?.id === ITEM.TREASURE_MAP);
  const mapped = await transferAll();
  assert.equal(mapped.mapCount, 1);
  await input.press("Escape");
  await poll("Chart closes", (state) => !state.containerOpen);
  const mapSlot = (await read()).slots.findIndex(
    (stack) => stack?.id === ITEM.TREASURE_MAP
  );
  assert.ok(mapSlot >= 0 && mapSlot < 9);
  await input.press(`Digit${mapSlot + 1}`);
  const guidance = await poll(
    "Selected map HUD appears",
    (state) => state.mapGuidanceVisible
  );
  assert.match(guidance.mapGuidance, /Treasure map/);
  assert.match(guidance.mapGuidance, /target -282, 60, 62/);
  assert.deepEqual(guidance.mapAnnouncements, [guidance.mapGuidance]);
  await input.press("Digit1");
  const deselected = await poll(
    "Deselect clears map guidance and its live region",
    (state) =>
      !state.mapGuidanceVisible &&
      state.mapAnnouncements.at(-1) === ""
  );
  assert.deepEqual(deselected.mapAnnouncements, [guidance.mapGuidance, ""]);
  await input.press("Digit2");
  const reselected = await poll(
    "Reselecting the same map announces it again",
    (state) =>
      state.mapGuidanceVisible &&
      state.mapAnnouncements.length === 3
  );
  assert.deepEqual(reselected.mapAnnouncements, [
    guidance.mapGuidance,
    "",
    guidance.mapGuidance,
  ]);
  const visibleBeforeProbe = reselected.mapVisibleUpdates.length;
  const probed = await page.evaluate(() =>
    window.__oceanAcceptance.probeGuidance([
      { x: -261, y: 69, z: -93 },
      { x: -260, y: 69, z: -93 },
    ])
  );
  assert.ok(
    probed.mapVisibleUpdates.length >= visibleBeforeProbe + 2,
    "controlled same-milestone positions rewrite visible distances"
  );
  assert.deepEqual(
    probed.mapAnnouncements,
    reselected.mapAnnouncements,
    "same cardinal milestone never rewrites the live region"
  );

  await travel("treasure");
  for (const cover of route.treasure.cover) {
    await aim(center(cover), cover);
    await input.mouseDown("left");
    await poll(
      `Mine natural cover ${key(cover)}`,
      (state) => state.cells[key(cover)] === BLOCK.AIR,
      12000
    );
    await input.mouseUp("left");
  }
  const openedTreasure = await openContainer(route.treasure.marker);
  assert.equal(
    openedTreasure.containerSlots
      .filter((stack) => stack?.id === ITEM.HEART_OF_THE_SEA)
      .reduce((total, stack) => total + stack.count, 0),
    1
  );
  const treasureLoot = structuredClone(
    openedTreasure.containerSlots.filter(Boolean)
  );
  const acquired = await transferAll();
  assert.equal(acquired.heartCount, 1);
  assert.equal(acquired.mapCount, 1);
  const reachedAnnouncement =
    "Treasure map · target reached · target -282, 60, 62";
  assert.deepEqual(acquired.mapAnnouncements, [
    guidance.mapGuidance,
    "",
    guidance.mapGuidance,
    reachedAnnouncement,
  ]);
  await input.press("Escape");
  await poll("Treasure closes", (state) => !state.containerOpen);

  const beforeSave = await read();
  await input.press("KeyP");
  const saved = await poll(
    "Actual IndexedDB save commits",
    (state) => state.storageRevision !== beforeSave.storageRevision &&
      state.storageStatus === "Saved on this device"
  );
  assert.deepEqual(saved.privilegedActions, [
    { sequence: 1, type: "locator-discover" },
    { sequence: 2, type: "game-teleport:chart" },
    { sequence: 3, type: "hud-position-probe" },
    { sequence: 4, type: "game-teleport:treasure" },
  ]);
  const oldDocument = beforeSave.documentId;
  await page.reload({ waitUntil: "load", timeout: 70000 });
  const restored = await ready();
  assert.notEqual(restored.documentId, oldDocument);
  assert.equal(restored.generatorVersion, 7);
  assert.equal(restored.mapCount, 1);
  assert.equal(restored.heartCount, 1);
  assert.equal(restored.claims.length, 2);
  assert.equal(restored.routeAvailable, false);
  assert.deepEqual(restored.privilegedActions, []);
  const restoredRoute = await page.evaluate(() =>
    window.__oceanAcceptance.discover()
  );
  assert.deepEqual(restoredRoute, route);

  await travel("treasure");
  const reopenedTreasure = await openContainer(route.treasure.marker);
  assert.ok(reopenedTreasure.containerSlots.every((stack) => stack === null));
  assert.equal(reopenedTreasure.mapCount, 1);
  assert.equal(reopenedTreasure.heartCount, 1);
  await input.press("Escape");

  await travel("chart");
  const reopenedChart = await openContainer(route.chart);
  assert.ok(reopenedChart.containerSlots.every((stack) => stack === null));
  assert.equal(reopenedChart.mapCount, 1);
  assert.equal(reopenedChart.heartCount, 1);
  assert.equal(reopenedChart.claims.length, 2);
  assert.equal(reopenedChart.observedDomInputs.untrusted, 0);
  assert.ok(reopenedChart.observedDomInputs.trusted > 0);
  assert.deepEqual(reopenedChart.privilegedActions, [
    { sequence: 1, type: "locator-discover" },
    { sequence: 2, type: "game-teleport:treasure" },
    { sequence: 3, type: "game-teleport:chart" },
  ]);
  const privilegedActions = [
    ...saved.privilegedActions,
    ...reopenedChart.privilegedActions,
  ];
  assert.equal(privilegedActions.length, 7);
  assert.deepEqual(errors, []);
  if (process.env.OCEAN_ACCEPTANCE_SCREENSHOT)
    await page.screenshot({
      path: process.env.OCEAN_ACCEPTANCE_SCREENSHOT,
      fullPage: true,
    });

  t.diagnostic(
    JSON.stringify({
      seed: SEED,
      generatorVersion: 7,
      shipwreck: route.shipwreck.id,
      chart: route.chart.position,
      mapTarget: route.mapped,
      treasure: route.treasure.id,
      chartLoot,
      treasureLoot,
      claims: reopenedChart.claims.length,
      controlAccounting: {
        observedRealDomInputs: {
          firstDocument: saved.observedDomInputs,
          coldReloadDocument: reopenedChart.observedDomInputs,
        },
        privilegedHarnessActions: {
          firstDocument: saved.privilegedActions,
          coldReloadDocument: reopenedChart.privilegedActions,
        },
        privilegedHarnessActionCount: privilegedActions.length,
      },
      accessibility: {
        firstDocumentAnnouncements: saved.mapAnnouncements,
        coldReloadDocumentAnnouncements: reopenedChart.mapAnnouncements,
      },
    })
  );
});
