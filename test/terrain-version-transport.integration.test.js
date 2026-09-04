import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  cloneChunkData, createChunkPacket, normalizeChunkPacket, normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { cloneTerrainStructures } from "../src/terrain-v4-transport.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";
import { admissionChunk, drainAdmissions } from "./world-admission-fixture.js";

const seed = "declaration-compatibility";
const jobFor = (generatorVersion, dimension) => ({
  type: "generate", schemaVersion: 2, seed, generatorVersion, dimension,
  id: 1, epoch: 0, cx: 0, cz: 0, ...getWorldSpec(generatorVersion, dimension),
});

for (const version of [1, 2, 3, 4, 5, 6])
  for (const dimension of ["overworld", "nether", "end"])
    test(`v${version}/${dimension}: absent, empty and opaque declaration packet/worker parity`, () => {
      const job = jobFor(version, dimension);
      const source = admissionChunk(0, 0, dimension, version);
      for (const structures of [undefined, [], source.structures]) {
        const raw = { ...source, structures };
        const packet = createChunkPacket(raw, job);
        const expected = normalizeGeneratedChunk(raw, job);
        assert.deepEqual(packet.structures, structures);
        assert.deepEqual(normalizeChunkPacket(packet, job), expected);
        if (structures) assert.notEqual(packet.structures, structures);
        let received;
        handleTerrainRequest(job, (reply, transfer) => {
          assert.equal(reply.type, "chunk", reply.message);
          received = structuredClone(reply, { transfer });
        }, { generatorFactory: () => ({ generateChunk: () => raw }) });
        assert.deepEqual(normalizeChunkPacket(received, job), expected);
      }
      for (const structures of [
        null, {}, [null], [{}], [{ kind: "shipwreck" }],
        [{ kind: "opaque-fixture", generatorVersion: version === 6 ? 5 : 6 }],
        [{ kind: "opaque-fixture", seed: "different-world" }],
        [{ kind: "opaque-fixture", dimension: dimension === "end" ? "nether" : "end" }],
      ])
        assert.throws(() => createChunkPacket({ ...source, structures }, job), RangeError);
      if (version <= 3) {
        const id = `structure:v1:${encodeURIComponent(JSON.stringify(seed))}:overworld:dungeon:0:0`;
        for (const generatorVersion of [version, 4, 5, 6])
          assert.throws(() => createChunkPacket({
            ...source, structures: [{ kind: "dungeon", id, generatorVersion }],
          }, job), RangeError, "nonempty canonical declarations never enter historical worlds");
      }
    });

for (const version of [1, 2, 3, 4, 5, 6])
  for (const empty of [true, false])
    test(`v${version} World fallback preserves ${empty ? "empty" : "opaque"} declarations`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const world = new World(seed, {
        generatorVersion: version, useWorker: false,
        generatorFactory: (_seed, dimension, generatorVersion) => ({
          generateChunk(cx, cz) {
            const chunk = admissionChunk(cx, cz, dimension, generatorVersion);
            return empty ? { ...chunk, structures: [] } : chunk;
          },
        }),
      });
      t.after(() => world.dispose());
      const pending = world.ensureArea({ x: 0, z: 0 }, 0);
      drainAdmissions(t, world);
      await pending;
      const chunk = admissionChunk(0, 0, "overworld", version);
      if (empty) chunk.structures = [];
      assert.deepEqual(cloneChunkData(world.chunks.get("0,0")),
        normalizeGeneratedChunk(chunk, jobFor(version, "overworld")));
      assert.deepEqual(world.admissionObserverErrors, []);
      let mutation;
      world.onMutation = (event) => {
        mutation = event;
        assert.equal(event.revision, world._editRevision, "revision is post-publication");
        assert.equal(world.get(5, world.minY + 16, 5), BLOCK.GLASS);
      };
      assert.equal(world.set(5, world.minY + 16, 5, BLOCK.GLASS), true);
      assert.equal(mutation.revision, 1);
    });

test("unsupported versions reject even absent or empty declaration planes", () => {
  const spec = getWorldSpec(6, "overworld");
  for (const generatorVersion of [undefined, 0, 7, "6"])
    for (const structures of [undefined, []])
      assert.throws(() => cloneTerrainStructures(structures,
        { ...jobFor(6, "overworld"), generatorVersion }, spec, new Uint16Array(384 * 256)), RangeError);
});
