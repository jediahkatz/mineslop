import assert from "node:assert/strict";
import test from "node:test";
import { CombatFeedback } from "../src/combat-feedback.js";
import { createCombatIndicator } from "../src/ui/combat-indicator.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(t) {
  const { document, get } = uiDomFixture(t);
  const host = get(".game-hud");
  const indicator = createCombatIndicator(host);
  t.after(() => indicator.dispose());
  return { document, host, indicator, node: indicator.node };
}

test("indicator mounts once, exposes readiness accessibly and toggles the small ready glyph", (t) => {
  const { host, indicator, node } = fixture(t);
  const track = node.querySelector(".combat-indicator-track");
  const fill = node.querySelector(".combat-indicator-fill");
  const sword = node.querySelector(".combat-indicator-ready");
  assert.equal(host.children.length, 1);
  assert.equal(node.hidden, true);
  assert.equal(node.getAttribute("role"), "progressbar");
  assert.equal(node.getAttribute("aria-live"), "off");
  assert.equal(node.getAttribute("aria-label"), "Melee attack readiness");
  indicator.update({ visible: true, progress: 0.5, phase: "cooldown" });
  assert.equal(node.hidden, false);
  assert.equal(track.hidden, false);
  assert.equal(sword.hidden, true);
  assert.equal(fill.style.transform, "scaleX(0.5)");
  assert.equal(node.getAttribute("aria-valuenow"), "50");
  indicator.update({ visible: true, progress: 1, phase: "ready" });
  assert.equal(track.hidden, true);
  assert.equal(sword.hidden, false);
  assert.equal(node.getAttribute("aria-valuetext"), "Melee ready");
  indicator.update({ visible: false });
  assert.equal(node.hidden, true);
});

test("blocked presses get bounded refusal state, not successful-hit feedback", (t) => {
  const { indicator, node } = fixture(t);
  const feedback = new CombatFeedback();
  const state = {
    active: true,
    hasTarget: true,
    now: 10.49,
    lastAction: 10,
    pressed: true,
  };
  feedback.noteAttempt(state);
  indicator.update(feedback.view(state));
  assert.equal(node.dataset.blocked, "cooldown");
  assert.match(
    node.getAttribute("aria-valuetext"),
    /Previous attack was too early/
  );
  indicator.update(feedback.view({ ...state, now: 10.51 }));
  assert.equal(node.dataset.phase, "ready");
  assert.equal(node.dataset.blocked, "cooldown");
  assert.match(node.getAttribute("aria-valuetext"), /^Melee ready\./);
  indicator.update(feedback.view({ ...state, now: 10.7 }));
  assert.equal(node.dataset.blocked, "");
  assert.equal(node.getAttribute("aria-valuetext"), "Melee ready");
  const using = { ...state, now: 11, usingItem: true };
  feedback.noteAttempt(using);
  indicator.update(feedback.view(using));
  assert.equal(node.dataset.phase, "using-item");
  assert.equal(node.dataset.blocked, "using-item");
  assert.equal(node.querySelector(".combat-indicator-ready").hidden, true);
  assert.match(
    node.getAttribute("aria-valuetext"),
    /Cannot attack while using an item/
  );
  assert.doesNotMatch(
    node.getAttribute("aria-valuetext"),
    /\bhit\b|\bdamage\b|\bhealth\b/i
  );
});

test("repeated frame snapshots do not recreate DOM, re-render HTML or repeat style/attribute writes", (t) => {
  const { indicator, node, document } = fixture(t);
  const state = { visible: true, progress: 0.5, phase: "cooldown" };
  indicator.update(state);
  const children = [...node.children];
  const fill = node.querySelector(".combat-indicator-fill");
  let transform = fill.style.transform;
  let writes = 0;
  Object.defineProperty(fill.style, "transform", {
    get: () => transform,
    set: (value) => {
      transform = value;
      writes++;
    },
  });
  Object.defineProperty(node, "innerHTML", {
    set: () => assert.fail("frame update must never reconstruct markup"),
  });
  t.mock.method(document, "createElement", () =>
    assert.fail("per-frame DOM creation")
  );
  const attributes = t.mock.method(node, "setAttribute");
  for (let frame = 0; frame < 100; frame++) indicator.update({ ...state });
  assert.equal(writes, 0);
  assert.equal(attributes.mock.callCount(), 0);
  assert.deepEqual(node.children, children);
  indicator.update({ ...state, progress: 0.75 });
  assert.equal(writes, 1);
  assert.equal(node.getAttribute("aria-valuenow"), "75");
  assert.equal(node.querySelector(".combat-indicator-fill"), fill);
});

test("invalid view data is clamped and never interpreted as markup or a ready hit", (t) => {
  const { indicator, node } = fixture(t);
  indicator.update({
    visible: true,
    progress: NaN,
    phase: "<img>",
    blockedReason: "<img>",
  });
  assert.equal(node.dataset.phase, "cooldown");
  assert.equal(node.dataset.blocked, "");
  assert.equal(node.getAttribute("aria-valuenow"), "0");
  assert.equal(node.getAttribute("aria-valuetext"), "Melee recharging");
  indicator.update({ visible: true, progress: 0.99, phase: "ready" });
  assert.equal(
    node.dataset.phase,
    "cooldown",
    "rounding does not imply early readiness"
  );
  assert.equal(node.getAttribute("aria-valuenow"), "99");
  indicator.update({ visible: true, progress: -1 });
  assert.equal(node.getAttribute("aria-valuenow"), "0");
});

test("dispose removes only the mounted indicator and stops subsequent writes", (t) => {
  const { host, indicator, node, document } = fixture(t);
  const other = document.createElement("div");
  host.append(other);
  indicator.dispose();
  indicator.dispose();
  assert.deepEqual(host.children, [other]);
  const attributes = t.mock.method(node, "setAttribute");
  indicator.update({ visible: true, progress: 1, phase: "ready" });
  assert.equal(attributes.mock.callCount(), 0);
});
