import {
  chunkTransferList,
  normalizeChunkPacket,
  normalizeGeneratedChunk,
} from "../src/chunk-data.js";
import { createGenerator } from "../src/terrain.js";
import { V4_GENERATION_MANIFEST } from "../src/terrain-v4-manifest.js";
import { World } from "../src/world.js";
import {
  assertNativeV4FrozenBuild,
  readNativeV4Host,
} from "./native-v4-browser-host.js";

const build = Object.freeze({
  fixture: "native-v4-worker",
  production: import.meta.env.PROD,
  development: import.meta.env.DEV,
  hmr: Boolean(import.meta.hot),
  label: import.meta.env.VITE_BENCHMARK_LABEL ?? null,
});
readNativeV4Host(location.origin);
assertNativeV4FrozenBuild(build);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function samePlane(actual, expected, label) {
  check(
    actual?.constructor === expected?.constructor,
    `${label}: wrong encoding`
  );
  check(actual?.length === expected?.length, `${label}: wrong length`);
  if (!actual) return;
  for (let i = 0; i < actual.length; i++)
    if (actual[i] !== expected[i])
      throw new Error(`${label}: mismatched cell ${i}`);
}

function sameChunk(actual, expected) {
  for (const key of ["cx", "cz", "minY", "maxY"])
    check(actual[key] === expected[key], `chunk ${key}`);
  samePlane(actual.blocks, expected.blocks, "blocks");
  samePlane(actual.biomes, expected.biomes, "biomes");
  check(actual.sections.size === expected.sections.size, "section count");
  for (const [sy, section] of expected.sections) {
    const got = actual.sections.get(sy);
    check(got?.sy === sy, "absolute section coordinate");
    samePlane(got.states, section.states, `${sy}/states`);
    samePlane(got.fluids, section.fluids, `${sy}/fluids`);
  }
  check(
    JSON.stringify(actual.structures) === JSON.stringify(expected.structures),
    "complete structure declarations, including presence"
  );
}

