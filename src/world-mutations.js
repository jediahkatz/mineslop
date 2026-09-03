import { BLOCK } from "./blocks.js";
import { cellsEqual, normalizeCell } from "./block-state.js";
import {
  cellIndex,
  chunkKey,
  prepareChunkWrites,
  publishChunkWrites,
  readChunkCell,
} from "./chunk-data.js";
import { MAX_EDITS } from "./save-budget.js";
import { CHUNK_SIZE } from "./terrain.js";
import {
  cellEditTuple,
  editChunkKey,
  editKey,
  editRecordBytes,
} from "./world-edits.js";
import { inWorldBounds, isEditablePosition } from "./world-spec.js";

const owners = new WeakMap();
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function location(world, x, y, z) {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const key = chunkKey(cx, cz);
  const chunk = world.chunks.get(key);
  return {
    x,
    y,
    z,
    cx,
    cz,
    key,
    chunk,
    incarnation: chunk?.incarnation,
    revision: chunk?.revision,
    at: cellIndex(x, y, z, world.spec),
  };
}

function sameLocation(world, read) {
  const chunk = world.chunks.get(read.key);
  return (
    chunk === read.chunk &&
    chunk?.incarnation === read.incarnation &&
    chunk?.revision === read.revision
  );
}

function expectedCell(change, read = false) {
  const field = Object.hasOwn(change, "before")
    ? "before"
    : Object.hasOwn(change, "expected")
      ? "expected"
      : read && Object.hasOwn(change, "cell")
        ? "cell"
        : null;
  if (!field) throw new RangeError("An expected cell is required");
  return change[field] === null ? null : normalizeCell(change[field]);
}

