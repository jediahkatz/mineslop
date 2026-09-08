import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator, WORLD_MIN, WORLD_MAX } from "../src/terrain.js";
import {
  certifySurfaceRegion, surfaceCertificateCurrent, surfaceIdentity, SurfaceRegionValidation,
} from "../src/surface-availability.js";

const bounds = { minX: -16, minZ: -16, maxX: 16, maxZ: 16 };
const world = () => ({
  dimension: "overworld", generatorVersion: 7, surfaceRevision: 0, epoch: 0,
  generator: createGenerator("cedar-valley", "overworld", 7),
});

test("production certificates are read-only, precise and bound to actual samplers", () => {
  const w = world(), height = w.generator.terrainHeight;
  const certificate = certifySurfaceRegion(w, bounds);
  assert.ok(certificate);
  assert.ok(Object.isFrozen(certificate) && Object.isFrozen(certificate.bounds));
  assert.equal(w.generator.terrainHeight, height);
  assert.ok(surfaceCertificateCurrent(certificate, w));
  assert.equal(surfaceCertificateCurrent(certificate, w, { ...bounds, maxX: 32 }), false);
  assert.equal(certifySurfaceRegion(w, { ...bounds, minX: WORLD_MIN - 1 }), null);
  assert.equal(certifySurfaceRegion(w, { ...bounds, maxX: WORLD_MAX + 1 }), null);
  assert.equal(certifySurfaceRegion(w, { ...bounds, minX: 0.5 }), null);
  assert.equal(surfaceCertificateCurrent(certificate, world()), false);
  w.generator.terrainHeight = () => NaN;
  assert.equal(surfaceCertificateCurrent(certificate, w), false);
  w.generator.terrainHeight = height;
  assert.equal(certifySurfaceRegion(w, bounds), null, "observed sampler ABA never revives a total-field certificate");
});

test("world revision ABA invalidates certificates and validation caches", () => {
  const w = world(), certificate = certifySurfaceRegion(w, bounds);
  w.surfaceRevision++;
  const replacement = surfaceIdentity(w);
  assert.equal(surfaceCertificateCurrent(certificate, w), false);
  w.surfaceRevision--;
  assert.notEqual(surfaceIdentity(w), replacement);
  assert.equal(surfaceCertificateCurrent(certificate, w), false);
  const renewed = certifySurfaceRegion(w, bounds);
  w.epoch++;
  assert.equal(surfaceCertificateCurrent(renewed, w), false);
  w.dimension = "end";
  assert.equal(certifySurfaceRegion(w, bounds), null);
});

test("arbitrary fields validate every interior under sample/deadline limits", () => {
  let queries = 0;
  const w = { dimension: "overworld", surfaceRevision: 0,
    generator: { terrainHeight: (x, z) => { queries++; return x === 8 && z === 8 ? NaN : 31; } } };
  assert.equal(certifySurfaceRegion(w, bounds), null);
  const cache = new Map();
  const validation = new SurfaceRegionValidation(w, bounds, { cx: 0, cz: 0 }, 0, cache);
  assert.equal(validation.unknown.size, 4);
  assert.equal(validation.step(128, -Infinity), 0);
  assert.equal(queries, 0);
  assert.equal(validation.step(127, Infinity), 127);
  assert.equal(validation.unknown.has("0,0"), true, "a partially checked chunk remains unknown");
  while (!validation.done) assert.ok(validation.step(128, Infinity) <= 128);
  assert.equal(queries, 1024);
  assert.deepEqual([...validation.unknown], ["0,0"]);
  const cached = new SurfaceRegionValidation(w, bounds, { cx: 0, cz: 0 }, 0, cache);
  assert.equal(cached.done, true);
  assert.deepEqual([...cached.unknown], ["0,0"]);
  w.surfaceRevision++;
  const fresh = new SurfaceRegionValidation(w, bounds, { cx: 0, cz: 0 }, 0, cache);
  assert.equal(fresh.unknown.size, 4);
  assert.equal(validation.step(128, Infinity), 0);
});
