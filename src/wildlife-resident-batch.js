import { synchronousEcologyHook } from "./aquatic-ai.js";
import { MAX_LIVING_HORSES } from "./horse-definitions.js";
import { horseDataArray, horseDataRecord } from "./horse-save.js";
import { MAX_ECOLOGY_RESIDENTS } from "./mob-species.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  captureResidentBatch, installResidentEdits, prepareResidentEdit,
} from "./wildlife-resident-edit.js";

export const RESIDENT_EDIT_LIMITS = Object.freeze({ entries: 8, actors: 8, peers: 16 });
export const POTION_RESIDENT_EDIT_LIMITS = Object.freeze({ entries: 28, actors: 28, peers: 64 });
const batches = new WeakMap();
const boundSources = new WeakMap();
const validBytes = (value) => Number.isSafeInteger(value) && value >= 0;
const dataField = (value, key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value");

function validPeer(part, snapshot) {
  return !!part && typeof part === "object" && !Array.isArray(part) &&
    ["owner", "beforeBytes", "afterBytes", "validate", "publish"].every((key) => dataField(part, key)) &&
    (!("notify" in part) || dataField(part, "notify")) && part.owner !== snapshot.wildlife &&
    validBytes(part.beforeBytes) && validBytes(part.afterBytes) &&
    synchronousEcologyHook(part.validate) && synchronousEcologyHook(part.publish) &&
    (part.notify === undefined || synchronousEcologyHook(part.notify)) &&
    snapshot.coordinator.usage(part.owner) === part.beforeBytes &&
    (part.owner?.coordinator === undefined || part.owner.coordinator === snapshot.coordinator);
}

function reject(state) {
  if (state && state.phase !== "published") state.phase = "rejected";
  return null;
}

function bindPeer(part, state) {
  const { owner, beforeBytes, afterBytes, validate, publish, notify } = part;
  const bound = Object.freeze({
    owner, beforeBytes, afterBytes,
    validate: () => state.phase === "finalized" &&
      Reflect.apply(validate, part, []) === true && state.phase === "finalized",
    publish: () => Reflect.apply(publish, part, []),
    ...(notify ? { notify: () => Reflect.apply(notify, part, []) } : {}),
  });
  boundSources.set(bound, part);
  return bound;
}

function begin(wildlife, limits) {
  const snapshot = captureResidentBatch(wildlife);
  if (!snapshot) return null;
  const batch = Object.freeze({ type: "wildlife-resident-edit-batch" });
  batches.set(batch, { snapshot, phase: "collecting", building: false,
    edits: [], identities: new Set(), contributions: [], peers: [], peerParts: new Map(),
    spawns: 0, retains: 0, counter: false, lifeCounter: false, defend: false, limits });
  return batch;
}

export function beginResidentEditBatch(wildlife) {
  return begin(wildlife, RESIDENT_EDIT_LIMITS);
}

/** Dedicated complete-roster bound; never used by generic resident callers. */
export function beginPotionResidentEditBatch(wildlife) {
  return begin(wildlife, POTION_RESIDENT_EDIT_LIMITS);
}

function append(state, domain, options) {
  if (state.phase !== "collecting" || !state.building ||
    state.edits.length >= state.limits.entries) return reject(state);
  const edit = prepareResidentEdit(state.snapshot, domain, options);
  if (!edit || (edit.id !== undefined && (state.identities.has(edit.id) ||
    state.identities.size >= state.limits.actors)) ||
    (edit.nextId !== state.snapshot.nextId && state.counter) || (edit.defend && state.defend) ||
    (edit.nextLife !== state.snapshot.nextLife && state.lifeCounter) ||
    state.snapshot.entities.length + state.spawns + Number(!!edit.spawn) > state.snapshot.maxEntities ||
    state.snapshot.ecologyCount + state.spawns + Number(!!edit.spawn) > MAX_ECOLOGY_RESIDENTS ||
    state.snapshot.retainedSize + state.retains + Number(edit.retainAdded) > MAX_LIVING_HORSES)
    return reject(state);
  // One write intent per canonical identity, even for disjoint fields. A caller
  // must combine cooldown/fuse in one source edit, never rely on last-write wins.
  if (edit.id !== undefined) state.identities.add(edit.id);
  state.counter ||= edit.nextId !== state.snapshot.nextId;
  state.lifeCounter ||= edit.nextLife !== state.snapshot.nextLife;
  state.defend ||= !!edit.defend;
  state.spawns += Number(!!edit.spawn);
  state.retains += Number(edit.retainAdded);
  state.edits.push(edit);
  return true;
}

/** Borrowers use this only to prepare one entry and its required peers. A
 * failed/ignored preparation poisons the detached batch, not any live owner.
 * The result deliberately has no `ok`, `participants`, or committed receipt.
 */
export function contributeResidentEditBatch(wildlife, batch, prepare) {
  const state = batches.get(batch);
  if (!state || state.snapshot.wildlife !== wildlife || state.phase !== "collecting" ||
    state.building || !synchronousEcologyHook(prepare) ||
    state.contributions.length >= state.limits.entries) return reject(state);
  state.building = true;
  const before = state.edits.length;
  try {
    const prepared = prepare((domain, options) => append(state, domain, options));
    if (state.phase !== "collecting" || !prepared || prepared.then ||
      state.edits.length !== before + 1 ||
      !horseDataArray(prepared.peers, state.limits.peers - state.peers.length) ||
      prepared.peers.some((part) => !validPeer(part, state.snapshot)) ||
      !state.snapshot.current() || state.edits.some((edit) => !edit.current())) return reject(state);
    const parts = prepared.peers.map((part) => bindPeer(part, state));
    // Tokens never expose validators/publishers, even after finalization. Only
    // the complete final plan may expose the prepared owner participants.
    const peers = parts.map((part) => {
      const peer = Object.freeze({ type: "wildlife-resident-edit-peer", complete: false,
        owner: part.owner, beforeBytes: part.beforeBytes, afterBytes: part.afterBytes });
      state.peerParts.set(peer, part);
      return peer;
    });
    const result = Object.freeze({ ...prepared.result });
    const contribution = Object.freeze({
      type: "wildlife-resident-edit-contribution", complete: false,
      peers: Object.freeze(peers),
      ...(prepared.exposeResult === true ? { result } : {}),
    });
    state.peers.push(...peers);
    state.contributions.push({ contribution, result });
    return state.phase === "collecting" && state.snapshot.current() &&
      state.edits.every((edit) => edit.current()) ? contribution : reject(state);
  } catch (error) {
    reject(state);
    throw error;
  } finally {
    state.building = false;
  }
}

/** Final caller supplies ALL contribution identities and exact peer tokens,
 * plus any independent action/runtime/cost participants. Same-owner keyed
 * peers coalesce into one participant; commit the complete list exactly once.
 */
export function finalizeResidentEditBatch(wildlife, batch, options = {}) {
  const state = batches.get(batch);
  try {
    return finalize(state, wildlife, options);
  } catch (error) {
    reject(state);
    throw error;
  }
}

function finalize(state, wildlife, options) {
  if (!horseDataRecord(options, ["contributions", "participants", "randomState"], []))
    return reject(state);
  const { contributions = [], participants = [], randomState = state?.snapshot.randomState } = options;
  if (!state || state.snapshot.wildlife !== wildlife || state.phase !== "collecting" ||
    state.building || !state.edits.length || !horseDataArray(contributions, state.limits.entries) ||
    contributions.length !== state.contributions.length ||
    new Set(contributions).size !== contributions.length ||
    state.contributions.some((entry) => !contributions.includes(entry.contribution)) ||
    !horseDataArray(participants, state.limits.peers) ||
    state.peers.some((part) => !participants.includes(part)) ||
    !Number.isSafeInteger(randomState) || randomState < 0 || randomState > 0xffffffff ||
    !state.snapshot.current() || state.edits.some((edit) => !edit.current())) return reject(state);
  state.phase = "finalizing";
  const peers = participants.map((part) => state.peerParts.get(part) ??
    (validPeer(part, state.snapshot) ? bindPeer(part, state) : null));
  if (peers.some((part) => !validPeer(part, state.snapshot)) ||
    state.phase !== "finalizing" || !state.snapshot.current() ||
    state.edits.some((edit) => !edit.current())) return reject(state);
  const { snapshot, edits } = state;
  const removals = edits.filter((edit) => edit.remove).sort((a, b) => b.removeIndex - a.removeIndex);
  const nextId = edits.find((edit) => edit.nextId !== snapshot.nextId)?.nextId ?? snapshot.nextId;
  const nextLife = edits.find((edit) => edit.nextLife !== snapshot.nextLife)?.nextLife ??
    snapshot.nextLife;
  if (removals.length && typeof wildlife.prepareStatusRetirement === "function") {
    const retirement = wildlife.prepareStatusRetirement(
      removals.map((edit) => edit.remove),
      () => state.phase === "finalized" && snapshot.current() &&
        removals.every((edit) => edit.current())
    );
    if (retirement && !peers.some((part) => part.owner === retirement.owner)) {
      if (!validPeer(retirement, snapshot)) return reject(state);
      peers.push(bindPeer(retirement, state));
    }
  }
  const notices = [
    ...edits.map((edit) => edit.notify).filter(Boolean),
    ...removals.map((edit) => () => wildlife.onRemove(edit.remove)),
  ];
  const notify = notices.length === 1 ? notices[0] : notices.length ? () => {
    const errors = [];
    for (const notice of notices) {
      try {
        const result = notice();
        if (result && typeof result.then === "function") throw new TypeError("notify must be synchronous");
      } catch (error) { errors.push(error); }
    }
    // Run every observer before preserving the fatal type that callers inspect.
    const fatal = errors.find((error) => error instanceof TransactionInvariantError);
    if (fatal) throw fatal;
    if (errors.length) throw new AggregateError(errors, "Resident edit observers failed after commit");
  } : undefined;
  state.phase = "finalized";
  const base = Object.freeze({
    owner: wildlife, beforeBytes: 0, afterBytes: 0,
    validate: () => state.phase === "finalized" && snapshot.current() &&
      edits.every((edit) => edit.current() && edit.validate() === true) &&
      state.phase === "finalized" && snapshot.current() && edits.every((edit) => edit.current()),
    publish: () => {
      state.phase = "published";
      installResidentEdits(snapshot, edits, removals, nextId, nextLife, randomState);
    },
    ...(notify ? { notify } : {}),
  });
  // Last validation catches late contributions (including attempted additions
  // from a peer's validator). Publishers are installation-only by coordinator
  // contract; the base never calls peer publishers or reserves their resources.
  const uniquePeers = [];
  for (const owner of new Set(peers.map((part) => part.owner))) {
    const owned = peers.filter((part) => part.owner === owner);
    if (owned.length === 1) {
      uniquePeers.push(owned[0]);
      continue;
    }
    const combined = owner?.prepareParticipantBatch?.(
      owned.map((part) => boundSources.get(part) ?? part));
    if (!validPeer(combined, state.snapshot) || combined.owner !== owner)
      return reject(state);
    uniquePeers.push(bindPeer(combined, state));
  }
  return Object.freeze({
    complete: true,
    participants: Object.freeze([...uniquePeers, base]),
    results: Object.freeze(contributions.map((contribution) =>
      state.contributions.find((entry) => entry.contribution === contribution).result)),
  });
}

export function prepareStandaloneResidentEdit(wildlife, domain, options) {
  const batch = beginResidentEditBatch(wildlife);
  const contribution = contributeResidentEditBatch(wildlife, batch, (add) =>
    add(domain, options) ? { peers: [], result: {} } : null);
  return (contribution && finalizeResidentEditBatch(wildlife, batch, {
    contributions: [contribution],
  })?.participants[0]) ?? null;
}
