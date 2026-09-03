import assert from "node:assert/strict";
import test from "node:test";
import { HURT_MAX_FLASH, HURT_SECONDS } from "../src/hurt-feedback.js";
import { createHurtIndicator } from "../src/ui/hurt-indicator.js";
import { hurtFixture } from "./hurt-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(t) {
  const { document, get } = uiDomFixture(t);
  const host = get(".game-hud");
  const indicator = createHurtIndicator(host);
  t.after(() => indicator.dispose());
  return { ...hurtFixture(t), document, host, indicator, node: indicator.node };
}

test("a real committed hit shows one decorative flash, then simulation expiry hides it", (t) => {
  const { gameplay, feedback, host, indicator, node } = fixture(t);
  assert.equal(host.children.length, 1);
  assert.equal(node.hidden, true);
  assert.equal(node.getAttribute("aria-hidden"), "true");
  assert.equal(node.children.length, 0);
  gameplay.damage(3, "fall");
  indicator.update(feedback.update(0));
  assert.equal(node.hidden, false);
  assert.ok(Number(node.style.opacity) > 0);
  assert.ok(Number(node.style.opacity) <= HURT_MAX_FLASH);
  indicator.update(feedback.update(HURT_SECONDS));
  assert.equal(node.hidden, true);
  assert.equal(node.style.opacity, "0");
});

test("frame updates reuse the node and avoid redundant styles, markup and attributes", (t) => {
  const { gameplay, feedback, document, indicator, node } = fixture(t);
  gameplay.damage(3);
  const state = feedback.update(0);
  indicator.update(state);
  let opacity = node.style.opacity;
  let writes = 0;
  Object.defineProperty(node.style, "opacity", {
    get: () => opacity,
    set: (value) => {
      opacity = value;
      writes++;
    },
  });
  Object.defineProperty(node, "innerHTML", {
    set: () => assert.fail("hurt updates must not rebuild markup"),
  });
  t.mock.method(document, "createElement", () =>
    assert.fail("per-frame DOM creation")
  );
  const attributes = t.mock.method(node, "setAttribute");
  for (let frame = 0; frame < 100; frame++) indicator.update({ ...state });
  assert.equal(writes, 0);
  assert.equal(attributes.mock.callCount(), 0);
  indicator.update(feedback.update(0.05));
  assert.equal(writes, 1);
  assert.equal(indicator.node, node);
});

test("pause/overlays/reset hide the flash and reduced motion retains the color cue", (t) => {
  const { gameplay, feedback, motionPreference, indicator, node } = fixture(t);
  motionPreference.matches = true;
  gameplay.damage(2);
  const view = feedback.update(0);
  assert.equal(view.roll, 0);
  indicator.update(view);
  assert.equal(node.hidden, false);
  indicator.update(feedback.update(100, { simulating: false }));
  assert.equal(node.hidden, true);
  indicator.update(feedback.update(0, { visible: false }));
  assert.equal(node.hidden, true);
  indicator.update(feedback.update(0));
  assert.equal(node.hidden, false);
  feedback.reset();
  indicator.update(feedback.update(0));
  assert.equal(node.hidden, true);
});

test("bad view data remains finite and subtle; disposal removes only its own node", (t) => {
  const { document, host, indicator, node } = fixture(t);
  for (const flash of [NaN, Infinity, -1, "<img>"]) {
    indicator.update({ visible: true, flash });
    assert.equal(node.hidden, true);
    assert.equal(node.style.opacity, "0");
  }
  indicator.update({ visible: true, flash: 100 });
  assert.equal(Number(node.style.opacity), HURT_MAX_FLASH);
  const sibling = document.createElement("div");
  host.append(sibling);
  indicator.dispose();
  indicator.dispose();
  assert.deepEqual(host.children, [sibling]);
  const opacity = node.style.opacity;
  indicator.update({ visible: false });
  assert.equal(node.style.opacity, opacity);
});
