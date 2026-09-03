import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { BLOCK } from "../src/blocks.js";
import {
  loadControlPreferences,
  normalizeControlPreferences,
} from "../src/control-preferences.js";
import { VoxelGame } from "../src/game.js";
import { FrameRate } from "../src/frame-rate.js";
import { bindGameControls } from "../src/game-controls.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { controlFixture, dispatch, InputElement } from "./control-fixture.js";
import { InteractionWorld } from "./interaction-fixture.js";

function fixture(t, preferences = { inputMode: "remote" }) {
  const f = controlFixture(t, preferences);
  const previous = {};
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  for (const [key, value] of Object.entries({
    document: f.document,
    window: f.window,
    HTMLElement: InputElement,
    localStorage: storage,
  })) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  t.after(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  const container = new InputElement(f.document);
  container.children.push(f.element);
  const world = new InteractionWorld({ floor: 0 });
  world.getSpawn = () => ({ x: 0.5, y: 1, z: 0.5 });
  f.world = world;
  f.player.world = world;
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    container,
    player: f.player,
    world,
    coordinator: world.coordinator,
    worldContext: world.context,
    controlPreferences: normalizeControlPreferences(preferences),
    graphics: { camera: f.camera, resize() {} },
    gameplay: new Gameplay({
      mode: "creative",
      coordinator: world.coordinator,
      context: world.context,
    }),
    effects: { unlockAudio() {}, select() {} },
    containerUI: { close() {} },
    paused: false,
    started: true,
    building: false,
    overlayOpen: false,
    heldAction: null,
    miningProgress: 0,
    target: { id: BLOCK.STONE },
    primaryCalls: 0,
    primaryArguments: [],
    secondaryCalls: 0,
    useBegins: [],
    useEnds: [],
    targetUpdates: 0,
    selectedSlots: [],
    swaps: 0,
    droppedStacks: [],
    picks: 0,
    perspectives: 0,
    teleports: 0,
    meals: 0,
    saves: 0,
    primary(...args) {
      this.primaryCalls++;
      this.primaryArguments.push(args);
    },
    secondary() {
      this.secondaryCalls++;
    },
    useActions: {
      held: false,
      source: null,
      resets: 0,
      reset() {
        this.held = false;
        this.source = null;
        this.resets++;
      },
    },
    beginUse(source = "mouse") {
      this.useBegins.push(source);
      this.useActions.held = true;
      this.useActions.source = source;
    },
    endUse(source = "mouse", cancel = false) {
      this.useEnds.push({ source, cancel });
      if (this.useActions.source === source) {
        this.useActions.held = false;
        this.useActions.source = null;
      }
    },
    updateTarget() {
      this.targetUpdates++;
    },
    select(index) {
      this.selectedSlots.push(index);
    },
    swapHands() {
      this.swaps++;
    },
    dropSelected(wholeStack) {
      this.droppedStacks.push(wholeStack);
    },
    pickBlock() {
      this.picks++;
    },
    cyclePerspective() {
      this.perspectives++;
      return this.player.cyclePerspective();
    },
    teleport() {
      this.teleports++;
    },
    eat() {
      this.meals++;
    },
    scheduleSave() {},
    refreshHud() {},
    save() {
      this.saves++;
      return Promise.resolve({ ok: true });
    },
  });
  game.ui = {
    inventory: false,
    menu: false,
    menuPage: "main",
    hud: true,
    debug: false,
    atlasToggles: 0,
    snapshots: [],
    get isMenuOpen() {
      return this.menu;
    },
    get isOverlayOpen() {
      return this.inventory;
    },
    toggleInventory() {
      this.inventory = !this.inventory;
      game.overlayChanged(this.inventory);
    },
    closeInventory() {
      if (this.inventory) this.toggleInventory();
    },
    closeAtlas() {},
    toggleAtlas() {
      this.atlasToggles++;
    },
    toggleHud() {
      this.hud = !this.hud;
    },
    toggleDebug() {
      this.debug = !this.debug;
    },
    hideMenu() {
      this.menu = false;
    },
    showMenu() {
      this.menu = true;
      this.menuPage = "main";
    },
    update(value) {
      this.snapshots.push(value);
    },
    toast() {},
  };
  f.document.querySelector = (selector) =>
    selector === ".menu-screen"
      ? { dataset: { page: game.ui.menuPage }, hidden: !game.ui.menu }
      : null;
  f.player.onInputReset = () => game.resetActions();
  const unbind = bindGameControls(game);
  t.after(unbind);
  t.after(() => game.gameplay.dispose());
  const down = (button, x = 100, y = 100, extra = {}) =>
    dispatch(
      container,
      "mousedown",
      f.event(x, y, {
        button,
        buttons: button === 2 ? 2 : button === 1 ? 4 : 1,
        ...extra,
      })
    );
  const move = (x, y = 100, extra = {}) =>
    dispatch(f.document, "mousemove", f.event(x, y, extra));
  const up = (button, x = 100, y = 100, extra = {}) =>
    dispatch(
      f.document,
      "mouseup",
      f.event(x, y, {
        button,
        buttons: 0,
        timeStamp: 100,
        ...extra,
      })
    );
  const key = (code, extra = {}) =>
    dispatch(f.document, "keydown", {
      code,
      key: code === "Escape" ? code : "",
      target: f.element,
      ...extra,
    });
  return { ...f, game, storage, down, move, up, key };
}

