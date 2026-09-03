import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createFpsSettings } from "../src/ui/fps-settings.js";
import { menuMarkup } from "../src/ui/menu-markup.js";

function fixture(t, onChange) {
  const toggle = Object.assign(new EventTarget(), { checked: true });
  const events = createEventScope();
  t.after(() => events.dispose());
  const settings = createFpsSettings(
    {
      querySelector(selector) {
        assert.equal(selector, "#show-fps-setting");
        return toggle;
      },
    },
    { listen: events.listen, onChange }
  );
  return { toggle, events, settings };
}

test("Video Settings expose an opt-in labeled FPS switch with no new key binding", () => {
  assert.match(menuMarkup(), /for="show-fps-setting"><span>Show FPS/);
  assert.match(
    menuMarkup(),
    /id="show-fps-setting" aria-describedby="show-fps-help"/
  );
});

test("FPS switch waits for the game's confirmed preference and supports turning off", (t) => {
  const changes = [];
  const f = fixture(t, (enabled) => {
    changes.push(enabled);
    f.settings.update(enabled);
  });
  assert.equal(f.toggle.checked, false);
  assert.equal(f.toggle.disabled, false);
  f.toggle.checked = true;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, true);
  f.toggle.checked = false;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, false);
  assert.deepEqual(changes, [true, false]);
});

test("rejected changes do not leave an optimistic checkbox and disposal removes listeners", (t) => {
  const changes = [];
  const f = fixture(t, (value) => changes.push(value));
  f.toggle.checked = true;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, false);
  f.settings.update(true);
  f.toggle.checked = false;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, true);
  assert.deepEqual(changes, [true, false]);
  f.events.dispose();
  f.toggle.dispatchEvent(new Event("change"));
  assert.deepEqual(changes, [true, false]);
});

test("FPS controls are disabled without an owning callback", (t) => {
  const f = fixture(t);
  assert.equal(f.toggle.disabled, true);
  assert.equal(f.toggle.checked, false);
});
