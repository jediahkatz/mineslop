import assert from "node:assert/strict";
import test from "node:test";
import { PagedLightStore } from "../src/paged-light-store.js";
import { BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT, lightLayout, lightUploadBudget } from "../src/light-page-layout.js";
import { ExactLightPalette, blockLightPalette } from "../src/block-light-palette.js";
import { cases, compare } from "./block-light-reference-fixture.js";
import { air, put } from "./block-light-reference-fixture.js";
import { BLOCKS } from "../src/blocks.js";
import { localLightStyle } from "../src/local-lighting.js";
import { Color } from "three";
import { flushRendererLighting, lightingSnapshotArrays, daylightTargetsReady } from "./light-renderer-fixture.js";

function renderer() {
  const calls = [];
  return { calls, initTexture() {}, getContext: () => ({ isContextLost: () => false, NO_ERROR: 0, getError: () => 0, MAX_TEXTURE_SIZE: 1,
    MAX_ARRAY_TEXTURE_LAYERS: 2, getParameter: (p) => p === 1 ? 2048 : 256 }),
  copyTextureToTexture(source, target, region, position) {
    calls.push({ bytes: source.image.data.byteLength, array: !!target.isDataArrayTexture, position,
      data: source.image.data.slice() });
  } };
}

test("fixture publication honors the host latch and does not acknowledge a failed flush", () => {
  let flushes = 0, renders = 0;
  const g = { renderer: {}, lightingNeedsFlush: true,
    daylightMaterial: { flush() { flushes++; return {}; } } };
  flushRendererLighting(g);
  flushRendererLighting(g);
  assert.equal(flushes, 1);
  assert.equal(g.lightingNeedsFlush, false);
  g.lightingNeedsFlush = true;
  g.daylightMaterial.flush = () => { throw new Error("upload failed"); };
  assert.throws(() => flushRendererLighting(g), /upload failed/);
  assert.equal(g.lightingNeedsFlush, true);
  g.renderer.render = () => {};
  g.render = () => { renders++; };
  flushRendererLighting(g);
  assert.equal(renders, 1, "real renderer uses its own publication latch");
});

test("fixture fingerprints include mapping, physical bytes and both kinds of constant pages", () => {
  const block = new PagedLightStore(BLOCK_PAGE_LAYOUT, 2, 1);
  const surface = new PagedLightStore(SURFACE_PAGE_LAYOUT, 2, 1);
  try {
    const bytes = new Uint8Array(6400); bytes[0] = 3;
    block.publish(block.claim(0, "physical"), bytes);
    block.publish(block.claim(1, "zero"), 0);
    surface.publish(surface.claim(0, "direct"), 16);
    const g = { blockLight: { store: block, cache: new Map(), paletteTexture: { image: { data: blockLightPalette.bytes } } },
      skyColumns: { data: new Float32Array(1), surfaceLight: { store: surface, cache: new Map() } } };
    const snapshot = () => lightingSnapshotArrays(g).map((array) => Array.from(array));
    const initial = snapshot();
    block.pages.get(1).constant = 1;
    assert.notDeepEqual(snapshot(), initial);
    block.pages.get(1).constant = 0;
    surface.pages.get(0).constant = 15;
    assert.notDeepEqual(snapshot(), initial);
    surface.pages.get(0).constant = 16;
    bytes[0] = 4;
    assert.notDeepEqual(snapshot(), initial);
    bytes[0] = 3;
    block.mapping[0] = 258;
    assert.notDeepEqual(snapshot(), initial);
  } finally { block.dispose(); surface.dispose(); }
});

