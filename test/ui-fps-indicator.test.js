import assert from "node:assert/strict";
import test from "node:test";
import { createHUD } from "../src/ui/hud.js";
import { createFpsIndicator } from "../src/ui/fps-indicator.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

test("compact FPS is opt-in and disabled samples never write DOM text", (t) => {
  const { get } = uiDomFixture(t);
  const host = get(".game-hud");
  const indicator = createFpsIndicator(host);
  let writes = 0,
    text = indicator.node.textContent;
  Object.defineProperty(indicator.node, "textContent", {
    get: () => text,
    set: (value) => {
      writes++;
      text = value;
    },
  });
  t.after(() => indicator.dispose());
  assert.equal(indicator.node.hidden, true);
  assert.equal(indicator.node.getAttribute("aria-live"), "off");
  for (let fps = 0; fps < 120; fps++) indicator.update(fps);
  assert.equal(writes, 0);
  indicator.setEnabled(true);
  assert.equal(indicator.node.hidden, false);
  assert.equal(text, "119 FPS");
  assert.equal(writes, 1);
  indicator.update(119.2);
  indicator.setEnabled(true);
  assert.equal(
    writes,
    1,
    "unchanged samples and preference snapshots are no-ops"
  );
  indicator.update(60);
  assert.equal(writes, 2);
  indicator.setEnabled(false);
  for (let fps = 1; fps < 100; fps++) indicator.update(fps);
  assert.equal(writes, 2);
  assert.equal(indicator.node.hidden, true);
  indicator.setEnabled(true);
  assert.equal(text, "99 FPS", "re-enabling uses the latest sample");
  assert.equal(host.children.length, 1);
});

test("unknown/invalid FPS is not fabricated and disposal is idempotent", (t) => {
  const { get } = uiDomFixture(t);
  const host = get(".game-hud");
  const indicator = createFpsIndicator(host);
  indicator.setEnabled(true);
  assert.equal(indicator.node.textContent, "— FPS");
  indicator.update(0.2);
  assert.equal(
    indicator.node.textContent,
    "0 FPS",
    "a real very slow sample is not hidden"
  );
  for (const invalid of [null, undefined, -2, NaN, Infinity, "60"]) {
    indicator.update(invalid);
    assert.equal(indicator.node.textContent, "— FPS");
  }
  indicator.setEnabled("true");
  assert.equal(indicator.node.hidden, true);
  indicator.dispose();
  indicator.dispose();
  indicator.setEnabled(true);
  indicator.update(60);
  assert.equal(host.children.length, 0);
});

test("F3 and the small indicator share the same existing HUD sample", (t) => {
  const { root, get } = uiDomFixture(t);
  const hud = createHUD(root, { listen() {} });
  t.after(() => hud.dispose());
  const compact = get(".game-hud").querySelector(".compact-fps");
  hud.update({ fps: 59.6 });
  assert.equal(get(".fps-indicator").textContent, "60 fps");
  assert.equal(compact.hidden, true);
  hud.setShowFps(true);
  assert.equal(compact.textContent, "60 FPS");
  hud.update({ fps: null });
  assert.equal(compact.textContent, "— FPS");
  assert.equal(get(".fps-indicator").textContent, "— fps");
});
