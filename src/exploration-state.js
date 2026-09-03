import {
  memberIdentity,
  normalizeExplorationMarker,
  normalizeTreasureMapTarget,
} from "./exploration-markers.js";
import {
  getLootTable,
  LOOT_TABLE_VERSION,
  lootNeedsMap,
  MAX_LOOT_STACKS,
  rollStructureLoot,
} from "./loot-tables.js";
import {
  composeProgressionPlan,
  freezeProgressData,
  normalizeProgressContext,
  prepareProgression,
  progressArray,
  progressionParticipants,
  progressPosition,
  progressPositionKey,
  progressRecord,
  synchronousProgressCallback,
} from "./progression-common.js";
import { normalizeProgressStack } from "./progression-items.js";
import { encodedBytes } from "./save-budget.js";
import { TransactionCoordinator } from "./transactions.js";

export const EXPLORATION_VERSION = 1;
export const MAX_EXPLORATION_CONTAINERS = 131072;
export const MAX_EXPLORATION_ENCOUNTERS = 32768;
// Two complete member/structure IDs plus a full contextual map target can exceed
// 2 KiB for an 80-character Unicode seed. Admission still charges exact UTF-8
// record bytes, not this ceiling, against the unchanged aggregate SaveBudget.
export const MAX_EXPLORATION_RECORD_BYTES = 4096;
export const MAX_EXPLORATION_BATCH = 32;

function containerRecord(value, context) {
  progressRecord(value, [
    "marker",
    "state",
    "claim",
    "lootVersion",
    "mapTarget",
  ]);
  const marker = normalizeExplorationMarker(value.marker, context);
  const definition = getLootTable(marker.role);
  if (
    marker.type !== "container" ||
    !definition ||
    marker.dimension !== definition.dimension ||
    !["materialized", "cleared", "destroyed"].includes(value.state) ||
    !["open", "break", "adopted"].includes(value.claim) ||
    (value.claim === "break" && value.state !== "destroyed") ||
    (value.claim === "adopted"
      ? value.lootVersion !== null
      : value.lootVersion !== LOOT_TABLE_VERSION)
  )
    throw new RangeError("Invalid persistent container claim");
  const needsMap = lootNeedsMap(marker.role);
  if (!needsMap && value.mapTarget !== undefined)
    throw new RangeError("Unexpected persistent map destination");
  const target =
    needsMap && (value.claim !== "adopted" || value.mapTarget !== undefined)
      ? value.mapTarget === null
        ? null
        : normalizeTreasureMapTarget(value.mapTarget, context)
      : undefined;
  if (target && target.dimension !== "overworld")
    throw new RangeError("Buried treasure is not in this dimension");
  return {
    marker,
    state: value.state,
    claim: value.claim,
    lootVersion: value.lootVersion,
    ...(target !== undefined ? { mapTarget: target } : {}),
  };
}

function encounterRecord(value, context) {
  progressRecord(value, ["marker", "completed"]);
  const marker = normalizeExplorationMarker(value.marker, context);
  if (marker.type !== "encounter" || value.completed !== true)
    throw new RangeError("Invalid unique encounter completion");
  return { marker, completed: true };
}

function recordBytes(value) {
  const bytes = encodedBytes(value);
  if (bytes > MAX_EXPLORATION_RECORD_BYTES)
    throw new RangeError("Exploration record exceeds its bound");
  return bytes + 1;
}

/** Pure contextual preflight. No temporary owners, loot rolls, truncation or IO. */
export function normalizeExplorationSnapshot(value, context) {
  try {
    context = normalizeProgressContext(context);
    progressRecord(value, [
      "version",
      "seed",
      "generatorVersion",
      "containers",
      "encounters",
    ]);
    if (
      value.version !== EXPLORATION_VERSION ||
      value.seed !== context.seed ||
      value.generatorVersion !== context.generatorVersion
    )
      return null;
    const containers = progressArray(
      value.containers,
      MAX_EXPLORATION_CONTAINERS
    ).map((record) => containerRecord(record, context));
    const encounters = progressArray(
      value.encounters,
      MAX_EXPLORATION_ENCOUNTERS
    ).map((record) => encounterRecord(record, context));
    const identities = new Set();
    const positions = new Set();
    for (const record of [...containers, ...encounters]) {
      const key = memberIdentity(record.marker, context);
      if (identities.has(key)) return null;
      identities.add(key);
      recordBytes(record);
      if (record.marker.type === "container") {
        const position = progressPositionKey(record.marker);
        if (positions.has(position)) return null;
        positions.add(position);
      }
    }
    return {
      version: EXPLORATION_VERSION,
      seed: context.seed,
      generatorVersion: context.generatorVersion,
      containers,
      encounters,
    };
  } catch {
    return null;
  }
}

