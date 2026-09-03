import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  cellIndex,
  chunkTransferList,
  createChunkPacket,
  normalizeChunkPacket,
  normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { explorationMarkersFromStructure } from "../src/exploration-markers.js";
import { createGenerator } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import {
  cloneTerrainStructures,
  TERRAIN_STRUCTURE_LIMITS,
} from "../src/terrain-v4-transport.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";
import {
  chunkBounds,
  firstNativeStructure,
  nativeJob,
  structureChunks,
} from "./native-v4-fixtures.js";
import { chunkCell } from "./terrain-v4-helpers.js";

let ship;
function naturalPacket() {
  ship ??= firstNativeStructure("shipwreck");
  const { generator, descriptor } = ship;
  const marker = descriptor.markers.find((entry) => entry.type === "container");
  assert.ok(marker);
  const cx = Math.floor(marker.position.x / 16);
  const cz = Math.floor(marker.position.z / 16);
  const job = nativeJob(generator, cx, cz);
  const raw = generator.generateChunk(cx, cz);
  return {
    generator,
    descriptor,
    marker,
    job,
    raw,
    packet: createChunkPacket(raw, job),
  };
}

test("native worker handler transfers all actual structure/state/fluid buffers and preserves full declarations", {
  timeout: 30000, // First real shipwreck footprint; no factory injection or fabricated descriptors.
}, () => {
  const { generator, descriptor } = naturalPacket();
  const context = createWorldContext({
    seed: generator.seed,
    generatorVersion: 4,
  });
  const markers = [];
  let statePlanes = 0;
  let fluidPlanes = 0;
  for (const { cx, cz } of structureChunks(descriptor).toReversed()) {
    const job = nativeJob(generator, cx, cz);
    const source = createGenerator(
      generator.seed,
      generator.dimension,
      4
    ).generateChunk(cx, cz);
    const expected = normalizeGeneratedChunk(source, job);
    const messages = [];
    handleTerrainRequest(job, (packet, transfer) =>
      messages.push({ packet, transfer })
    );
    assert.equal(messages.length, 1);
    const { packet, transfer } = messages[0];
    assert.equal(packet.type, "chunk", packet.message);
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
      assert.equal(packet[key], job[key]);
    assert.deepEqual(new Set(transfer), new Set(chunkTransferList(packet)));
    assert.equal(transfer.length, new Set(transfer).size);
    const buffers = [packet.blocks, packet.biomes];
    for (const section of packet.sections ?? []) {
      if (section.states) {
        statePlanes++;
        buffers.push(section.states);
      }
      if (section.fluids) {
        fluidPlanes++;
        buffers.push(section.fluids);
      }
    }
    for (const view of buffers) assert.ok(transfer.includes(view.buffer));
    const received = structuredClone(packet, { transfer });
    for (const view of buffers) assert.equal(view.byteLength, 0);
    const admitted = normalizeChunkPacket(received, job);
    assert.deepEqual(
      admitted,
      expected,
      "worker and sync use exactly the same ingestion"
    );
    assert.ok(
      source.blocks.byteLength > 0,
      "native generator buffers never detach during packet creation"
    );
    const declaration = admitted.structures.find(
      (entry) => entry.id === descriptor.id
    );
    assert.ok(declaration);
    assert.deepEqual(declaration.markers, descriptor.markers);
    const bounds = chunkBounds(admitted);
    markers.push(
      ...explorationMarkersFromStructure(declaration, context, { bounds })
    );
    for (const marker of declaration.markers)
      if (
        Math.floor(marker.position.x / 16) === cx &&
        Math.floor(marker.position.z / 16) === cz &&
        marker.block
      )
        assert.equal(
          chunkCell(
            admitted,
            marker.position.x,
            marker.position.y,
            marker.position.z
          ).id,
          BLOCK[marker.block]
        );
  }
  assert.ok(
    statePlanes > 0,
    "real ship layout exercises oriented native planes"
  );
  if (!descriptor.plan.beached)
    assert.ok(
      fluidPlanes > 0,
      "real sunken geometry exercises waterlogged planes"
    );
  assert.deepEqual(
    markers.map((entry) => entry.id).sort(),
    descriptor.markers.map((entry) => entry.id).sort()
  );
  assert.equal(new Set(markers.map((entry) => entry.id)).size, markers.length);
});

