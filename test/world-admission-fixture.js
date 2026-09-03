import assert from "node:assert/strict";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { chunkTransferList, createChunkPacket } from "../src/chunk-data.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";

export const ADMISSION_SEED = "authored-admission-fixture";

/** Literal column data, not natural terrain or a materialized structure. */
export function admissionChunk(cx, cz, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
  const ground = spec.minY + 16;
  const y = ground + 1;
  blocks.fill(BLOCK.STONE, 16 * 256, 17 * 256);
  const sy = Math.floor(y / 16);
  const states = new Uint16Array(4096);
  const fluids = new Uint8Array(4096);
  const local = (y - sy * 16) * 256 + 2 * 16;
  blocks[17 * 256 + 2 * 16 + 1] = BLOCK.OAK_STAIRS;
  states[local + 1] = S.TOP | 1;
  fluids[local + 1] = F.WATER_SOURCE;
  blocks[17 * 256 + 2 * 16 + 2] = BLOCK.WATER;
  fluids[local + 2] = F.BUBBLE_UP;
  blocks[17 * 256 + 2 * 16 + 3] = BLOCK.OAK_LOG;
  states[local + 3] = S.AXIS_Z;
  const structureId = `authored:${dimension}:${cx},${cz}`;
  return {
    cx,
    cz,
    minY: spec.minY,
    maxY: spec.maxY,
    blocks,
    biomes: new Uint8Array(256),
    sections: [{ sy, states, fluids }],
    structures: [
      {
        id: structureId,
        kind: "authored-admission-only",
        dimension,
        markers: [
          {
            id: `${structureId}/container/unit`,
            structureId,
            type: "container",
            key: "unit",
            role: "fixture",
            position: { x: cx * 16 + 4, y, z: cz * 16 + 2 },
          },
        ],
      },
    ],
  };
}

export function admissionGenerator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    getSpawn: () => ({ x: 0.5, y: spec.minY + 17.01, z: 0.5 }),
    generateChunk: (cx, cz) =>
      admissionChunk(cx, cz, dimension, generatorVersion),
  };
}

export function admissionWorld(t, options = {}) {
  const generated = [];
  const world = new World(ADMISSION_SEED, {
    useWorker: false,
    generatorFactory(seed, dimension, generatorVersion) {
      const generator = admissionGenerator(seed, dimension, generatorVersion);
      return {
        ...generator,
        generateChunk(cx, cz) {
          const chunk = generator.generateChunk(cx, cz);
          generated.push({ dimension, generatorVersion, cx, cz, chunk });
          return chunk;
        },
      };
    },
    ...options,
  });
  t.after(() => world.dispose());
  return { world, generated };
}

/**
 * Real World worker admission with controlled fixture packets. Keep the default
 * v3 factory identity; neither enable v4 nor override World's worker gating.
 */
export function admissionWorkerWorld(t, { immediate = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers = [];
  class AdmissionWorker {
    constructor() {
      this.sent = [];
      this.pending = new Map();
      this.terminated = false;
      workers.push(this);
    }

    postMessage(request) {
      assert.equal(
        this.terminated,
        false,
        "a retired worker cannot receive new jobs"
      );
      this.sent.push(request);
      this.pending.set(request.id, request);
      if (immediate) this.reply(request);
    }

    reply(request = this.pending.values().next().value) {
      this.pending.delete(request.id);
      const packet = createChunkPacket(
        admissionChunk(
          request.cx,
          request.cz,
          request.dimension,
          request.generatorVersion
        ),
        request
      );
      this.onmessage({
        data: structuredClone(packet, { transfer: chunkTransferList(packet) }),
      });
    }

    terminate() {
      this.terminated = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: AdmissionWorker,
  });
  const world = new World(ADMISSION_SEED, { generatorVersion: 3 });
  const generated = [];
  world.generator.getSpawn = () => ({ x: 0.5, y: 17.01, z: 0.5 });
  world.generator.generateChunk = (cx, cz) => {
    generated.push([cx, cz]);
    return admissionChunk(cx, cz, world.dimension, world.generatorVersion);
  };
  t.after(() => {
    world.dispose();
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else delete globalThis.Worker;
  });
  return { world, generated, workers };
}

export function drainAdmissions(t, world, workers = []) {
  for (let step = 0; step < 1000 && world._requests.size; step++) {
    t.mock.timers.tick(1);
    for (const worker of [...workers]) {
      for (const request of [...worker.pending.values()]) {
        if (worker.terminated) break;
        worker.reply(request);
      }
    }
  }
  assert.equal(world._requests.size, 0, "admission requests must settle");
  assert.equal(world._inFlight.size, 0);
}