/**
 * One world-wide permanent entitlement ledger, never a second chest inventory.
 * Missing record = uninitialized; materialized includes EMPTY containers.
 * Cleared/destroyed records and coordinate claims are never evicted or removed.
 * Ownership resides in Settlement/Gameplay/retained drops after materialization.
 * Preserve this instance across dimension travel/unload; archive it independently.
 */
export class ExplorationState {
  constructor({
    context,
    coordinator = new TransactionCoordinator(),
    onChange,
    rollLoot = rollStructureLoot,
    allowOverBudget = false,
  } = {}) {
    if (
      !(coordinator instanceof TransactionCoordinator) ||
      !synchronousProgressCallback(rollLoot) ||
      typeof allowOverBudget !== "boolean" ||
      (onChange !== undefined && !synchronousProgressCallback(onChange))
    )
      throw new TypeError("Invalid exploration domain dependencies");
    this.context = normalizeProgressContext(context);
    this.coordinator = coordinator;
    this.onChange = onChange;
    this._rollLoot = rollLoot;
    this._containers = new Map();
    this._encounters = new Map();
    this._positions = new Map();
    this._recordBytes = new Map();
    this._bytes = 0;
    this._revision = 0;
    this._busy = false;
    this._disposed = false;
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register exploration state");
  }

  get reservedBytes() {
    return this._bytes;
  }
  get revision() {
    return this._revision;
  }

  container(marker) {
    const key = memberIdentity(marker, this.context);
    return structuredClone(this._containers.get(key) ?? null);
  }

  containerAt(dimension, position) {
    const at = progressPosition(position, dimension, this.context);
    const key = this._positions.get(
      progressPositionKey({ dimension, position: at })
    );
    return structuredClone(this._containers.get(key) ?? null);
  }

  completed(marker) {
    return this._encounters.has(memberIdentity(marker, this.context));
  }