function prepare(world, changes, options, allowUnloaded) {
  if (
    world._disposed ||
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > MAX_EDITS ||
    !object(options) ||
    (options.epoch !== undefined && options.epoch !== world.epoch) ||
    (options.notify !== undefined && typeof options.notify !== "function")
  )
    return null;
  const { reads: requested = [], prerequisites = [] } = options;
  if (
    !Array.isArray(requested) ||
    !Array.isArray(prerequisites) ||
    requested.length + prerequisites.length > MAX_EDITS
  )
    return null;
  const requestedReads = [...requested, ...prerequisites];
  const epoch = world.epoch;
  const revision = world._editRevision;
  const dimension = world.dimension;
  const beforeBytes = world._editBytes;
  const records = [];
  const reads = [];
  const targets = new Set();
  const byChunk = new Map();
  let afterBytes = beforeBytes + (world.edits.size ? 1 : 0);
  let afterCount = world.edits.size;
  try {
    for (const change of changes) {
      if (
        !object(change) ||
        (change.dimension !== undefined && change.dimension !== dimension) ||
        !isEditablePosition(
          change.x,
          change.y,
          change.z,
          world.generatorVersion,
          dimension
        )
      )
        return null;
      const { x, y, z } = change;
      const target = location(world, x, y, z);
      const key = editKey(dimension, x, y, z);
      if (targets.has(key) || (!target.chunk && !allowUnloaded)) return null;
      targets.add(key);
      const before = target.chunk
        ? readChunkCell(target.chunk, target.at)
        : (world.edits.get(key) ?? null);
      if (!cellsEqual(before, expectedCell(change))) return null;
      if (before?.id === BLOCK.BEDROCK) return null;
      const after = Object.freeze(
        normalizeCell(
          Object.hasOwn(change, "after") ? change.after : change.cell
        )
      );
      reads.push({ ...target, before, editKey: key, legacy: allowUnloaded });
      if (cellsEqual(before, after)) continue;
      const original = target.chunk
        ? (target.chunk.originals.get(target.at) ?? before)
        : null;
      const remove = original !== null && cellsEqual(original, after);
      const size = remove
        ? 0
        : editRecordBytes(cellEditTuple(dimension, x, y, z, after));
      afterBytes += size - (world._editRecordBytes.get(key) ?? 0);
      if (remove && world.edits.has(key)) afterCount--;
      else if (!remove && !world.edits.has(key)) afterCount++;
      const columnKey = editChunkKey(dimension, target.cx, target.cz);
      const record = {
        ...target,
        editKey: key,
        columnKey,
        before,
        after,
        original,
        remove,
        size,
      };
      records.push(record);
      if (target.chunk) {
        if (!byChunk.has(target.chunk)) byChunk.set(target.chunk, []);
        byChunk.get(target.chunk).push({ at: target.at, cell: after });
      }
    }
    for (const read of requestedReads) {
      if (
        !object(read) ||
        ![read.x, read.y, read.z].every(Number.isSafeInteger) ||
        (read.dimension !== undefined && read.dimension !== dimension)
      )
        return null;
      const target = location(world, read.x, read.y, read.z);
      const before = world.getCell(read.x, read.y, read.z);
      if (!cellsEqual(before, expectedCell(read, true))) return null;
      reads.push({ ...target, before });
    }
  } catch {
    return null;
  }
  if (!records.length || afterCount > MAX_EDITS) return null;
  if (afterCount) afterBytes--;

  const chunkWrites = [...byChunk].map(([chunk, writes]) => ({
    chunk,
    prepared: prepareChunkWrites(chunk, writes),
  }));
  const newColumns = new Map();
  for (const record of records) {
    if (!record.remove && !world._editsByChunk.has(record.columnKey))
      newColumns.set(record.columnKey, new Map());
  }
  const dirtySections = world._cellDirtySections(records);
  const event = Object.freeze({
    epoch,
    dimension,
    changes: Object.freeze(
      records.map(({ x, y, z, before, after }) =>
        Object.freeze({
          x,
          y,
          z,
          before: before === null ? null : Object.freeze({ ...before }),
          after,
        })
      )
    ),
  });
  const notify = options.notify;
  let used = false;
  const participant = Object.freeze({
    owner: world,
    beforeBytes,
    afterBytes,
    validate() {
      if (
        used ||
        world._disposed ||
        world.epoch !== epoch ||
        world.dimension !== dimension ||
        world._editRevision !== revision ||
        world._editBytes !== beforeBytes
      )
        return false;
      for (const read of reads) {
        if (!sameLocation(world, read)) return false;
        const current =
          read.legacy && !read.chunk
            ? (world.edits.get(read.editKey) ?? null)
            : world.getCell(read.x, read.y, read.z);
        if (!cellsEqual(current, read.before)) return false;
      }
      return true;
    },
    publish() {
      used = true;
      for (const [key, column] of newColumns)
        world._editsByChunk.set(key, column);
      for (const record of records) {
        const column = world._editsByChunk.get(record.columnKey);
        if (record.remove) {
          world.edits.delete(record.editKey);
          world._editRecordBytes.delete(record.editKey);
          column?.delete(record.at);
          record.chunk.originals.delete(record.at);
        } else {
          world.edits.set(record.editKey, record.after);
          world._editRecordBytes.set(record.editKey, record.size);
          column.set(record.at, record.after);
          if (record.chunk)
            record.chunk.originals.set(record.at, record.original);
        }
      }
      for (const record of records) {
        if (world._editsByChunk.get(record.columnKey)?.size === 0)
          world._editsByChunk.delete(record.columnKey);
      }
      for (const { chunk, prepared } of chunkWrites) {
        publishChunkWrites(chunk, prepared);
        chunk.revision++;
        for (const sy of prepared.sections.keys())
          chunk.sectionRevisions.set(
            sy,
            (chunk.sectionRevisions.get(sy) ?? 0) + 1
          );
      }
      world._editBytes = afterBytes;
      world._editRevision++;
      world._markSectionsDirty(dirtySections);
    },
    notify() {
      world.onMutation?.(event);
      notify?.(event);
    },
  });
  owners.set(participant, world);
  return participant;
}

/**
 * Changes: {x,y,z,before,after}; expected/cell are aliases for before/after.
 * options.reads (alias prerequisites) holds {x,y,z,before: Cell|null}.
 * Null reads pin unavailable neighbors as unavailable. Mutation targets must
 * be loaded. Every participant captures epoch, incarnation and owner revision.
 */
export function prepareWorldMutation(world, changes, options = {}) {
  return prepare(world, changes, options, false);
}

export function isWorldMutation(world, plan) {
  return object(plan) && owners.get(plan) === world;
}

/** Compatibility only: set never generates a missing column or resets same IDs. */
export function prepareLegacySet(world, x, y, z, id) {
  if (world._disposed || !inWorldBounds(x, y, z, world.spec)) return null;
  let after;
  try {
    after = normalizeCell({ id });
  } catch {
    return null;
  }
  const before = world.isLoaded(x, z)
    ? world.getCell(x, y, z)
    : (world.edits.get(editKey(world.dimension, x, y, z)) ?? null);
  if (before?.id === id) return null;
  return prepare(world, [{ x, y, z, before, after }], {}, true);
}
