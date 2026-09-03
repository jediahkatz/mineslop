import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createInspectionSettings } from "../src/ui/inspection-settings.js";

function fixture(t, onChange) {
  const toggle = Object.assign(new EventTarget(), { checked: true });
  const badge = { hidden: false };
  const events = createEventScope();
  t.after(() => events.dispose());
  const settings = createInspectionSettings(
    {
      querySelector(selector) {
        if (selector === "#fullbright-inspection-badge") return badge;
        assert.equal(selector, "#fullbright-inspection-setting");
        return toggle;
      },
    },
    { listen: events.listen, onChange }
  );
  return { settings, toggle, badge, events };
}

test("inspection is opt-in and renderer snapshots update it without emitting changes", (t) => {
  const changes = [];
  const { settings, toggle, badge } = fixture(t, (enabled) =>
    changes.push(enabled)
  );
  assert.equal(toggle.checked, false);
  assert.equal(badge.hidden, true);
  assert.equal(toggle.disabled, false);
  settings.update(true);
  assert.equal(toggle.checked, true);
  assert.equal(badge.hidden, false);
  settings.update(false);
  assert.equal(toggle.checked, false);
  assert.equal(badge.hidden, true);
  settings.update("true");
  assert.equal(toggle.checked, false);
  assert.deepEqual(changes, []);
});

test("the switch only displays a confirmed setting, including switching back off", (t) => {
  const changes = [];
  const f = fixture(t, (enabled) => {
    changes.push(enabled);
    f.settings.update(enabled);
  });
  f.toggle.checked = true;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, true);
  f.toggle.checked = false;
  f.toggle.dispatchEvent(new Event("change"));
  assert.equal(f.toggle.checked, false);
  assert.deepEqual(changes, [true, false]);
});

test("rejected requests cannot leave a false checked state and listeners dispose", (t) => {
  const changes = [];
  const { settings, toggle, events } = fixture(t, (value) =>
    changes.push(value)
  );
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change"));
  assert.equal(toggle.checked, false, "no renderer confirmation");
  settings.update(true);
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change"));
  assert.equal(toggle.checked, true, "retains the actual active inspection");
  assert.deepEqual(changes, [true, false]);
  events.dispose();
  toggle.dispatchEvent(new Event("change"));
  assert.deepEqual(changes, [true, false]);
});

test("inspection is not interactive without a game callback", (t) => {
  const { toggle } = fixture(t);
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.checked, false);
});
