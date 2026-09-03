import { advanceBrewing } from "./brewing.js";
import { nextEnchantingSeed, synchronous } from "./enchantment-domain.js";
import { normalizeEnchantingPlayer } from "./enchanting.js";
import { captureEntityContext } from "./entity-context.js";
import { progressionReadSet } from "./progression-access.js";
import { normalizeProgressionContext } from "./progression-context.js";
import {
  createProgressionStationsSnapshot, createStationRecord, freezeStationEntry,
  MAX_ACTIVE_BREWING_STANDS, MAX_PROGRESSION_STATIONS, normalizeProgressionStationsSnapshot,
  normalizeStationEntry, progressionStationKey, progressionStationKind,
  PROGRESSION_STATIONS_VERSION, stationEntryBytes, stationHeaderBytes,
  stationCanBrew, stationPosition, stationSlots,
} from "./progression-station-state.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const noOp = () => {};

/**
 * The sole public owner of physical enchanting/anvil/brewing/smithing escrow
 * and the player's table seed. NOT Settlement, a menu, or a second inventory.
 * Construction/load are detached; no World writes, callbacks or subscriptions.
 * Parent must retain this owner across dimension changes.
 */
export class ProgressionStations {
  #records = new Map();
  #sizes = new Map();
  #brewing = new Set();
  #player;
  #randomState;
  #revision = 0;
  #bytes = 0;
  #disposed = false;
  #preparing = false;
  #sealed = false;