function actualBowUse(f) {
  const { game } = f;
  game.gameplay.setMode("survival");
  const bow = {
    id: ITEM.BOW,
    count: 1,
    durability: 20,
    data: { version: 1, name: "<control bow>" },
  };
  assert.equal(
    game.gameplay.inventoryTransaction((owned) => {
      owned.slots.fill(null);
      owned.slots[0] = bow;
      owned.slots[1] = { ...bow };
      owned.slots[9] = { id: ITEM.ARROW, count: 2 };
      return true;
    }),
    true
  );
  game.target = null;
  game.mobTarget = null;
  game.elapsed = 10;
  game.wildlife = { endSpawnProtection() {} };
  game.effects.sound = () => {};
  game.ui.setSelected = () => {};
  game.useActions = new GameUseActions(game);
  for (const method of ["beginUse", "endUse", "select"])
    game[method] = VoxelGame.prototype[method];
  return bow;
}

for (const inputMode of ["native", "remote"]) {
  test(`${inputMode} real control release commits named bow wear and ammo once`, async (t) => {
    const f = fixture(t, { inputMode });
    const bow = actualBowUse(f);
    let shots = 0,
      changes = 0;
    f.game.effects.shoot = () => shots++;
    f.game.gameplay.onChange = () => changes++;
    if (inputMode === "native") {
      await f.player.lock();
      f.down(2);
    } else f.key("KeyV");
    for (let index = 0; index < 4; index++) f.game.useActions.update(0.25);
    assert.equal(f.game.gameplay.countPlain(ITEM.ARROW), 2);
    if (inputMode === "native") f.up(2);
    else dispatch(f.document, "keyup", { code: "KeyV" });
    assert.deepEqual(f.game.gameplay.getHandStack(), {
      ...bow,
      durability: 19,
    });
    assert.equal(f.game.gameplay.countPlain(ITEM.ARROW), 1);
    assert.equal(shots, 1);
    assert.equal(changes, 1);
    if (inputMode === "native") f.up(2);
    else dispatch(f.document, "keyup", { code: "KeyV" });
    assert.equal(shots, 1);
    assert.equal(changes, 1);
  });

  for (const replacement of ["same-copy", "selection"]) {
    test(`${inputMode} real release rejects ${replacement} while charged before any costs`, async (t) => {
      const f = fixture(t, { inputMode });
      actualBowUse(f);
      let shots = 0;
      f.game.effects.shoot = () => shots++;
      if (inputMode === "native") {
        await f.player.lock();
        f.down(2);
      } else f.key("KeyV");
      for (let index = 0; index < 4; index++) f.game.useActions.update(0.25);
      if (replacement === "selection") f.key("Digit2");
      else
        assert.equal(
          f.game.gameplay.inventoryTransaction((owned) => {
            owned.slots[0] = { ...owned.slots[0] };
            return true;
          }),
          true
        );
      const before = f.game.gameplay.serialize();
      if (inputMode === "native") f.up(2);
      else dispatch(f.document, "keyup", { code: "KeyV" });
      assert.deepEqual(f.game.gameplay.serialize(), before);
      assert.equal(shots, 0);
      assert.equal(f.game.gameplay.countPlain(ITEM.ARROW), 2);
    });
  }
}