function requestPacket(worker, job) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
      worker.removeEventListener("messageerror", fail);
    };
    const fail = (event) => {
      cleanup();
      reject(new Error(event.message ?? "Native module worker failed"));
    };
    const receive = ({ data }) => {
      if (data?.id !== job.id) return;
      cleanup();
      if (data.type !== "chunk")
        reject(new Error(data.message ?? "Missing native worker packet"));
      else resolve(data);
    };
    const timer = setTimeout(
      () =>
        fail({
          message: "Native worker packet exceeded the production 15s timeout",
        }),
      15000
    );
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    try {
      worker.postMessage(job);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Real browser module workers, real default-factory World and real fallback.
 * This page imports no Game/save/UI lifecycle and never touches local storage.
 * These are transport assertions, not a streaming/FPS release certification.
 */
async function run(cases) {
  readNativeV4Host(location.origin);
  assertNativeV4FrozenBuild(build);
  check(
    Array.isArray(cases) && cases.length > 0 && cases.length <= 8,
    "bounded browser workload"
  );
  const results = [];
  for (const input of cases) {
    const { seed, dimension, cx, cz, structureId } = input;
    check(
      typeof seed === "string" && seed.length <= 80,
      "raw World-valid browser seed"
    );
    if (structureId !== undefined)
      check(
        typeof structureId === "string" &&
          structureId.startsWith("structure:v1:"),
        "an expected native declaration must have its canonical ID"
      );
    const admissions = [];
    const world = new World(seed, {
      generatorVersion: 4,
      dimension,
      onChunkAdmitted: (event) => admissions.push(event),
    });
    const fallback = new World(seed, {
      generatorVersion: 4,
      dimension,
      useWorker: false,
    });
    const directWorker = new Worker(
      new URL("../src/terrain.worker.js", import.meta.url),
      { type: "module" }
    );
    try {
      check(
        world._generatorFactory === createGenerator &&
          fallback._generatorFactory === createGenerator,
        "no injected native factories"
      );
      check(
        world.seed === seed && fallback.seed === seed,
        "raw seed is never trimmed or replaced"
      );
      check(
        world.generator.generationManifest === V4_GENERATION_MANIFEST &&
          fallback.generator.generationManifest === V4_GENERATION_MANIFEST,
        "canonical factory manifest"
      );
      const position = { x: cx * 16 + 0.5, z: cz * 16 + 0.5 };
      await world.ensureArea(position, 0);
      check(
        world._worker instanceof Worker && !world._workerDisabled,
        "World must actually complete through its browser module worker"
      );
      check(
        world.generator.counters.chunkGenerations === 0,
        "native World must not silently substitute synchronous generation"
      );
      check(admissions.length === 1, "one post-admission event");
      check(
        world.admissionObserverErrors.length === 0,
        "no admission observer failures"
      );
      await fallback.ensureArea(position, 0);
      check(
        fallback._worker === null &&
          fallback._workerDisabled &&
          fallback.generator.counters.chunkGenerations === 1,
        "explicit native fallback path"
      );
      check(
        fallback.admissionObserverErrors.length === 0,
        "no fallback observer failures"
      );
      const resident = world.chunks.get(`${cx},${cz}`);
      const event = admissions[0];
      check(
        event.world === world &&
          event.chunk === resident &&
          Object.isFrozen(event),
        "event borrows the installed native resident"
      );
      for (const [key, value] of Object.entries({
        seed,
        dimension,
        generatorVersion: 4,
        cx,
        cz,
        epoch: world.epoch,
        incarnation: resident.incarnation,
        revision: 0,
      }))
        check(event[key] === value, `admission identity ${key}`);
      sameChunk(resident, fallback.chunks.get(`${cx},${cz}`));
      const job = {
        type: "generate",
        schemaVersion: 2,
        id: results.length + 1,
        epoch: 17,
        seed,
        dimension,
        generatorVersion: 4,
        cx,
        cz,
        minY: world.minY,
        maxY: world.maxY,
      };
      const expected = normalizeGeneratedChunk(
        createGenerator(seed, dimension, 4).generateChunk(cx, cz),
        job
      );
      sameChunk(resident, expected);
      const packet = await requestPacket(directWorker, job);
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
        check(packet[key] === job[key], `worker identity ${key}`);
      const transfers = chunkTransferList(packet);
      const views = [packet.blocks, packet.biomes];
      for (const section of packet.sections ?? []) {
        if (section.states) views.push(section.states);
        if (section.fluids) views.push(section.fluids);
      }
      check(
        transfers.length === new Set(transfers).size,
        "deduplicated transfer buffers"
      );
      for (const view of views)
        check(transfers.includes(view.buffer), "every typed plane transfers");
      const received = structuredClone(packet, { transfer: transfers });
      for (const view of views)
        check(view.byteLength === 0, "transported plane detaches");
      sameChunk(normalizeChunkPacket(received, job), expected);
      for (const y of [world.minY, world.maxY - 1])
        check(
          world.getCell(cx * 16, y, cz * 16) !== null,
          `real bound cell ${y}`
        );
      for (const y of [world.minY - 1, world.maxY])
        check(
          world.getCell(cx * 16, y, cz * 16) === null,
          `exclusive bound ${y}`
        );
      if (structureId !== undefined) {
        const declaration = resident.structures?.find(
          (descriptor) => descriptor.id === structureId
        );
        check(
          declaration &&
            declaration.seed === seed &&
            declaration.dimension === dimension &&
            declaration.generatorVersion === 4 &&
            declaration.markers.length > 0,
          "the first natural structure must retain its real canonical declaration and markers"
        );
      }
      let residentBytes =
        resident.blocks.byteLength + resident.biomes.byteLength;
      for (const section of resident.sections.values())
        residentBytes +=
          (section.states?.byteLength ?? 0) + (section.fluids?.byteLength ?? 0);
      results.push({
        seed,
        dimension,
        cx,
        cz,
        minY: resident.minY,
        maxY: resident.maxY,
        manifest: world.generator.generationManifest.id,
        cellsCompared: resident.blocks.length,
        sections: resident.sectionRevisions.size,
        auxiliarySections: resident.sections.size,
        structures: (resident.structures ?? []).map((entry) => ({
          id: entry.id,
          markers: entry.markers.length,
        })),
        transferBuffers: transfers.length,
        residentPlaneBytes: residentBytes,
        workerMainThreadGenerations: world.generator.counters.chunkGenerations,
        fallbackWork: fallback.generator.lastGenerationWork,
        fallbackCaches: fallback.generator.cacheSizes,
      });
    } finally {
      directWorker.terminate();
      world.dispose();
      fallback.dispose();
    }
  }
  return results;
}

window.__nativeV4Transport = Object.freeze({ build, run });
