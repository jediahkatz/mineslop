import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { geometryBuffers } from "../src/regional-section-pages.js";
import { detailMeshResources } from "../src/section-renderer.js";
import { regionalRegressionFixture, addBuffers, bytes } from "./regional-regression-fixture.js";
import { assertCensusAccounting } from "./regional-census-fixture.js";

test("geometry buffers preserve default and supplied destination identity and missing geometry behavior", () => {
  const seed = new ArrayBuffer(4), backing = new ArrayBuffer(32);
  const primary = new Set([seed]), secondary = new Set([seed]);
  for (const geometry of [undefined, null, false]) {
    assert.equal(geometryBuffers(geometry, primary, secondary), primary);
    assert.deepEqual(primary, new Set([seed]));
    assert.deepEqual(secondary, new Set([seed]));
    assert.deepEqual(geometryBuffers(geometry), new Set());
  }
  const geometry = { attributes: { position: { array: new Float32Array(backing) } }, index: null };
  assert.equal(geometryBuffers(geometry, primary), primary);
  assert.deepEqual(primary, new Set([seed, backing]));
  const defaultPrimary = geometryBuffers(geometry, undefined, secondary);
  assert.deepEqual(defaultPrimary, new Set([backing]));
  assert.notEqual(defaultPrimary, secondary);
  assert.deepEqual(secondary, new Set([seed, backing]));
  assert.deepEqual(geometryBuffers({ attributes: {}, index: null }), new Set());
  // Absent attribute dictionaries remain outside the existing format contract.
  assert.throws(() => geometryBuffers({}), TypeError);
  assert.throws(() => geometryBuffers({ attributes: null }), TypeError);
});

test("geometry buffers enumerate own attributes and read each backing once for both sets", () => {
  const shared = new ArrayBuffer(128), indexBacking = new ArrayBuffer(32), seed = new ArrayBuffer(1);
  const reads = {}, order = [];
  const read = (key) => { reads[key] = (reads[key] ?? 0) + 1; order.push(key); };
  const attribute = (name, view) => ({
    get array() {
      read(`${name}.array`);
      return new Proxy(view, {
        get(target, key) {
          assert.equal(key, "buffer");
          read(`${name}.buffer`);
          return Reflect.get(target, key, target);
        },
      });
    },
  });
  const attributes = Object.create({
    get inherited() { assert.fail("inherited attributes must not be read"); },
  });
  Object.defineProperties(attributes, {
    position: { enumerable: true, get() { read("position"); return attribute("position", new Float32Array(shared, 0, 9)); } },
    normal: { enumerable: true, get() { read("normal"); return attribute("normal", new Int8Array(shared, 36, 9)); } },
    missing: { enumerable: true, value: undefined },
    withoutArray: { enumerable: true, value: {} },
    hidden: { get() { assert.fail("non-enumerable attributes must not be read"); } },
    [Symbol("ignored")]: { enumerable: true, get() { assert.fail("symbol attributes must not be read"); } },
  });
  const geometry = {
    get attributes() {
      read("attributes");
      return new Proxy(attributes, { ownKeys(target) { read("ownKeys"); return Reflect.ownKeys(target); } });
    },
    get index() { read("index"); return attribute("index", new Uint16Array(indexBacking, 4, 6)); },
  };
  const cpu = new Set([seed]), gpu = new Set();
  assert.equal(geometryBuffers(geometry, cpu, gpu), cpu);
  assert.deepEqual(cpu, new Set([seed, shared, indexBacking]));
  assert.deepEqual(gpu, new Set([shared, indexBacking]));
  assert.deepEqual(reads, {
    attributes: 1, ownKeys: 1, position: 1, normal: 1, index: 1,
    "position.array": 1, "position.buffer": 1, "normal.array": 1, "normal.buffer": 1,
    "index.array": 1, "index.buffer": 1,
  });
  assert.deepEqual(order.slice(0, 5), ["attributes", "ownKeys", "position", "normal", "index"],
    "preserve own-value snapshot and index-read ordering before processing attributes");
});

test("geometry buffers deduplicate attribute/index/shared views and support the same destination twice", () => {
  const backing = new ArrayBuffer(128);
  const geometry = {
    attributes: {
      position: { array: new Float32Array(backing, 0, 9) },
      normal: { array: new Int8Array(backing, 36, 9) },
      color: { array: new Uint8Array(backing, 45, 9) },
      unsupportedInterleaved: { data: { array: new Float32Array(12) } },
    },
    index: { array: new Uint16Array(backing, 64, 6) },
  };
  const both = new Set();
  assert.equal(geometryBuffers(geometry, both, both), both);
  assert.deepEqual(both, new Set([backing]));
  const cpu = new Set(), gpu = new Set();
  geometryBuffers(geometry, cpu, gpu);
  geometryBuffers({ attributes: { borrowed: geometry.attributes.position }, index: geometry.index }, cpu, gpu);
  assert.deepEqual(cpu, both);
  assert.deepEqual(gpu, both);
  assert.equal(bytes(cpu), 128, "count backing capacity, not view byte lengths");
});

test("geometry buffers always read fresh arrays and never retain a previous census", () => {
  const old = new Float32Array(9), replacement = new Float32Array(18);
  const geometry = { attributes: { position: { array: old } }, index: null };
  const oldCpu = new Set(), oldGpu = new Set();
  geometryBuffers(geometry, oldCpu, oldGpu);
  geometry.attributes.position.array = replacement;
  const cpu = new Set(), gpu = new Set();
  geometryBuffers(geometry, cpu, gpu);
  assert.deepEqual(cpu, new Set([replacement.buffer]));
  assert.deepEqual(gpu, cpu);
  assert.deepEqual(oldCpu, new Set([old.buffer]));
  assert.deepEqual(oldGpu, oldCpu);
});

test("regional census enumerates each physical geometry once while keeping exact fresh accounting", (t) => {
  const { renderer, world } = regionalRegressionFixture(t, [
    [1, 0, 1, BLOCK.STONE], [17, 0, 1, BLOCK.STONE], [2, 0, 1, BLOCK.WATER],
  ]);
  for (let i = 0; i < 200 && world.dirtySectionRevisions.size; i++) renderer.rebuildDirty(2);
  assert.equal(world.dirtySectionRevisions.size, 0);
  assert.equal(renderer.sectionJobs.size, 0);
  const meshes = [...renderer.sectionRegions.values()].flatMap((region) => region.userData.pages)
    .concat([...renderer.chunks.values()].flatMap((column) => column.userData.transparentMeshes));
  assert.ok(meshes.length >= 2, "real canonical pages and unfused transparency");
  const physical = new Set(), originals = new Map(), enumerations = new Map();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    addBuffers(geometry, physical);
    assert.ok(!originals.has(geometry));
    originals.set(geometry, geometry.attributes);
    enumerations.set(geometry, 0);
    geometry.attributes = new Proxy(geometry.attributes, {
      ownKeys(target) {
        enumerations.set(geometry, enumerations.get(geometry) + 1);
        return Reflect.ownKeys(target);
      },
    });
  }
  let actual;
  try {
    actual = detailMeshResources(renderer);
    for (const count of enumerations.values()) assert.equal(count, 1, "one enumeration feeds CPU and GPU");
  } finally {
    for (const [geometry, attributes] of originals) geometry.attributes = attributes;
  }
  assert.equal(actual.canonicalBytes, bytes(physical) + renderer.geometryPalette.resources().cpuBytes);
  assert.equal(actual.gpuBytes, bytes(physical) + renderer.geometryPalette.resources().gpuBytes);
  assertCensusAccounting(renderer);
});
