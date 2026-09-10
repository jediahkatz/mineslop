import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createRenderDistanceSettings } from "../src/ui/render-distance-settings.js";
import { menuMarkup } from "../src/ui/menu-markup.js";

function fixture(t, onChange, { withMode = false, onModeChange } = {}) {
  const slider = Object.assign(new EventTarget(), { value: "" });
  const mode = withMode ? Object.assign(new EventTarget(), { value: "" }) : null;
  const output = { textContent: "" };
  const events = createEventScope();
  t.after(() => events.dispose());
  const root = {
    querySelector: (selector) => ({
      "#render-distance-setting": slider,
      "#render-distance-value": output,
      "#render-mode-setting": mode,
    })[selector],
  };
  const settings = createRenderDistanceSettings(root, {
    listen: events.listen, onChange, onModeChange,
  });
  return { slider, mode, output, settings, events };
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

test("Video settings expose Nearby and experimental Extended using existing setting rows", () => {
  const video = menuMarkup().match(/<section class="menu-page video-page"[\s\S]*?<\/section>/)?.[0];
  assert.ok(video);
  assert.match(video, /class="setting-row" for="render-mode-setting"/);
  assert.match(video, /id="render-mode-setting" aria-describedby="render-mode-help"/);
  assert.match(video, /<option value="nearby">Nearby<\/option>/);
  assert.match(video, /<option value="extended">Extended \(experimental\)<\/option>/);
  assert.match(video, /Nearby disables far terrain and preserves your previous Extended distance/);
  assert.match(video, /id="render-distance-setting"/);
  assert.match(video, /Nearby follows Graphics until you choose a distance/);
});

test("mode-aware controls start Nearby at the default preset with a four-chunk cap", (t) => {
  const f = fixture(t, undefined, { withMode: true });
  assert.equal(f.mode.value, "nearby");
  assert.equal(f.mode.disabled, true);
  assert.equal(f.slider.disabled, true);
  assert.deepEqual([f.slider.min, f.slider.max, f.slider.step], ["2", "4", "1"]);
  assert.equal(f.slider.value, "3");
  assert.equal(f.output.textContent, "3 chunks (48 blocks)");
});

test("mode requests revert until the host confirms mode, bounds and radius together", (t) => {
  const requests = [];
  const f = fixture(t, () => {}, { withMode: true, onModeChange: (mode) => requests.push(mode) });
  f.settings.update({ mode: "nearby", radius: 2, maxRadius: 4 });
  f.mode.value = "extended";
  f.mode.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, ["extended"]);
  assert.equal(f.mode.value, "nearby");
  assert.equal(f.slider.max, "4");
  assert.equal(f.slider.value, "2");
  assert.equal(f.output.textContent, "2 chunks (32 blocks)");
  f.settings.update({ mode: "extended", radius: 12, maxRadius: 12 });
  assert.equal(f.mode.value, "extended");
  assert.equal(f.slider.max, "12");
  assert.equal(f.slider.value, "12");
  f.mode.value = "nearby";
  f.mode.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, ["extended", "nearby"]);
  assert.equal(f.mode.value, "extended");
  assert.equal(f.slider.max, "12");
  assert.equal(f.slider.value, "12");
  f.settings.update({ mode: "nearby", radius: 3, maxRadius: 4 });
  assert.equal(f.mode.value, "nearby");
  assert.equal(f.slider.max, "4");
  assert.equal(f.slider.value, "3");
  assert.equal(f.output.textContent, "3 chunks (48 blocks)");
});

test("Nearby slider requests and legacy numeric updates cannot bypass the current mode's cap", (t) => {
  const requests = [];
  const f = fixture(t, (radius) => requests.push(radius), { withMode: true });
  for (const value of ["5", "6", "12", "2.5", "1"]) {
    f.slider.value = value;
    f.slider.dispatchEvent(new Event("change"));
    f.settings.update(Number(value));
    assert.equal(f.slider.value, "3");
    assert.equal(f.slider.max, "4");
  }
  assert.deepEqual(requests, []);
  f.slider.value = "4";
  f.slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, [4]);
  assert.equal(f.slider.value, "3");
  f.settings.update(4);
  assert.equal(f.slider.value, "4");
  f.settings.update({ mode: "extended", radius: 6, maxRadius: 12 });
  f.slider.value = "12";
  f.slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, [4, 12]);
  assert.equal(f.slider.value, "6");
  f.settings.update(12);
  assert.equal(f.slider.value, "12");
});

test("invalid or incomplete mode snapshots never publish mismatched bounds or a clamped distance", (t) => {
  const requests = [];
  const f = fixture(t, () => {}, { withMode: true, onModeChange: (mode) => requests.push(mode) });
  f.settings.update({ mode: "extended", radius: 12, maxRadius: 12 });
  for (const value of [
    { mode: "nearby" },
    { mode: "nearby", radius: 12, maxRadius: 4 },
    { mode: "nearby", radius: 3, maxRadius: 12 },
    { mode: "nearby", radius: "3", maxRadius: 4 },
    { mode: "extended", radius: 6, maxRadius: 4 },
    { mode: "far", radius: 3, maxRadius: 12 },
    { mode: "nearby", radius: NaN, maxRadius: 4 },
    { mode: "nearby", radius: 3.5, maxRadius: 4 },
    {},
  ]) {
    f.settings.update(value);
    assert.equal(f.mode.value, "extended");
    assert.equal(f.slider.max, "12");
    assert.equal(f.slider.value, "12");
  }
  for (const mode of ["far", "", "Nearby", "12"]) {
    f.mode.value = mode;
    f.mode.dispatchEvent(new Event("change"));
    assert.equal(f.mode.value, "extended");
  }
  assert.deepEqual(requests, []);
});

test("mode changes support synchronous host acceptance without emitting extra requests", (t) => {
  const requests = [];
  let f;
  f = fixture(t, () => {}, { withMode: true, onModeChange: (mode) => {
    requests.push(mode);
    f.settings.update(mode === "extended"
      ? { mode, radius: 12, maxRadius: 12 }
      : { mode, radius: 2, maxRadius: 4 });
  } });
  for (const [mode, radius, max] of [["extended", "12", "12"], ["nearby", "2", "4"]]) {
    f.mode.value = mode;
    f.mode.dispatchEvent(new Event("change"));
    assert.equal(f.mode.value, mode);
    assert.equal(f.slider.value, radius);
    assert.equal(f.slider.max, max);
  }
  assert.deepEqual(requests, ["extended", "nearby"]);
});

test("mode and distance bindings disable independently and both dispose their listeners", (t) => {
  const requests = [];
  const f = fixture(t, undefined, { withMode: true, onModeChange: (mode) => requests.push(mode) });
  assert.equal(f.slider.disabled, true);
  assert.equal(f.mode.disabled, false);
  f.events.dispose();
  f.mode.value = "extended";
  f.mode.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, []);
  const distanceOnly = fixture(t, (radius) => requests.push(radius), { withMode: true });
  assert.equal(distanceOnly.mode.disabled, true);
  assert.equal(distanceOnly.slider.disabled, false);
  distanceOnly.events.dispose();
  distanceOnly.slider.value = "2";
  distanceOnly.slider.dispatchEvent(new Event("change"));
  assert.deepEqual(requests, []);
});
