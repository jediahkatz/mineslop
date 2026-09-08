import assert from "node:assert/strict";
import test from "node:test";
import { GameRenderer } from "../src/renderer.js";
import { checkedLightTransfer } from "../src/light-transfer.js";

function fixture() {
  const calls = [];
  const state = { lost: false, error: 0 };
  const gl = {
    isContextLost: () => state.lost,
    NO_ERROR: 0,
    getError() { const error = state.error; state.error = 0; return error; },
  };
  const g = Object.assign(Object.create(GameRenderer.prototype), {
    renderer: { getContext: () => gl, render: () => calls.push("draw") },
    lightingNeedsFlush: true,
    daylightMaterial: { flush: () => calls.push("flush") },
  });
  return { g, calls, state };
}

for (const latch of [true, false, undefined]) {
  test(`lost context skips all GPU work and preserves latch=${latch}`, () => {
    const { g, calls, state } = fixture();
    state.lost = true;
    g.lightingNeedsFlush = latch;
    g.sectionWater = { refresh: () => assert.fail("lost context reached water publication") };
    assert.equal(g.render(), false);
    assert.equal(g.render(), false);
    assert.deepEqual(calls, []);
    assert.equal(g.lightingNeedsFlush, latch);
  });
}

test("restored context consumes the retained flush exactly once before drawing", () => {
  const { g, calls, state } = fixture();
  state.lost = true;
  assert.equal(g.render(), false);
  state.lost = false;
  assert.equal(g.render(), true);
  assert.equal(g.lightingNeedsFlush, false);
  assert.equal(g.render(), true);
  assert.deepEqual(calls, ["flush", "draw", "draw"]);
});

for (const label of ["palette", "page data"]) {
  test(`${label} allocation/transfer errors still propagate and retain retry`, () => {
    const { g, calls, state } = fixture();
    let fail = true;
    g.daylightMaterial.flush = () => checkedLightTransfer(g.renderer, label, () => {
      calls.push("transfer");
      if (fail) state.error = 1285;
    });
    assert.throws(() => g.render(), new RegExp(`Lighting ${label} failed \\(WebGL 1285\\)`));
    assert.equal(g.lightingNeedsFlush, true);
    assert.deepEqual(calls, ["transfer"]);
    fail = false;
    assert.equal(g.render(), true);
    assert.equal(g.lightingNeedsFlush, false);
    assert.deepEqual(calls, ["transfer", "transfer", "draw"]);
  });
}

test("CPU renderer mocks without a WebGL context retain the original flush/draw contract", () => {
  for (const getContext of [undefined, () => null, () => ({})]) {
    const { g, calls } = fixture();
    g.renderer.getContext = getContext;
    assert.equal(g.render(), true);
    assert.equal(g.lightingNeedsFlush, false);
    assert.deepEqual(calls, ["flush", "draw"]);
  }
});
