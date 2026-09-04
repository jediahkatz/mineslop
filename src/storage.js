import { MAX_ARCHIVE_BYTES, MAX_EDITS } from "./save-budget.js";
import { normalizeWorldSave } from "./world-edits.js";
import {
  createWorldContext,
  inColumnBounds,
  isDimension,
  isWorldPose,
} from "./world-spec.js";

const DATABASE = "voxelcraft-worlds";
const utf8 = new TextEncoder();
const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("World save failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("World save was interrupted"));
  });

/** Old saves retain their original terrain generator and are never overwritten in localStorage. */
export function normalizeSave(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !input.world
  )
    throw new Error("Not a Mineslop world file");
  const data = structuredClone(input);
  if (![1, 2, 3].includes(data.version))
    throw new Error("Unsupported or invalid world format");
  if (data.world.version === 1) data.legacy = true;
  data.world = normalizeWorldSave(data.world);
  data.version = 3;
  const context = createWorldContext(data.world);
  if (data.player !== undefined) {
    const p = data.player;
    if (
      !isWorldPose(p, context, data.world.dimension) ||
      ![p.yaw, p.pitch].every(Number.isFinite)
    )
      throw new Error("Invalid player position");
  }
  if (
    data.time !== undefined &&
    (!Number.isFinite(data.time) || data.time < 0 || data.time > 1)
  )
    throw new Error("Invalid world clock");
  return data;
}

function checkArchiveBytes(text, maxBytes) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_ARCHIVE_BYTES
  )
    throw new RangeError("Invalid archive byte limit");
  if (
    typeof text !== "string" ||
    text.length > maxBytes ||
    utf8.encode(text).byteLength > maxBytes
  )
    throw new Error("World file is too large (256 MiB encoded limit)");
}