test("Remote play stays active without lock; WASD, inventory, Escape and resume reset input", async (t) => {
  const f = fixture(t);
  const { game, player } = f;
  await game.play();
  assert.equal(game.active, true);
  assert.equal(player.locked, false);
  assert.deepEqual(f.calls, []);
  dispatch(f.document, "pointerlockchange");
  assert.equal(
    game.paused,
    false,
    "uncaptured Remote is not a lost native lock"
  );
  f.key("KeyW");
  const z = player.position.z;
  for (let i = 0; i < 10; i++) player.update(1 / 60);
  assert.ok(player.position.z < z);
  f.down(0);
  f.down(2, 200);
  f.key("KeyE");
  assert.equal(game.overlayOpen, true);
  assert.equal(player.enabled, false);
  assert.equal(player._keys.size, 0);
  assert.equal(game.heldAction, null);
  const yaw = player.yaw;
  f.move(900);
  f.up(2, 900);
  assert.equal(player.yaw, yaw);
  assert.equal(game.secondaryCalls, 0);
  f.key("KeyE");
  await flush();
  assert.equal(game.active, true);
  assert.equal(player.enabled, true);
  assert.equal(player.locked, false);
  f.move(800);
  assert.equal(
    player.yaw,
    yaw,
    "closing inventory does not revive a held drag"
  );
  f.key("Escape");
  assert.equal(game.paused, true);
  assert.equal(player.enabled, false);
  await flush();
  await game.play();
  assert.equal(game.active, true);
  assert.equal(player._keys.size, 0);
  assert.deepEqual(f.calls, []);
});

test("RMB drag never places or repeats; short tap places once and long hold/release over UI do not", (t) => {
  const f = fixture(t);
  f.down(2);
  assert.equal(f.game.heldAction, null);
  assert.equal(f.game.secondaryCalls, 0);
  for (let x = 102; x <= 500; x += 2) f.move(x);
  assert.ok(Math.abs(f.player.yaw + 0.8) < 1e-10);
  f.up(2, 500);
  assert.equal(f.game.secondaryCalls, 0);
  f.down(2, 200);
  f.move(201);
  f.up(2, 201);
  assert.equal(f.game.secondaryCalls, 1);
  assert.equal(f.game.heldAction, null);
  f.down(2, 200);
  f.up(2, 200, 100, { timeStamp: 1000 });
  f.down(2, 200);
  f.up(2, 200, 100, { target: new InputElement(f.document) });
  assert.equal(f.game.secondaryCalls, 1);
});

test("LMB mining and RMB look coexist in both press/release orders", (t) => {
  const f = fixture(t);
  f.down(0);
  assert.equal(f.game.primaryCalls, 1);
  f.down(2, 100, 100, { buttons: 3 });
  f.move(150, 100, { buttons: 3 });
  assert.equal(f.game.heldAction, "mine");
  f.up(2, 150, 100, { buttons: 1 });
  assert.equal(
    f.game.heldAction,
    "mine",
    "RMB release does not stop LMB mining"
  );
  f.up(0, 150);
  assert.equal(f.game.heldAction, null);
  f.down(2);
  f.down(0, 100, 100, { buttons: 3 });
  f.move(150, 100, { buttons: 3 });
  f.up(0, 150, 100, { buttons: 2 });
  const yaw = f.player.yaw;
  f.move(170);
  assert.ok(Math.abs(f.player.yaw - yaw + 0.04) < 1e-10);
  f.up(2, 170);
  assert.equal(f.game.secondaryCalls, 0);
  assert.equal(f.game.primaryCalls, 2);
});

