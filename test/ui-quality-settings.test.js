import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createQualitySettings } from "../src/ui/quality-settings.js";

function fixture(t, onChange) {
  const select = Object.assign(new EventTarget(), { value: "low" });
  const events = createEventScope();
  t.after(() => events.dispose());
  const settings = createQualitySettings({
    querySelector: (selector) => {
      assert.equal(selector, "#quality-setting");
      return select;
    },
  }, { listen: events.listen, onChange });
  return { select, settings, events };
}

test("quality starts Balanced and reflects only valid host snapshots without requests", (t) => {
  const requests = [];
  const f = fixture(t, (value) => requests.push(value));
  assert.equal(f.select.value, "medium");
  assert.equal(f.select.disabled, false);
  for (const quality of ["low", "high", "medium"]) {
    f.settings.update(quality);
    assert.equal(f.select.value, quality);
  }
  for (const value of [undefined, null, "toString", "ultra", "", 3, {}, ["high"]]) {
    f.settings.update(value);
    assert.equal(f.select.value, "medium");
  }
  assert.deepEqual(requests, []);
});

test("a refused quality request restores the confirmed selector before invoking the host", (t) => {
  const requests = [];
  const f = fixture(t, (quality) => {
    assert.equal(f.select.value, "medium");
    requests.push(quality);
    return false;
  });
  f.select.value = "high";
  f.select.dispatchEvent(new Event("change"));
  assert.equal(f.select.value, "medium");
  assert.deepEqual(requests, ["high"]);
});

test("pending or returned acceptance never replaces an explicit host quality snapshot", async (t) => {
  for (const accepted of [false, true]) {
    const pending = Promise.withResolvers();
    const f = fixture(t, () => pending.promise);
    f.select.value = "high";
    f.select.dispatchEvent(new Event("change"));
    assert.equal(f.select.value, "medium");
    pending.resolve(accepted);
    await pending.promise;
    assert.equal(f.select.value, "medium");
    f.settings.update("low");
    f.select.value = "high";
    f.select.dispatchEvent(new Event("change"));
    await pending.promise;
    assert.equal(f.select.value, "low");
    f.settings.update("high");
    assert.equal(f.select.value, "high");
  }
});

test("synchronous quality acceptance publishes without being reverted after the callback", (t) => {
  const requests = [];
  const f = fixture(t, (quality) => {
    requests.push(quality);
    f.settings.update(quality);
    return true;
  });
  for (const quality of ["high", "low"]) {
    f.select.value = quality;
    f.select.dispatchEvent(new Event("change"));
    assert.equal(f.select.value, quality);
  }
  assert.deepEqual(requests, ["high", "low"]);
});

test("invalid requests are not forwarded and quality listeners are disabled/disposable", (t) => {
  assert.equal(fixture(t).select.disabled, true);
  const requests = [];
  const f = fixture(t, (quality) => requests.push(quality));
  for (const value of ["ultra", "toString", "", "HIGH"]) {
    f.select.value = value;
    f.select.dispatchEvent(new Event("change"));
    assert.equal(f.select.value, "medium");
  }
  f.events.dispose();
  f.select.value = "high";
  f.select.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, []);
});
