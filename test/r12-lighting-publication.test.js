import assert from "node:assert/strict";
import test from "node:test";
import { PagedLightStore } from "../src/paged-light-store.js";
import { BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT, LIGHT_UPLOAD_PUBLICATIONS, lightUploadBudget } from "../src/light-page-layout.js";
import { SkyColumns } from "../src/sky-columns.js";
import { DaylightMaterial } from "../src/daylight-material.js";
import { checkedLightTransfer } from "../src/light-transfer.js";
import { authoredLightingWorld, faultRenderer } from "./r12-lighting-regression-fixture.js";

for (const layout of [BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT])
  for (const mode of ["throw", "oom", "loss"])
    test(`${layout.width}px table ${mode}: durable unpublished high-slot owner and retry`, () => {
      const store = new PagedLightStore(layout, 625, 24), renderer = faultRenderer(), index = 14999;
      const data = new Uint8Array(layout.width * layout.height); data[1] = 12;
      store.publish(store.claim(index, "before"), mode === "oom" ? 12 : data);
      renderer.mode = mode;
      renderer.fail = (call, source) => call.target === store.table && source.image.data[index] !== 0;
      const budget = lightUploadBudget();
      assert.throws(() => store.flush(renderer, budget), /Lighting|lighting/);
      assert.equal(store.mapping[index], 0);
      assert.equal(renderer.gpu.get(store.table)?.[index] ?? 0, 0);
      assert.equal(store.sample(index, 1), undefined);
      assert.equal(store.queue.size, 1);
      assert.equal(store.mappingDirty, true);
      assert.ok(store.resources().pendingRequired > 0);
      assert.ok(budget.uploadedBytes <= 131072 && budget.copies >= 0);
      renderer.lost = false;
      store.flush(renderer);
      assert.ok(store.mapping[index] > 0);
      assert.equal(renderer.gpu.get(store.table)[index], store.mapping[index]);
      assert.equal(store.queue.size, 0);
      assert.equal(store.sample(index, 1), 12);
      store.dispose();
    });

test("failed page transfer cannot publish its handle; unpublished slot reuse rejects old tickets", () => {
  const store = new PagedLightStore(BLOCK_PAGE_LAYOUT, 1, 1), renderer = faultRenderer();
  const data = new Uint8Array(6400); data[1] = 9;
  const old = store.claim(0, "old"); store.publish(old, data);
  renderer.mode = "oom";
  renderer.fail = (call) => call.kind === "copy" && call.target.isDataArrayTexture;
  assert.throws(() => store.flush(renderer), /page data/);
  assert.equal(store.mapping[0], 0);
  assert.equal(store.staging.image.data, null);
  store.publish(store.claim(0, "new"), 7);
  assert.equal(store.publish(old, data), false);
  store.flush(renderer);
  assert.equal(store.sample(0, 1), 7);
  assert.equal(store.queue.size, 0);
  const ticket = store.claim(0, "new");
  store.restoreGPU();
  assert.equal(store.publish(ticket, data), false);
  assert.equal(store.mapping[0], 0);
  store.flush(renderer);
  assert.equal(store.sample(0, 1), 7);
  store.dispose();
});

test("all pending table invalidations precede page copies and abort the draw on failure", () => {
  const columns = new SkyColumns(0), host = new DaylightMaterial(columns), renderer = faultRenderer();
  const block = host.blockLight.store, surface = columns.surfaceLight.store;
  const data = new Uint8Array(6400); data[1] = 15;
  block.publish(block.claim(0, "old"), data); host.flush(renderer);
  block.publish(block.claim(0, "new"), data);
  surface.setAuxiliary(columns.skyIndex(0), 0);
  surface.mappingDirty = true;
  renderer.calls.length = 0;
  renderer.fail = (call) => call.target === surface.table;
  let draws = 0;
  assert.throws(() => { host.flush(renderer); draws++; }, /failure/);
  assert.equal(draws, 0);
  assert.equal(host.resources().ready, false);
  assert.ok(host.resources().pendingRequired > 0);
  assert.deepEqual(renderer.calls.map((c) => c.target), [block.table, surface.table]);
  host.flush(renderer);
  assert.equal(block.sample(0, 1), 15);
  renderer.lost = true;
  assert.throws(() => host.flush(renderer), /barrier unavailable/);
  assert.equal(host.resources().ready, false);
  host.dispose(); columns.dispose();
});

for (const failure of ["sky", "table"])
  test(`${failure} OOM retains sky publication until data and auxiliary table succeed`, () => {
    const columns = new SkyColumns(0), renderer = faultRenderer();
    const entry = { heights: new Float32Array(256).fill(11), complete: true, serial: 1 };
    columns.cache.set("0,0", entry); columns.skyOwners[0] = "0,0";
    columns.skyUploads.set(0, { key: "0,0", entry, stamp: "0,0:1" });
    renderer.mode = "oom";
    const store = columns.surfaceLight.store, at = columns.skyIndex(0);
    renderer.fail = (call, source) => failure === "sky" ? call.target === columns.texture :
      call.target === store.table && source.image.data[at] === 1;
    assert.throws(() => columns.flush(renderer, lightUploadBudget()), /Lighting/);
    assert.equal(columns.skyUploaded[0], null);
    assert.equal(columns.skyUploads.size, 1);
    assert.equal(store.mapping[at], 0);
    assert.equal(columns.staging.image.data, null);
    columns.flush(renderer, lightUploadBudget());
    assert.equal(columns.skyUploaded[0], "0,0:1");
    assert.equal(columns.skyUploads.size, 0);
    assert.equal(renderer.gpu.get(store.table)[at], 1);
    assert.equal(renderer.gpu.get(columns.texture)[0], 11);
    columns.dispose();
  });

