import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import {
  cellIndex,
  chunkTransferList,
  createChunkPacket,
  normalizeChunkPacket,
  normalizeGeneratedChunk,
  readChunkCell,
} from "../src/chunk-data.js";
import { SUPPORTED_GENERATOR_VERSIONS } from "../src/generator-version.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { V4_GENERATION_MANIFEST } from "../src/terrain-v4-manifest.js";
import { getWorldSpec } from "../src/world-spec.js";

const job = (generatorVersion = 3, dimension = "overworld") => ({
  type: "generate",
  id: 7,
  epoch: 3,
  seed: "transport-fixture",
  generatorVersion,
  dimension,
  cx: -1,
  cz: 1,
});

function legacyChunk(request) {
  const blocks = new Uint8Array(96 * 256);
  blocks[5 * 256] = BLOCK.WATER;
  return {
    cx: request.cx,
    cz: request.cz,
    blocks,
    biomes: new Uint8Array(256),
  };
}

function historicalReply(request) {
  return {
    type: "chunk",
    id: request.id,
    epoch: request.epoch,
    dimension: request.dimension,
    ...legacyChunk(request),
  };
}

/** Literal typed fixtures validate transport; they are not natural v4 terrain. */
function expandedChunk(request) {
  const spec = getWorldSpec(request.generatorVersion, request.dimension);
  const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
  const states = new Uint16Array(4096);
  const fluids = new Uint8Array(4096);
  blocks[cellIndex(-15, -1, 18, spec)] = BLOCK.OAK_STAIRS;
  blocks[cellIndex(-14, -2, 18, spec)] = BLOCK.WATER;
  states[15 * 256 + 2 * 16 + 1] = S.TOP | 1;
  fluids[15 * 256 + 2 * 16 + 1] = F.WATER_SOURCE;
  fluids[14 * 256 + 2 * 16 + 2] = F.BUBBLE_UP;
  return {
    cx: request.cx,
    cz: request.cz,
    minY: spec.minY,
    maxY: spec.maxY,
    blocks,
    biomes: new Uint8Array(256),
    sections: [{ sy: -1, states, fluids }],
    structures: [{ kind: "fixture", anchor: new Int32Array([-15, -1, 18]) }],
  };
}

test("strict historical packets and modern packets produce identical promoted residents", () => {
  for (const version of [1, 2, 3]) {
    const request = job(version);
    const historical = historicalReply(request);
    const modern = createChunkPacket(legacyChunk(request), request);
    assert.equal(modern.schemaVersion, 2);
    assert.equal(modern.encoding, "u8");
    assert.ok(modern.blocks instanceof Uint8Array);
    const resident = normalizeChunkPacket(historical, request);
    assert.ok(resident.blocks instanceof Uint16Array);
    assert.equal(resident.sections.size, 0);
    assert.deepEqual(resident, normalizeChunkPacket(modern, request));
    assert.deepEqual(
      resident,
      normalizeGeneratedChunk(legacyChunk(request), request)
    );
    assert.deepEqual(readChunkCell(resident, 5 * 256), {
      id: BLOCK.WATER,
      state: 0,
      fluid: F.WATER_SOURCE,
    });
    resident.blocks[5 * 256] = BLOCK.COPPER_BLOCK;
    assert.equal(historical.blocks[5 * 256], BLOCK.WATER);
    assert.equal(modern.blocks[5 * 256], BLOCK.WATER);
  }
});