  constructor({ world, context = world, catalog, snapshot, allowOverBudget = false,
    onChange = noOp } = {}) {
    const normalizedContext = normalizeProgressionContext(context);
    if (
      !(world?.coordinator instanceof TransactionCoordinator) ||
      world.coordinator.usage(world) === undefined || world._disposed ||
      world.seed !== normalizedContext.seed ||
      world.generatorVersion !== normalizedContext.generatorVersion ||
      !synchronous(onChange) || typeof allowOverBudget !== "boolean"
    )
      throw new RangeError("Stations require their World's shared coordinator");
    const normalized = normalizeProgressionStationsSnapshot(
      snapshot === undefined ? createProgressionStationsSnapshot(normalizedContext) : snapshot,
      catalog, normalizedContext
    );
    Object.defineProperties(this, {
      world: { value: world, enumerable: true },
      context: { value: normalizedContext, enumerable: true },
      coordinator: { value: world.coordinator, enumerable: true },
      catalog: { value: catalog },
    });
    this.onChange = onChange;
    this.#install(normalized);
    if (!this.coordinator.register(this, this.#bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve progression stations");
  }

  get revision() { return this.#revision; }
  get reservedBytes() { return this.#bytes; }
  get disposed() { return this.#disposed; }
  get size() { return this.#records.size; }
  get brewingCount() { return this.#brewing.size; }
  get playerState() { return { ...this.#player }; }
  get randomState() { return this.#randomState; }

  #available() {
    return !this.#disposed && !this.world._disposed &&
      this.world.coordinator === this.coordinator &&
      this.world.seed === this.context.seed &&
      this.world.generatorVersion === this.context.generatorVersion &&
      this.coordinator.usage(this) === this.#bytes;
  }

  #install(snapshot) {
    const records = new Map(), sizes = new Map(), brewing = new Set();
    let bytes = stationHeaderBytes(this.context);
    for (const value of snapshot.stations) {
      const entry = freezeStationEntry(value), key = progressionStationKey(entry);
      const size = stationEntryBytes(entry, this.catalog, this.context);
      records.set(key, entry);
      sizes.set(key, size);
      bytes += size;
      if (stationCanBrew(entry, this.catalog, this.context)) brewing.add(key);
    }
    this.#records = records;
    this.#sizes = sizes;
    this.#brewing = brewing;
    this.#bytes = bytes - Number(records.size > 0);
    this.#player = normalizeEnchantingPlayer(snapshot.player);
    this.#randomState = snapshot.randomState;
  }

  get(value) {
    const key = progressionStationKey(stationPosition(value, this.context));
    const entry = this.#records.get(key);
    return entry ? structuredClone(entry) : null;
  }

  serialize() {
    if (!this.#available()) throw new Error("Cannot serialize stale progression stations");
    return structuredClone({
      version: PROGRESSION_STATIONS_VERSION,
      seed: this.context.seed, generatorVersion: this.context.generatorVersion,
      player: this.#player, randomState: this.#randomState,
      stations: [...this.#records.values()],
    });
  }

  /**
   * Staged replacement only; callers must never load half of a live archive.
   * Use a NEW GameProgressionServices candidate for live-world replacement.
   */
  load(snapshot, { allowOverBudget = false } = {}) {
    if (!this.#available() || this.#preparing || this.#sealed ||
        typeof allowOverBudget !== "boolean")
      return false;
    const normalized = normalizeProgressionStationsSnapshot(snapshot, this.catalog, this.context);
    // Build all fallible state before touching the registered owner.
    const entries = normalized.stations.map((entry) => [
      progressionStationKey(entry), freezeStationEntry(entry),
      stationEntryBytes(entry, this.catalog, this.context),
    ]);
    const records = new Map(entries.map(([key, entry]) => [key, entry]));
    const sizes = new Map(entries.map(([key, , size]) => [key, size]));
    const brewing = new Set(entries.filter(([, entry]) =>
      stationCanBrew(entry, this.catalog, this.context)).map(([key]) => key));
    const bytes = stationHeaderBytes(this.context) +
      entries.reduce((sum, [, , size]) => sum + size, 0) - Number(entries.length > 0);
    if (!this.coordinator.register(this, bytes, { allowOverBudget })) return false;
    this.#records = records;
    this.#sizes = sizes;
    this.#brewing = brewing;
    this.#player = normalizeEnchantingPlayer(normalized.player);
    this.#randomState = normalized.randomState;
    this.#bytes = bytes;
    this.#revision++;
    return true;
  }

  /** Activation closes staged load; runtime changes must be prepared transfers. */
  seal() {
    if (!this.#available() || this.#preparing ||
        !this.coordinator.register(this, this.#bytes, { allowOverBudget: true })) return false;
    this.#sealed = true;
    return true;
  }

  #prepare(edits, { validate, playerState, randomState, notify = true } = {}) {
    if (!this.#available() || !synchronous(validate) || this.#preparing ||
        !Array.isArray(edits) || edits.length > 128 || typeof notify !== "boolean")
      return null;
    this.#preparing = true;
    try {
      const revision = this.#revision, store = this.#records;
      const current = captureEntityContext(this.world, this.context);
      const player = this.#player, random = this.#randomState;
      const nextPlayer = playerState === undefined ? player : normalizeEnchantingPlayer(playerState);
      const nextRandom = randomState === undefined ? random : randomState;
      if (!Number.isSafeInteger(nextRandom) || nextRandom < 0 || nextRandom > 0xffffffff)
        return null;
      const staged = [], seen = new Set();
      let count = store.size;
      let brewingCount = this.#brewing.size;
      let bytes = this.#bytes + Number(count > 0);
      for (const { at, before, after, reuseBytes = false } of edits) {
        const key = progressionStationKey(stationPosition(at, this.context));
        const previous = store.get(key) ?? null;
        if (seen.has(key) || !same(previous, before)) return null;
        seen.add(key);
        // Only our private progress-only path supplies reuseBytes: it changes
        // bounded timers, not positions, slots, batch identity or seed.
        const next = after === null ? null : freezeStationEntry(reuseBytes
          ? after : normalizeStationEntry(after, this.catalog, this.context));
        if (next && progressionStationKey(next) !== key) return null;
        const size = next === null ? 0 : reuseBytes
          ? this.#sizes.get(key) : stationEntryBytes(next, this.catalog, this.context);
        if (!Number.isSafeInteger(size)) return null;
        bytes += size - (this.#sizes.get(key) ?? 0);
        count += Number(next !== null) - Number(previous !== null);
        const brewing = stationCanBrew(next, this.catalog, this.context);
        brewingCount += Number(brewing) - Number(this.#brewing.has(key));
        staged.push({ key, previous, next, size, brewing });
      }
      if (count > MAX_PROGRESSION_STATIONS || brewingCount > MAX_ACTIVE_BREWING_STANDS ||
          !Number.isSafeInteger(revision + 1))
        return null;
      bytes -= Number(count > 0);
      const beforeBytes = this.#bytes;
      let used = false;
      return Object.freeze({
        owner: this, beforeBytes, afterBytes: bytes,
        validate: () => !used && this.#available() && !this.#preparing && current() &&
          this.#revision === revision && this.#records === store &&
          this.#player === player && this.#randomState === random &&
          this.#bytes === beforeBytes && validate() === true,
        publish: () => {
          used = true;
          for (const { key, next, size, brewing } of staged) {
            if (next === null) { store.delete(key); this.#sizes.delete(key); }
            else { store.set(key, next); this.#sizes.set(key, size); }
            if (brewing) this.#brewing.add(key); else this.#brewing.delete(key);
          }
          this.#player = nextPlayer;
          this.#randomState = nextRandom;
          this.#bytes = bytes;
          this.#revision++;
        },
        ...(notify ? { notify: () => this.onChange() } : {}),
      });
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this.#preparing = false;
    }
  }

  prepareOpen(at, { validate } = {}) {
    const reads = progressionReadSet(this.world, this.context);
    if (!reads || at.dimension !== this.world.dimension || !synchronous(validate))
      return null;
    const kind = progressionStationKind(reads.read(at.x, at.y, at.z)?.id);
    if (!kind) return null;
    const before = this.get(at);
    if (before && before.kind !== kind) return null;
    const after = before ?? { ...stationPosition(at, this.context), kind, record: createStationRecord(kind) };
    return this.#prepare([{ at, before, after }], {
      validate: () => reads.validate() && validate(),
      notify: before === null,
    });
  }

  /** Combined escrow + player seed participant required by enchanting.js. */
  prepareChange(at, change, { validate, randomState, remove = false } = {}) {
    if (at?.dimension !== this.world.dimension) return null;
    const reads = progressionReadSet(this.world, this.context);
    const before = this.get(at);
    if (!before || !reads || !synchronous(validate) ||
        progressionStationKind(reads.read(at.x, at.y, at.z)?.id) !== before.kind ||
        !same(before.record, change?.before?.record) ||
        (change.before.playerState && !same(change.before.playerState, this.#player)))
      return null;
    return this.#prepare([{
      at, before, after: remove ? null : { ...before, record: change.after.record },
    }], {
      validate: () => reads.validate() && validate(),
      randomState, playerState: change.after.playerState,
    });
  }

  /** A separate prepared RNG stream: wear/Mending can never reroll table offers. */
  prepareRandom(draws, { validate } = {}) {
    if (!Number.isInteger(draws) || draws < 1 || draws > 256) return null;
    let state = this.#randomState;
    const rolls = Array.from({ length: draws }, () => {
      state = nextEnchantingSeed(state);
      return state / 0x100000000;
    });
    const participant = this.#prepare([], { validate, randomState: state, notify: false });
    return participant ? { rolls, participant } : null;
  }

  /**
   * Parent MUST compose the returned source with its World removal AND a
   * destination accepting ALL stacks. validateDestination pins those prepared
   * peers; prepareStationRemoval in the interaction host supplies this safely.
   * Anvil stage changes retain the same escrow and are not removals.
   */
  prepareRemoval(changes, { validateDestination, randomDraws = 0 } = {}) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 128 ||
        !synchronous(validateDestination) || !Number.isInteger(randomDraws) ||
        randomDraws < 0 || randomDraws > 256) return null;
    const current = captureEntityContext(this.world, this.context);
    const reads = progressionReadSet(this.world, this.context);
    if (!reads) return null;
    const edits = [], stacks = [];
    for (const change of changes) {
      const at = { ...change, dimension: this.world.dimension };
      const before = this.get(at);
      if (!before) continue;
      const cell = reads.read(at.x, at.y, at.z);
      if (!same(cell, change.before) ||
          progressionStationKind(cell?.id) !== before.kind)
        return null;
      if (progressionStationKind(change.after?.id) === before.kind) continue;
      stacks.push(...stationSlots(before.kind, before.record, this.context).filter(Boolean));
      edits.push({ at, before, after: null });
    }
    // Harvest wear and physical removal share this owner's ONE participant.
    // A second prepareRandom participant would otherwise duplicate the owner.
    let randomState = this.#randomState;
    const rolls = Object.freeze(Array.from({ length: randomDraws }, () => {
      randomState = nextEnchantingSeed(randomState);
      return randomState / 0x100000000;
    }));
    const participant = this.#prepare(edits, {
      validate: () => current() && reads.validate() && validateDestination(),
      randomState,
    });
    return participant ? { stacks, rolls, participant } : null;
  }

  /**
   * At most 64 active recipes, each receiving the SAME active dt. No whole-save
   * serialization, scan of idle tables, runtime time debt or offline catch-up.
   * Fractional ticks live in the paid stand and therefore survive save/load.
   * A budget below the active set refuses instead of silently skipping time.
   */
  prepareBrewingAdvance(dt, { limit = MAX_ACTIVE_BREWING_STANDS, validate } = {}) {
    if (!this.#available() || !Number.isFinite(dt) || dt <= 0 || dt > 0.25 ||
        !Number.isInteger(limit) || limit < this.#brewing.size ||
        limit < 1 || limit > MAX_ACTIVE_BREWING_STANDS || !synchronous(validate)) return null;
    if (!this.#brewing.size) return { changed: false, checked: 0 };
    const current = captureEntityContext(this.world, this.context);
    const edits = [], guards = [];
    let checked = 0, completed = 0;
    for (const key of this.#brewing) {
      const entry = this.#records.get(key);
      if (!entry || entry.dimension !== this.world.dimension) continue;
      checked++;
      const reads = progressionReadSet(this.world, this.context);
      const cell = reads?.read(entry.x, entry.y, entry.z);
      if (progressionStationKind(cell?.id) !== "brewing" || !reads.validate()) continue;
      const transition = advanceBrewing(entry.record, dt, this.catalog, { context: this.context });
      if (!transition.changed) continue;
      edits.push({
        at: entry, before: entry, after: { ...entry, record: transition.state },
        reuseBytes: !transition.reservationChanged,
      });
      guards.push(reads);
      completed += transition.operationsCompleted;
    }
    if (!edits.length) return { changed: false, checked };
    const participant = this.#prepare(edits, {
      validate: () => current() && validate() && guards.every((read) => read.validate()),
      notify: completed > 0,
    });
    return participant ? { changed: true, checked, completed, participant } : null;
  }

  dispose() {
    if (this.#disposed) return true;
    if (this.#preparing || !this.coordinator.release(this)) return false;
    this.#disposed = true;
    this.#revision++;
    return true;
  }
}
