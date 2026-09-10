import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import { qualityFogDistance } from "../src/renderer.js";
import { lightWorld } from "./block-light-fixture.js";
import { daylightRenderer } from "./daylight-fixture.js";

// Real renderer/scene/lighting logic; no WebGL output or performance assertion.
function fixture(t, { dimension = "overworld", quality = "medium", version = 4 } = {}) {
  const world = lightWorld({ dimension, version });
  const graphics = daylightRenderer(t, world, { x: 8, y: 8, z: 8 }, quality);
  const gpu = {
    MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
    isContextLost: () => false,
    getParameter: (key) => ({ 1: 2048, 2: 256, 3: 16 })[key],
  };
  graphics.renderer.getContext = () => gpu;
  t.after(() => graphics.daylightMaterial?.dispose());
  return { world, graphics, gpu };
}

test("nearby mode releases the far owner, its scene callback and caches without replacing native resources", (t) => {
  const { world, graphics } = fixture(t, { quality: "high" });
  graphics.setRenderDistanceOverride(12);
  const previous = graphics.distant, beforeSceneRender = previous._beforeSceneRender;
  const resourceRevision = graphics.meshResourceRevision ?? 0;
  const native = {
    scene: graphics.scene, chunks: graphics.chunks, materials: graphics.materials,
    world, camera: graphics.camera, atmosphere: graphics.atmosphere,
    position: graphics.camera.position.toArray(),
  };
  graphics.nativeBoundaryCache = { old: true };
  graphics.detailBatchCache = { old: true };
  const dispose = t.mock.method(previous, "dispose");
  assert.equal(graphics.configureTerrain({ radius: null, distantTerrain: false }), 4);
  assert.equal(graphics.meshResourceRevision, resourceRevision + 1, "far-owner release invalidates admission");
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(previous._disposed, true);
  assert.equal(previous.group.parent, null);
  assert.equal(graphics.scene.onBeforeRender, beforeSceneRender);
  assert.equal(graphics.distant, null);
  assert.equal(graphics.nativeBoundaryCache, null);
  assert.equal(graphics.detailBatchCache, null);
  assert.equal(graphics.scene.fog.far, qualityFogDistance(4));
  assert.equal(graphics.viewCenter, null);
  assert.equal(graphics.expandedFog, undefined);
  for (const key of ["scene", "chunks", "materials", "world", "camera", "atmosphere"])
    assert.equal(graphics[key], native[key]);
  assert.deepEqual(graphics.camera.position.toArray(), native.position);
  assert.equal(graphics.quality, "high");
  assert.equal(graphics.configureTerrain({ radius: 2, distantTerrain: false }), 2);
  assert.equal(graphics.meshResourceRevision, resourceRevision + 1, "radius-only nearby changes retain admission");
  assert.equal(dispose.mock.callCount(), 1);
});

for (const dimension of ["overworld", "nether", "end"])
  test(`nearby ${dimension} frames keep finite native fog and lighting without any distant update or handoff census`, (t) => {
    const { world, graphics } = fixture(t, { dimension });
    assert.equal(graphics.configureTerrain({ radius: null, distantTerrain: false }), 3);
    t.mock.method(graphics, "detailBatchCoverage", () => assert.fail("nearby frames cannot census LOD handoff"));
    t.mock.method(DistantTerrain.prototype, "update", () => assert.fail("nearby frames cannot sample distant terrain"));
    world.ensureArea = world._generateSync = () => assert.fail("renderer cannot generate terrain");
    const chunks = world.chunks, revision = world._editRevision;
    for (let frame = 1; frame <= 3; frame++)
      graphics.update(0.02, frame * 0.02, graphics.camera.position);
    assert.equal(graphics.distant, null);
    assert.equal(graphics.nativeBoundaryCache, null);
    assert.equal(graphics.detailBatchCache, null);
    assert.equal(world.chunks, chunks);
    assert.equal(world._editRevision, revision);
    assert.ok(graphics.daylightMaterial);
    assert.ok(Number.isFinite(graphics.scene.fog.near));
    assert.ok(Number.isFinite(graphics.scene.fog.far));
    assert.ok(graphics.scene.fog.near < graphics.scene.fog.far);
    assert.ok(graphics.camera.far >= graphics.scene.fog.far);
  });

for (const [name, block] of [["water", BLOCK.WATER], ["lava", BLOCK.LAVA]])
  test(`nearby mode retains the actual ${name} camera-medium path`, (t) => {
    const { world, graphics } = fixture(t);
    graphics.configureTerrain({ radius: 3, distantTerrain: false });
    world.put(8, Math.floor(graphics.camera.position.y), 8, block);
    graphics.update(0.02, 0.02, graphics.camera.position);
    assert.equal(graphics.distant, null);
    assert.equal(graphics.scene.fog.near, 0.2);
    assert.ok(Number.isFinite(graphics.scene.fog.far) && graphics.scene.fog.far > 0);
    if (name === "lava") {
      assert.equal(graphics.scene.fog.far, 4);
      assert.equal(graphics.scene.fog.color.getHexString(), "d66629");
    }
  });

