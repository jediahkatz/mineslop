import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { createHUD } from "../src/ui/hud.js";
import { shellMarkup } from "../src/ui/shell.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

test("the mob-grace badge counts down from simulation snapshots and hides at expiry", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  hud.update({ spawnGrace: 8 });
  const badge = get(".spawn-grace");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "Mob grace: 8s (ends on attack)");
  hud.update({ spawnGrace: 3.1 });
  assert.match(badge.textContent, /4s/);
  hud.update({ fps: 60 });
  assert.match(
    badge.textContent,
    /4s/,
    "unrelated HUD updates do not restart it"
  );
  hud.update({ spawnGrace: 0.01 });
  assert.match(badge.textContent, /1s/);
  for (const spawnGrace of [0, -1, NaN]) {
    hud.update({ spawnGrace });
    assert.equal(badge.hidden, true);
    assert.equal(badge.textContent, "");
  }
});

test("HUD uses per-slot counts, real protection, air and experience", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {}, onSelect() {} });
  t.after(() => hud.dispose());
  const slots = Array(36).fill(null);
  slots[0] = { id: ITEM.APPLE, count: 1 };
  slots[1] = { id: ITEM.APPLE, count: 5 };
  const state = {
    mode: "survival",
    slots,
    hotbar: [ITEM.APPLE, ITEM.APPLE],
    selected: 0,
    counts: { [ITEM.APPLE]: 6 },
    health: 19,
    hunger: 14,
    armorPoints: 7,
    air: 8,
    underwater: true,
    experience: { total: 31, level: 3, progress: 0.25 },
    offhand: { id: ITEM.WOOD_PICKAXE, count: 1, durability: 12 },
  };
  hud.updateGameplay(state, true);
  assert.equal(
    get(".hotbar").children[0].querySelector(".slot-count").textContent,
    ""
  );
  assert.equal(
    get(".hotbar").children[1].querySelector(".slot-count").textContent,
    "5"
  );
  assert.equal(
    get('[data-vital="armor"]').parentElement.getAttribute("aria-label"),
    "Armor: 7 of 20"
  );
  assert.equal(
    get('[data-vital="health"]').children[9].properties.get("--vital-fill"),
    "50%"
  );
  assert.equal(get('[data-vital="air"]').parentElement.hidden, false);
  assert.equal(get(".experience-level").textContent, "3");
  assert.equal(get(".experience-track").getAttribute("aria-valuenow"), "25");
  assert.equal(get(".experience-fill").style.transform, "scaleX(0.25)");
  assert.equal(get(".hud-offhand").hidden, false);
  hud.updateGameplay(
    { ...state, armorPoints: 0, air: 20, underwater: false, offhand: null },
    true
  );
  assert.equal(get('[data-vital="armor"]').parentElement.hidden, true);
  assert.equal(get('[data-vital="air"]').parentElement.hidden, true);
  assert.equal(get(".hud-offhand").hidden, true);
  hud.updateGameplay({ ...state, experience: undefined }, true);
  assert.equal(
    get(".experience-meter").hidden,
    true,
    "missing XP must not display a fabricated bar"
  );
  hud.updateGameplay({ ...state, mode: "creative" }, true);
  assert.equal(get(".survival-vitals").hidden, true);
  assert.equal(get(".experience-meter").hidden, true);
});

test("selected item names fade without being restarted by routine HUD snapshots", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  const slots = Array(36).fill(null);
  slots[0] = { id: ITEM.APPLE, count: 3 };
  slots[1] = { id: ITEM.APPLE, count: 2 };
  const state = {
    mode: "survival",
    slots,
    selected: 0,
    health: 20,
    hunger: 20,
    air: 20,
  };
  hud.updateGameplay(state, true);
  const name = get(".selected-block-name");
  assert.equal(name.textContent, "Apple");
  assert.equal(name.classList.contains("is-visible"), true);
  t.mock.timers.tick(1500);
  hud.updateGameplay({ ...state, health: 18 }, true);
  t.mock.timers.tick(200);
  assert.equal(name.classList.contains("is-visible"), false);
  hud.updateGameplay({ ...state, selected: 1 }, true);
  assert.equal(
    name.classList.contains("is-visible"),
    true,
    "changing slots refreshes the transient label"
  );
  hud.updateGameplay({ ...state, selected: 8 }, true);
  assert.equal(name.classList.contains("is-visible"), false);
  assert.equal(name.textContent, "");
});

test("held custom names use literal text, refresh on metadata changes, and ignore ordinary wear", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  const name = get(".selected-block-name");
  Object.defineProperty(name, "innerHTML", {
    set() {
      assert.fail("custom names must never become HTML");
    },
  });
  const slots = Array(36).fill(null);
  slots[0] = {
    id: ITEM.WOOD_PICKAXE,
    count: 1,
    durability: 30,
    data: { version: 1, name: "<img src=x onerror=alert(1)>" },
  };
  const state = {
    mode: "survival",
    slots,
    selected: 0,
    health: 20,
    hunger: 20,
    air: 20,
  };
  hud.updateGameplay(state, true);
  assert.equal(name.textContent, "<img src=x onerror=alert(1)>");
  t.mock.timers.tick(1500);
  slots[0] = { ...slots[0], durability: 29 };
  hud.updateGameplay(state, true);
  t.mock.timers.tick(200);
  assert.equal(name.classList.contains("is-visible"), false);
  slots[0] = { ...slots[0], data: { version: 1, name: "Second pick | north" } };
  hud.updateGameplay(state, true);
  assert.equal(name.textContent, "Second pick | north");
  assert.equal(name.classList.contains("is-visible"), true);
});

test("target block data is distinct from the selected-item name", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  hud.update({
    targetName: "Moss",
    position: { x: 1.7, y: 23, z: -5.2 },
    fps: 60,
  });
  assert.equal(get(".target-label").textContent, "Targeted block: Moss");
  assert.equal(get(".selected-block-name").textContent, "");
  assert.equal(get('[data-coordinate="z"]').textContent, "-6");
  hud.update({ targetName: "" });
  assert.equal(get(".target-label").hidden, true);
});

test("mining progress remains accessible without a visible HUD meter or ring", (t) => {
  const markup = shellMarkup();
  assert.match(
    markup,
    /class="mining-progress sr-only"[^>]*role="progressbar"[^>]*aria-live="off"[^>]*hidden><\/div>/
  );
  assert.doesNotMatch(markup, /mining-progress-fill/);
  const { root, get } = uiDomFixture(t);
  const query = root.querySelector;
  root.querySelector = (selector) => {
    assert.notEqual(
      selector,
      ".mining-progress-fill",
      "the old visible fill must not be animated"
    );
    return query(selector);
  };
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  const progress = get(".mining-progress");
  hud.update({ miningProgress: 0.45 });
  assert.equal(progress.getAttribute("aria-valuenow"), "45");
  assert.equal(
    progress.hidden,
    false,
    "active screen-reader-only progress remains in the accessibility tree"
  );
  hud.update({ fps: 60 });
  assert.equal(progress.getAttribute("aria-valuenow"), "45");
  for (const [value, percent] of [
    [0, "0"],
    [1, "100"],
    [-2, "0"],
    [NaN, "0"],
    [2, "100"],
  ]) {
    hud.update({ miningProgress: value });
    assert.equal(progress.hidden, true);
    assert.equal(progress.getAttribute("aria-valuenow"), percent);
  }
});