for (const transition of ["blur", "resize", "pointercancel"]) {
  test(`${transition} clears mining and a pending Remote tap without accidental placement`, async (t) => {
    const f = fixture(t);
    f.down(0);
    f.down(2);
    f.key("KeyW");
    dispatch(
      transition === "pointercancel" ? f.document : f.window,
      transition
    );
    assert.equal(f.game.heldAction, null);
    assert.equal(f.player._keys.size, 0);
    await flush();
    if (f.game.paused) await f.game.play();
    f.up(2);
    assert.equal(f.game.secondaryCalls, 0);
  });
}

test("preferences persist across player replacement, reset mode/sensitivity, and require fresh Native capture", async (t) => {
  const f = fixture(t);
  f.down(0);
  f.down(2);
  f.game.setControlPreferences({ mouseSensitivity: 2 });
  assert.deepEqual(loadControlPreferences(f.storage), {
    inputMode: "remote",
    mouseSensitivity: 2,
  });
  assert.equal(f.game.heldAction, null);
  f.move(900);
  assert.equal(f.player.yaw, 0);
  f.game.setControlPreferences({ inputMode: "native" });
  assert.equal(f.game.paused, true);
  assert.equal(f.calls.length, 0);
  await flush();
  await f.game.play();
  assert.equal(f.player.locked, true);
  assert.deepEqual(f.calls, [[{ unadjustedMovement: true }]]);
  f.move(900, 100, { movementX: 400, movementY: 0 });
  assert.ok(Math.abs(f.player.yaw + 1.6) < 1e-10);
  f.game.setControlPreferences({ inputMode: "remote" });
  assert.equal(f.player.locked, false);
  assert.equal(f.game.active, true);
  assert.deepEqual(loadControlPreferences(f.storage), {
    inputMode: "remote",
    mouseSensitivity: 2,
  });
  const fresh = controlFixture(t, loadControlPreferences(f.storage));
  assert.equal(fresh.player.inputMode, "remote");
  assert.equal(fresh.player.mouseSensitivity, 2);
  assert.equal(await fresh.player.lock(), true);
  assert.deepEqual(fresh.calls, []);
});

test("Native keeps capture-click, fast look, held placement, lock-loss pause and middle pick", async (t) => {
  const f = fixture(t, {});
  assert.equal(f.player.inputMode, "native");
  f.down(0);
  assert.equal(f.game.primaryCalls, 0, "first click only requests capture");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.player.locked, true);
  f.down(0);
  assert.equal(f.game.primaryCalls, 1);
  f.up(0);
  f.move(800, 100, { movementX: 400, movementY: -100, buttons: 0 });
  assert.equal(f.player.yaw, -0.8);
  assert.equal(f.player.pitch, 0.2);
  f.down(2);
  assert.equal(f.game.heldAction, null);
  assert.deepEqual(f.game.useBegins, ["mouse"]);
  assert.equal(f.game.secondaryCalls, 0);
  f.up(2);
  assert.deepEqual(f.game.useEnds, [{ source: "mouse", cancel: false }]);
  assert.equal(f.game.heldAction, null);
  f.down(1);
  assert.equal(f.game.picks, 1);
  f.document.exitPointerLock();
  assert.equal(f.game.paused, true);
  assert.equal(f.game.heldAction, null);
});

