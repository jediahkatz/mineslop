import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { parseStructureIdentity } from "../src/canonical-structure-identity.js";
import {
  chunkTransferList,
  cloneChunkData,
  createChunkPacket,
  normalizeChunkPacket,
  normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { explorationMarkersFromStructure } from "../src/exploration-markers.js";
import { normalizeProgressContext } from "../src/progression-common.js";
import {
  describeStructure,
  locateStructure,
  structureTarget,
} from "../src/structure-catalog.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { World } from "../src/world.js";
import {
  chunkBounds,
  drainNativeFallback,
  nativeContext,
  nativeJob,
  NATIVE_STRUCTURE_SEARCH,
} from "./native-v4-fixtures.js";

// Same bounded locator windows as the native structure suite, but NEVER replace
// the requested raw seed. A missing native declaration is a failure, not a skip.
const origins = [
  { x: -4096, z: -4096 },
  { x: 0, z: 0 },
  { x: 6144, z: 4096 },
  { x: -6144, z: 6144 },
];
const seeds = [
  ["existing ordinary identity", "cedar-valley"],
  ["empty", ""],
  ["whitespace only", " \t\r\n "],
  [
    "embedded controls and URI punctuation",
    '\u0000raw\n\t\r\u007f\u202e:/%"\\',
  ],
  ["unpaired high surrogate", "\ud800"],
  ["unpaired low surrogate", "\udfff"],
  ["eighty UTF-16 code units", "\ud800".repeat(80)],
];

function firstRawSeedRuin(seed, t) {
  const generator = createGenerator(seed, "overworld", 4);
  assert.equal(generator.seed, seed);
  const context = nativeContext(generator);
  const attempts = [];
  for (const from of origins) {
    const before = generator.counters;
    const found = locateStructure(
      "ocean_ruin",
      context,
      from,
      NATIVE_STRUCTURE_SEARCH
    );
    assert.ok(found.examinedCells <= NATIVE_STRUCTURE_SEARCH.maxCells);
    assert.ok(found.sampledColumns <= NATIVE_STRUCTURE_SEARCH.maxSamples);
    assert.equal(
      generator.counters.surfaceQueries - before.surfaceQueries,
      found.sampledColumns
    );
    for (const key of [
      "chunkGenerations",
      "regionGenerations",
      "decoratorCells",
      "decoratorSamples",
      "decoratorDescriptors",
      "decoratorWrites",
      "caveColumns",
      "voxelVisits",
    ])
      assert.equal(
        generator.counters[key],
        before[key],
        `raw-seed discovery must not perform ${key}`
      );
    attempts.push({ from, ...found });
    if (!found.target) continue;
    const queries = generator.counters.surfaceQueries;
    const descriptor = describeStructure(
      "ocean_ruin",
      context,
      found.target.gx,
      found.target.gz
    );
    assert.ok(generator.counters.surfaceQueries - queries <= 256);
    assert.ok(descriptor);
    assert.deepEqual(structureTarget(descriptor), found.target);
    t.diagnostic(
      JSON.stringify({ seed, firstNativeRuin: descriptor.id, attempts })
    );
    // Geometry/transport/projection failures of THIS first result may not reroll.
    return { generator, descriptor };
  }
  assert.fail(
    `No native raw-seed ruin in four bounded windows: ${JSON.stringify({ seed, attempts })}`
  );
}

for (const [label, seed] of seeds) {
  test(`raw World seed ${label} survives native declarations, packets, fallback and marker projection`, {
    timeout: 30000, // Four bounded discovery windows, then three real generations of one native column.
  }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(GENERATOR_VERSION, 3);
    assert.ok(seed.length <= 80);
    const { generator, descriptor } = firstRawSeedRuin(seed, t);
    const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:ocean_ruin:${descriptor.gx}:${descriptor.gz}`;
    assert.equal(
      descriptor.id,
      id,
      "retain the existing JSON-quoted v1 identity format exactly"
    );
    assert.equal(descriptor.seed, seed);
    assert.deepEqual(parseStructureIdentity(id, seed, 4, "overworld"), {
      layoutVersion: 1,
      generatorVersion: 4,
      dimension: "overworld",
      kind: "ocean_ruin",
      gx: descriptor.gx,
      gz: descriptor.gz,
      spacing: 192,
    });
    const context = normalizeProgressContext({ seed, generatorVersion: 4 });
    assert.equal(
      context.seed,
      seed,
      "progression must preserve raw World identity"
    );
    const marker = descriptor.markers.find(
      (entry) => entry.type === "container" && entry.mapTarget
    );
    assert.ok(
      marker,
      "a real first-result ruin must have its map-bearing container"
    );
    assert.equal(marker.mapTarget.seed, seed);
    assert.equal(marker.mapTarget.sourceMarkerId, marker.id);
    const { x, y, z } = marker.position;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const request = nativeJob(generator, cx, cz);
    const source = generator.generateChunk(cx, cz);
    const declared = source.structures?.find((entry) => entry.id === id);
    assert.ok(
      declared,
      "missing native declarations cannot become an ordinary empty success"
    );
    assert.deepEqual(declared, {
      ...descriptor,
      owner: "structure:ocean_ruin:v1",
    });
    const expected = normalizeGeneratedChunk(source, request);
    const packet = createChunkPacket(source, request);
    assert.equal(packet.seed, seed);
    assert.deepEqual(packet.structures, source.structures);
    const messages = [];
    handleTerrainRequest(request, (reply, transfer) =>
      messages.push({ reply, transfer })
    );
    assert.equal(messages.length, 1);
    const { reply, transfer } = messages[0];
    assert.equal(reply.type, "chunk", reply.message);
    assert.equal(reply.schemaVersion, 2);
    assert.equal(reply.encoding, "u16");
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
      assert.equal(reply[key], request[key], key);
    assert.equal(transfer.length, new Set(transfer).size);
    assert.deepEqual(new Set(transfer), new Set(chunkTransferList(reply)));
    const buffers = [...transfer];
    const received = structuredClone(reply, { transfer });
    assert.ok(buffers.every((buffer) => buffer.byteLength === 0));
    assert.ok(source.blocks.byteLength > 0);
    const admitted = normalizeChunkPacket(received, request);
    assert.deepEqual(admitted, expected);
    const admittedDeclaration = admitted.structures.find(
      (entry) => entry.id === id
    );
    assert.ok(admittedDeclaration);
    assert.deepEqual(admittedDeclaration, declared);
    const projected = explorationMarkersFromStructure(
      admittedDeclaration,
      context,
      {
        bounds: chunkBounds(admitted),
      }
    );
    const anchors = descriptor.markers.filter(
      ({ type, position }) =>
        ["container", "encounter"].includes(type) &&
        Math.floor(position.x / 16) === cx &&
        Math.floor(position.z / 16) === cz
    );
    assert.ok(anchors.length > 0);
    assert.deepEqual(
      projected.map((entry) => entry.id).sort(),
      anchors.map((entry) => entry.id).sort()
    );
    assert.ok(projected.some((entry) => entry.id === marker.id));

    const observations = [];
    const world = new World(seed, {
      generatorVersion: 4,
      useWorker: false,
      onChunkAdmitted: (event) => observations.push(event),
    });
    t.after(() => world.dispose());
    assert.equal(world._generatorFactory, createGenerator);
    const saved = {
      version: 3,
      seed,
      generatorVersion: 4,
      dimension: "overworld",
      edits: [],
    };
    assert.equal(world.loadEdits(saved), true);
    const loading = world.ensureArea({ x, z }, 0);
    drainNativeFallback(t, world);
    await loading;
    assert.equal(world.seed, seed);
    assert.deepEqual(world.serialize(), saved);
    assert.equal(world.generator.counters.chunkGenerations, 1);
    assert.equal(world.get(x, y, z), BLOCK.CHEST);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].seed, seed);
    assert.equal(observations[0].epoch, world.epoch);
    assert.equal(
      observations[0].incarnation,
      world.chunks.get(`${cx},${cz}`).incarnation
    );
    assert.deepEqual(cloneChunkData(observations[0].chunk), expected);
    assert.deepEqual(world.admissionObserverErrors, []);

    const wrongSeed = seed === "" ? " " : "";
    assert.throws(
      () => parseStructureIdentity(id, wrongSeed, 4, "overworld"),
      RangeError
    );
    assert.throws(
      () =>
        explorationMarkersFromStructure(admittedDeclaration, {
          seed: wrongSeed,
          generatorVersion: 4,
        }),
      RangeError
    );
    const declarationIndex = received.structures.findIndex(
      (entry) => entry.id === id
    );
    assert.ok(declarationIndex >= 0);
    for (const corrupt of [
      (p) => {
        p.seed = wrongSeed;
      },
      (p) => {
        p.structures[declarationIndex].seed = wrongSeed;
      },
      (p) => {
        const parts = p.structures[declarationIndex].id.split(":");
        parts[2] = encodeURIComponent(JSON.stringify(wrongSeed));
        p.structures[declarationIndex].id = parts.join(":");
      },
      (p) => {
        p.structures[declarationIndex].markers.find(
          (entry) => entry.id === marker.id
        ).mapTarget.seed = wrongSeed;
      },
    ]) {
      const bad = structuredClone(received);
      corrupt(bad);
      assert.throws(() => normalizeChunkPacket(bad, request), RangeError);
      assert.throws(() => normalizeGeneratedChunk(bad, request), RangeError);
    }
    const resident = world.chunks.get(`${cx},${cz}`);
    const epoch = world.epoch;
    assert.equal(world.loadEdits({ ...saved, seed: wrongSeed }), false);
    assert.equal(world.chunks.get(`${cx},${cz}`), resident);
    assert.equal(world.epoch, epoch);
    assert.deepEqual(world.serialize(), saved);
  });
}

test("raw-seed admission still rejects non-string and over-eighty-code-unit identities", () => {
  for (const seed of [undefined, null, 7, {}, "x".repeat(81)]) {
    assert.throws(
      () => normalizeProgressContext({ seed, generatorVersion: 4 }),
      RangeError
    );
    const encoded = encodeURIComponent(
      JSON.stringify(typeof seed === "string" ? seed : "")
    );
    assert.throws(
      () =>
        parseStructureIdentity(
          `structure:v1:${encoded}:overworld:ocean_ruin:0:0`,
          seed,
          4,
          "overworld"
        ),
      RangeError
    );
    let reply;
    handleTerrainRequest(
      {
        type: "generate",
        schemaVersion: 2,
        id: 1,
        epoch: 0,
        seed,
        generatorVersion: 4,
        dimension: "overworld",
        cx: 0,
        cz: 0,
      },
      (message) => {
        reply = message;
      }
    );
    assert.equal(reply.type, "error");
    assert.equal(reply.seed, seed);
  }
});
