import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { createTravelPreviewWorld, stageTravelDestination } from "../src/game-travel-stage.js";
import { MAX_WORLD_RADIUS, renderDistanceLayout, validateRenderDistanceOverride } from "../src/render-distance.js";
import { QUALITY } from "../src/renderer.js";
import { SkyColumns } from "../src/sky-columns.js";
import { buildingFixture } from "./building-fixture.js";
import { lightField, lightWorld, settleLight } from "./block-light-fixture.js";
import { daylightRenderer } from "./daylight-fixture.js";
import { flushColumns } from "./light-renderer-fixture.js";

const point = (x = 8, y = 8, z = 8) => ({ x, y, z });
const gpu = (layers = 256, size = 2048, samplers = 16) => ({
  NO_ERROR: 0, getError: () => 0,
  MAX_ARRAY_TEXTURE_LAYERS: 1, MAX_TEXTURE_SIZE: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
  isContextLost: () => false,
  getParameter: (key) => ({ 1: layers, 2: size, 3: samplers })[key],
});

test("distance opt-in validates device caps without changing quality effects or resolution", (t) => {
  assert.deepEqual(Object.values(QUALITY).map((q) => q.renderRadius), [2, 3, 4]);
  assert.deepEqual(renderDistanceLayout(6), {
    radius: 6, tiles: 13, visibleChunks: 169, sourceChunks: 225, spareChunks: 289,
  });
  assert.equal(validateRenderDistanceOverride(6, gpu(), 384), 6);
  for (const value of [-1, 0, 1, 6.1, 13, NaN, Infinity, undefined, "6"])
    assert.throws(() => validateRenderDistanceOverride(value, gpu(), 384), RangeError);
  assert.throws(() => validateRenderDistanceOverride(6, gpu(255), 384), /WebGL2 limits/);
  assert.throws(() => validateRenderDistanceOverride(6, gpu(256, 2047), 384), /WebGL2 limits/);
  assert.throws(() => validateRenderDistanceOverride(6, { ...gpu(), isContextLost: () => true }, 384), /live WebGL2/);
  assert.equal(validateRenderDistanceOverride(null, null, 384), null);
  const graphics = daylightRenderer(t, lightWorld(), point(), "high");
  graphics.renderer.getContext = () => gpu();
  graphics.scaleController = { pixelRatio: 1 };
  let resizes = 0;
  graphics.resize = () => resizes++;
  const rippleVersion = graphics.materials.water.version;
  assert.equal(graphics.setRenderDistanceOverride(6), 6);
  assert.equal(graphics.quality, "high");
  assert.equal(graphics.scaleController.pixelRatio, 1);
  assert.equal(graphics.materials.water.version, rippleVersion);
  assert.equal(resizes, 0);
  const viewCenter = graphics.viewCenter = "unchanged";
  const expandedFog = graphics.expandedFog = { far: 100 };
  const fog = { near: graphics.scene.fog.near, far: graphics.scene.fog.far };
  graphics.renderer.getContext = () => gpu(100);
  assert.throws(() => graphics.setRenderDistanceOverride(12), /WebGL2 limits/);
  assert.equal(graphics.renderRadius, 6, "rejected changes leave the active override intact");
  assert.equal(graphics.renderDistanceOverride, 6);
  assert.equal(graphics.viewCenter, viewCenter);
  assert.equal(graphics.expandedFog, expandedFog);
  assert.deepEqual({ near: graphics.scene.fog.near, far: graphics.scene.fog.far }, fog);
  assert.equal(resizes, 0);
  assert.equal(graphics.setRenderDistanceOverride(null), 4);
  graphics.renderer.getContext = () => gpu();
  graphics.setRenderDistanceOverride(12);
  graphics.updateDaylight();
  t.after(() => graphics.daylightMaterial.dispose());
  graphics.daylightMaterial.update(graphics.atmosphere);
  const previous = graphics.skyColumns.texture;
  let disposed = 0;
  previous.addEventListener("dispose", () => disposed++);
  graphics.setQuality("low");
  assert.equal(graphics.renderRadius, 12);
  assert.equal(graphics.renderDistanceOverride, 12);
  graphics.updateDaylight();
  graphics.daylightMaterial.update(graphics.atmosphere);
  assert.equal(disposed, 0);
  assert.equal(graphics.skyColumns.texture, previous);
  assert.equal(graphics.daylightMaterial.uniforms.uSurfaceField.value.z, 25);
  assert.equal(graphics.daylightMaterial.uniforms.uSurfaceLightPages.value, graphics.skyColumns.surfaceLight.store.table);
  assert.equal(graphics.setRenderDistanceOverride(null), 2);
  graphics.updateDaylight();
  graphics.daylightMaterial.update(graphics.atmosphere);
  assert.equal(disposed, 1);
  assert.equal(graphics.skyColumns.size, 112);
  assert.equal(graphics.daylightMaterial.uniforms.uSkyCeilings.value, graphics.skyColumns.texture);
  assert.equal(graphics.daylightMaterial.uniforms.uSurfaceField.value.z, 5);
});