for (const mode of ["creative", "survival"]) {
  test(`${mode} middle click delegates picking without inventing inventory semantics`, (t) => {
    const f = fixture(t);
    f.game.gameplay.setMode(mode);
    assert.equal(f.down(1).defaultPrevented, true);
    assert.equal(f.game.picks, 1);
    assert.equal(f.game.targetUpdates, 1);
    assert.deepEqual(f.game.selectedSlots, []);
    assert.deepEqual(f.calls, []);
  });
}

test("F swaps hands; Q drops one and Ctrl+Q drops a stack without changing flight", (t) => {
  const f = fixture(t);
  assert.equal(f.key("KeyF").defaultPrevented, true);
  assert.equal(f.game.swaps, 1);
  assert.equal(f.player.flying, false);
  assert.equal(f.player._keys.has("KeyF"), false);
  f.key("KeyQ");
  for (const control of ["ControlLeft", "ControlRight"]) {
    f.key(control);
    assert.equal(f.key("KeyQ", { ctrlKey: true }).defaultPrevented, true);
    dispatch(f.document, "keyup", { code: control });
  }
  assert.deepEqual(f.game.droppedStacks, [false, true, true]);
  assert.equal(f.player._keys.has("KeyQ"), false);
  for (const code of ["KeyF", "KeyQ"])
    assert.equal(f.key(code, { repeat: true }).defaultPrevented, true);
  assert.equal(f.game.swaps, 1);
  assert.deepEqual(f.game.droppedStacks, [false, true, true]);
});

test("F1/F3/F5 route HUD, debug and perspectives, suppressing browser defaults and repeats", (t) => {
  const f = fixture(t);
  const position = f.player.position.clone();
  for (const code of ["F1", "F3", "F5"]) {
    assert.equal(f.key(code).defaultPrevented, true);
    assert.equal(f.key(code, { repeat: true }).defaultPrevented, true);
  }
  assert.equal(f.game.ui.hud, false);
  assert.equal(f.game.ui.debug, true);
  assert.equal(f.player.perspective, "back");
  assert.equal(f.game.perspectives, 1);
  f.key("F5");
  assert.equal(f.player.perspective, "front");
  f.key("F5");
  assert.equal(f.player.perspective, "first");
  assert.deepEqual(f.player.position, position);
});

test("editing, inventory, pause and death block gameplay action shortcuts", (t) => {
  const f = fixture(t);
  const editor = new InputElement(f.document);
  editor.closest = () => editor;
  for (const state of ["editor", "overlay", "paused", "dead"]) {
    f.game.overlayOpen = state === "overlay";
    f.game.paused = state === "paused";
    f.game.gameplay.dead = state === "dead";
    for (const code of ["KeyF", "KeyQ", "F1", "F3", "F5"])
      f.key(code, { target: state === "editor" ? editor : f.element });
  }
  assert.equal(f.game.swaps, 0);
  assert.deepEqual(f.game.droppedStacks, []);
  assert.equal(f.game.perspectives, 0);
  assert.equal(f.game.ui.hud, true);
  assert.equal(f.game.ui.debug, false);
});

test("number keys, wheel, inventory and B/P extensions remain; G/R have no gameplay binding", async (t) => {
  const f = fixture(t);
  f.key("Digit1");
  f.key("Digit9");
  dispatch(f.game.container, "wheel", { deltaY: 1 });
  dispatch(f.game.container, "wheel", { deltaY: -1 });
  assert.deepEqual(f.game.selectedSlots, [0, 8, 1, 8]);
  f.key("KeyB");
  f.key("KeyB", { repeat: true });
  f.key("KeyP");
  f.key("KeyP", { repeat: true });
  f.key("KeyG");
  f.key("KeyR");
  assert.equal(f.game.ui.atlasToggles, 1);
  assert.equal(f.game.saves, 1);
  assert.equal(f.game.meals, 0);
  assert.equal(f.game.teleports, 0);
  f.key("KeyE");
  assert.equal(f.game.overlayOpen, true);
  f.key("KeyE", { repeat: true });
  assert.equal(f.game.overlayOpen, true);
  f.key("Escape");
  await flush();
  assert.equal(f.game.overlayOpen, false);
  f.key("Escape", { repeat: true });
  assert.equal(f.game.paused, false);
});