test("modern worker fixtures transfer every buffer and preserve generated cells/structures", () => {
  const request = job(4);
  const raw = expandedChunk(request);
  const expected = normalizeGeneratedChunk(raw, request);
  let response;
  handleTerrainRequest(
    request,
    (packet, transfer) => {
      assert.equal(packet.encoding, "u16");
      assert.equal(transfer.length, 5);
      assert.deepEqual(new Set(transfer), new Set(chunkTransferList(packet)));
      response = structuredClone(packet, { transfer });
      assert.equal(packet.blocks.byteLength, 0);
      assert.equal(packet.biomes.byteLength, 0);
      assert.equal(packet.sections[0].states.byteLength, 0);
      assert.equal(packet.sections[0].fluids.byteLength, 0);
      assert.equal(packet.structures[0].anchor.byteLength, 0);
    },
    { generatorFactory: () => ({ generateChunk: () => raw }) }
  );
  const resident = normalizeChunkPacket(response, request);
  assert.deepEqual(resident, expected);
  assert.deepEqual(readChunkCell(resident, cellIndex(-15, -1, 18, resident)), {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 1,
    fluid: F.WATER_SOURCE,
  });
  assert.equal(
    readChunkCell(resident, cellIndex(-14, -2, 18, resident)).fluid,
    F.BUBBLE_UP
  );
  assert.ok(
    raw.blocks.byteLength > 0,
    "normalization never detaches generator memory"
  );
});

test("packet identity, spec, encoding, registered cells and section metadata are mandatory", () => {
  const request = job(4);
  const packet = createChunkPacket(expandedChunk(request), request);
  const invalid = [
    (p) => {
      p.id++;
    },
    (p) => {
      p.epoch++;
    },
    (p) => {
      p.seed = "other";
    },
    (p) => {
      p.dimension = "nether";
    },
    (p) => {
      p.generatorVersion = 3;
    },
    (p) => {
      p.cx++;
    },
    (p) => {
      p.cz++;
    },
    (p) => {
      p.schemaVersion = 3;
    },
    (p) => {
      p.minY = 0;
    },
    (p) => {
      p.maxY--;
    },
    (p) => {
      p.encoding = "u8";
    },
    (p) => {
      p.encoding = "float";
    },
    (p) => {
      p.blocks = new Uint16Array(1);
    },
    (p) => {
      p.biomes = new Uint16Array(256);
    },
    (p) => {
      p.blocks[0] = 999;
    },
    (p) => {
      p.sections.push(p.sections[0]);
    },
    (p) => {
      p.sections[0].sy = -5;
    },
    (p) => {
      p.sections[0].sy = 20;
    },
    (p) => {
      p.sections[0].sy = 1.5;
    },
    (p) => {
      p.sections[0].states = new Uint8Array(4096);
    },
    (p) => {
      p.sections[0].fluids = new Uint8Array(4095);
    },
    (p) => {
      p.sections[0].states[0] = S.OPEN;
    },
    (p) => {
      p.sections[0].fluids[0] = F.WATER_SOURCE;
    },
    (p) => {
      p.sections[0].fluids[14 * 256 + 34] = F.NONE;
    },
    (p) => {
      p.states = new Uint16Array(4096);
    },
    (p) => {
      p.fluids = new Uint8Array(4096);
    },
  ];
  for (const corrupt of invalid) {
    const malformed = structuredClone(packet);
    corrupt(malformed);
    assert.throws(() => normalizeChunkPacket(malformed, request), RangeError);
  }
  assert.deepEqual(
    normalizeChunkPacket(packet, request),
    normalizeGeneratedChunk(expandedChunk(request), request)
  );
});

test("unversioned packets cannot smuggle expanded layouts, orientations or fluid planes", () => {
  const request = job(3);
  const packet = historicalReply(request);
  for (const extra of [
    { schemaVersion: 1 },
    { minY: 0, maxY: 96 },
    { encoding: "u8" },
    { sections: [] },
    { structures: [] },
    { states: new Uint16Array(4096) },
    { fluids: new Uint8Array(4096) },
    { blocks: new Uint16Array(96 * 256) },
    { blocks: new Uint8Array(384 * 256) },
    { seed: "wrong" },
    { generatorVersion: 2 },
  ])
    assert.throws(() => normalizeChunkPacket({ ...packet, ...extra }, request));
  assert.throws(() => normalizeChunkPacket(packet, job(4)));
});