test("selected receiver readiness rejects missing sky, unavailable pages and out-of-field aliases", () => {
  const columns = { cx: 0, cz: 0, layout: { radius: 0 }, spec: { minY: 0 },
    skySlot: () => 0, skyOwners: ["0,0"], skyUploaded: [null],
    surfaceLight: { height: 16, index: () => 0, store: { mapping: new Uint16Array([1]) } } };
  const points = [{ x: 0.5, y: 0.5, z: 0.5 }];
  assert.equal(daylightTargetsReady(columns, points), false);
  columns.skyUploaded[0] = "verified";
  assert.equal(daylightTargetsReady(columns, points), true, "certified zero remains authoritative");
  columns.surfaceLight.store.mappingDirty = true;
  assert.equal(daylightTargetsReady(columns, points), false, "a pending GPU invalidation barrier is not ready");
  columns.surfaceLight.store.mappingDirty = false;
  columns.surfaceLight.store.mapping[0] = 0;
  assert.equal(daylightTargetsReady(columns, points), false);
  columns.surfaceLight.store.mapping[0] = 258;
  assert.equal(daylightTargetsReady(columns, [{ x: 16.5, y: 0.5, z: 0.5 }]), false);
});

test("R12 logical coverage and both layouts fit minimum dimensions with no bank mirror", () => {
  assert.deepEqual(lightLayout(12), { radius: 12, tiles: 25, chunks: 625, sourceChunks: 729, spareChunks: 841 });
  for (const layout of [BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT]) {
    const store = new PagedLightStore(layout, 625, 24), addresses = new Set();
    // Shared synthetic page is intentional: enumerate every distinct physical
    // handle without building a terrain world or spending 174 MB on fixtures.
    const data = new Uint8Array(layout.width * layout.height); data[1] = 16;
    for (let i = 0; i < 15000; i++) {
      assert.ok(store.publish(store.claim(i, `owner:${i}`), data));
      const address = store.address(store.pages.get(i).physical);
      addresses.add(JSON.stringify(address));
      assert.ok(address.bank < layout.banks && address.layer < 256);
    }
    assert.equal(addresses.size, 15000);
    assert.equal(store.resources().pinnedPages, 15000);
    assert.equal(store.resources().capacity, 16384);
    assert.equal(store.resources().cpuBankBytes, 0);
    assert.ok(store.banks.every((b) => b.image.data === null));
    store.dispose();
  }
});

test("full physical capacity, resize identity and slot generation rollover cannot resurrect handles", () => {
  for (const layout of [BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT]) {
    const store = new PagedLightStore(layout, 1024, 16), bytes = new Uint8Array(layout.width * layout.height);
    bytes[0] = 1;
    for (let i = 0; i < 16384; i++) store.publish(store.claim(i, `${i}`), bytes);
    assert.equal(store.pages.get(16383).physical, 16383);
    assert.equal(store.address(16383).bank, layout.banks - 1);
    assert.equal(store.address(16383).layer, layout.layers - 1);
    assert.throws(() => new PagedLightStore(layout, 16385, 1), /exceed/);
    store.dispose();
  }
  const old = new PagedLightStore(BLOCK_PAGE_LAYOUT, 1, 1);
  const ticket = old.claim(0, "same-owner"), resized = new PagedLightStore(BLOCK_PAGE_LAYOUT, 1, 1);
  resized.claim(0, "same-owner");
  assert.equal(resized.publish(ticket, null), false, "store identity survives same-size reallocation");
  old.generations[0] = 0xffffffff;
  old.invalidate(0);
  old.claim(0, "same-owner");
  assert.equal(old.publish(ticket, null), false, "uint32 wrap advances context before generation reuse");
  old.dispose(); resized.dispose();
});