test("Native use temporarily overrides LMB and releasing RMB resumes mining without another attack press", async (t) => {
  const f = fixture(t, { inputMode: "native" });
  await f.player.lock();
  f.down(0);
  f.down(0);
  assert.deepEqual(f.game.primaryArguments, [[1, true]]);
  f.game.miningKey = "0,2,0";
  f.game.miningProgress = 0.6;
  f.down(2, 100, 100, { buttons: 3 });
  f.down(2, 100, 100, { buttons: 3 });
  assert.equal(f.game.heldAction, null);
  assert.equal(f.game.miningKey, "");
  assert.equal(f.game.miningProgress, 0);
  assert.deepEqual(f.game.useBegins, ["mouse"]);
  f.up(2, 100, 100, {
    buttons: 1,
    target: new InputElement(f.document),
    defaultPrevented: true,
  });
  assert.equal(f.game.heldAction, "mine");
  assert.deepEqual(f.game.useEnds, [{ source: "mouse", cancel: false }]);
  assert.equal(
    f.game.primaryCalls,
    1,
    "resuming held mine is not a mob attack press"
  );
  f.game.miningKey = "0,2,0";
  f.game.miningProgress = 0.6;
  f.up(0, 100, 100, {
    target: new InputElement(f.document),
    defaultPrevented: true,
  });
  assert.equal(f.game.heldAction, null);
  assert.equal(f.game.miningKey, "");
  assert.equal(f.game.miningProgress, 0);
});

test("LMB pressed during Native RMB use is remembered but does not interrupt use", async (t) => {
  const f = fixture(t, { inputMode: "native" });
  await f.player.lock();
  f.down(2);
  f.down(0, 100, 100, { buttons: 3 });
  assert.equal(f.game.primaryCalls, 0);
  assert.equal(f.game.useActions.held, true);
  assert.equal(f.game.heldAction, null);
  f.up(2, 100, 100, { buttons: 1 });
  assert.equal(f.game.heldAction, "mine");
  assert.equal(f.game.primaryCalls, 0);
  f.up(0);

  f.down(0);
  f.down(2, 100, 100, { buttons: 3 });
  f.game.miningKey = "stale";
  f.game.miningProgress = 0.4;
  f.up(0, 100, 100, { buttons: 2 });
  assert.equal(f.game.useActions.held, true);
  assert.equal(f.game.useEnds.length, 1);
  assert.equal(f.game.miningProgress, 0);
  assert.equal(f.game.miningKey, "");
  f.up(2);
  assert.deepEqual(f.game.useEnds.at(-1), { source: "mouse", cancel: false });
});

test("a lost Native RMB release cancels use instead of firing, and preserves a real held LMB", async (t) => {
  const f = fixture(t, { inputMode: "native" });
  await f.player.lock();
  f.down(0);
  f.down(2, 100, 100, { buttons: 3 });
  f.move(200, 100, { buttons: 1, movementX: 100, movementY: 0 });
  assert.equal(f.game.useActions.held, false);
  assert.deepEqual(f.game.useEnds, [{ source: "mouse", cancel: true }]);
  assert.equal(f.game.heldAction, "mine");
  f.up(2, 200, 100, { buttons: 1 });
  assert.equal(
    f.game.useEnds.length,
    1,
    "the late release cannot fire a canceled bow"
  );
  f.game.miningProgress = 0.8;
  f.game.miningKey = "stale";
  f.move(250, 100, { buttons: 0 });
  assert.equal(f.game.heldAction, null);
  assert.equal(f.game.miningProgress, 0);
  assert.equal(f.game.miningKey, "");
});

