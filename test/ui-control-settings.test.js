import assert from "node:assert/strict";
import test from "node:test";
import { createControlSettings } from "../src/ui/control-settings.js";
import { createEventScope } from "../src/ui/dom.js";

function fixture(t, withCallback = true) {
  const nodes = new Map();
  const root = {
    dataset: {},
    querySelector(selector) {
      if (!nodes.has(selector))
        nodes.set(
          selector,
          Object.assign(new EventTarget(), {
            textContent: "",
            value: "",
            hidden: false,
          })
        );
      return nodes.get(selector);
    },
  };
  const scope = createEventScope();
  const changed = [];
  const settings = createControlSettings(root, {
    listen: scope.listen,
    onChange: withCallback ? (value) => changed.push(value) : undefined,
  });
  t.after(() => scope.dispose());
  return { root, settings, changed, get: (selector) => nodes.get(selector) };
}

test("control settings teach explicit drag/tap and edge tradeoffs only in Remote", (t) => {
  const f = fixture(t);
  assert.equal(f.root.dataset.inputMode, "native");
  assert.equal(f.get(".hotbar-look-hint").hidden, true);
  assert.equal(f.get(".remote-input-hints").hidden, true);
  assert.equal(f.get(".remote-held-use").hidden, true);
  assert.match(f.get("#input-mode-help").textContent, /captured mouse look/);
  f.get("#input-mode-setting").value = "remote";
  f.get("#input-mode-setting").dispatchEvent(new Event("change"));
  assert.deepEqual(f.changed, [{ inputMode: "remote", mouseSensitivity: 1 }]);
  assert.equal(f.root.dataset.inputMode, "remote");
  assert.equal(f.get(".hotbar-look-hint").hidden, false);
  assert.equal(f.get(".hotbar-edge-hint").hidden, false);
  assert.equal(f.get(".remote-input-hints").hidden, false);
  assert.equal(f.get(".remote-held-use").hidden, false);
  assert.match(
    f.get("#input-mode-help").textContent,
    /Hold V.*eat.*bow.*shield/
  );
  assert.equal(f.get('[data-control="look"] kbd').textContent, "RIGHT-DRAG");
  assert.equal(f.get(".hotbar-use-hint kbd").textContent, "RIGHT-CLICK");
  assert.match(
    f.get("#input-mode-help").textContent,
    /No mouse capture.*Release and reposition at window edges/
  );
  f.settings.update({ inputMode: "native" });
  assert.equal(f.get(".hotbar-look-hint").hidden, true);
  assert.equal(f.get(".hotbar-edge-hint").hidden, true);
  assert.equal(f.get(".remote-input-hints").hidden, true);
  assert.equal(f.get(".remote-held-use").hidden, true);
  assert.equal(
    f.changed.length,
    1,
    "restoring preferences does not write them"
  );
});

test("sensitivity input displays its multiplier and emits bounded browser preferences", (t) => {
  const f = fixture(t);
  f.settings.update({ inputMode: "remote", mouseSensitivity: 1.75 });
  assert.equal(f.get("#mouse-sensitivity-setting").value, "1.75");
  assert.equal(f.get("#mouse-sensitivity-value").textContent, "1.75×");
  f.get("#mouse-sensitivity-setting").value = "2";
  f.get("#mouse-sensitivity-setting").dispatchEvent(new Event("input"));
  assert.deepEqual(f.changed, [{ inputMode: "remote", mouseSensitivity: 2 }]);
  assert.equal(f.get("#mouse-sensitivity-value").textContent, "2.00×");
  f.get("#mouse-sensitivity-setting").value = "999";
  f.get("#mouse-sensitivity-setting").dispatchEvent(new Event("input"));
  assert.equal(
    f.changed.at(-1).mouseSensitivity,
    Number(f.get("#mouse-sensitivity-setting").max)
  );
});

test("unbound input preferences do not present interactive controls", (t) => {
  const f = fixture(t, false);
  assert.equal(f.get("#input-mode-setting").disabled, true);
  assert.equal(f.get("#mouse-sensitivity-setting").disabled, true);
});