test("native packets reject corrupted identity, bounds, biome, cell and auxiliary planes in both ingestion APIs", {
  timeout: 30000, // Reuse the first natural site; bounded full-height packet corruption matrix.
}, () => {
  const { job, packet } = naturalPacket();
  const corruptions = [
    (p) => {
      p.id++;
    },
    (p) => {
      p.epoch++;
    },
    (p) => {
      p.seed = "wrong-seed";
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
      p.type = "error";
    },
    (p) => {
      p.schemaVersion = 99;
    },
    (p) => {
      p.minY = 0;
    },
    (p) => {
      p.maxY = 96;
    },
    (p) => {
      p.encoding = "u8";
    },
    (p) => {
      p.blocks = new Uint16Array(96 * 256);
    },
    (p) => {
      p.biomes = new Uint16Array(256);
    },
    (p) => {
      p.biomes[0] = 255;
    },
    (p) => {
      p.blocks[0] = 65535;
    },
    (p) => {
      p.sections = [{ sy: -4 }, { sy: -4 }];
    },
    (p) => {
      p.sections = [{ sy: -5 }];
    },
    (p) => {
      p.sections = [{ sy: 20 }];
    },
    (p) => {
      p.sections = [{ sy: -4, states: new Uint8Array(4096) }];
    },
    (p) => {
      p.sections = [{ sy: -4, fluids: new Uint8Array(4095) }];
    },
    (p) => {
      const states = new Uint16Array(4096);
      states[0] = S.OPEN;
      p.sections = [{ sy: -4, states }];
    },
    (p) => {
      const fluids = new Uint8Array(4096);
      fluids[0] = FLUID.WATER_SOURCE;
      p.sections = [{ sy: -4, fluids }];
    },
    (p) => {
      p.states = new Uint16Array(4096);
    },
    (p) => {
      p.fluids = new Uint8Array(4096);
    },
  ];
  for (const corrupt of corruptions) {
    const bad = structuredClone(packet);
    corrupt(bad);
    assert.throws(() => normalizeChunkPacket(bad, job), RangeError);
    assert.throws(() => normalizeGeneratedChunk(bad, job), RangeError);
  }
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator("native-v4-reply-layout", dimension, 4);
    const request = nativeJob(generator, -1, 0);
    const raw = generator.generateChunk(-1, 0);
    const modern = createChunkPacket(raw, request);
    delete modern.schemaVersion;
    assert.throws(() => normalizeChunkPacket(modern, request), /historical/);
  }
});

test("canonical structure identity, marker bounds and generated anchor blocks cannot be stripped or forged", {
  timeout: 30000, // Validate corruptions of an authentic first-result declaration.
}, () => {
  const { job, packet, marker } = naturalPacket();
  const corruptions = [
    (p) => {
      p.structures = {};
    },
    (p) => {
      p.structures = [null];
    },
    (p) => {
      p.structures.push(structuredClone(p.structures[0]));
    },
    (p) => {
      p.structures[0].seed = "another-world";
    },
    (p) => {
      p.structures[0].generatorVersion = 3;
    },
    (p) => {
      p.structures[0].dimension = "nether";
    },
    (p) => {
      delete p.structures[0].id;
    },
    (p) => {
      p.structures[0].id += ":extra";
    },
    (p) => {
      p.structures[0].owner = "structure:shipwreck:v2";
    },
    (p) => {
      p.structures[0].kind = "village";
    },
    (p) => {
      p.structures[0].layoutVersion++;
    },
    (p) => {
      p.structures[0].gx++;
    },
    (p) => {
      p.structures[0].rotation = 4;
    },
    (p) => {
      p.structures[0].origin.x++;
    },
    (p) => {
      delete p.structures[0].bounds;
    },
    (p) => {
      p.structures[0].bounds.maxY++;
    },
    (p) => {
      p.structures[0].entries[0].facing = 4;
    },
    (p) => {
      p.structures[0].markers = [];
    },
    (p) => {
      p.structures[0].markers.push(structuredClone(p.structures[0].markers[0]));
    },
    (p) => {
      p.structures[0].markers[0].id += "-invented";
    },
    (p) => {
      p.structures[0].markers[0].structureId = "wrong-owner";
    },
    (p) => {
      p.structures[0].markers[0].dimension = "end";
    },
    (p) => {
      p.structures[0].markers[0].position.y = 320;
    },
    (p) => {
      p.structures[0].markers[0].items = [];
    },
    (p) => {
      p.structures[0].markers[0].homeId = `${p.structures[0].id}/home/nonexistent`;
    },
    (p) => {
      p.structures[0].markers[0].table = "";
    },
    (p) => {
      p.blocks[
        cellIndex(
          marker.position.x,
          marker.position.y,
          marker.position.z,
          packet
        )
      ] = BLOCK.AIR;
    },
  ];
  for (const corrupt of corruptions) {
    const bad = structuredClone(packet);
    corrupt(bad);
    assert.throws(() => normalizeChunkPacket(bad, job), RangeError);
    assert.throws(() => normalizeGeneratedChunk(bad, job), RangeError);
  }
  const expected = normalizeChunkPacket(packet, job);
  assert.deepEqual(expected.structures, packet.structures);
  assert.notEqual(expected.structures, packet.structures);
});

