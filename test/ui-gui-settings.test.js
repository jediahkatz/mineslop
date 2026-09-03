import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createGuiSettings } from "../src/ui/gui-settings.js";

function fixture(t, onChange) {
  const select = Object.assign(new EventTarget(), { value: "" });
  const view = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 720,
  });
  const properties = new Map();
  const root = {
    dataset: {},
    ownerDocument: { defaultView: view },
    querySelector: () => select,
    style: { setProperty: (key, value) => properties.set(key, value) },
  };
  const events = createEventScope();
  t.after(() => events.dispose());
  const settings = createGuiSettings(root, { listen: events.listen, onChange });
  return { settings, root, properties, select, view };
}

test("GUI scale follows the viewport while retaining the confirmed user preference", (t) => {
  const f = fixture(t, () => {});
  assert.equal(f.properties.get("--gui-scale"), "3");
  f.settings.update(4);
  assert.equal(f.select.value, "4");
  assert.equal(f.properties.get("--gui-scale"), "3");
  f.view.innerWidth = 640;
  f.view.innerHeight = 480;
  f.view.dispatchEvent(new Event("resize"));
  assert.equal(f.properties.get("--gui-scale"), "2");
  assert.equal(f.select.value, "4");
  f.view.innerWidth = 1920;
  f.view.innerHeight = 1080;
  f.view.dispatchEvent(new Event("resize"));
  assert.equal(f.root.dataset.guiScale, "4");
});

test("a rejected setting change cannot leave an unconfirmed GUI value", (t) => {
  const requested = [];
  const f = fixture(t, (scale) => requested.push(scale));
  f.select.value = "1";
  f.select.dispatchEvent(new Event("change"));
  assert.deepEqual(requested, [1]);
  assert.equal(f.select.value, "auto");
  assert.equal(f.properties.get("--gui-scale"), "3");
  f.settings.update(1);
  assert.equal(f.select.value, "1");
  assert.equal(f.properties.get("--gui-scale"), "1");
});

test("unbound GUI settings are non-interactive", (t) => {
  assert.equal(fixture(t).select.disabled, true);
});
