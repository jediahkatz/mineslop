import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE } from "../src/block-state.js";
import { CaveDaylight, CAVE_DAYLIGHT_LIMITS } from "../src/cave-daylight.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { raycast } from "../src/raycast.js";
import { SkyColumns, SKY_COLUMN_LIMITS, UNKNOWN_SKY_HEIGHT } from "../src/sky-columns.js";
import { daylightTunnel } from "./daylight-fixture.js";
import { ENTRANCE_SURFACES, surfaceAccess, surfaceTunnel } from "./daylight-surface-fixture.js";

function sampler(t, fixture) {
  const columns = new SkyColumns();
  const daylight = new CaveDaylight(columns);
  t.after(() => columns.dispose());
  return {
    columns,
    daylight,
    at(x, forward = { x: 1, y: 0, z: 0 }) {
      columns.begin(fixture.world);
      return daylight.sample(fixture.world, fixture.position(x), forward);
    },
  };
}

test("entrance fill falls with geometry distance, not cave labels, elapsed time or looking direction", (t) => {
  const fixture = daylightTunnel();
  const probe = sampler(t, fixture);
  let previous = probe.at(-0.5);
  assert.equal(previous.directSky, true);
  assert.equal(previous.exposure, 1);
  const samples = [];
  for (let x = -0.25; x <= 24.5; x += 0.25) {
    const next = probe.at(x);
    assert.ok(next.known && next.skyVisible);
    assert.ok(Math.abs(previous.exposure - next.exposure) < 0.08, `x=${x}`);
    assert.ok(next.sources.length <= CAVE_DAYLIGHT_LIMITS.sources);
    assert.ok(next.rays <= CAVE_DAYLIGHT_LIMITS.sources + CAVE_DAYLIGHT_LIMITS.directions + 1);
    previous = next;
    if (Number.isInteger(x)) samples.push([x, next.exposure]);
  }
  assert.equal(previous.exposure, 0, "a visible distant mouth does not light the deep room");
  probe.columns.updateField(fixture.position(24.5), 4);
  assert.deepEqual(
    sampleDaylightAt(probe.columns, fixture.position(24.5)),
    { direct: 0, ambient: 0 },
    "zero exposure at the camera does not require deleting light from remote entrance surfaces"
  );
  assert.equal(probe.at(24.5, { x: -1, y: 0, z: 0 }).exposure, 0);
  const first = probe.at(4.5);
  const back = probe.at(4.5, { x: -1, y: 0, z: 0 });
  assert.equal(back.exposure, first.exposure, "turning is not a brightness control");
  t.diagnostic(JSON.stringify({ spatialEntranceFalloff: samples }));
});

test("a real closure, eviction, or world replacement invalidates observed sky without a grace period", (t) => {
  const fixture = daylightTunnel();
  const probe = sampler(t, fixture);
  assert.ok(probe.at(4.5).exposure > 0);
  fixture.close();
  const closed = probe.at(4.5);
  assert.equal(closed.exposure, 0);
  assert.equal(closed.skyVisible, false);
  assert.deepEqual(probe.daylight.anchors, []);
  fixture.close(false);
  assert.ok(probe.at(4.5).exposure > 0);
  assert.equal(probe.at(32.5).skyVisible, true);
  fixture.world.chunks.delete("1,0");
  const acrossUnknown = probe.at(32.5);
  assert.equal(acrossUnknown.known, true, "the camera column itself is still loaded");
  assert.equal(acrossUnknown.skyVisible, false, "a missing intermediate column is not a daylight path");
  assert.equal(acrossUnknown.exposure, 0);
  const unknown = probe.at(24.5);
  assert.equal(unknown.known, false);
  assert.equal(unknown.skyVisible, false);
  assert.equal(unknown.exposure, 0);
  fixture.world.epoch++;
  fixture.close();
  assert.equal(probe.at(4.5).skyVisible, false);
});

