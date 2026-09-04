import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { normalizeGeneratedChunk } from "../src/chunk-data.js";
import { stageWorld } from "../src/game-world-stage.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { getWorldSpec } from "../src/world-spec.js";
import { browserJob, check, sameJSON, sameNativeChunk } from "./terrain-v7-browser-contract.js";
import { checkStagingGeneration } from "./terrain-v7-staging-generation.js";

// Real Game staging entry point, real World/generation/landing/save logic.
// No VoxelGame/DOM/renderer facade, replacement World or terrain factory.
// Node may run this with expectWorker:false and fake-indexeddb; that is explicitly
// fallback/storage-fixture evidence, never a browser/module-worker certification.
export async function runV7NativeStaging({ expectWorker = true, indexedDB = globalThis.indexedDB } = {}) {
  check(GENERATOR_VERSION === 3, "ordinary-new-world activation is still gated");
  const rows = [];
  for (const version of [null, 7, 1, 2, 3, 4, 5, 6, 7]) {
    const isSaved = rows.length >= 2, expectedVersion = version ?? 3;
    const seed = "cedar-valley", dimension = isSaved ? "end" : "overworld";
    const source = createGenerator(seed, dimension, expectedVersion);
    const spawn = source.getSpawn();
    const saved = isSaved ? {
      version: 3,
      world: { version: 3, generatorVersion: expectedVersion, seed, dimension,
        edits: [[dimension, 4, 94, 4, BLOCK.OAK_LOG, BLOCK_STATE.AXIS_X, FLUID.NONE]] },
      player: { ...spawn, yaw: 0.25, pitch: -0.1, flying: false },
    } : null;
    const input = {
      seed, dimension: "overworld", quality: "low", mode: "survival", saved,
      // Deliberately different from saved End1–6: saved dimension/version win.
      ...(version === null ? {} : { generatorVersion: 7 }),
    };
    const staged = await stageWorld(input);
    const world = staged.world;
    const storage = new WorldStorage({ indexedDB, name: "mineslop-v7-native-staging-gate" });
    try {
      check(world.generatorVersion === expectedVersion, "saved version/default preserved by Game staging");
      check(world.dimension === dimension, "saved dimension preserved by Game staging");
      check(world._generatorFactory === createGenerator, "production World factory");
      sameJSON(world.spec, getWorldSpec(expectedVersion, dimension), "staged spec");
      check(world.chunks.size === 49, "low-quality Game staging stays at 7x7 columns");
      let generation = null;
      if (expectWorker) {
        check(world._worker instanceof Worker && !world._workerDisabled, "staging must use a real browser module worker");
        generation = checkStagingGeneration(world, isSaved);
      } else check(world._worker === null, "Node fixture explicitly verifies native fallback");
      check(world.admissionObserverErrors.length === 0, "staging admissions");
      const resident = isSaved ? world.chunks.get("-1,-1") : world.chunks.values().next().value;
      const expected = normalizeGeneratedChunk(source.generateChunk(resident.cx, resident.cz),
        browserJob(seed, dimension, expectedVersion, resident.cx, resident.cz, 1));
      sameNativeChunk(resident, expected);
      check(world.edits.size === Number(isSaved), "staging never manufactures a platform");
      if (isSaved) {
        check(staged.restored, "native saved pose restores without relocation");
        sameJSON(staged.pose.position, spawn, "saved pose position");
        sameJSON(world.serialize(), saved.world, "saved world is not migrated");
        sameJSON(world.getCell(4, 94, 4),
          { id: BLOCK.OAK_LOG, state: BLOCK_STATE.AXIS_X, fluid: FLUID.NONE }, "stateful saved edit");
      }
      if (expectedVersion >= 4 && expectedVersion <= 6)
        check((world.generator.getEndPillars?.() ?? []).length === 0, "no phantom legacy4–6 pillars");
      const archive = { version: 3, world: world.serialize(),
        player: { ...staged.pose.position, yaw: staged.pose.yaw, pitch: staged.pose.pitch, flying: staged.pose.flying } };
      const parsed = parseWorldFile(exportWorldFile(archive));
      sameJSON(parsed.world, archive.world, "file version/edit preservation");
      await storage.save(parsed);
      const restored = await storage.load();
      sameJSON(restored.world, archive.world, "IndexedDB version/edit preservation");
      rows.push({ saved: isSaved, dimension, version: world.generatorVersion, spec: world.spec,
        chunks: world.chunks.size, restored: staged.restored, nativeCellsCompared: expected.blocks.length,
        worker: expectWorker, edits: world.edits.size, pose: staged.pose.position, generation });
    } finally {
      await storage.close();
      world.dispose();
    }
  }
  return rows;
}
