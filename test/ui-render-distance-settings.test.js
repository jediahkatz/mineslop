import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createRenderDistanceSettings } from "../src/ui/render-distance-settings.js";

function fixture(t, onChange) {
  const slider = Object.assign(new EventTarget(), { value: "" });
  const output = { textContent: "" };
  const events = createEventScope();
  t.after(() => events.dispose());
  const root = {
    querySelector: (selector) => ({
      "#render-distance-setting": slider,
      "#render-distance-value": output,
    })[selector],
  };
  const settings = createRenderDistanceSettings(root, { listen: events.listen, onChange });
  return { slider, output, settings, events };
}

test("distance control uses shared bounds and displays chunks and blocks", (t) => {
  const f = fixture(t, () => {});
  assert.deepEqual([f.slider.min, f.slider.max, f.slider.step], ["2", "12", "1"]);
  assert.equal(f.slider.value, "12");
  assert.equal(f.output.textContent, "12 chunks (192 blocks)");
  for (const radius of [2, 6, 12]) {
    f.settings.update(radius);
    assert.equal(f.slider.value, String(radius));
    assert.equal(f.output.textContent, `${radius} chunks (${radius * 16} blocks)`);
  }
});

test("requested changes remain unconfirmed until the host publishes acceptance", (t) => {
  const requests = [];
  const f = fixture(t, (radius) => requests.push(radius));
  f.settings.update(4);
  f.slider.value = "12";
  f.slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, [12]);
  assert.equal(f.slider.value, "4");
  assert.equal(f.output.textContent, "4 chunks (64 blocks)");
  f.settings.update(12);
  assert.equal(f.slider.value, "12");
  assert.equal(f.output.textContent, "12 chunks (192 blocks)");
});

test("invalid requests and invalid host updates preserve the accepted value", (t) => {
  const requests = [];
  const f = fixture(t, (radius) => requests.push(radius));
  f.settings.update(6);
  for (const value of ["", "1", "13", "4.5", "NaN", "Infinity", "bad"]) {
    f.slider.value = value;
    f.slider.dispatchEvent(new Event("change"));
    assert.equal(f.slider.value, "6");
  }
  for (const value of [undefined, null, "12", 1, 13, 6.5, NaN]) {
    f.settings.update(value);
    assert.equal(f.slider.value, "6");
  }
  assert.deepEqual(requests, []);
  assert.equal(f.output.textContent, "6 chunks (96 blocks)");
});

test("the control supports synchronous host acceptance", (t) => {
  let f;
  f = fixture(t, (radius) => f.settings.update(radius));
  f.slider.value = "2";
  f.slider.dispatchEvent(new Event("change"));
  assert.equal(f.slider.value, "2");
  assert.equal(f.output.textContent, "2 chunks (32 blocks)");
});

test("unbound controls are disabled and event disposal releases callbacks", (t) => {
  assert.equal(fixture(t).slider.disabled, true);
  const requests = [];
  const f = fixture(t, (radius) => requests.push(radius));
  assert.equal(f.slider.disabled, false);
  f.events.dispose();
  f.slider.value = "2";
  f.slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, []);
});