test("stale tickets, ABA reuse, context replacement and mandatory invalidation precede page bytes and handles", () => {
  const store = new PagedLightStore(BLOCK_PAGE_LAYOUT, 1, 1), r = renderer();
  const a = store.claim(0, "A:world1:epoch1:dependency1"), data = new Uint8Array(6400);
  data[0] = 15;
  store.publish(a, data);
  store.flush(r);
  assert.deepEqual(r.calls.map((c) => [c.array, c.bytes]), [[false, 2], [true, 6400], [false, 2]]);
  const oldPhysical = store.pages.get(0).physical;
  const b = store.claim(0, "B:world1:epoch1:dependency1");
  assert.equal(store.publish(a, data), false);
  store.publish(b, data);
  assert.equal(store.pages.get(0).physical, oldPhysical);
  const budget = lightUploadBudget(); budget.bytes = 2; budget.copies = 1;
  store.flush(r, budget);
  assert.equal(store.mapping[0], 0);
  assert.equal(r.calls.at(-1).data[0], 0);
  assert.equal(store.queue.size, 1);
  store.restoreGPU();
  assert.equal(store.publish(b, data), false);
  assert.equal(store.mapping[0], 0);
  store.flush(r);
  assert.equal(store.mapping[0], 258);
  store.claim(0, "A:world1:epoch1:dependency1");
  assert.equal(store.publish(a, data), false, "returning coordinate cannot resurrect an old generation");
  store.dispose();
});

test("shared upload budget counts mapping calls and never evicts required pages", () => {
  const stores = [BLOCK_PAGE_LAYOUT, SURFACE_PAGE_LAYOUT].map((l) => new PagedLightStore(l, 625, 24));
  const r = renderer();
  for (const store of stores) {
    const data = new Uint8Array(store.layout.width * store.layout.height); data[0] = 12;
    for (let i = 0; i < 100; i++) store.publish(store.claim(i, `p${i}`), data);
  }
  const budget = lightUploadBudget();
  for (const store of stores) store.flushInvalidations(r, budget);
  for (const store of stores) store.flush(r, budget);
  assert.ok(budget.uploadedBytes <= 131072);
  assert.ok(r.calls.length <= 16);
  assert.equal(r.calls.reduce((n, c) => n + c.bytes, 0), budget.uploadedBytes);
  assert.ok(stores.every((s) => s.pages.size === 100));
  stores.forEach((s) => s.dispose());
});

test("palette roundtrips independent frozen dense outputs and fails explicitly on overflow", () => {
  for (const [name, sources] of Object.entries(cases())) {
    const { solver } = compare(sources);
    const palette = new ExactLightPalette();
    for (let i = 0; i < solver.values.length; i += 4) palette.add(...solver.values.subarray(i, i + 3));
    const indices = palette.encode(solver.values);
    for (let i = 0; i < indices.length; i++)
      assert.deepEqual(palette.decode(indices[i]), [...solver.values.subarray(i * 4, i * 4 + 3)], name);
  }
  assert.ok(blockLightPalette.colors.size <= 256);
  const p = new ExactLightPalette();
  for (let i = 1; i < 256; i++) p.add(i, 0, 0);
  assert.throws(() => p.add(0, 1, 0), /exceeds R8/);
  assert.throws(() => p.encode(new Uint8Array([0, 1, 0, 0])), /Unregistered/);
});

test("all production emission colors and every attenuated level decode to frozen dense RGB", (t) => {
  const colors = new Map();
  for (const id of Object.keys(BLOCKS)) {
    const style = localLightStyle(Number(id));
    if (!style) continue;
    const color = new Color(style.color), rgb = [color.r, color.g, color.b].map((v) => Math.round(v * 255));
    const packed = ((rgb[0] << 24) | (rgb[1] << 16) | (rgb[2] << 8)) >>> 0;
    colors.set(packed, Math.max(colors.get(packed) ?? 0, style.level));
  }
  let levels = 0;
  for (const [color, maximum] of colors) for (let level = 1; level <= maximum; level++) {
    const sources = air();
    put(sources, 24, 24, 24, (color | level) >>> 0);
    const { solver } = compare(sources);
    const encoded = blockLightPalette.encode(solver.values), decoded = new Uint8Array(solver.values.length);
    for (let i = 0; i < encoded.length; i++) decoded.set(blockLightPalette.decode(encoded[i]), i * 4);
    assert.deepEqual(decoded, solver.values);
    levels++;
  }
  t.diagnostic(JSON.stringify({ sourceColors: colors.size, sourceLevels: levels, exactRgbEntries: blockLightPalette.colors.size }));
});
