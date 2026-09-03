import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTransferList, createChunkPacket, normalizeChunkPacket, normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { createGenerator } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { V5_GENERATION_MANIFEST } from "../src/terrain-v5-manifest.js";
import { firstV5Structure, v5Job } from "./terrain-v5-native-fixtures.js";
import { structureChunks } from "./native-v4-fixtures.js";

for (const kind of V5_GENERATION_MANIFEST.structureKinds)
  test(`real v5 ${kind} declarations survive all intersecting worker packets`, {
    timeout: 60000,
  }, () => {
    const { generator, descriptor } = firstV5Structure(kind);
    let statePlanes = 0, fluidPlanes = 0;
    for (const { cx, cz } of structureChunks(descriptor).reverse()) {
      const job = v5Job(generator, cx, cz), raw = generator.generateChunk(cx, cz);
      const expected = normalizeGeneratedChunk(raw, job), messages = [];
      handleTerrainRequest(job, (packet, transfer) => messages.push({ packet, transfer }));
      assert.equal(messages.length, 1);
      const { packet, transfer } = messages[0];
      assert.equal(packet.type, "chunk", packet.message);
      assert.deepEqual(new Set(transfer), new Set(chunkTransferList(packet)));
      assert.equal(transfer.length, new Set(transfer).size);
      statePlanes += packet.sections?.filter((s) => s.states).length ?? 0;
      fluidPlanes += packet.sections?.filter((s) => s.fluids).length ?? 0;
      const received = structuredClone(packet, { transfer });
      assert.equal(packet.blocks.byteLength, 0);
      const actual = normalizeChunkPacket(received, job);
      assert.deepEqual(actual, expected);
      const declaration = actual.structures.find((s) => s.id === descriptor.id);
      assert.ok(declaration);
      assert.equal(declaration.generatorVersion, 5);
      assert.deepEqual(declaration.markers, descriptor.markers);
      assert.ok(raw.blocks.byteLength > 0, "the factory's source buffers are not detached");
    }
    if (kind === "shipwreck") {
      assert.ok(statePlanes > 0);
      if (!descriptor.plan.beached) assert.ok(fluidPlanes > 0);
    }
  });

test("v5 packets reject missing specs, old identity, wrong bounds, invalid cells and forged declarations", {
  timeout: 60000,
}, () => {
  const { generator, descriptor } = firstV5Structure("shipwreck");
  const marker = descriptor.markers.find((m) => m.type === "container");
  const cx = Math.floor(marker.position.x / 16), cz = Math.floor(marker.position.z / 16);
  const job = v5Job(generator, cx, cz), raw = generator.generateChunk(cx, cz);
  const packet = createChunkPacket(raw, job);
  for (const mutate of [
    (p) => { p.generatorVersion = 4; },
    (p) => { p.minY = 0; },
    (p) => { p.maxY = 96; },
    (p) => { p.seed = "wrong"; },
    (p) => { p.blocks[0] = 65535; },
    (p) => { p.biomes[0] = 255; },
    (p) => { p.structures[0].generatorVersion = 4; },
    (p) => { p.structures[0].seed = "wrong"; },
    (p) => { p.structures[0].bounds.maxX += 192; },
    (p) => { p.structures[0].markers[0].id += "/forged"; },
  ]) {
    const bad = structuredClone(packet);
    mutate(bad);
    assert.throws(() => normalizeChunkPacket(bad, job), RangeError);
  }
  const missing = { ...raw };
  delete missing.minY;
  assert.throws(() => normalizeGeneratedChunk(missing, job), RangeError);
});

test("worker cache keys distinguish v4/v5 and reject unsupported versions", { timeout: 30000 }, () => {
  for (const version of [5, 4, 5]) {
    const generator = createGenerator("same-seed", "overworld", version);
    const job = { ...v5Job(generator, -1, 0), generatorVersion: version };
    let reply;
    handleTerrainRequest(job, (packet) => { reply = packet; });
    assert.equal(reply.type, "chunk", reply.message);
    assert.deepEqual(normalizeChunkPacket(reply, job),
      normalizeGeneratedChunk(generator.generateChunk(-1, 0), job));
  }
  let reply;
  handleTerrainRequest({ ...v5Job(createGenerator("invalid", "overworld", 5), 0, 0),
    generatorVersion: 6 }, (packet) => { reply = packet; });
  assert.equal(reply.type, "error");
});