test("radius-six surface halo settles and survives resize, modulo wrap and reversal read-only", (t) => {
  t.mock.method(performance, "now", () => 0);
  const coords = [];
  for (let z = -7; z <= 7; z++) for (let x = -7; x <= 7; x++) coords.push([x, z]);
  const world = lightWorld({ columns: coords });
  for (const [x, z] of coords) world.put(x * 16 + 8, 3, z * 16 + 8, BLOCK.STONE);
  const revisions = [...world.chunks].map(([key, chunk]) => [key, chunk.revision]);
  world.ensureArea = world.generate = () => assert.fail("lighting cannot load terrain");
  world.chunks.values = world.chunks[Symbol.iterator] = () => assert.fail("no resident-map scan");
  const sky = new SkyColumns(2);
  t.after(() => sky.dispose());
  const tick = (radius, x = 8) => {
    sky.begin(world);
    sky.updateField(point(x), radius);
    const layout = renderDistanceLayout(radius), light = sky.surfaceLight;
    assert.ok(sky.stats.surfaceBuilds <= 2);
    assert.ok(sky.stats.surfaceTopologyBuilds <= 18);
    assert.ok(sky.stats.surfaceStampChecks <= layout.spareChunks);
    assert.ok(sky.stats.cellReads <= 8192);
    assert.ok(sky.stats.surfaceCellReads <= 8192);
    assert.ok(sky.stats.surfaceVoxelVisits + sky.stats.surfaceFloodVisits + sky.stats.surfaceOutputVisits <= 32768);
    assert.ok(light.cache.size <= layout.sourceChunks);
    assert.ok(light.topology.cache.size <= layout.spareChunks);
    assert.ok(sky.cache.size <= layout.spareChunks);
    const upload = flushColumns(sky);
    assert.ok(upload.uploadedBytes <= 131072);
    return light.pending || sky.requests.size || sky.skyUploads.size || light.store.queue.size;
  };
  const settle = (radius, x = 8) => {
    for (let i = 0; i < 10000; i++) if (!tick(radius, x)) return i + 1;
    assert.fail("surface ring starved");
  };
  settle(4);
  const old = sky.surfaceLight.cache.get("0,0");
  settle(6);
  assert.equal(sky.surfaceLight.cache.get("0,0"), old);
  assert.equal(sky.surfaceLight.cache.size, 169);
  assert.equal(sky.surfaceLight.topology.cache.size, 225);
  tick(6);
  assert.equal(sky.stats.surfaceBuilds, 0);
  assert.equal(sky.stats.chunkBuilds, 0, "all 225 source ceilings fit without cache thrash");
  assert.equal(sky.stats.surfaceTopologyBuilds, 0);
  assert.equal(sky.stats.surfaceUploadBytes, 0);
  const expected = sampleDaylightAt(sky, point(8, 2));
  assert.equal(expected.direct, 0);
  assert.ok(expected.ambient > 0.5, "roofed receiver uses surface pages, not direct sky");
  // Move a full logical ring width: the receiver shares a modulo slot with old x=0.
  tick(6, 13 * 16 + 8);
  assert.deepEqual(sampleDaylightAt(sky, point(13 * 16 + 8, 2)), { direct: 0, ambient: 0 });
  settle(6, -8);
  settle(6);
  assert.deepEqual(sampleDaylightAt(sky, point(8, 2)), expected);
  settle(2);
  assert.equal(sky.surfaceLight.resources().requiredPages, 25 * sky.surfaceLight.height / 16);
  assert.ok(sky.surfaceLight.cache.size <= 49);
  assert.ok(sky.surfaceLight.topology.cache.size <= 81);
  assert.equal(world.chunks.size, revisions.length);
  assert.deepEqual(revisions.map(([key]) => [key, world.chunks.get(key).revision]), revisions);
});

