import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GameRenderer } from "../src/renderer.js";

test("sustained slow frames reduce resolution without changing world or quality features", (t) => {
  const previous = globalThis.window;
  globalThis.window = {
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  let pixelRatio = 1;
  let size;
  const world = {};
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    world,
    quality: "low",
    camera: new THREE.PerspectiveCamera(),
    container: { clientWidth: 1920, clientHeight: 1080 },
    renderer: {
      setPixelRatio(value) {
        pixelRatio = value;
      },
      setSize(width, height) {
        size = [width, height];
      },
    },
  });
  renderer.resize();
  assert.equal(pixelRatio, 0.8);
  for (let frame = 0; frame < 250; frame++) renderer.observeFrame(40);
  assert.ok(pixelRatio < 0.8 && pixelRatio >= 0.5);
  assert.deepEqual(size, [1920, 1080]);
  assert.equal(renderer.quality, "low");
  assert.equal(renderer.renderRadius, 2);
  assert.equal(renderer.world, world);
  assert.equal(renderer.camera.aspect, 1920 / 1080);
  const retained = pixelRatio;
  for (let frame = 0; frame < 100; frame++)
    renderer.observeFrame(500, { paused: true });
  assert.equal(pixelRatio, retained);
  renderer.resize({ resetScale: true });
  assert.equal(pixelRatio, 0.8);
});

test("software rendering starts within a measured pixel budget at full HD", (t) => {
  const previous = globalThis.window;
  globalThis.window = {
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  let pixelRatio;
  let resizes = 0;
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    softwareRendering: true,
    quality: "low",
    camera: new THREE.PerspectiveCamera(),
    container: { clientWidth: 1920, clientHeight: 1080 },
    renderer: {
      setPixelRatio(value) {
        pixelRatio = value;
      },
      setSize() {
        resizes++;
      },
    },
  });
  renderer.resize();
  assert.ok(pixelRatio >= renderer.scaleController.minRatio);
  assert.ok(pixelRatio < renderer.scaleController.maxRatio);
  renderer.resize();
  assert.equal(
    resizes,
    1,
    "duplicate resize listeners do not reallocate the drawing buffer"
  );
});