test("invalid or lost-GPU mode requests leave the current radius, far owner and callback intact", (t) => {
  const { graphics, gpu } = fixture(t);
  graphics.setRenderDistanceOverride(6);
  const distant = graphics.distant, callback = graphics.scene.onBeforeRender;
  const resourceRevision = graphics.meshResourceRevision;
  const beforeFog = [graphics.scene.fog.near, graphics.scene.fog.far];
  for (const request of [
    { radius: 13, distantTerrain: false },
    { radius: "2", distantTerrain: false },
    { radius: 3, distantTerrain: "false" },
  ]) assert.throws(() => graphics.configureTerrain(request), RangeError);
  gpu.getParameter = () => 0;
  assert.throws(() => graphics.configureTerrain({ radius: 12, distantTerrain: true }), /WebGL2 limits/);
  gpu.isContextLost = () => true;
  assert.throws(() => graphics.configureTerrain({ radius: null, distantTerrain: false }), /live WebGL2/);
  graphics.renderer.getContext = () => null;
  assert.throws(() => graphics.configureTerrain({ radius: null, distantTerrain: false }), /live WebGL2/);
  assert.equal(graphics.renderRadius, 6);
  assert.equal(graphics.distant, distant);
  assert.equal(distant._disposed, false);
  assert.equal(graphics.scene.onBeforeRender, callback);
  assert.equal(graphics.meshResourceRevision, resourceRevision, "rejected requests do not invalidate admission");
  assert.deepEqual([graphics.scene.fog.near, graphics.scene.fog.far], beforeFog);
});

test("extended re-entry creates a fresh far owner bound to current daylight, with no duplicate scene hooks", (t) => {
  const { graphics, world } = fixture(t);
  const previous = graphics.distant, originalCallback = previous._beforeSceneRender;
  const resourceRevision = graphics.meshResourceRevision ?? 0;
  graphics.configureTerrain({ radius: null, distantTerrain: false });
  assert.equal(graphics.meshResourceRevision, resourceRevision + 1);
  graphics.updateDaylight();
  const lighting = graphics.daylightMaterial;
  const installs = t.mock.method(lighting, "install");
  assert.equal(graphics.configureTerrain({ radius: 6, distantTerrain: true }), 6);
  assert.equal(graphics.meshResourceRevision, resourceRevision + 2, "fresh far-owner admission invalidates once");
  const next = graphics.distant;
  assert.ok(next instanceof DistantTerrain);
  assert.notEqual(next, previous);
  assert.equal(next.world, world);
  assert.equal(next._beforeSceneRender, originalCallback);
  assert.equal(graphics.scene.onBeforeRender, next._sceneRender);
  assert.equal(installs.mock.callCount(), 2);
  assert.deepEqual(installs.mock.calls.map((call) => call.arguments[0]),
    [next._terrainMaterial, next._waterMaterial]);
  assert.equal(graphics.configureTerrain({ radius: 12, distantTerrain: true }), 12);
  assert.equal(graphics.meshResourceRevision, resourceRevision + 2, "retaining the far owner retains admission");
  assert.equal(graphics.distant, next);
  assert.equal(installs.mock.callCount(), 2);
  graphics.configureTerrain({ radius: 3, distantTerrain: false });
  assert.equal(graphics.meshResourceRevision, resourceRevision + 3);
  assert.equal(next._disposed, true);
  assert.equal(graphics.scene.onBeforeRender, originalCallback);
  assert.equal(graphics.scene.children.some((child) => child.name === "Distant terrain"), false);
});

test("failed far lighting binding cleans its tentative owner without changing the active nearby view", (t) => {
  const { graphics } = fixture(t);
  graphics.configureTerrain({ radius: 2, distantTerrain: false });
  const before = {
    callback: graphics.scene.onBeforeRender,
    children: [...graphics.scene.children],
    fog: [graphics.scene.fog.near, graphics.scene.fog.far],
    resourceRevision: graphics.meshResourceRevision,
  };
  graphics.daylightMaterial = {
    install() { throw new Error("deliberate lighting binding refusal"); },
    dispose() {},
  };
  assert.throws(() => graphics.configureTerrain({ radius: 6, distantTerrain: true }),
    /lighting binding refusal/);
  assert.equal(graphics.renderRadius, 2);
  assert.equal(graphics.distant, null);
  assert.equal(graphics.scene.onBeforeRender, before.callback);
  assert.deepEqual(graphics.scene.children, before.children);
  assert.equal(graphics.meshResourceRevision, before.resourceRevision, "failed owner installation retains admission");
  assert.deepEqual([graphics.scene.fog.near, graphics.scene.fog.far], before.fog);
});