test("radius-six block pages retain unavailable versus dark states through resize, wrap and recovery", (t) => {
  const world = lightWorld({ columns: [[0, 0], [1, 0], [13, 0]] }), field = lightField(t);
  world.ensureArea = world.generate = () => assert.fail("render-only field");
  world.put(8, 8, 8, BLOCK.TORCH);
  const revisions = [...world.chunks].map(([key, chunk]) => [key, chunk.revision]);
  world.chunks.values = world.chunks[Symbol.iterator] = () => assert.fail("no resident-map scan");
  settleLight(field, world, point(), 4);
  const old = field.cache.get("0,0,0");
  settleLight(field, world, point(), 6);
  assert.equal(field.cache.get("0,0,0"), old);
  assert.ok(field.sample(point(9))[0] > 0.5);
  assert.equal(field.valid[field.index(6, 6, 0)], 0, "missing page remains unavailable, not verified dark");
  assert.equal(field.valid[field.index(1, 0, 5)], 1, "constant zero uses handle one; unavailable uses zero");
  assert.equal(field.store.sample(field.index(1, 0, 5), 0), 0);
  assert.equal(field.store.sample(field.index(6, 6, 0), 0), undefined);
  field.restoreGPU();
  assert.ok(field.valid.every((value) => value === 0));
  settleLight(field, world, point(), 6);
  assert.ok(field.sample(point(9))[0] > 0.5);
  field.update(world, point(13 * 16 + 8), 6);
  assert.deepEqual(field.sample(point(13 * 16 + 9)), [0, 0, 0], "old modulo owner cannot leak torch light");
  settleLight(field, world, point(13 * 16 + 8), 6);
  settleLight(field, world, point(), 6);
  assert.ok(field.sample(point(9))[0] > 0.5);
  let disposed = 0;
  const oldStore = field.store;
  oldStore.table.addEventListener("dispose", () => disposed++);
  settleLight(field, world, point(), 2);
  assert.equal(disposed, 1);
  assert.equal(oldStore.disposed, true);
  assert.equal(field.tiles, 5);
  assert.ok(field.resources().metadataEntries <= 81 * 6);
  assert.deepEqual(revisions.map(([key]) => [key, world.chunks.get(key).revision]), revisions);
  world.put(8, 8, 8, BLOCK.AIR);
  field.update(world, point(), 2);
  assert.deepEqual(field.sample(point(9)), [0, 0, 0]);
});

