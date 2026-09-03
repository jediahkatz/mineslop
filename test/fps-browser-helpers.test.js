import assert from "node:assert/strict";
import test from "node:test";
import { readFpsPixelRatio } from "./fps-browser-fixture.mjs";
import { completedFpsImport } from "./fps-import-completion.mjs";

const controls = [
  ".save-button",
  ".export-button",
  ".import-button",
  ".import-file",
  ".play-button",
  ".menu-back-button",
  ".generate-button",
  ".new-world-button",
];

function importFixture() {
  const previousWorld = {
    seed: "cedar-valley",
    dimension: "overworld",
    generatorVersion: 3,
  };
  const storage = {
    revision: "committed-import-revision",
    hydrated: true,
    database: {},
  };
  const game = {
    // Same portable metadata, different World object, just like the real probe.
    world: { ...previousWorld },
    storage,
    storageStatus: "Saved on this device",
    saveErrorReported: false,
    failed: false,
    building: false,
    transitionGate: { busy: false },
    closingScreens: false,
    screenClose: null,
    playing: false,
    started: true,
    paused: true,
    overlayOpen: false,
  };
  const before = {
    game,
    world: previousWorld,
    storage,
    revision: "before-import-revision",
  };
  const status = {
    dataset: { state: "idle" },
    textContent: "Saved on this device",
  };
  const menu = {
    hidden: false,
    busy: "false",
    getAttribute(name) {
      return name === "aria-busy" ? this.busy : null;
    },
  };
  const loading = { hidden: true };
  const nodes = new Map([
    [".storage-status", status],
    [".menu-screen", menu],
    [".loading-screen", loading],
    ...controls.map((selector) => [selector, { disabled: false }]),
  ]);
  const environment = {
    game,
    hostError: null,
    root: { querySelector: (selector) => nodes.get(selector) ?? null },
  };
  return {
    before,
    game,
    storage,
    status,
    menu,
    loading,
    nodes,
    environment,
    read: () => completedFpsImport(before, environment),
  };
}

test("a committed import completes at saved/idle without observing its transient label", () => {
  const f = importFixture();
  assert.deepEqual(f.read(), {
    sameGame: true,
    sameStorage: true,
    worldReplaced: true,
    revisionChanged: true,
    storageReady: true,
    gatesIdle: true,
    controlsEnabled: true,
    saveSucceeded: true,
    errorFree: true,
    modelStatus: "Saved on this device",
    saveErrorReported: false,
    uiState: "idle",
    uiText: "Saved on this device",
  });
});

test("completion stays true when imported/success becomes saved/idle", () => {
  const f = importFixture();
  f.status.dataset.state = "success";
  f.status.textContent = "World imported";
  // The probe first saw the message while transition ownership was still held.
  f.game.transitionGate.busy = true;
  assert.equal(f.read(), false);
  f.game.transitionGate.busy = false;
  assert.equal(f.read().uiState, "success");
  f.status.dataset.state = "idle";
  f.status.textContent = "Saved on this device";
  assert.equal(f.read().uiState, "idle");
});

test("an old World, stale revision or unavailable storage cannot count as import success", () => {
  for (const [name, change] of [
    ["unchanged World", (f) => (f.game.world = f.before.world)],
    ["no replacement World", (f) => (f.game.world = null)],
    ["no prior World", (f) => (f.before.world = null)],
    ["different game", (f) => (f.environment.game = { ...f.game })],
    ["different storage owner", (f) => (f.game.storage = { ...f.storage })],
    ["unchanged revision", (f) => (f.storage.revision = f.before.revision)],
    ["missing revision", (f) => (f.storage.revision = null)],
    ["empty revision", (f) => (f.storage.revision = "")],
    ["no revision baseline", (f) => (f.before.revision = null)],
    ["storage not hydrated", (f) => (f.storage.hydrated = false)],
    ["database unavailable", (f) => (f.storage.database = null)],
  ]) {
    const f = importFixture();
    change(f);
    assert.equal(f.read(), false, name);
  }
});

