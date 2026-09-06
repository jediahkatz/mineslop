import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_RENDER_RADIUS, MAX_RENDER_RADIUS, DEFAULT_RENDER_RADIUS,
  MAX_WORLD_RADIUS, MAX_RESIDENT_CHUNKS,
  renderDistanceLayout, streamingDistanceLayout, validateRenderDistanceOverride,
} from "../src/render-distance.js";
import { validateLightCapabilities } from "../src/light-page-layout.js";

const gpu = (size = 2048, layers = 256, samplers = 16) => ({
  MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
  isContextLost: () => false,
  getParameter: (key) => ({ 1: size, 2: layers, 3: samplers })[key],
});

test("shared full-detail R12 contract retains exact historical radii and halos", () => {
  assert.deepEqual(
    [MIN_RENDER_RADIUS, MAX_RENDER_RADIUS, DEFAULT_RENDER_RADIUS, MAX_WORLD_RADIUS, MAX_RESIDENT_CHUNKS],
    [2, 12, 12, 14, 841],
  );
  assert.deepEqual(renderDistanceLayout(12), {
    radius: 12, tiles: 25, visibleChunks: 625, sourceChunks: 729, spareChunks: 841,
  });
  for (let radius = 0; radius <= MAX_RENDER_RADIUS; radius++) {
    const detail = renderDistanceLayout(radius), streaming = streamingDistanceLayout(radius);
    assert.ok(Object.isFrozen(detail) && Object.isFrozen(streaming));
    assert.deepEqual(detail, {
      radius, tiles: radius * 2 + 1, visibleChunks: (radius * 2 + 1) ** 2,
      sourceChunks: (radius * 2 + 3) ** 2, spareChunks: (radius * 2 + 5) ** 2,
    });
    assert.deepEqual(streaming, {
      detailRadius: radius, sourceRadius: radius + 1, dependencyRadius: radius + 2,
      demandRadius: radius + 2, retentionRadius: radius + 2,
      demandChunks: detail.spareChunks, retainedChunks: detail.spareChunks,
    });
    assert.ok(streaming.retainedChunks <= MAX_RESIDENT_CHUNKS);
  }
});

test("R2 through R12 accept minimum paged WebGL2 capabilities at every supported height", () => {
  for (let height = 16; height <= 384; height += 16)
    for (let radius = MIN_RENDER_RADIUS; radius <= MAX_RENDER_RADIUS; radius++) {
      assert.equal(validateLightCapabilities(gpu(), height, radius), radius);
      assert.equal(validateRenderDistanceOverride(radius, gpu(), height), radius);
    }
});

test("distance validation rejects invalid bounds and unavailable or insufficient paged devices", () => {
  for (const value of [-1, 12.1, 13, NaN, Infinity, -Infinity, undefined, null, "12", {}, true]) {
    assert.throws(() => renderDistanceLayout(value), RangeError);
    assert.throws(() => streamingDistanceLayout(value), RangeError);
    if (value !== null) assert.throws(() => validateRenderDistanceOverride(value, gpu(), 384), RangeError);
  }
  for (const radius of [0, 1])
    assert.throws(() => validateRenderDistanceOverride(radius, gpu(), 384), /override 2–12/);
  for (const height of [0, 15, 17, 383, 400, NaN, Infinity, undefined, "384"])
    assert.throws(() => validateRenderDistanceOverride(12, gpu(), height), /Unsupported lighting height/);
  for (const context of [null, undefined, { ...gpu(), isContextLost: () => true }])
    assert.throws(() => validateRenderDistanceOverride(12, context, 384), /live WebGL2 context/);
  for (const limits of [[2047, 256, 16], [2048, 255, 16], [2048, 256, 15],
    [NaN, 256, 16], [2048, Infinity, 16], [2048, 256, undefined]]) {
    const context = gpu(...limits);
    // Explicit undefined represents an unavailable queried limit, not a helper default.
    context.getParameter = (key) => limits[key - 1];
    assert.throws(() => validateRenderDistanceOverride(12, context, 384), /WebGL2 limits/);
  }
  const inaccessible = {
    isContextLost: () => assert.fail("null override cannot inspect the GPU"),
    getParameter: () => assert.fail("null override cannot inspect limits"),
  };
  assert.equal(validateRenderDistanceOverride(null, inaccessible, NaN), null);
  assert.equal(validateRenderDistanceOverride(null, null, undefined), null);
});
