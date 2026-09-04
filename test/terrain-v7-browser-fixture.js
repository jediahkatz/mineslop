import { BLOCK } from "../src/blocks.js";
import { chunkTransferList, normalizeChunkPacket, normalizeGeneratedChunk } from "../src/chunk-data.js";
import { createGenerator } from "../src/terrain.js";
import { V7_GENERATION_MANIFEST } from "../src/terrain-v7-manifest.js";
import { World } from "../src/world.js";
import { browserJob, check, sameJSON, sameNativeChunk, v7BrowserCases } from "./terrain-v7-browser-contract.js";
import { assertV7BrowserBuild, readV7BrowserHost } from "./terrain-v7-browser-host.js";
import { runV7NativeStaging } from "./terrain-v7-browser-staging.js";

const build = Object.freeze({
  fixture: "terrain-v7-worker", production: import.meta.env.PROD,
  development: import.meta.env.DEV, hmr: Boolean(import.meta.hot),
  label: import.meta.env.VITE_BENCHMARK_LABEL ?? null,
  source: import.meta.env.VITE_NATIVE_V7_SOURCE_SHA ?? null,
});
readV7BrowserHost(location.origin);
assertV7BrowserBuild(build);
const position = (cx, cz) => ({ x: cx * 16 + 0.5, z: cz * 16 + 0.5 });

function requestPacket(worker, job) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
      worker.removeEventListener("messageerror", fail);
    };
    const fail = (event) => { cleanup(); reject(new Error(event.message ?? "module worker failed")); };
    const receive = ({ data }) => {
      if (data?.id !== job.id) return;
      cleanup(); resolve(data);
    };
    const timer = setTimeout(() => fail({ message: "native worker exceeded 15s" }), 15000);
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    try { worker.postMessage(job); } catch (error) { fail(error); }
  });
}

function transferPacket(packet, job, expected) {
  check(packet.type === "chunk", packet.message ?? "missing native packet");
  const buffers = chunkTransferList(packet);
  check(buffers.length === new Set(buffers).size, "deduplicated transfer list");
  const views = [packet.blocks, packet.biomes];
  for (const section of packet.sections ?? []) {
    if (section.states) views.push(section.states);
    if (section.fluids) views.push(section.fluids);
  }
  for (const view of views) check(buffers.includes(view.buffer), "all typed planes transfer");
  const received = structuredClone(packet, { transfer: buffers });
  for (const view of views) check(view.byteLength === 0, "onward transfer detaches the received buffer");
  sameNativeChunk(normalizeChunkPacket(received, job), expected);
  return { packet: received, count: buffers.length };
}

// Adversarial delivery is explicitly synthetic, but the replay payloads come
// from the real module worker. Valid native generation is never fabricated.
async function replayGuards(input, validPacket, foreignPacket, expected) {
  const { seed, dimension, cx, cz } = input;
  const outcomes = [];
  for (const foreign of [false, true]) {
    const events = [], world = new World(seed, {
      dimension, generatorVersion: 7, onChunkAdmitted: (event) => events.push(event),
    });
    try {
      // Let the foreign-replay worker genuinely start and deliver a native
      // column before terminating it; browser worker evidence is then stable.
      if (foreign) await world.ensureArea(position(cx + 1, cz), 0);
      const baseline = events.length;
      const pending = world.ensureArea(position(cx, cz), 0);
      // Send now, then synchronously replay before the genuine asynchronous reply.
      world._pump();
      const worker = world._worker, request = [...world._inFlight.values()][0];
      check(worker instanceof Worker && request, "real native request in flight");
      if (foreign) {
        worker.dispatchEvent(new MessageEvent("message", { data: {
          ...foreignPacket, id: request.id, epoch: world.epoch,
        } }));
        check(world._workerDisabled && world._worker === null, "foreign version must disable/reject the worker");
        check(events.length === baseline, "foreign bytes were not admitted");
      } else {
        for (const identity of [
          { id: request.id, epoch: world.epoch - 1 },
          { id: request.id + 100000, epoch: world.epoch },
        ])
          worker.dispatchEvent(new MessageEvent("message", { data: { ...validPacket, ...identity } }));
        check(world._worker === worker && events.length === baseline && world._inFlight.size === 1,
          "stale epoch and unknown request do not admit or cancel the current request");
      }
      await pending;
      sameNativeChunk(world.chunks.get(`${cx},${cz}`), expected);
      check(events.length - baseline === 1 && world.admissionObserverErrors.length === 0, "one genuine post-admission");
      check(world.generator.counters.chunkGenerations === (foreign ? 1 : 0), "expected native fallback only");
      outcomes.push({ replay: foreign ? "foreign-v6" : "stale-epoch-and-unknown-id",
        admitted: events.length - baseline, fallback: foreign });
    } finally { world.dispose(); }
  }
  return outcomes;
}

