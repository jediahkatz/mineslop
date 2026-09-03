import { SaveBudget } from "./save-budget.js";

const rejected = (reason) => ({ ok: false, reason });
const validBytes = (bytes) => Number.isSafeInteger(bytes) && bytes >= 0;
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const thenable = (value) =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof value.then === "function";

export class TransactionInvariantError extends Error {
  constructor(message, cause) {
    super(`Transaction invariant: ${message}`, { cause });
    this.name = "TransactionInvariantError";
  }
}

/**
 * A synchronous preflight/install/observe protocol, NOT arbitrary callback rollback.
 *
 * Participants are {owner,beforeBytes,afterBytes,validate,publish,notify?}.
 * validate must be read-only and return exactly true, checking domain revisions,
 * read prerequisites and single-use state. Byte equality alone is not a revision.
 * publish may ONLY install already-validated state: no callbacks, veto, asynchronous
 * work, registry mutation or fallible external operations. Return values are not
 * vetoes. A publication throw/thenable is a fatal TransactionInvariantError; state
 * may already be partially installed, so callers must not treat it as rejection
 * or retry against those owners. This protocol cannot undo contract violations.
 *
 * Only notify may call observers or intentionally start another transaction.
 * All state and reservations are committed before notification, with the guard
 * released. Thrown observer values are collected without changing success.
 * Share ONE coordinator across participating domains and prepare them all before
 * committing once; do not mutate its budget directly from participant callbacks.
 */
export class TransactionCoordinator {
  #budget;
  #committing = false;
  #reentered = false;

  constructor({ budget = new SaveBudget() } = {}) {
    if (!(budget instanceof SaveBudget))
      throw new TypeError("TransactionCoordinator requires a SaveBudget");
    this.#budget = budget;
  }

  get budget() {
    return this.#budget;
  }

  register(owner, bytes = 0, options) {
    if (this.#rejectReentry()) return false;
    return this.#budget.register(owner, bytes, options);
  }

  release(owner) {
    if (this.#rejectReentry()) return false;
    return this.#budget.release(owner);
  }

  usage(owner) {
    return this.#budget.usage(owner);
  }

  #rejectReentry() {
    if (!this.#committing) return false;
    this.#reentered = true;
    return true;
  }

  /** Returns {ok:false,reason} before installation, or {ok:true,observerErrors}. */
  commit(participants) {
    if (this.#rejectReentry()) return rejected("reentrant-commit");
    this.#committing = true;
    this.#reentered = false;
    const staged = [];
    try {
      if (!Array.isArray(participants)) return rejected("invalid-participants");
      const owners = new Set();
      try {
        // Capture fields/functions once, before ANY user validation. Method calls
        // retain their original participant receiver, not this internal snapshot.
        for (const participant of participants) {
          if (
            !participant ||
            typeof participant !== "object" ||
            Array.isArray(participant)
          )
            return rejected("invalid-participant");
          const { owner, beforeBytes, afterBytes, validate, publish, notify } =
            participant;
          if (owners.has(owner)) return rejected("duplicate-owner");
          owners.add(owner);
          const usage = this.#budget.usage(owner);
          if (usage === undefined) return rejected("unknown-owner");
          if (!validBytes(beforeBytes) || !validBytes(afterBytes))
            return rejected("invalid-byte-count");
          if (usage !== beforeBytes) return rejected("stale-reservation");
          if (
            !synchronous(validate) ||
            !synchronous(publish) ||
            (notify !== undefined && !synchronous(notify))
          )
            return rejected("invalid-callback");
          staged.push({
            participant,
            owner,
            beforeBytes,
            afterBytes,
            validate,
            publish,
            notify,
          });
        }
      } catch {
        return rejected("invalid-participant");
      }
      if (this.#reentered) return rejected("reentrant-commit");
      for (const entry of staged) {
        let valid;
        try {
          valid = Reflect.apply(entry.validate, entry.participant, []);
        } catch {
          return rejected("validation-threw");
        }
        if (this.#reentered) return rejected("reentrant-commit");
        // Includes thenables without invoking their asynchronous continuation.
        if (valid !== true) return rejected("validation-failed");
      }
      try {
        if (
          !synchronous(this.#budget.canCommit) ||
          !synchronous(this.#budget.commit) ||
          this.#budget.canCommit(staged) !== true
        )
          return rejected("budget-rejected");
      } catch {
        return rejected("budget-rejected");
      }
      if (this.#reentered) return rejected("reentrant-commit");

      // Past this boundary there are NO ordinary rejection paths.
      for (const entry of staged) {
        try {
          const result = Reflect.apply(entry.publish, entry.participant, []);
          if (thenable(result))
            throw new TypeError("publish returned a thenable");
          if (this.#reentered)
            throw new Error(
              "publish attempted a recursive commit or registry change"
            );
        } catch (cause) {
          throw new TransactionInvariantError(
            "publish must only install prevalidated state",
            cause
          );
        }
      }
      try {
        if (this.#budget.commit(staged) !== true || this.#reentered)
          throw new Error("prevalidated reservations could not be installed");
      } catch (cause) {
        throw new TransactionInvariantError("budget publication failed", cause);
      }
    } finally {
      this.#committing = false;
    }

    const observerErrors = [];
    for (const entry of staged) {
      if (entry.notify === undefined) continue;
      try {
        if (thenable(Reflect.apply(entry.notify, entry.participant, [])))
          throw new TypeError("notify must be synchronous");
      } catch (error) {
        observerErrors.push(error);
      }
    }
    return { ok: true, observerErrors };
  }
}
