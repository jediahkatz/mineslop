import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_STATE as S,
  defaultFluidFor,
  FLUID,
} from "../src/block-state.js";
import { BLOCK as B } from "../src/blocks.js";
import { normalizeChunkPacket } from "../src/chunk-data.js";
import { createGenerator, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { handleTerrainRequest } from "../src/terrain.worker.js";
import { createTerrainV4 } from "../src/terrain-v4.js";
import { getWorldSpec } from "../src/world-spec.js";
import { chunkCell, naturalColumns, v4Digest } from "./terrain-v4-helpers.js";

function compareRegionChunk(region, chunk) {
  const dx = chunk.cx * 16 - region.minX;
  const dz = chunk.cz * 16 - region.minZ;
  assert.equal(chunk.minY, region.minY);
  assert.equal(chunk.maxY, region.maxY);
  const layer = region.width * region.depth;
  for (let y = 0; y < chunk.maxY - chunk.minY; y++)
    for (let z = 0; z < 16; z++) {
      const start = y * layer + (z + dz) * region.width + dx;
      assert.deepEqual(
        chunk.blocks.subarray(y * 256 + z * 16, y * 256 + z * 16 + 16),
        region.blocks.subarray(start, start + 16)
      );
    }
  for (let z = 0; z < 16; z++)
    assert.deepEqual(
      chunk.biomes.subarray(z * 16, z * 16 + 16),
      region.biomes.subarray(
        (z + dz) * region.width + dx,
        (z + dz) * region.width + dx + 16
      )
    );
  for (let sy = Math.floor(chunk.minY / 16); sy < chunk.maxY / 16; sy++) {
    const wide = region.sections?.find(
      (entry) =>
        entry.cx === chunk.cx && entry.cz === chunk.cz && entry.sy === sy
    );
    const narrow = chunk.sections?.find((entry) => entry.sy === sy);
    if (wide?.states || narrow?.states)
      assert.deepEqual(
        wide?.states ?? new Uint16Array(4096),
        narrow?.states ?? new Uint16Array(4096)
      );
    if (wide?.fluids || narrow?.fluids) {
      const start = (sy * 16 - chunk.minY) * 256;
      const defaults = () =>
        Uint8Array.from(
          chunk.blocks.subarray(start, start + 4096),
          defaultFluidFor
        );
      assert.deepEqual(
        wide?.fluids ?? defaults(),
        narrow?.fluids ?? defaults()
      );
    }
  }
  assert.deepEqual(
    chunk.structures ?? [],
    (region.structures ?? []).filter(
      ({ bounds }) =>
        bounds.minX < (chunk.cx + 1) * 16 &&
        bounds.maxX > chunk.cx * 16 &&
        bounds.minZ < (chunk.cz + 1) * 16 &&
        bounds.maxZ > chunk.cz * 16
    ),
    "independent chunks retain the same complete intersecting declarations"
  );
}

for (const dimension of ["overworld", "nether", "end"]) {
  for (const [minX, minZ] of [
    [-16, -16],
    [WORLD_MIN, WORLD_MAX - 32],
  ]) {
    test(`real v4 ${dimension} independent chunk/region/order parity at ${minX},${minZ}`, {
      // Real full-height voxel buffers and multiple independent generators.
      timeout: 30000,
    }, () => {
      const seed = "v4-global-ownership";
      const wide = createGenerator(seed, dimension, 4);
      const region = wide.generateRegion(minX, minZ, 32, 32);
      const coordinates = [
        [minX / 16, minZ / 16],
        [minX / 16 + 1, minZ / 16],
        [minX / 16, minZ / 16 + 1],
        [minX / 16 + 1, minZ / 16 + 1],
      ];
      const expected = new Map();
      for (const [cx, cz] of coordinates) {
        const chunk = createGenerator(seed, dimension, 4).generateChunk(cx, cz);
        compareRegionChunk(region, chunk);
        expected.set(`${cx},${cz}`, v4Digest(chunk));
      }
      const reverse = createGenerator(seed, dimension, 4);
      for (const [cx, cz] of coordinates.toReversed())
        assert.equal(
          v4Digest(reverse.generateChunk(cx, cz)),
          expected.get(`${cx},${cz}`)
        );
      assert.deepEqual(wide.spec, getWorldSpec(4, dimension));
      assert.ok(region.blocks instanceof Uint16Array);
    });
  }
}

test("real v4 clipped world-edge regions contain no outside cells or unsafe coordinate aliases", {
  timeout: 30000, // Full-height region at both horizontal bounds in all dimensions.
}, () => {
  for (const dimension of ["overworld", "nether", "end"]) {
    const generator = createGenerator("v4-world-edge", dimension, 4);
    for (const minX of [WORLD_MIN - 8, WORLD_MAX - 8]) {
      const region = generator.generateRegion(minX, -8, 16, 16);
      for (let x = 0; x < 16; x++) {
        const outside = minX + x < WORLD_MIN || minX + x >= WORLD_MAX;
        if (!outside) continue;
        assert.equal(generator.surfaceYAt(minX + x, 0), null);
        for (let y = 0; y < generator.maxY - generator.minY; y++)
          for (let z = 0; z < 16; z++)
            assert.equal(region.blocks[y * 256 + z * 16 + x], B.AIR);
      }
    }
    assert.throws(
      () => generator.generateChunk(Number.MAX_SAFE_INTEGER, 0),
      /safe integers/
    );
    assert.throws(() => generator.generateRegion(0, 0, 65, 16), /1–64/);
  }
});

// An intentionally authored marker fixture atop REAL v4 terrain. This proves
// the future decorator/transport seam; it is not a shipwreck/ruin implementation.
const marker = {
  id: "authored-test-marker",
  spacing: 32,
  reach: 4,
  maxWrites: 16,
  describe({ gx, gz }) {
    const x = gx * 32 + 31;
    const z = gz * 32 + 8;
    return [
      {
        kind: "authored-test-marker",
        x,
        z,
        bounds: {
          minX: x - 2,
          minY: -17,
          minZ: z,
          maxX: x + 4,
          maxY: 0,
          maxZ: z + 1,
        },
      },
    ];
  },
  emit(descriptor, put) {
    for (let dx = -2; dx <= 3; dx++) {
      put(descriptor.x + dx, -17, descriptor.z, B.OAK_LOG, {
        state: S.AXIS_X,
        mode: "replace",
      });
      put(descriptor.x + dx, -1, descriptor.z, B.OAK_SLAB, {
        fluid: FLUID.WATER_SOURCE,
        mode: "replace",
      });
    }
  },
};

test("authored descriptor fixture has clipped ID/state/fluid parity across negative chunk/section seams", {
  timeout: 30000, // Several real terrain chunks plus the explicit test marker.
}, () => {
  const factory = () =>
    createTerrainV4("v4-decorator-seam", "overworld", { decorators: [marker] });
  const generator = factory();
  const region = generator.generateRegion(-16, 0, 48, 16);
  assert.ok(
    region.structures.every((entry) => entry.kind === "authored-test-marker")
  );
  let states = 0;
  let fluids = 0;
  for (const cx of [1, 0, -1]) {
    const chunk = factory().generateChunk(cx, 0);
    compareRegionChunk(region, chunk);
    states += (chunk.sections ?? []).filter((section) => section.states).length;
    fluids += (chunk.sections ?? []).filter((section) => section.fluids).length;
  }
  assert.ok(states > 0 && fluids > 0);
  const natural = createTerrainV4("v4-decorator-seam").generateChunk(0, 0);
  assert.equal(
    natural.structures,
    undefined,
    "natural terrain must not advertise fake structures"
  );
});

test("real v4 worker dispatch preserves the request identity and all generated typed planes", {
  timeout: 30000, // Default production worker handler, no fake generator injection.
}, () => {
  for (const dimension of ["overworld", "nether", "end"]) {
    const seed = "v4-worker-parity";
    const spec = getWorldSpec(4, dimension);
    const job = {
      type: "generate",
      schemaVersion: 2,
      id: 7,
      epoch: 11,
      seed,
      dimension,
      generatorVersion: 4,
      cx: -1,
      cz: 0,
      ...spec,
    };
    const sent = [];
    handleTerrainRequest(job, (packet, transfer) =>
      sent.push({ packet, transfer })
    );
    assert.equal(sent.length, 1);
    const { packet, transfer } = sent[0];
    assert.equal(packet.type, "chunk", packet.message);
    assert.equal(packet.encoding, "u16");
    assert.equal(packet.seed, seed);
    assert.equal(packet.epoch, 11);
    assert.ok(transfer.includes(packet.blocks.buffer));
    assert.ok(transfer.includes(packet.biomes.buffer));
    for (const section of packet.sections ?? []) {
      if (section.states) assert.ok(transfer.includes(section.states.buffer));
      if (section.fluids) assert.ok(transfer.includes(section.fluids.buffer));
    }
    const transferred = structuredClone(packet, { transfer });
    const normalized = normalizeChunkPacket(transferred, job);
    const expected = createGenerator(seed, dimension, 4).generateChunk(-1, 0);
    assert.equal(
      v4Digest({ ...normalized, sections: [...normalized.sections.values()] }),
      v4Digest(expected)
    );
    assert.equal(
      v4Digest(createGenerator(seed, dimension, 4).generateChunk(-1, 0)),
      v4Digest(expected)
    );
  }
});

test("a real oriented tree branch survives native generation and the production worker packet", {
  timeout: 30000, // Search actual tree descriptors, then generate the chosen branch's chunk.
}, () => {
  const seed = "v4-native-log-axis";
  const generator = createGenerator(seed, "overworld", 4);
  let found = null;
  let checked = 0;
  search: for (const col of naturalColumns(generator)) {
    if (
      !col.profile.tree ||
      ["spruce", "pine", "giant_spruce", "mushroom"].includes(col.profile.tree)
    )
      continue;
    const gx = Math.floor(col.x / 8);
    const gz = Math.floor(col.z / 8);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const tree of generator.getTrees(gx + dx, gz + dz)) {
          const part = tree.parts.find(
            (entry) => entry.state === S.AXIS_X || entry.state === S.AXIS_Z
          );
          if (!part) continue;
          const cx = Math.floor(part.x / 16);
          const cz = Math.floor(part.z / 16);
          const chunk = generator.generateChunk(cx, cz);
          const cell = chunkCell(chunk, part.x, part.y, part.z);
          if (cell.id === tree.wood && cell.state === part.state) {
            found = { cx, cz, part, cell };
            break search;
          }
          if (++checked >= 64) break search;
        }
  }
  assert.ok(found, "native branching wood must have a non-default axis");
  const job = {
    type: "generate",
    schemaVersion: 2,
    id: 31,
    epoch: 5,
    seed,
    dimension: "overworld",
    generatorVersion: 4,
    cx: found.cx,
    cz: found.cz,
  };
  let packet;
  handleTerrainRequest(job, (message) => {
    packet = message;
  });
  assert.equal(packet.type, "chunk", packet.message);
  assert.deepEqual(
    chunkCell(packet, found.part.x, found.part.y, found.part.z),
    found.cell
  );
  assert.ok(
    packet.sections.some((section) =>
      section.states?.some((state) => state !== 0)
    )
  );
});