test("every pending gate still blocks a new revision and saved/idle status", () => {
  for (const [name, change] of [
    ["building", (f) => (f.game.building = true)],
    ["transition busy", (f) => (f.game.transitionGate.busy = true)],
    ["missing transition gate", (f) => (f.game.transitionGate = null)],
    ["closing screens", (f) => (f.game.closingScreens = true)],
    ["screen close pending", (f) => (f.game.screenClose = {})],
    ["play pending", (f) => (f.game.playing = true)],
    ["not started", (f) => (f.game.started = false)],
    ["unpaused", (f) => (f.game.paused = false)],
    ["overlay open", (f) => (f.game.overlayOpen = true)],
    ["menu busy", (f) => (f.menu.busy = "true")],
    ["menu hidden", (f) => (f.menu.hidden = true)],
    ["loading visible", (f) => (f.loading.hidden = false)],
  ]) {
    const f = importFixture();
    change(f);
    assert.equal(f.read(), false, name);
  }
  for (const selector of controls) {
    const f = importFixture();
    f.nodes.get(selector).disabled = true;
    assert.equal(f.read(), false, `${selector} still disabled`);
  }
});

test("missing status, gates or controls are not a successful terminal UI", () => {
  for (const selector of [
    ".storage-status",
    ".menu-screen",
    ".loading-screen",
    ...controls,
  ]) {
    const f = importFixture();
    f.nodes.delete(selector);
    assert.equal(f.read(), false, `${selector} missing`);
  }
});

test("a checkpoint revision or stale success label cannot hide failed or pending saves", () => {
  for (const [name, change] of [
    ["save pending", (f) => (f.game.storageStatus = "Saving…")],
    ["unsaved replacement", (f) => (f.game.storageStatus = "Unsaved changes")],
    [
      "storage unavailable",
      (f) => (f.game.storageStatus = "Export to keep your progress"),
    ],
    [
      "save failed after the pre-import checkpoint",
      (f) => {
        f.storage.revision = "committed-checkpoint-revision";
        f.game.saveErrorReported = true;
      },
    ],
    [
      "stale final write",
      (f) => {
        f.storage.revision = f.before.revision;
        f.game.saveErrorReported = true;
        f.status.dataset.state = "error";
        f.status.textContent = "STALE_WORLD";
      },
    ],
    [
      "imported label with failed save",
      (f) => {
        f.status.dataset.state = "success";
        f.status.textContent = "World imported";
        f.game.saveErrorReported = true;
      },
    ],
    ["UI error with saved text", (f) => (f.status.dataset.state = "error")],
    ["UI busy with saved text", (f) => (f.status.dataset.state = "busy")],
    ["UI idle but unsaved", (f) => (f.status.textContent = "Unsaved changes")],
    [
      "unrelated export success",
      (f) => {
        f.status.dataset.state = "success";
        f.status.textContent = "World exported. Keep this file as a backup.";
      },
    ],
    ["failed game", (f) => (f.game.failed = true)],
    ["host error", (f) => (f.environment.hostError = "fixture failed")],
  ]) {
    const f = importFixture();
    change(f);
    assert.equal(f.read(), false, name);
  }
});

test("FPS resolution defaults to adaptive and accepts the realtime driver's bounded override", () => {
  assert.equal(readFpsPixelRatio(undefined), null);
  for (const [value, expected] of [
    ["0.4", 0.4],
    ["0.5", 0.5],
    [" 1 ", 1],
    ["2", 2],
  ])
    assert.equal(readFpsPixelRatio(value), expected);
});

test("invalid FPS resolution options fail before any browser is needed", () => {
  for (const value of [
    "",
    " ",
    "0",
    "-1",
    "0.3999",
    "2.0001",
    "NaN",
    "Infinity",
    "-Infinity",
    "0.5px",
    null,
    true,
    0.5,
  ])
    assert.throws(
      () => readFpsPixelRatio(value),
      /VOXELCRAFT_FPS_PIXEL_RATIO.*0\.4.*2/,
      String(value)
    );
});
