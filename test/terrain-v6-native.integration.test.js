import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTransferList, createChunkPacket, normalizeChunkPacket, normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { admittedExplorationEntries } from "../src/exploration-admission.js";
import { explorationAdmission, EXPLORATION_SERVICE_LIMITS } from "../src/exploration-host-state.js";
import { createGenerator } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { cloneTerrainStructures } from "../src/terrain-v4-transport.js";
import { describeV6Structure, V6_GENERATION_MANIFEST } from "../src/terrain-v6-manifest.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { drainNativeFallback, structureChunks } from "./native-v4-fixtures.js";
import { firstV6Structure, v6Context, v6Job } from "./terrain-v6-fixtures.js";

for (const kind of V6_GENERATION_MANIFEST.structureKinds)
  test(`real v6 ${kind}: all native chunks, transfer, fallback and canonical admission`, { timeout: 60000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { generator, descriptor } = firstV6Structure(kind);
    let statePlanes = 0, fluidPlanes = 0;
    for (const { cx, cz } of structureChunks(descriptor).reverse()) {
      const job = v6Job(generator, cx, cz), raw = generator.generateChunk(cx, cz);
      const expected = normalizeGeneratedChunk(raw, job);
      let reply, transfers;
      handleTerrainRequest(job, (packet, transfer) => { reply = packet; transfers = transfer; });
      assert.equal(reply.type, "chunk", reply.message);
      assert.deepEqual(new Set(transfers), new Set(chunkTransferList(reply)));
      assert.equal(transfers.length, new Set(transfers).size);
      statePlanes += reply.sections?.filter((s) => s.states).length ?? 0;
      fluidPlanes += reply.sections?.filter((s) => s.fluids).length ?? 0;
      const received = structuredClone(reply, { transfer: transfers });
      assert.equal(reply.blocks.byteLength, 0);
      assert.deepEqual(normalizeChunkPacket(received, job), expected);
      assert.deepEqual(expected.structures.find((entry) => entry.id === descriptor.id),
        { ...descriptor, owner: `structure:${kind}:v1` });
    }
    if (kind === "shipwreck") {
      assert.ok(statePlanes > 0);
      if (!descriptor.plan.beached) assert.ok(fluidPlanes > 0);
    }
    const world = new World(generator.seed, {
      generatorVersion: 6, dimension: generator.dimension, useWorker: false,
    });
    t.after(() => world.dispose());
    const context = createWorldContext({ seed: world.seed, generatorVersion: 6 });
    const admittedIds = new Set();
    const anchors = new Map(descriptor.markers.filter((marker) =>
      marker.type === "container" || marker.type === "encounter").map((marker) => {
      const { x, z } = marker.position;
      return [`${Math.floor(x / 16)},${Math.floor(z / 16)}`, { x, z }];
    }));
    for (const point of anchors.values()) {
      const pending = world.ensureArea(point, 0);
      drainNativeFallback(t, world);
      await pending;
      const cx = Math.floor(point.x / 16), cz = Math.floor(point.z / 16);
      const chunk = world.chunks.get(`${cx},${cz}`);
      const expected = normalizeGeneratedChunk(generator.generateChunk(cx, cz), v6Job(generator, cx, cz));
      for (const key of ["blocks", "biomes", "sections", "structures", "minY", "maxY"])
        assert.deepEqual(chunk[key], expected[key], `fallback ${kind}/${key}`);
      assert.ok(chunk.structures.some((entry) => entry.id === descriptor.id));
      const event = explorationAdmission(world, chunk);
      const entries = admittedExplorationEntries(world, event, context, EXPLORATION_SERVICE_LIMITS);
      assert.ok(entries.length);
      for (const entry of entries) {
        assert.equal(entry.invalidated, false, `${kind}/${entry.marker.id}: native anchor block`);
        admittedIds.add(entry.marker.id);
      }
      const original = chunk.structures;
      for (const version of [4, 5]) {
        chunk.structures = original.map((entry) => ({ ...entry, generatorVersion: version }));
        assert.throws(() => admittedExplorationEntries(world, event, context, EXPLORATION_SERVICE_LIMITS),
          /native structure declaration/);
      }
      chunk.structures = [];
      assert.throws(() => admittedExplorationEntries(world, event, context, EXPLORATION_SERVICE_LIMITS),
        /metadata is missing/);
      chunk.structures = original;
    }
    // Projection supports container/encounter markers; village civic markers are
    // consumed by the separate settlement pipeline rather than exploration.
    for (const marker of descriptor.markers.filter((entry) =>
      entry.type === "container" || entry.type === "encounter"))
      assert.ok(admittedIds.has(marker.id), `${kind}: missing ${marker.id}`);
    console.log(JSON.stringify({ kind, origin: descriptor.origin,
      chunks: structureChunks(descriptor).length, admitted: admittedIds.size }));
  });

test("v4/v5/v6 worker contexts alternate explicitly; future 8 and cross-version descriptors reject", () => {
  for (const dimension of ["overworld", "nether", "end"])
    for (const version of [4, 5, 6, 5, 4, 6]) {
      const generator = createGenerator("v6-context-alternation", dimension, version);
      const job = v6Job(generator, -1, 0);
      let reply;
      handleTerrainRequest(job, (packet) => { reply = packet; });
      assert.equal(reply.type, "chunk", reply.message);
      assert.deepEqual(normalizeChunkPacket(reply, job),
        normalizeGeneratedChunk(generator.generateChunk(-1, 0), job));
    }
  const { generator, descriptor } = firstV6Structure("shipwreck");
  const { cx, cz } = structureChunks(descriptor)[0];
  const job = v6Job(generator, cx, cz), raw = generator.generateChunk(cx, cz);
  const packet = createChunkPacket(raw, job);
  for (const version of [4, 5, 7]) {
    const bad = structuredClone(packet);
    bad.structures[0].generatorVersion = version;
    assert.throws(() => normalizeChunkPacket(bad, job), RangeError);
    assert.throws(() => describeV6Structure("shipwreck",
      { ...v6Context(generator), generatorVersion: version }, descriptor.gx, descriptor.gz), RangeError);
  }
  let future;
  handleTerrainRequest({ ...job, generatorVersion: 8 }, (packet) => { future = packet; });
  assert.equal(future.type, "error");
  assert.throws(() => cloneTerrainStructures(undefined, { ...job, generatorVersion: 8 }, generator.spec, raw.blocks),
    RangeError);
});