test("real material palette OOM is unready and retries initialization before any draw", () => {
  const columns = new SkyColumns(0), host = new DaylightMaterial(columns), renderer = faultRenderer();
  columns.world = { dimension: "nether" };
  host.blockLight.store.publish(host.blockLight.store.claim(0, "dark"), 0);
  renderer.mode = "oom";
  renderer.fail = (call) => call.target === host.blockLight.paletteTexture;
  assert.throws(() => host.flush(renderer), /palette.*1285/);
  assert.notEqual(host.uploadedPalette, host.blockLight.paletteTexture);
  assert.equal(host.resources().ready, false);
  assert.ok(host.resources().pendingPalette > 0);
  host.flush(renderer);
  assert.equal(host.resources().ready, true);
  assert.equal(renderer.calls.filter((c) => c.target === host.blockLight.paletteTexture).length, 2);
  assert.ok(renderer.gpu.has(host.blockLight.paletteTexture));
  host.dispose(); columns.dispose();
});

test("pre-existing GL errors are reported once, not globally drained", () => {
  let reads = 0, transfers = 0;
  const renderer = { getContext: () => ({
    NO_ERROR: 0, isContextLost: () => false, getError: () => { reads++; return 1282; },
  }) };
  assert.throws(() => checkedLightTransfer(renderer, "test", () => transfers++), /pre-existing.*1282/);
  assert.equal(reads, 1);
  assert.equal(transfers, 0);
});

test("15,000 constant pages publish incrementally, retain readiness on retry, and recover after context loss", () => {
  const store = new PagedLightStore(BLOCK_PAGE_LAYOUT, 625, 24), renderer = faultRenderer();
  for (let i = 0; i < 15000; i++) store.publish(store.claim(i, `p${i}`), i % 17);
  const first = lightUploadBudget();
  store.flush(renderer, first);
  assert.equal(store.resources().readyPages, LIGHT_UPLOAD_PUBLICATIONS);
  assert.equal(store.queue.size, 15000 - LIGHT_UPLOAD_PUBLICATIONS);
  renderer.mode = "oom";
  renderer.fail = (call, source) => call.target === store.table && source.image.data[LIGHT_UPLOAD_PUBLICATIONS] !== 0;
  assert.throws(() => store.flush(renderer), /1285/);
  assert.equal(store.mapping[LIGHT_UPLOAD_PUBLICATIONS], 0);
  assert.equal(store.sample(0, 0), 0, "previously committed holders are not destroyed by failed publication");
  for (let frame = 0; store.queue.size && frame < 60; frame++) {
    const before = store.queue.size, budget = lightUploadBudget();
    store.flush(renderer, budget);
    assert.ok(before - store.queue.size <= LIGHT_UPLOAD_PUBLICATIONS);
    assert.ok(budget.uploadedBytes <= 131072 && budget.copies >= 0);
  }
  assert.equal(store.resources().pendingRequired, 0);
  assert.equal(renderer.gpu.get(store.table)[14999], store.mapping[14999]);
  renderer.lost = true;
  assert.throws(() => store.flush(renderer), /barrier unavailable/);
  assert.ok(store.resources().pendingRequired > 0);
  store.restoreGPU(); renderer.gpu.clear(); renderer.lost = false;
  assert.equal(store.mapping[14999], 0);
  for (let frame = 0; store.queue.size && frame < 60; frame++) store.flush(renderer);
  assert.equal(store.resources().pendingRequired, 0);
  assert.equal(renderer.gpu.get(store.table)[14999], store.mapping[14999]);
  store.dispose();
});

test("uncertified cache bytes count unique buffers, shared published pages once, dispose releases sky ownership", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(1, 16), columns = new SkyColumns(0);
  const center = world.chunks.get("0,0");
  center.blocks = center.blocks.slice(); center.blocks.fill(1, 10 * 256, 11 * 256);
  for (let i = 0; i < 100 && !columns.surfaceLight.cache.size; i++) {
    columns.begin(world); columns.updateField({ x: 8, y: 8, z: 8 }, 0);
  }
  const surface = columns.surfaceLight, entry = surface.cache.get("0,0");
  assert.equal(entry.certified, false);
  const page = entry.pages[0];
  assert.ok(page instanceof Uint8Array);
  assert.equal(surface.resources().canonicalBytes, page.byteLength);
  surface.store.publish(surface.store.claim(0, "shared"), page);
  assert.equal(surface.resources().canonicalBytes, page.byteLength);
  assert.equal(surface.resources().cacheBytes, page.byteLength);
  columns.dispose();
  const sky = new SkyColumns(12);
  assert.equal(sky.data.byteLength, 746496);
  sky.dispose();
  assert.equal(sky.data.byteLength, 0);
  assert.equal(sky.texture.image.data, null);
  assert.ok(Object.values(sky.resources()).every((value) => value === 0));
});
