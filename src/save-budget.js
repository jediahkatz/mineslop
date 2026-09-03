export const MAX_EDITS = 2_000_000;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_RESERVED_BYTES = 224 * 1024 * 1024;

const utf8 = new TextEncoder();
const validBytes = (bytes) => Number.isSafeInteger(bytes) && bytes >= 0;
const referenceOwner = (owner) =>
  owner !== null && (typeof owner === "object" || typeof owner === "function");

/**
 * Exact UTF-8 bytes of the JSON projection, not the in-memory value. Normal JSON
 * omission/toJSON rules apply; unsupported roots, cycles and bigint throw.
 * Owners add separator/envelope overhead to changed-record counts; do not
 * serialize whole saves per action. Moving records may reserve bounded maxima.
 */
export function encodedBytes(value) {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new TypeError("Value has no JSON representation");
  return utf8.encode(json).byteLength;
}

/**
 * Incremental reservations keyed by object/function identity. Mutators return
 * booleans; usage is undefined for an unregistered owner, distinct from zero.
 * Registration may replace an already-validated staged load's entire footprint.
 * allowOverBudget retains accepted input; it does not validate an archive or waive
 * future capacity checks. Actual archive bytes/edit counts are checked separately.
 */
export class SaveBudget {
  #owners = new Map();
  #totalBytes = 0;

  get totalBytes() {
    return this.#totalBytes;
  }

  usage(owner) {
    return this.#owners.get(owner);
  }

  register(owner, bytes = 0, options = {}) {
    if (
      !referenceOwner(owner) ||
      !validBytes(bytes) ||
      !options ||
      typeof options !== "object" ||
      Array.isArray(options)
    )
      return false;
    let allowOverBudget;
    try {
      ({ allowOverBudget = false } = options);
    } catch {
      return false;
    }
    if (typeof allowOverBudget !== "boolean") return false;
    const total = this.#totalBytes - (this.#owners.get(owner) ?? 0) + bytes;
    if (!validBytes(total) || (!allowOverBudget && !this.#allows(total)))
      return false;
    this.#owners.set(owner, bytes);
    this.#totalBytes = total;
    return true;
  }

  release(owner) {
    if (!this.#owners.has(owner)) return false;
    this.#totalBytes -= this.#owners.get(owner);
    this.#owners.delete(owner);
    return true;
  }

  canCommit(changes) {
    return this.#prepare(changes) !== null;
  }

  /** Revalidate immediately; admission is not a lease or a cached permission. */
  commit(changes) {
    const prepared = this.#prepare(changes);
    if (!prepared) return false;
    for (const { owner, afterBytes } of prepared.entries)
      this.#owners.set(owner, afterBytes);
    this.#totalBytes = prepared.total;
    return true;
  }

  #allows(total) {
    return total <= MAX_RESERVED_BYTES || total <= this.#totalBytes;
  }

  #prepare(changes) {
    if (!Array.isArray(changes)) return null;
    const seen = new Set();
    const entries = [];
    let removed = 0;
    let added = 0;
    try {
      for (const change of changes) {
        if (!change || typeof change !== "object" || Array.isArray(change))
          return null;
        const { owner, beforeBytes, afterBytes } = change;
        if (
          seen.has(owner) ||
          !this.#owners.has(owner) ||
          !validBytes(beforeBytes) ||
          !validBytes(afterBytes) ||
          this.#owners.get(owner) !== beforeBytes
        )
          return null;
        seen.add(owner);
        removed += beforeBytes;
        added += afterBytes;
        if (!validBytes(removed) || !validBytes(added)) return null;
        entries.push({ owner, afterBytes });
      }
    } catch {
      return null;
    }
    // Subtract ALL old reservations first: a later owner can fund an earlier one,
    // and valid transfers never transiently overflow safe-integer arithmetic.
    const total = this.#totalBytes - removed + added;
    if (!validBytes(total) || !this.#allows(total)) return null;
    return { entries, total };
  }
}