test("the ceiling texture preserves exposed surfaces independently of camera light and responds to high roof edits", (t) => {
  const fixture = daylightTunnel(-32);
  const probe = sampler(t, fixture);
  const access = probe.at(8.5);
  probe.columns.updateField(fixture.position(8.5), 2);
  const exterior = fixture.position(-2.5);
  const interior = fixture.position(4.5);
  assert.deepEqual(sampleDaylightAt(probe.columns, exterior), { direct: 1, ambient: 1 });
  const litEntry = sampleDaylightAt(probe.columns, interior);
  assert.equal(litEntry.direct, 0, "a roof blocks the solar key even near a doorway");
  assert.ok(litEntry.ambient > 0 && litEntry.ambient < 1);
  assert.deepEqual(sampleDaylightAt(probe.columns, fixture.position(32.5)), { direct: 0, ambient: 0 });
  assert.ok(access.sources.length > 0);
  assert.deepEqual(probe.at(32.5).sources, []);
  assert.deepEqual(sampleDaylightAt(probe.columns, interior), litEntry, "changing camera access does not change surface daylight");
  fixture.world.put(-3, 100, 2, BLOCK.OAK_SLAB, BLOCK_STATE.TOP);
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.equal(probe.columns.ceiling(-2.5, 2.5), 101);
  assert.equal(sampleDaylightAt(probe.columns, exterior).direct, 0, "a high opaque slab blocks direct sky; neighboring open sky may still provide diffuse light");
  fixture.world.put(-3, 100, 2, BLOCK.GLASS);
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.deepEqual(sampleDaylightAt(probe.columns, exterior), { direct: 1, ambient: 1 });
  fixture.world.chunks.delete("-1,0");
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.equal(probe.columns.ceiling(-2.5, 2.5), UNKNOWN_SKY_HEIGHT);
  assert.deepEqual(sampleDaylightAt(probe.columns, exterior), { direct: 0, ambient: 0 });
});

test("skylight work is bounded to resident columns and never queries a generator or admits geometry", (t) => {
  const fixture = daylightTunnel();
  fixture.world.getBiome = fixture.world.ensureArea = fixture.world.generate = () =>
    assert.fail("geometry lighting cannot generate or classify terrain");
  fixture.world.chunks.values = fixture.world.chunks[Symbol.iterator] = () =>
    assert.fail("do not scan the world's resident map");
  const probe = sampler(t, fixture);
  const count = fixture.world.chunks.size;
  const access = probe.at(8.5);
  probe.columns.updateField(fixture.position(8.5), 1000);
  assert.equal(fixture.world.chunks.size, count);
  assert.ok(probe.columns.cache.size <= SKY_COLUMN_LIMITS.cachedChunks);
  assert.equal(probe.columns.data.byteLength, 144 * 144 * 4);
  assert.ok(probe.columns.stats.chunkBuilds <= count);
  assert.ok(probe.columns.stats.cellReads <= count * 16 * 16 * SKY_COLUMN_LIMITS.height);
  const textureVersion = probe.columns.texture.version;
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 1000);
  assert.equal(probe.columns.stats.chunkBuilds, 0, "unchanged chunks reuse revision-keyed ceiling data");
  assert.equal(probe.columns.texture.version, textureVersion);
  t.diagnostic(JSON.stringify({ rays: access.rays, residentColumns: count, textureBytes: probe.columns.data.byteLength }));
});

test("ceiling cache detects replacement objects without retaining evicted terrain buffers", (t) => {
  const fixture = daylightTunnel();
  const probe = sampler(t, fixture);
  probe.columns.begin(fixture.world);
  assert.equal(probe.columns.ceiling(8, 2), 12);
  const original = fixture.world.chunks.get("0,0");
  fixture.world.chunks.set("0,0", {
    ...original,
    blocks: new Uint16Array(original.blocks.length),
    sections: new Map(),
  });
  // Even a legacy replacement that reuses revision/incarnation values is new.
  probe.columns.begin(fixture.world);
  assert.equal(probe.columns.ceiling(8, 2), fixture.world.spec.minY);
  for (const entry of probe.columns.cache.values())
    assert.ok(entry.stamps.every((stamp) => stamp === undefined || typeof stamp === "number"));
});

