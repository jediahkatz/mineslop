import { normalizeCell } from "./block-state.js";
import { cellIndex } from "./chunk-data.js";
import { encodedBytes, MAX_EDITS } from "./save-budget.js";
import { CHUNK_SIZE } from "./terrain.js";
import { getWorldSpec, isDimension, isEditablePosition } from "./world-spec.js";

export const editKey = (dimension, x, y, z) => `${dimension}:${x},${y},${z}`;
export const editChunkKey = (dimension, cx, cz) => `${dimension}:${cx},${cz}`;
export const cellEditTuple = (dimension, x, y, z, cell) => [
  dimension,
  x,
  y,
  z,
  cell.id,
  cell.state,
  cell.fluid,
];

// Per-record costs include one separator, independent of map order. The owner
// subtracts the final separator when nonempty; fixed headroom covers brackets.
export const editRecordBytes = (tuple) => encodedBytes(tuple) + 1;

/** Shared by disk import and World.loadEdits; legacy tuples gain real defaults. */
export function normalizeWorldSave(data, { expectedSeed } = {}) {
  if (
    !data ||
    typeof data !== "object" ||
    ![1, 2, 3].includes(data.version) ||
    typeof data.seed !== "string" ||
    data.seed.length > 80 ||
    (expectedSeed !== undefined && data.seed !== expectedSeed) ||
    !Array.isArray(data.edits) ||
    data.edits.length > MAX_EDITS
  )
    throw new RangeError("Unsupported or invalid world format");
  const generatorVersion = data.version === 1 ? 1 : data.generatorVersion;
  const dimension = data.version === 1 ? "overworld" : data.dimension;
  getWorldSpec(generatorVersion, dimension);
  const edits = new Map();
  for (const source of data.edits) {
    if (
      !Array.isArray(source) ||
      source.length !== (data.version === 1 ? 4 : data.version === 2 ? 5 : 7)
    )
      throw new RangeError("Invalid block edit");
    const [dim, x, y, z, id, state, fluid] =
      data.version === 1 ? ["overworld", ...source] : source;
    if (
      !isDimension(dim) ||
      !isEditablePosition(x, y, z, generatorVersion, dim) ||
      (data.version === 3 && (state === undefined || fluid === undefined))
    )
      throw new RangeError("Invalid block coordinates or material");
    let cell;
    try {
      cell = normalizeCell({ id, state, fluid });
    } catch {
      throw new RangeError("Invalid block coordinates, state or fluid");
    }
    // Old archives already used last-write-wins within each edited chunk.
    // Validate every tuple before coalescing so a bad earlier tuple cannot hide.
    edits.set(editKey(dim, x, y, z), cellEditTuple(dim, x, y, z, cell));
  }
  return {
    version: 3,
    generatorVersion,
    seed: data.seed,
    dimension,
    edits: [...edits.values()],
  };
}

export function createEditState(data) {
  const edits = new Map();
  const byChunk = new Map();
  const recordBytes = new Map();
  let bytes = 0;
  for (const tuple of data.edits) {
    const [dimension, x, y, z, id, state, fluid] = tuple;
    const cell = Object.freeze({ id, state, fluid });
    const key = editKey(dimension, x, y, z);
    const column = editChunkKey(
      dimension,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(z / CHUNK_SIZE)
    );
    if (!byChunk.has(column)) byChunk.set(column, new Map());
    byChunk
      .get(column)
      .set(
        cellIndex(x, y, z, getWorldSpec(data.generatorVersion, dimension)),
        cell
      );
    edits.set(key, cell);
    const size = editRecordBytes(tuple);
    recordBytes.set(key, size);
    bytes += size;
  }
  if (edits.size) bytes--;
  return { edits, byChunk, recordBytes, bytes };
}