  _prepareRecords(changes, validate) {
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const context = this.context;
    const coordinator = this.coordinator;
    const stores = [this._containers, this._encounters];
    const sizes = stores.map((store) => store.size);
    const nextSizes = [...sizes];
    const records = [];
    const seen = new Set();
    const positions = new Set();
    let cost = beforeBytes + sizes.filter(Boolean).length;
    for (const value of changes) {
      const index = value.marker.type === "container" ? 0 : 1;
      const next = freezeProgressData(
        index === 0
          ? containerRecord(value, context)
          : encounterRecord(value, context)
      );
      const key = memberIdentity(next.marker, context);
      const store = stores[index];
      const previous = store.get(key);
      const position = index === 0 ? progressPositionKey(next.marker) : null;
      if (
        seen.has(key) ||
        (position !== null &&
          (positions.has(position) ||
            (this._positions.has(position) &&
              this._positions.get(position) !== key))) ||
        (previous &&
          JSON.stringify(previous.marker) !== JSON.stringify(next.marker))
      )
        return null;
      seen.add(key);
      if (position !== null) positions.add(position);
      if (previous) cost -= this._recordBytes.get(key);
      else nextSizes[index]++;
      const bytes = recordBytes(next);
      cost += bytes;
      records.push({ store, key, previous, next, bytes, position });
    }
    const afterBytes = cost - nextSizes.filter(Boolean).length;
    if (
      nextSizes[0] > MAX_EXPLORATION_CONTAINERS ||
      nextSizes[1] > MAX_EXPLORATION_ENCOUNTERS ||
      !Number.isSafeInteger(afterBytes) ||
      afterBytes < 0 ||
      !Number.isSafeInteger(revision + 1)
    )
      return null;
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._busy &&
        !this._disposed &&
        this.context === context &&
        this.coordinator === coordinator &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this._containers === stores[0] &&
        this._encounters === stores[1] &&
        records.every(
          ({ store, key, previous }) => store.get(key) === previous
        ) &&
        validate() === true,
      publish: () => {
        used = true;
        for (const { store, key, next, bytes, position } of records) {
          store.set(key, next);
          this._recordBytes.set(key, bytes);
          if (position !== null) this._positions.set(position, key);
        }
        this._bytes = afterBytes;
        this._revision++;
      },
      ...(this.onChange ? { notify: () => this.onChange() } : {}),
    });
  }

  /**
   * Bounded API: requests = [{marker,action,mapTarget?,firstClaim?,state?}].
   * An explicit firstClaim pins whether materialization must already exist.
   * open requires an unclaimed member; break rolls only if unclaimed; clear
   * requires materialized ownership. prepareDestination receives detached
   * [{marker,action,firstClaim,stacks}] and MUST prepare all Settlement records,
   * retained drops and world removal as needed, each owner at most once.
   * It is called even for empty stacks. No public mutation/commit may occur there.
   * validate must pin manifest membership AND live world/station prerequisites.
   * Map-bearing tables require a target or explicit null from a bounded locator.
   * Null is a permanent "no map destination" result, not an uninitialized lookup.
   * adopt never rolls. Its state is materialized/cleared/destroyed; mixing adopted
   * and first-time records still produces exactly ONE ledger participant.
   */
  prepareContainers(
    requests,
    { prepareDestination, validate, participants = [] } = {}
  ) {
    return prepareProgression(this, () => {
      if (
        !synchronousProgressCallback(prepareDestination) ||
        !synchronousProgressCallback(validate)
      )
        return null;
      progressArray(requests, MAX_EXPLORATION_BATCH);
      if (!requests.length || validate() !== true) return null;
      const records = [];
      const claims = [];
      const identities = new Set();
      const positions = new Set();
      for (const request of requests) {
        progressRecord(request, [
          "marker",
          "action",
          "mapTarget",
          "firstClaim",
          "state",
        ]);
        const marker = normalizeExplorationMarker(request.marker, this.context);
        const adopted = request.action === "adopt";
        if (
          marker.type !== "container" ||
          !["open", "break", "clear", "adopt"].includes(request.action) ||
          (!adopted && request.state !== undefined) ||
          (adopted &&
            !["materialized", "cleared", "destroyed"].includes(request.state))
        )
          return null;
        const key = memberIdentity(marker, this.context);
        const position = progressPositionKey(marker);
        if (identities.has(key) || positions.has(position)) return null;
        identities.add(key);
        positions.add(position);
        const previous = this._containers.get(key);
        const claimedPosition = this._positions.get(position);
        const firstClaim = previous === undefined;
        if (
          (claimedPosition !== undefined && claimedPosition !== key) ||
          (previous &&
            JSON.stringify(previous.marker) !== JSON.stringify(marker)) ||
          (request.firstClaim !== undefined &&
            request.firstClaim !== firstClaim) ||
          ((request.action === "open" || adopted) && previous) ||
          (request.action === "clear" && previous?.state !== "materialized") ||
          (request.action === "break" && previous?.state === "destroyed") ||
          (previous && request.mapTarget !== undefined)
        )
          return null;
        const mapTarget = previous ? previous.mapTarget : request.mapTarget;
        const record = containerRecord(
          {
            marker,
            state: adopted
              ? request.state
              : request.action === "open"
                ? "materialized"
                : request.action === "clear"
                  ? "cleared"
                  : "destroyed",
            claim: previous?.claim ?? (adopted ? "adopted" : request.action),
            lootVersion: previous
              ? previous.lootVersion
              : adopted
                ? null
                : LOOT_TABLE_VERSION,
            ...(mapTarget === undefined ? {} : { mapTarget }),
          },
          this.context
        );
        const stacks =
          firstClaim && !adopted
            ? progressArray(
                this._rollLoot(structuredClone(marker), this.context, {
                  ...(record.mapTarget !== undefined
                    ? { mapTarget: structuredClone(record.mapTarget) }
                    : {}),
                }),
                MAX_LOOT_STACKS
              ).map((stack) => normalizeProgressStack(stack, this.context))
            : [];
        records.push(record);
        claims.push({
          marker,
          action: request.action,
          firstClaim,
          adopted,
          stacks,
        });
      }
      const source = this._prepareRecords(records, validate);
      if (!source) return null;
      const destination = progressionParticipants(
        prepareDestination(structuredClone(claims))
      );
      return composeProgressionPlan(
        this,
        source,
        [...destination, ...participants],
        {
          ok: true,
          lootCommitted: true,
          ...(claims.some(({ action }) => action === "break")
            ? { dropsCommitted: true }
            : {}),
          claims: claims.map(({ marker, action, firstClaim }) => ({
            id: marker.id,
            action,
            firstClaim,
          })),
        }
      );
    });
  }

  prepareFirstOpen(marker, options) {
    return this.prepareContainers(
      [
        {
          marker,
          action: "open",
          firstClaim: true,
          ...(options?.mapTarget === undefined
            ? {}
            : { mapTarget: options.mapTarget }),
        },
      ],
      options
    );
  }

  prepareFirstBreak(marker, options) {
    return this.prepareContainers(
      [
        {
          marker,
          action: "break",
          firstClaim: true,
          ...(options?.mapTarget === undefined
            ? {}
            : { mapTarget: options.mapTarget }),
        },
      ],
      options
    );
  }

  /** Compose clearing/destruction with the actual slot debit/removal participant. */
  prepareContainerState(marker, state, options) {
    if (!["cleared", "destroyed"].includes(state)) return null;
    return this.prepareContainers(
      [
        {
          marker,
          action: state === "cleared" ? "clear" : "break",
          firstClaim: false,
        },
      ],
      options
    );
  }

  /**
   * Migration/admission hook for an ALREADY initialized caller-owned container,
   * including an empty one. It never rolls loot. Supply its prepared Settlement
   * read/install participant and a membership/ownership prerequisite. An adopted
   * marker records lootVersion:null because no roll/version is being claimed.
   */
  prepareAdoptContainer(
    value,
    { state = "materialized", mapTarget, validate, participants = [] } = {}
  ) {
    return prepareProgression(this, () => {
      if (
        !synchronousProgressCallback(validate) ||
        !Array.isArray(participants) ||
        !participants.length
      )
        return null;
      const marker = normalizeExplorationMarker(value, this.context);
      if (
        this._containers.has(memberIdentity(marker, this.context)) ||
        this._positions.has(progressPositionKey(marker))
      )
        return null;
      const record = containerRecord(
        {
          marker,
          state,
          claim: "adopted",
          lootVersion: null,
          ...(mapTarget === undefined ? {} : { mapTarget }),
        },
        this.context
      );
      const source = this._prepareRecords([record], validate);
      return source
        ? composeProgressionPlan(this, source, participants, {
            ok: true,
            containerId: marker.id,
            adopted: true,
          })
        : null;
    });
  }

  /** Ecology supplies death/reward participants; this is not wildlife's killed LRU. */
  prepareEncounterComplete(value, { validate, participants = [] } = {}) {
    return prepareProgression(this, () => {
      if (!synchronousProgressCallback(validate)) return null;
      const record = encounterRecord(
        { marker: value, completed: true },
        this.context
      );
      if (this.completed(record.marker)) return null;
      const source = this._prepareRecords([record], validate);
      return source
        ? composeProgressionPlan(this, source, participants, {
            ok: true,
            encounterId: record.marker.id,
          })
        : null;
    });
  }

  commit(plan) {
    if (!plan) return { ok: false, reason: "invalid-exploration-plan" };
    const result = this.coordinator.commit(plan.participants);
    return result.ok
      ? { ...plan.result, observerErrors: result.observerErrors }
      : result;
  }

  serialize() {
    return structuredClone({
      version: EXPLORATION_VERSION,
      seed: this.context.seed,
      generatorVersion: this.context.generatorVersion,
      containers: [...this._containers.values()],
      encounters: [...this._encounters.values()],
    });
  }

  load(value, { allowOverBudget = false } = {}) {
    return (
      prepareProgression(this, () => {
        if (typeof allowOverBudget !== "boolean") return false;
        const normalized = normalizeExplorationSnapshot(value, this.context);
        if (!normalized) return false;
        const containers = new Map();
        const encounters = new Map();
        const positions = new Map();
        const recordSizes = new Map();
        let bytes = 0;
        for (const record of [
          ...normalized.containers,
          ...normalized.encounters,
        ]) {
          const key = memberIdentity(record.marker, this.context);
          const size = recordBytes(record);
          recordSizes.set(key, size);
          bytes += size;
          if (record.marker.type === "container") {
            containers.set(key, freezeProgressData(record));
            positions.set(progressPositionKey(record.marker), key);
          } else encounters.set(key, freezeProgressData(record));
        }
        bytes -= Number(containers.size > 0) + Number(encounters.size > 0);
        if (!this.coordinator.register(this, bytes, { allowOverBudget }))
          return false;
        this._containers = containers;
        this._encounters = encounters;
        this._positions = positions;
        this._recordBytes = recordSizes;
        this._bytes = bytes;
        this._revision++;
        return true;
      }) === true
    );
  }

  dispose() {
    if (this._busy || this._disposed || !this.coordinator.release(this))
      return false;
    this._disposed = true;
    this._revision++;
    return true;
  }
}