for (const version of [3, 4]) {
  test(`v${version} paged allocation stays lazy and logical tables shrink with distance`, (t) => {
    const world = lightWorld({ version, columns: [] });
    const height = world.spec.maxY - world.spec.minY;
    const sky = new SkyColumns(2), block = new BlockLightField();
    t.after(() => { sky.dispose(); block.dispose(); });
    for (const radius of [2, 4, 6, 12, 2]) {
      sky.begin(world);
      sky.updateField(point(), radius);
      block.update(world, point(), radius);
      const layout = renderDistanceLayout(radius), surface = sky.surfaceLight.resources(), b = block.resources();
      assert.equal(b.atlasBytes, 0);
      assert.equal(surface.atlasBytes, 0);
      assert.equal(b.banks, 0, "unavailable receivers allocate no physical banks");
      assert.equal(surface.banks, 0);
      assert.equal(b.cpuBankBytes + surface.cpuBankBytes, 0);
      assert.equal(b.requiredPages, layout.visibleChunks * height / 16);
      assert.equal(surface.requiredPages, b.requiredPages);
      assert.equal(b.tableBytes, b.requiredPages * Uint16Array.BYTES_PER_ELEMENT);
      assert.equal(surface.tableBytes, layout.sourceChunks * (height / 16 + 1) * Uint16Array.BYTES_PER_ELEMENT);
      assert.equal(b.validityBytes, b.tableBytes);
      assert.equal(b.gpuBytes, b.tableBytes + 1);
      assert.equal(surface.gpuBytes, surface.tableBytes + 1);
      assert.equal(b.readyPages + surface.readyPages, 0);
      assert.equal(b.pendingRequired, b.requiredPages);
      assert.equal(surface.pendingRequired, surface.requiredPages);
      assert.equal(sky.data.byteLength, layout.sourceChunks * 1024);
      assert.ok(b.metadataEntries <= layout.spareChunks * height / 16);
      assert.ok(b.cachedSections <= layout.visibleChunks * height / 16);
      assert.ok(b.topologySections <= layout.sourceChunks * height / 16);
      assert.equal(block.stats.scans, 0, "empty world is not generated or marked lit");
      assert.ok(block.valid.every((v) => v === 0));
      assert.equal(BLOCK_LIGHT_LIMITS.uploads, 2);
      t.diagnostic(JSON.stringify({ height, radius, skyBytes: sky.data.byteLength,
        surfaceGpuBytes: surface.gpuBytes, blockGpuBytes: b.gpuBytes,
        tableBytes: surface.tableBytes + b.tableBytes, requiredPages: b.requiredPages,
        gpuTotalBytes: sky.data.byteLength + surface.gpuBytes + b.gpuBytes,
        scratchBytes: surface.scratchBytes + b.scratchBytes,
        metadataPrefixBytes: b.metadataPrefixBytes }));
    }
  });

  test(`v${version} native detached travel respects the shared explicit world bounds`, async (t) => {
    const f = buildingFixture(t, { generatorVersion: version });
    f.player.world = f.world;
    f.put(8, 20, 8, BLOCK.STONE);
    f.game.graphics.renderRadius = 6;
    const before = f.snapshot(), calls = [];
    const stage = await stageTravelDestination(f.game, { x: 8, y: 21, z: 8, dimension: "overworld" }, {
      worldFactory(source, dimension) {
        const preview = createTravelPreviewWorld(source, dimension);
        const ensure = preview.ensureArea.bind(preview);
        preview.ensureArea = (at, radius) => { calls.push(radius); return ensure(at, radius); };
        return preview;
      },
    });
    t.after(() => stage.dispose());
    assert.deepEqual(calls, [7]);
    assert.equal(stage.radius, 7);
    assert.equal(stage.world.chunks.size, 225);
    assert.equal(stage.current(), true);
    assert.deepEqual(f.snapshot(), before);
    stage.world.updateStreaming(stage.position, 6);
    assert.equal(stage.world._focus.radius, 8);
    assert.ok(stage.world.chunks.size <= 289);
    await assert.rejects(stage.world.ensureArea(stage.position, MAX_WORLD_RADIUS + 1),
      /radius 0–14/);
  });
}