test("[surface-light] fixed roofed entrance faces stay lit when the observer crosses the light radius", (t) => {
  const fixture = surfaceTunnel();
  const { columns, daylight } = sampler(t, fixture);
  const samples = [4.5, 15, 15.5, 16, 16.25, 16.5, 24.5, 32.5]
    .map((x) => surfaceAccess(fixture, columns, daylight, x));
  t.diagnostic(JSON.stringify({ fixedEntranceSurfaces: samples }));
  for (const state of samples) {
    assert.ok(state.access.known && state.access.skyVisible);
    assert.ok(state.access.sources.length <= CAVE_DAYLIGHT_LIMITS.sources);
    assert.ok(state.work.rays <= CAVE_DAYLIGHT_LIMITS.sources + CAVE_DAYLIGHT_LIMITS.directions + 1);
    assert.ok(state.work.cache <= SKY_COLUMN_LIMITS.cachedChunks);
    assert.equal(state.work.bytes, 144 * 144 * 4);
    for (let i = 0; i < ENTRANCE_SURFACES.length; i++) {
      const surface = state.surfaces[i];
      assert.ok(surface.known && surface.visible, `${surface.name} must be resident and still visible`);
      assert.equal(surface.mask.direct, 0, "the selected face is underneath a real roof");
    }
  }
  assert.equal(samples.at(-1).access.exposure, 0, "deep camera exposure must remain zero");
  for (const state of samples.slice(1))
    for (let i = 0; i < ENTRANCE_SURFACES.length; i++)
      assert.ok(
        Math.abs(state.surfaces[i].mask.ambient - samples[0].surfaces[i].mask.ambient) < 0.08,
        `${state.surfaces[i].name} loses entrance illumination at observer x=${state.camera[0]}`
      );
});

test("[surface-light] a cold outside observer does not carry the entrance's daylight source", (t) => {
  const fixture = surfaceTunnel();
  const { columns } = sampler(t, fixture);
  const cold = [-28.5, -16.5, -8.5, -0.5].map((x) =>
    surfaceAccess(fixture, columns, new CaveDaylight(columns), x, { x: 1, y: 0, z: 0 }));
  const daylight = new CaveDaylight(columns);
  const returning = [4.5, -0.5, -8.5, -16.5, -28.5].map((x) =>
    surfaceAccess(fixture, columns, daylight, x, { x: 1, y: 0, z: 0 }));
  t.diagnostic(JSON.stringify({ outsideEntranceSurfaces: { cold, returning } }));
  for (const state of [...cold, ...returning.slice(1)]) {
    assert.equal(state.access.directSky, true);
    assert.equal(state.access.exposure, 1);
    for (const surface of state.surfaces)
      assert.ok(surface.known && surface.visible && surface.mask.direct === 0);
  }
  const reference = cold.at(-1);
  for (const state of [...cold, ...returning])
    for (let i = 0; i < ENTRANCE_SURFACES.length; i++)
      assert.ok(
        Math.abs(state.surfaces[i].mask.ambient - reference.surfaces[i].mask.ambient) < 0.08,
        `${state.surfaces[i].name} follows the outside observer at x=${state.camera[0]}`
      );
});

test("[surface-light] retained openings cannot illuminate the far face of a sealed side room", (t) => {
  const fixture = surfaceTunnel();
  for (let x = 1; x <= 5; x++)
    for (let z = 5; z <= 8; z++)
      for (let y = 7; y <= 11; y++)
        if (x === 1 || x === 5 || z === 5 || z === 8 || y === 7 || y === 11)
          fixture.world.put(x, y, z, BLOCK.STONE);
  const { columns, daylight } = sampler(t, fixture);
  const state = surfaceAccess(fixture, columns, daylight, 4.5);
  const face = { x: 2.53125, y: 9.53125, z: 6.02 };
  const mask = sampleDaylightAt(columns, face);
  const blockers = state.access.sources.map((source) => {
    const direction = { x: face.x - source.x, y: face.y - source.y, z: face.z - source.z };
    const hit = raycast(fixture.world, source, direction, Math.hypot(direction.x, direction.y, direction.z), { channel: "occlusion" });
    return hit ? { x: hit.x, y: hit.y, z: hit.z, id: hit.id } : null;
  });
  t.diagnostic(JSON.stringify({ sealedFace: { mask, blockers } }));
  assert.ok(state.access.exposure > 0);
  assert.ok(blockers.length > 0 && blockers.every(Boolean), "all source-to-face paths cross stone");
  assert.equal(mask.direct, 0);
  assert.equal(mask.ambient, 0, "camera-visible sources must not leak through an opaque side wall");
});
