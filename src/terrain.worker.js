import { createGenerator } from "./terrain.js";
import {
  chunkTransferList,
  createChunkPacket,
  validateChunkJob,
} from "./chunk-data.js";

let cachedGenerator;
let cachedKey;
let cachedFactory;

/**
 * The browser worker and World fallback share the versioned native factory,
 * including the frozen all-family v4 manifest. Injection is only a test seam.
 */
export function handleTerrainRequest(
  data,
  send,
  { generatorFactory = createGenerator } = {}
) {
  if (data?.type !== "generate") return;
  const { id, epoch, seed, dimension, generatorVersion, cx, cz } = data;
  try {
    validateChunkJob(data);
    const key = JSON.stringify([seed, dimension, generatorVersion]);
    if (key !== cachedKey || generatorFactory !== cachedFactory) {
      const generator = generatorFactory(seed, dimension, generatorVersion);
      cachedGenerator = generator;
      cachedKey = key;
      cachedFactory = generatorFactory;
    }
    const chunk = cachedGenerator.generateChunk(cx, cz);
    const packet = createChunkPacket(chunk, data);
    send(packet, chunkTransferList(packet));
  } catch (error) {
    send({
      type: "error",
      schemaVersion: 2,
      id,
      epoch,
      seed,
      dimension,
      generatorVersion,
      cx,
      cz,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

if (
  typeof WorkerGlobalScope !== "undefined" &&
  globalThis instanceof WorkerGlobalScope
) {
  self.onmessage = ({ data }) =>
    handleTerrainRequest(data, (message, transfer) =>
      self.postMessage(message, transfer ?? [])
    );
}