test("sync ingestion rejects invalid generator metadata instead of overwriting it", () => {
  const request = job(4);
  const valid = expandedChunk(request);
  for (const extra of [
    { minY: undefined },
    { cx: 20 },
    { seed: "wrong" },
    { generatorVersion: 3 },
    { epoch: 99 },
    { schemaVersion: 99 },
  ])
    assert.throws(() =>
      normalizeGeneratedChunk({ ...valid, ...extra }, request)
    );
});

test("the default worker factory admits real native v4 packets in all dimensions", {
  timeout: 30000, // Two real full-height generations per dimension, no injected factory.
}, () => {
  assert.equal(GENERATOR_VERSION, 3, "native v4 remains explicit opt-in");
  for (const dimension of ["overworld", "nether", "end"]) {
    const spec = getWorldSpec(4, dimension);
    const request = {
      ...job(4, dimension),
      schemaVersion: 2,
      minY: spec.minY,
      maxY: spec.maxY,
    };
    const generator = createGenerator(request.seed, dimension, 4);
    assert.equal(generator.generationManifest, V4_GENERATION_MANIFEST);
    const source = generator.generateChunk(request.cx, request.cz);
    const expected = normalizeGeneratedChunk(source, request);
    const messages = [];
    handleTerrainRequest(request, (packet, transfer) =>
      messages.push({ packet, transfer })
    );
    assert.equal(messages.length, 1);
    const { packet, transfer } = messages[0];
    assert.equal(packet.type, "chunk", packet.message);
    assert.equal(packet.schemaVersion, 2);
    assert.equal(packet.encoding, "u16");
    for (const key of [
      "id",
      "epoch",
      "seed",
      "dimension",
      "generatorVersion",
      "cx",
      "cz",
      "minY",
      "maxY",
    ])
      assert.equal(packet[key], request[key], key);
    assert.ok(packet.blocks instanceof Uint16Array);
    assert.equal(packet.blocks.length, (spec.maxY - spec.minY) * 256);
    assert.equal(transfer.length, new Set(transfer).size);
    assert.deepEqual(new Set(transfer), new Set(chunkTransferList(packet)));
    const buffers = [...transfer];
    const received = structuredClone(packet, { transfer });
    assert.ok(buffers.every((buffer) => buffer.byteLength === 0));
    assert.deepEqual(normalizeChunkPacket(received, request), expected);
    assert.ok(
      source.blocks.byteLength > 0,
      "packet transfer never detaches generator memory"
    );
  }
});

test("worker helpers still reject malformed jobs and unsupported generator versions", () => {
  for (const request of [
    job(Math.max(...SUPPORTED_GENERATOR_VERSIONS) + 1),
    { ...job(), id: -1 },
    { ...job(), epoch: 0.5 },
    { ...job(), seed: 123 },
    { ...job(4), seed: "x".repeat(81) },
    { ...job(4), schemaVersion: 99 },
    { ...job(), dimension: "moon" },
    { ...job(), cx: 30_000_000 },
    { ...job(), minY: -64 },
    { ...job(4), minY: 0 },
    { ...job(4), maxY: 96 },
  ]) {
    let response;
    handleTerrainRequest(request, (message) => {
      response = message;
    });
    assert.equal(response.type, "error");
    assert.equal(response.schemaVersion, 2);
    for (const key of [
      "id",
      "epoch",
      "seed",
      "dimension",
      "generatorVersion",
      "cx",
      "cz",
    ])
      assert.equal(response[key], request[key], key);
    assert.equal(typeof response.message, "string");
    assert.ok(response.message.length > 0);
  }
});

test("worker cache includes the injected factory, not only seed/dimension/version", () => {
  const request = job();
  const factories = [BLOCK.STONE, BLOCK.GRASS].map((id) => () => ({
    generateChunk() {
      const chunk = legacyChunk(request);
      chunk.blocks[0] = id;
      return chunk;
    },
  }));
  factories.forEach((generatorFactory, index) => {
    let response;
    handleTerrainRequest(
      request,
      (message) => {
        response = message;
      },
      { generatorFactory }
    );
    assert.equal(response.blocks[0], index === 0 ? BLOCK.STONE : BLOCK.GRASS);
  });
});