test("Remote V holds use while RMB remains drag-look, and captured V release ends use once", (t) => {
  const f = fixture(t);
  f.key("KeyV");
  f.key("KeyV");
  f.key("KeyV", { repeat: true });
  assert.deepEqual(f.game.useBegins, ["remote-key"]);
  f.down(2);
  f.move(200);
  f.up(2, 200);
  assert.equal(f.player.yaw, -0.2);
  assert.equal(f.game.secondaryCalls, 0);
  assert.equal(f.game.useActions.held, true);
  dispatch(f.document, "keyup", {
    code: "KeyV",
    target: new InputElement(f.document),
    defaultPrevented: true,
  });
  assert.deepEqual(f.game.useEnds, [{ source: "remote-key", cancel: false }]);
  dispatch(f.document, "keyup", { code: "KeyV" });
  assert.equal(f.game.useEnds.length, 1);
});

test("V release targeted at a text editor cancels instead of firing", (t) => {
  const f = fixture(t);
  const editor = new InputElement(f.document);
  editor.closest = () => editor;
  f.key("KeyV");
  dispatch(f.document, "keyup", { code: "KeyV", target: editor });
  assert.deepEqual(f.game.useEnds, [{ source: "remote-key", cancel: true }]);
});

for (const inputMode of ["native", "remote"]) {
  test(`${inputMode} release after death cancels even before another frame/reset`, async (t) => {
    const f = fixture(t, { inputMode });
    if (inputMode === "native") {
      await f.player.lock();
      f.down(2);
    } else f.key("KeyV");
    f.game.gameplay.dead = true;
    if (inputMode === "native") f.up(2);
    else dispatch(f.document, "keyup", { code: "KeyV" });
    assert.deepEqual(f.game.useEnds, [
      {
        source: inputMode === "native" ? "mouse" : "remote-key",
        cancel: true,
      },
    ]);
    assert.equal(f.game.useActions.held, false);
  });
}

test("V cannot start while typing, paused, dead, in a menu/overlay, or in Native mode", (t) => {
  const f = fixture(t);
  const editor = new InputElement(f.document);
  editor.closest = () => editor;
  for (const state of [
    "editor",
    "paused",
    "dead",
    "menu",
    "overlay",
    "consumed",
  ]) {
    f.game.paused = state === "paused";
    f.game.gameplay.dead = state === "dead";
    f.game.ui.menu = state === "menu";
    f.game.overlayOpen = state === "overlay";
    f.key("KeyV", {
      target: state === "editor" ? editor : f.element,
      defaultPrevented: state === "consumed",
    });
  }
  f.game.overlayOpen = false;
  f.player.inputMode = "native";
  f.key("KeyV");
  assert.deepEqual(f.game.useBegins, []);
});

for (const inputMode of ["native", "remote"]) {
  for (const reason of [
    "blur",
    "pointercancel",
    "resize",
    "inventory",
    "preferences",
    "world-reset",
    "typing",
    "hidden",
    "pagehide",
  ]) {
    test(`${inputMode} held use cannot fire after ${reason}`, async (t) => {
      const f = fixture(t, { inputMode });
      if (inputMode === "native") {
        await f.player.lock();
        f.down(2);
      } else f.key("KeyV");
      assert.equal(f.game.useActions.held, true);
      if (reason === "inventory") f.key("KeyE");
      else if (reason === "preferences")
        f.game.setControlPreferences({ mouseSensitivity: 2 });
      else if (reason === "world-reset") f.game.resetActions();
      else if (reason === "typing") {
        const editor = new InputElement(f.document);
        editor.closest = () => editor;
        dispatch(f.document, "focusin", { target: editor });
      } else if (reason === "hidden") {
        f.document.hidden = true;
        dispatch(f.document, "visibilitychange");
      } else {
        dispatch(reason === "pointercancel" ? f.document : f.window, reason);
      }
      await flush();
      assert.equal(f.game.useActions.held, false);
      assert.equal(f.game.heldAction, null);
      if (inputMode === "native") f.up(2);
      else dispatch(f.document, "keyup", { code: "KeyV" });
      assert.equal(
        f.game.useEnds.some((entry) => !entry.cancel),
        false
      );
    });
  }
}