async function transport() {
  const rows = [];
  for (const input of v7BrowserCases()) {
    const { seed, dimension, cx, cz } = input;
    const world = new World(seed, { dimension, generatorVersion: 7 });
    const fallback = new World(seed, { dimension, generatorVersion: 7, useWorker: false });
    const direct = new Worker(new URL("../src/terrain.worker.js", import.meta.url), { type: "module" });
    try {
      check(world._generatorFactory === createGenerator && fallback._generatorFactory === createGenerator,
        "no injected generation factory");
      check(world.generator.generationManifest === V7_GENERATION_MANIFEST, "production v7 manifest");
      sameJSON(world.spec, fallback.spec, "complete dimension specs");
      const gen = createGenerator(seed, dimension, 7);
      sameJSON(world.spec, gen.spec, "World and native generator specs");
      const coordinates = [[cx, cz], [cx + 1, cz]];
      const expected = coordinates.map(([x, z]) => normalizeGeneratedChunk(gen.generateChunk(x, z),
        browserJob(seed, dimension, 7, x, z, 1)));
      // Opposite World and direct-worker orders exercise warm source caches.
      for (let i = 0; i < 2; i++) {
        await world.ensureArea(position(...coordinates[i]), 0);
        await fallback.ensureArea(position(...coordinates[1 - i]), 0);
      }
      let primaryPacket, transferBuffers = 0;
      for (const i of [1, 0, 0]) {
        const [x, z] = coordinates[i], job = browserJob(seed, dimension, 7, x, z, 10 + transferBuffers);
        const result = transferPacket(await requestPacket(direct, job), job, expected[i]);
        transferBuffers += result.count;
        if (i === 0) primaryPacket = result.packet;
      }
      for (let i = 0; i < 2; i++) {
        const key = coordinates[i].join(",");
        sameNativeChunk(world.chunks.get(key), expected[i]);
        sameNativeChunk(fallback.chunks.get(key), expected[i]);
      }
      const key = `${cx},${cz}`, incarnation = world.chunks.get(key).incarnation;
      if (input.pillar) {
        check(world.get(input.x, input.pillar.top, input.z) === BLOCK.OBSIDIAN, "real pillar body");
        check(world.get(input.x, input.pillar.cap.y, input.z) === BLOCK.GLOWSTONE, "real pillar cap");
      }
      if (input.structureId) {
        check(world.chunks.get(key).structures.some((entry) => entry.id === input.structureId), "real structure declaration");
        const p = input.marker.position;
        check(world.get(p.x, p.y, p.z) === BLOCK[input.marker.block], "native marker anchor");
      }
      // Exercise public streaming eviction, not Map.delete or replacement chunks.
      for (const target of [world, fallback]) {
        await target.ensureArea(position(cx + 8, cz + 8), 0);
        check(!target.chunks.has(key), "unloaded by normal World cache trimming");
        await target.ensureArea(position(cx, cz), 0);
        sameNativeChunk(target.chunks.get(key), expected[0]);
      }
      check(world.chunks.get(key).incarnation !== incarnation, "new resident incarnation after reload");
      check(world._worker instanceof Worker && !world._workerDisabled, "World remains on real worker path");
      check(world.generator.counters.chunkGenerations === 0, "no silent synchronous substitution");
      check(fallback._worker === null && fallback._workerDisabled, "explicit synchronous fallback");
      check(fallback.generator.counters.chunkGenerations === 4, "bounded two columns, remote and reload");
      sameJSON(world.generator.getEndPillars(), fallback.generator.getEndPillars(), "authoritative metadata");
      let guards = [];
      if (input.label === "pillar0") {
        const foreignJob = browserJob(seed, dimension, 6, cx, cz, 900);
        const foreign = await requestPacket(direct, foreignJob);
        normalizeChunkPacket(foreign, foreignJob); // Genuine supported-v6 source packet.
        guards = await replayGuards(input, primaryPacket, foreign, expected[0]);
        const future = await requestPacket(direct, { ...foreignJob, generatorVersion: 8, id: 901 });
        check(future.type === "error", "real module worker rejects unsupported8");
        const returnedJob = browserJob(seed, dimension, 7, cx, cz, 902);
        transferPacket(await requestPacket(direct, returnedJob), returnedJob, expected[0]);
      }
      check(world.admissionObserverErrors.length === 0 && fallback.admissionObserverErrors.length === 0,
        "no observer errors");
      rows.push({ label: input.label, dimension, cx, cz, spec: world.spec,
        cellsPerChunk: expected[0].blocks.length, transferBuffers, guards,
        worldMainThreadChunks: world.generator.counters.chunkGenerations,
        fallbackChunks: fallback.generator.counters.chunkGenerations,
        cacheReload: true, structures: (expected[0].structures ?? []).map(({ id }) => id) });
    } finally { direct.terminate(); world.dispose(); fallback.dispose(); }
  }
  return rows;
}

window.__v7NativeBrowser = Object.freeze({
  build,
  async run() {
    assertV7BrowserBuild(build);
    const cases = await transport();
    const staging = await runV7NativeStaging();
    return { cases, staging, performanceCertification: false, visualCertification: false };
  },
});
