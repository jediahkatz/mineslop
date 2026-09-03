import assert from "node:assert/strict";
import test from "node:test";
import { experienceForLevel, experienceState } from "../src/experience.js";
import { ITEM } from "../src/items.js";
import { createHUD } from "../src/ui/hud.js";
import { integratedProgressionFixture } from "./game-progression-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

const snapshot = (total) => ({
  mode: "survival", slots: Array(36).fill(null), selected: 0,
  health: 20, hunger: 20, armorPoints: 0, air: 20,
  experience: experienceState(total),
});

test("HUD shows level zero and exact remaining XP; loading a high level cannot show a celebration", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  hud.updateGameplay(snapshot(0), true);
  assert.equal(get(".experience-level").textContent, "0");
  assert.equal(
    get(".experience-track").getAttribute("aria-valuetext"),
    "Level 0 · 0 / 7 XP · 7 XP to level 1"
  );
  assert.match(get(".experience-meter").getAttribute("title"), /enchanting table or anvil/);
  const notice = get(".game-hud").querySelector(".experience-feedback");
  for (const level of [1, 16, 31, 40]) {
    hud.updateGameplay(snapshot(experienceForLevel(level)), true);
    assert.equal(get(".experience-level").textContent, String(level));
    assert.equal(get(".experience-fill").style.transform, "scaleX(0)");
    assert.equal(notice.hidden, true);
    assert.equal(notice.textContent, "");
    assert.equal(get(".experience-meter").properties.get("--xp-pulse"), "0");
  }
  hud.updateGameplay(snapshot(experienceForLevel(17) - 1), true);
  assert.match(get(".experience-track").getAttribute("aria-valuetext"), /1 XP to level 17$/);
});

test("only explicit earned feedback shows the compact notice, and missing/dead/Creative snapshots clear it", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  const state = snapshot(experienceForLevel(5));
  const notice = get(".game-hud").querySelector(".experience-feedback");
  const earned = { visible: true, pulse: 1, levelUp: true, level: 5, opacity: 1 };
  hud.updateGameplay(state, true);
  hud.update({ experienceFeedback: earned });
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "Level 5");
  assert.equal(notice.getAttribute("aria-live"), "polite");
  assert.equal(get(".experience-meter").classList.contains("is-level-up"), true);
  hud.update({ experienceFeedback: { visible: true, pulse: 0.4, levelUp: false } });
  assert.equal(notice.hidden, true, "individual orbs do not create a text toast");
  assert.equal(get(".experience-meter").properties.get("--xp-pulse"), "0.4");
  for (const next of [
    { ...state, experience: undefined }, { ...state, dead: true }, { ...state, mode: "creative" },
  ]) {
    hud.updateGameplay(state, true);
    hud.update({ experienceFeedback: earned });
    hud.updateGameplay(next, true);
    assert.equal(notice.hidden, true);
    assert.equal(get(".experience-meter").hidden, true);
    assert.equal(get(".experience-meter").properties.get("--xp-pulse"), "0");
  }
});

test("the activated production ProgressionUI routes paid anvil actions and closes without spending again", async (t) => {
  const { document, Node } = uiDomFixture(t);
  const documentEvents = new EventTarget();
  for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"])
    document[name] = documentEvents[name].bind(documentEvents);
  const root = new Node("div");
  const f = integratedProgressionFixture(t, { root, document });
  f.collect(experienceForLevel(8));
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, { name: "Old pick" }, 10);
    owned.slots[1] = progressionStack(ITEM.IRON_INGOT, 3);
    return true;
  });
  assert.equal(f.open().opened, true);
  const ui = f.integration.ui;
  assert.equal(ui.isOpen, true);
  assert.equal(f.game.overlayOpen, true);
  for (const index of [0, 1]) {
    assert.equal(await ui.dispatch({ type: "click", area: "inventory", index, button: 0 }), true);
    assert.equal(await ui.dispatch({ type: "click", area: "container", index, button: 0 }), true);
  }
  const name = ui.element.querySelector(".progression-name");
  name.value = "Paid pick";
  name.dispatchEvent(new Event("input"));
  assert.equal(await ui.dispatch({ type: "takeResult" }), true);
  assert.equal(f.gameplay.cursor.data.name, "Paid pick");
  assert.equal(f.gameplay.getState().experience.level, 4);
  const owned = f.gameplay.serialize(), escrow = f.services.stations.serialize();
  const sounds = structuredClone(f.calls.sounds);
  assert.equal(ui.close(), true);
  assert.equal(ui.isOpen, false);
  assert.equal(f.game.overlayOpen, false);
  assert.deepEqual(f.gameplay.serialize(), owned);
  assert.deepEqual(f.services.stations.serialize(), escrow);
  assert.deepEqual(f.calls.sounds, sounds);
});