test("an anchor-free native monument packet retains all three elder declarations before later anchor packets", {
  timeout: 30000, // First real monument, at most sixteen chunks within its existing footprint.
}, () => {
  const { generator, descriptor } = firstNativeStructure("ocean_monument");
  const context = createWorldContext({
    seed: generator.seed,
    generatorVersion: 4,
  });
  const coordinates = structureChunks(descriptor);
  const ownsMarker = ({ cx, cz }) =>
    descriptor.markers.some(
      ({ position }) =>
        Math.floor(position.x / 16) === cx && Math.floor(position.z / 16) === cz
    );
  const anchorFree = coordinates.find((chunk) => !ownsMarker(chunk));
  assert.ok(
    anchorFree,
    "the first natural monument must include a declaration-only intersecting chunk"
  );
  const first = normalizeGeneratedChunk(
    generator.generateChunk(anchorFree.cx, anchorFree.cz),
    nativeJob(generator, anchorFree.cx, anchorFree.cz)
  );
  assert.deepEqual(first.structures[0].markers, descriptor.markers);
  assert.deepEqual(
    explorationMarkersFromStructure(first.structures[0], context, {
      bounds: chunkBounds(first),
    }),
    []
  );
  const anchored = [];
  for (const { cx, cz } of coordinates.toReversed()) {
    const packet = createChunkPacket(
      generator.generateChunk(cx, cz),
      nativeJob(generator, cx, cz)
    );
    const admitted = normalizeChunkPacket(packet, nativeJob(generator, cx, cz));
    for (const declaration of admitted.structures)
      anchored.push(
        ...explorationMarkersFromStructure(declaration, context, {
          bounds: chunkBounds(admitted),
        })
      );
  }
  assert.equal(anchored.length, 3);
  assert.equal(new Set(anchored.map((marker) => marker.id)).size, 3);
  assert.deepEqual(
    anchored.map((marker) => marker.id).sort(),
    descriptor.markers.map((marker) => marker.id).sort()
  );
});

test("native map queries retain their source identity and reject unbounded or cross-world metadata", {
  timeout: 30000, // The first real ruin always declares a map-bearing container.
}, () => {
  const { generator, descriptor } = firstNativeStructure("ocean_ruin");
  const marker = descriptor.markers.find((entry) => entry.mapTarget);
  assert.ok(marker);
  const cx = Math.floor(marker.position.x / 16);
  const cz = Math.floor(marker.position.z / 16);
  const job = nativeJob(generator, cx, cz);
  const packet = createChunkPacket(generator.generateChunk(cx, cz), job);
  const declaration = packet.structures.find(
    (entry) => entry.id === descriptor.id
  );
  assert.deepEqual(
    declaration.markers.find((entry) => entry.id === marker.id).mapTarget,
    marker.mapTarget
  );
  for (const corrupt of [
    (query) => {
      query.seed = "wrong";
    },
    (query) => {
      query.sourceMarkerId += "-wrong";
    },
    (query) => {
      query.from.x++;
    },
    (query) => {
      query.search.maxCells = Number.MAX_SAFE_INTEGER;
    },
    (query) => {
      query.search.maxSamples = Infinity;
    },
    (query) => {
      query.search.radius = -1;
    },
  ]) {
    const bad = structuredClone(packet);
    corrupt(
      bad.structures[0].markers.find((entry) => entry.id === marker.id)
        .mapTarget
    );
    assert.throws(() => normalizeChunkPacket(bad, job), RangeError);
    assert.throws(() => normalizeGeneratedChunk(bad, job), RangeError);
  }
});

test("bounded opaque decorator metadata keeps shared typed buffers without becoming canonical declarations", () => {
  const job = {
    seed: "authored-transport-only",
    dimension: "overworld",
    generatorVersion: 4,
    cx: 0,
    cz: 0,
  };
  const spec = getWorldSpec(4, "overworld");
  const anchor = new Int32Array([1, -1, 2]);
  const source = [
    {
      kind: "authored-transport-only",
      anchor,
      aliases: new Map([["same", anchor]]),
    },
  ];
  const structures = cloneTerrainStructures(
    source,
    job,
    spec,
    new Uint16Array(384 * 256)
  );
  assert.deepEqual(structures, source);
  assert.notEqual(structures[0].anchor.buffer, anchor.buffer);
  assert.equal(
    structures[0].anchor.buffer,
    structures[0].aliases.get("same").buffer
  );
  const transfer = chunkTransferList({ structures });
  assert.equal(transfer.length, 1);
  const received = structuredClone({ structures }, { transfer });
  assert.deepEqual([...received.structures[0].anchor], [1, -1, 2]);
  assert.equal(structures[0].anchor.byteLength, 0);
  const tooDeep = { kind: "authored-transport-only" };
  let cursor = tooDeep;
  for (let i = 0; i <= TERRAIN_STRUCTURE_LIMITS.depth; i++)
    cursor = cursor.next = {};
  for (const malformed of [
    [tooDeep],
    [
      {
        kind: "fixture",
        payload: new Uint8Array(TERRAIN_STRUCTURE_LIMITS.bytes + 1),
      },
    ],
    [
      {
        kind: "fixture",
        payload: new Array(TERRAIN_STRUCTURE_LIMITS.values + 1),
      },
    ],
    [{ kind: "fixture", payload: () => {} }],
    [{ kind: "fixture", payload: NaN }],
    new Array(TERRAIN_STRUCTURE_LIMITS.descriptors + 1).fill({
      kind: "fixture",
    }),
  ])
    assert.throws(
      () => cloneTerrainStructures(malformed, job, spec, new Uint16Array(0)),
      RangeError
    );
});