test("Native pointer-lock loss cancels held use before a late mouseup", async (t) => {
  const f = fixture(t, { inputMode: "native" });
  await f.player.lock();
  f.down(2);
  f.document.exitPointerLock();
  f.up(2);
  assert.equal(f.game.useActions.held, false);
  assert.equal(
    f.game.useEnds.some((entry) => !entry.cancel),
    false
  );
  assert.equal(f.game.paused, true);
});

test("resetHeldButtons only clears input records and cannot recurse into gameplay reset", (t) => {
  const f = fixture(t);
  f.down(0);
  f.key("KeyV");
  f.game.heldAction = "mine";
  f.game.miningKey = "kept";
  f.game.miningProgress = 0.5;
  const resets = f.game.useActions.resets;
  f.game.resetHeldButtons();
  assert.equal(f.game.heldAction, "mine");
  assert.equal(f.game.miningKey, "kept");
  assert.equal(f.game.miningProgress, 0.5);
  assert.equal(f.game.useActions.held, true);
  assert.equal(f.game.useActions.resets, resets);
  f.game.resetActions();
  dispatch(f.document, "keyup", { code: "KeyV" });
  assert.equal(f.game.useActions.held, false);
  assert.equal(f.game.useEnds.length, 0);
});

test("UI-consumed reserved keys are not handled twice; started paused/editing games prevent browser defaults", async (t) => {
  const f = fixture(t);
  for (const code of ["F1", "F3", "F5", "Escape"])
    f.key(code, { defaultPrevented: true });
  assert.equal(f.game.ui.hud, true);
  assert.equal(f.game.ui.debug, false);
  assert.equal(f.game.perspectives, 0);
  assert.equal(f.game.paused, false);
  await f.game.pause();
  for (const code of ["F1", "F3", "F5"])
    assert.equal(f.key(code).defaultPrevented, true);
  assert.equal(
    dispatch(f.window, "keydown", { code: "F5", target: f.element })
      .defaultPrevented,
    true,
    "modal capture cannot leave F5 available to browser reload"
  );
  const editor = new InputElement(f.document);
  editor.closest = () => editor;
  for (const code of ["F1", "F3", "F5"])
    assert.equal(
      dispatch(f.window, "keydown", { code, target: editor }).defaultPrevented,
      true
    );
});

test("Escape outside the UI resumes only a paused main menu and never skips an option subpage", async (t) => {
  const f = fixture(t);
  await f.game.pause();
  f.game.ui.menuPage = "controls";
  f.key("Escape", { target: f.element });
  await flush();
  assert.equal(f.game.paused, true);
  assert.equal(f.game.ui.menuPage, "controls");
  f.game.ui.menuPage = "main";
  f.key("Escape", { target: f.element });
  await flush();
  assert.equal(f.game.paused, false);
  assert.equal(f.player.enabled, true);
  assert.equal(f.game.ui.menu, false);
});

test("visibility changes reset FPS even when an already-paused tab receives no RAF", (t) => {
  const f = fixture(t);
  f.game.paused = true;
  f.game.frameRate = new FrameRate();
  f.game.frameRate.observe(1);
  f.game.frameRate.observe(500);
  f.game.fps = f.game.frameRate.fps;
  assert.equal(f.game.fps, 2);
  f.document.hidden = true;
  dispatch(f.document, "visibilitychange");
  assert.equal(f.game.fps, null);
  assert.equal(f.game.frameRate.fps, null);
  f.document.hidden = false;
  dispatch(f.document, "visibilitychange");
  f.game.frameRate.observe(60000);
  assert.equal(
    f.game.frameRate.fps,
    null,
    "hidden wall time cannot become a gameplay sample"
  );
});
