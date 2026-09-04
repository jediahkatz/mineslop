import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chunkTransferList, createChunkPacket, normalizeChunkPacket, normalizeGeneratedChunk } from "../src/chunk-data.js";
import { admittedExplorationEntries } from "../src/exploration-admission.js";
import { explorationAdmission, EXPLORATION_SERVICE_LIMITS } from "../src/exploration-host-state.js";
import { createGenerator } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { cloneTerrainStructures } from "../src/terrain-v4-transport.js";
import { describeV7Structure } from "../src/terrain-v7-manifest.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { drainNativeFallback, structureChunks } from "./native-v4-fixtures.js";
import { v7Context, v7Job } from "./terrain-v7-fixtures.js";

const old = JSON.parse(readFileSync(new URL("./terrain-v6-golden.json", import.meta.url), "utf8"));
for (const row of old.native)
  test(`v7 real ${row.kind} native cells, worker transfer, fallback and canonical admission`, { timeout: 60000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gen = createGenerator(row.seed, row.dimension, 7);
    const descriptor = describeV7Structure(row.kind, v7Context(gen), row.descriptor.gx, row.descriptor.gz);
    assert.deepEqual(descriptor, { ...row.descriptor, generatorVersion: 7 });
    for (const { cx, cz } of structureChunks(descriptor)) {
      const job = v7Job(gen, cx, cz), expected = normalizeGeneratedChunk(gen.generateChunk(cx, cz), job);
      let received;
      handleTerrainRequest(job, (reply, transfers) => {
        assert.equal(reply.type, "chunk", reply.message);
        assert.deepEqual(new Set(transfers), new Set(chunkTransferList(reply)));
        received = structuredClone(reply, { transfer: transfers });
        assert.equal(reply.blocks.byteLength, 0);
      });
      assert.deepEqual(normalizeChunkPacket(received, job), expected);
      assert.deepEqual(expected.structures.find(({ id }) => id === descriptor.id),
        { ...descriptor, owner: `structure:${row.kind}:v1` });
      const packet = createChunkPacket(gen.generateChunk(cx, cz), job);
      for (const version of [1, 2, 3, 4, 5, 6, 8]) {
        const foreign = structuredClone(packet);
        foreign.structures[0].generatorVersion = version;
        assert.throws(() => normalizeChunkPacket(foreign, job), RangeError);
      }
    }
    const world = new World(row.seed, {
      generatorVersion: 7, dimension: row.dimension, useWorker: false,
    });
    t.after(() => world.dispose());
    const context = createWorldContext({ seed: row.seed, generatorVersion: 7 });
    const anchors = descriptor.markers.filter(({ type }) => type === "container" || type === "encounter");
    let admitted = 0;
    for (const { position } of anchors) {
      const pending = world.ensureArea(position, 0);
      drainNativeFallback(t, world);
      await pending;
      const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16);
      const chunk = world.chunks.get(`${cx},${cz}`), event = explorationAdmission(world, chunk);
      const expected = normalizeGeneratedChunk(gen.generateChunk(cx, cz), v7Job(gen, cx, cz));
      for (const key of ["blocks", "biomes", "sections", "structures"])
        assert.deepEqual(chunk[key], expected[key]);
      const entries = admittedExplorationEntries(world, event, context, EXPLORATION_SERVICE_LIMITS);
      assert.ok(entries.length);
      assert.ok(entries.every((entry) => !entry.invalidated));
      admitted += entries.length;
      const original = chunk.structures;
      chunk.structures = original.map((entry) => ({ ...entry, generatorVersion: 6 }));
      assert.throws(() => admittedExplorationEntries(world, event, context, EXPLORATION_SERVICE_LIMITS),
        /native structure declaration/);
      chunk.structures = original;
    }
    assert.ok(admitted);
    console.log(JSON.stringify({ kind: row.kind, chunks: structureChunks(descriptor).length, admitted }));
  });

test("explicit 1–7 worker contexts alternate; version8 and legacy canonical structures reject", () => {
  for (const dimension of ["overworld", "nether", "end"])
    for (const version of [1, 2, 3, 4, 5, 6, 7, 4, 7, 5, 7, 6]) {
      const gen = createGenerator("context-v7", dimension, version), job = v7Job(gen, 0, 0);
      // Legacy generator objects predate an explicit generatorVersion property.
      job.generatorVersion = version;
      job.seed = "context-v7";
      job.dimension = dimension;
      job.minY = version <= 3 ? 0 : gen.minY;
      job.maxY = version <= 3 ? 96 : gen.maxY;
      let reply;
      handleTerrainRequest(job, (packet) => { reply = packet; });
      assert.equal(reply.type, "chunk", reply.message);
      assert.deepEqual(normalizeChunkPacket(reply, job), normalizeGeneratedChunk(gen.generateChunk(0, 0), job));
    }
  const gen = createGenerator("context-v7", "end", 7), job = v7Job(gen, 0, 0);
  let future;
  handleTerrainRequest({ ...job, generatorVersion: 8 }, (packet) => { future = packet; });
  assert.equal(future.type, "error");
  for (const structures of [undefined, []])
    assert.throws(() => cloneTerrainStructures(structures, { ...job, generatorVersion: 8 }, gen.spec), RangeError);
  const row = old.native[0], native = createGenerator(row.seed, row.dimension, 7);
  const descriptor = describeV7Structure(row.kind, v7Context(native), row.descriptor.gx, row.descriptor.gz);
  for (const version of [1, 2, 3, 4, 5, 6, 8])
    assert.throws(() => describeV7Structure(row.kind, { ...v7Context(native), generatorVersion: version },
      descriptor.gx, descriptor.gz), RangeError);
});

test("actual End pillar worker/fallback bytes and metadata survive serialization", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gen = createGenerator("cedar-valley", "end", 7);
  const world = new World(gen.seed, {
    generatorVersion: 7, dimension: "end", useWorker: false,
  });
  t.after(() => world.dispose());
  for (const pillar of gen.getEndPillars()) {
    const cx = Math.floor(pillar.x / 16), cz = Math.floor(pillar.z / 16), job = v7Job(gen, cx, cz);
    let packet;
    handleTerrainRequest(job, (reply, transfer) => { packet = structuredClone(reply, { transfer }); });
    assert.deepEqual(normalizeChunkPacket(packet, job), normalizeGeneratedChunk(gen.generateChunk(cx, cz), job));
    const pending = world.ensureArea(pillar, 0);
    drainNativeFallback(t, world); await pending;
    assert.equal(world.get(pillar.x, pillar.top, pillar.z), pillar.body.block);
    assert.equal(world.get(pillar.x, pillar.cap.y, pillar.z), pillar.cap.block);
  }
  assert.deepEqual(world.generator.getEndPillars(), JSON.parse(JSON.stringify(gen.getEndPillars())));
  const saved = world.serialize();
  assert.equal(world.loadEdits(saved), true);
  assert.equal(world.generatorVersion, 7);
  assert.deepEqual(world.generator.getEndPillars(), gen.getEndPillars());
});