/** Optional caller limits may tighten, never raise, the shared archive ceiling. */
export function parseWorldFile(text, { maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  checkArchiveBytes(text, maxBytes);
  try {
    return normalizeSave(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("This file is not valid JSON");
    throw error;
  }
}

export function exportWorldFile(
  snapshot,
  { maxBytes = MAX_ARCHIVE_BYTES } = {}
) {
  const text = JSON.stringify(normalizeSave(snapshot));
  checkArchiveBytes(text, maxBytes);
  return text;
}

function groupEdits(edits) {
  const chunks = new Map();
  for (const [dimension, x, y, z, id, state, fluid] of edits) {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const key = `active|${dimension}|${cx},${cz}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = {
        key,
        worldKey: "active",
        version: 3,
        dimension,
        cx,
        cz,
        cells: new Map(),
      };
      chunks.set(key, chunk);
    }
    chunk.cells.set(`${x},${y},${z}`, [x, y, z, id, state, fluid]);
  }
  return new Map(
    [...chunks].map(([key, chunk]) => {
      const { cells, ...record } = chunk;
      record.edits = [...cells.values()];
      return [key, record];
    })
  );
}

function snapshotFromRecords(metadata, chunks) {
  if (!metadata) {
    if (chunks.length) throw new Error("Edited chunks have no world metadata");
    return null;
  }
  if (!metadata.snapshot?.world)
    throw new Error("Invalid stored world metadata");
  const snapshot = structuredClone(metadata.snapshot);
  const version = snapshot.world.version;
  const edits = [];
  const keys = new Set();
  for (const chunk of chunks) {
    if (
      !chunk ||
      chunk.worldKey !== "active" ||
      !isDimension(chunk.dimension) ||
      !Number.isSafeInteger(chunk.cx) ||
      !Number.isSafeInteger(chunk.cz) ||
      !inColumnBounds(chunk.cx * 16, chunk.cz * 16) ||
      chunk.key !== `active|${chunk.dimension}|${chunk.cx},${chunk.cz}` ||
      keys.has(chunk.key) ||
      (chunk.version !== undefined && chunk.version !== 3) ||
      !Array.isArray(chunk.edits) ||
      edits.length + chunk.edits.length > MAX_EDITS
    )
      throw new Error("Invalid stored edited chunk");
    keys.add(chunk.key);
    for (const edit of chunk.edits) {
      if (
        !Array.isArray(edit) ||
        edit.length !== (version === 3 ? 6 : 4) ||
        Math.floor(edit[0] / 16) !== chunk.cx ||
        Math.floor(edit[2] / 16) !== chunk.cz ||
        (version === 1 && chunk.dimension !== "overworld")
      )
        throw new Error("Invalid stored block edit");
      edits.push(version === 1 ? [...edit] : [chunk.dimension, ...edit]);
    }
  }
  snapshot.world.edits = edits;
  const normalized = normalizeSave(snapshot);
  if (
    metadata.identity !== undefined &&
    metadata.identity !==
      JSON.stringify([normalized.world.seed, normalized.world.generatorVersion])
  )
    throw new Error("Stored world identity does not match its terrain");
  return normalized;
}

export class StaleWorldError extends Error {
  constructor() {
    super(
      "Another tab has changed the saved world. Export your progress, then reload before saving again."
    );
    this.name = "StaleWorldError";
    this.code = "STALE_WORLD";
  }
}

/**
 * Metadata and edited chunks commit atomically. Untouched terrain never goes to disk.
 * Local writes are serialized; a revision check rejects writes from stale tabs.
 */
export class WorldStorage {
  constructor({ indexedDB = globalThis.indexedDB, name = DATABASE } = {}) {
    this.indexedDB = indexedDB;
    this.name = name;
    this.database = null;
    this.opening = null;
    this.queue = Promise.resolve();
    this.identity = null;
    this.revision = null;
    this.signatures = new Map();
    this.hydrated = false;
  }

  async open() {
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    if (!this.indexedDB)
      throw new Error(
        "Browser storage is unavailable; export a world file to keep your progress"
      );
    this.opening = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("worlds", { keyPath: "key" });
        const chunks = database.createObjectStore("chunks", { keyPath: "key" });
        chunks.createIndex("worldKey", "worldKey");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Close other Mineslop tabs to open this world"));
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => {
          this.database?.close();
          this.database = null;
          this.opening = null;
          // Reopening must not silently adopt a replacement archive's revision.
        };
        resolve(this.database);
      };
    });
    try {
      return await this.opening;
    } catch (error) {
      this.opening = null;
      throw error;
    }
  }

  async readRecords() {
    const database = await this.open();
    const transaction = database.transaction(["worlds", "chunks"], "readonly");
    const done = transactionDone(transaction);
    const [metadata, chunks] = await Promise.all([
      requestResult(transaction.objectStore("worlds").get("active")),
      requestResult(
        transaction.objectStore("chunks").index("worldKey").getAll("active")
      ),
      done,
    ]);
    // Validate the entire archive before adopting a revision/signature baseline.
    const snapshot = snapshotFromRecords(metadata, chunks);
    this.identity = metadata?.identity ?? null;
    this.revision = metadata?.revision ?? null;
    this.signatures = new Map(
      chunks.map((chunk) => [chunk.key, JSON.stringify(chunk.edits)])
    );
    this.hydrated = true;
    return { metadata, chunks, snapshot };
  }

  async load() {
    await this.queue.catch(() => {});
    const { snapshot } = await this.readRecords();
    return snapshot;
  }

  save(snapshot) {
    // Clone now, not when this write reaches the front of the queue.
    const validated = normalizeSave(snapshot);
    const next = this.queue.catch(() => {}).then(() => this.write(validated));
    this.queue = next;
    return next;
  }

  /**
   * Publish a replacement only if its synchronous activation succeeds. No
   * candidate records become visible before activation; abort/crash keeps the
   * previous archive intact. Callers must stop using retired live owners if the
   * transaction subsequently fails (e.g. quota), and recover by reloading.
   */
  replace(snapshot, activate) {
    if (typeof activate !== "function")
      throw new TypeError("A synchronous world activation is required");
    const validated = normalizeSave(snapshot);
    const next = this.queue.catch(() => {}).then(() => this.write(validated, activate));
    this.queue = next;
    return next;
  }

  async write(snapshot, activate) {
    if (!this.hydrated) await this.readRecords();
    const database = await this.open();
    const identity = JSON.stringify([
      snapshot.world.seed,
      snapshot.world.generatorVersion,
    ]);
    const chunks = groupEdits(snapshot.world.edits);
    const signatures = new Map(
      [...chunks].map(([key, chunk]) => [key, JSON.stringify(chunk.edits)])
    );
    const previousIdentity = this.identity;
    const previousSignatures = this.signatures;
    const expectedRevision = this.revision;
    // Fresh tokens avoid resetting a revision counter when an archive is cleared.
    const revision = globalThis.crypto
      .getRandomValues(new Uint32Array(4))
      .join("-");
    const transaction = database.transaction(["worlds", "chunks"], "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("chunks");
    const worlds = transaction.objectStore("worlds");
    try {
      // Check and mutate in the same transaction, before any clear/delete/put.
      const current = await requestResult(worlds.get("active"));
      if (
        (current?.revision ?? null) !== expectedRevision ||
        (current?.identity ?? null) !== previousIdentity
      )
        throw new StaleWorldError();
      if (previousIdentity !== identity) store.clear();
      else {
        for (const key of previousSignatures.keys())
          if (!chunks.has(key)) store.delete(key);
      }
      for (const [key, chunk] of chunks) {
        if (
          previousIdentity !== identity ||
          previousSignatures.get(key) !== signatures.get(key)
        )
          store.put(chunk);
      }
      const metadata = { ...snapshot, world: { ...snapshot.world } };
      delete metadata.world.edits;
      worlds.put({
        key: "active",
        identity,
        revision,
        updatedAt: Date.now(),
        snapshot: metadata,
      });
      // Stay in this transaction's request callback: never await activation.
      // A thrown error aborts all queued puts/clears, without a rollback write
      // that could clobber a newer tab's revision.
      const activation = activate?.();
      if (activation != null && typeof activation.then === "function") {
        // Reject asynchronous activation without leaking its eventual rejection.
        Promise.resolve(activation).catch(() => {});
        throw new TypeError("World activation must not be asynchronous");
      }
      await done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A failed transaction may already have aborted.
      }
      await done.catch(() => {});
      throw error;
    }
    this.identity = identity;
    this.revision = revision;
    this.signatures = signatures;
    return { chunks: chunks.size, savedAt: Date.now() };
  }

  async requestPersistence() {
    try {
      return (await globalThis.navigator?.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }

  async close() {
    await this.queue.catch(() => {});
    this.database?.close();
    this.database = null;
    this.opening = null;
    // Keep the loaded baseline until an explicit load, even across reconnects.
  }
}
