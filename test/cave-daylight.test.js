import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE } from "../src/block-state.js";
import { CaveDaylight, CAVE_DAYLIGHT_LIMITS } from "../src/cave-daylight.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { SkyColumns, SKY_COLUMN_LIMITS, UNKNOWN_SKY_HEIGHT } from "../src/sky-columns.js";
import { daylightTunnel } from "./daylight-fixture.js";

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
  assert.equal(previous.sources.length, 0);
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
  assert.deepEqual(sampleDaylightAt(probe.columns, [], exterior), { direct: 1, ambient: 1 });
  assert.deepEqual(sampleDaylightAt(probe.columns, [], interior), { direct: 0, ambient: 0 });
  const litEntry = sampleDaylightAt(probe.columns, access.sources, interior);
  assert.equal(litEntry.direct, 0, "a roof blocks the solar key even near a doorway");
  assert.ok(litEntry.ambient > 0 && litEntry.ambient < 1);
  assert.deepEqual(sampleDaylightAt(probe.columns, access.sources, fixture.position(32.5)), { direct: 0, ambient: 0 });
  fixture.world.put(-3, 100, 2, BLOCK.OAK_SLAB, BLOCK_STATE.TOP);
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.equal(probe.columns.ceiling(-2.5, 2.5), 101);
  assert.deepEqual(sampleDaylightAt(probe.columns, [], exterior), { direct: 0, ambient: 0 });
  fixture.world.put(-3, 100, 2, BLOCK.GLASS);
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.deepEqual(sampleDaylightAt(probe.columns, [], exterior), { direct: 1, ambient: 1 });
  fixture.world.chunks.delete("-1,0");
  probe.columns.begin(fixture.world);
  probe.columns.updateField(fixture.position(8.5), 2);
  assert.equal(probe.columns.ceiling(-2.5, 2.5), UNKNOWN_SKY_HEIGHT);
  assert.deepEqual(sampleDaylightAt(probe.columns, [exterior], exterior), { direct: 0, ambient: 0 });
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
