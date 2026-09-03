import { immutable, refusal, synchronous } from "./enchantment-domain.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

/**
 * Prepare, NEVER commit, an equipment-station ownership change.
 *
 * This adapter has no inventory/escrow/seed store. The future station integrator
 * supplies prepareStation({before,after}), returning a nonempty array of prepared
 * participants (or one participant) covering EVERY record and player-seed change.
 * It must compare the expected snapshots, capture owner revisions/incarnations,
 * reserve their exact archive bytes, and publish only prevalidated state.
 * If station and seed share an owner, return ONE combined participant.
 *
 * validateAccess is required and must pin the station's type/position/dimension,
 * world identity/admission/revisions, player reach, and any shelf-read verdict.
 * Gameplay.prepareInventory already guards its own mode/context/revision.
 *
 * receiveOutput(ownedDraft, output) is an optional synchronous, draft-only edit.
 * Anvil requires it; callers may target the canonical cursor or use insertStack
 * on ownedDraft.slots. Exactly true means the ENTIRE output fits. No eager drops,
 * external inventories or callbacks that mutate live state belong there.
 *
 * Caller commits plan.participants ONCE on gameplay.coordinator and only reports
 * success after commit().ok. A prepared plan/result is NOT a paid/owned output.
 * Extra required participants may veto capacity or other domain prerequisites;
 * do not silently omit a participant that failed preparation.
 */
export function prepareEquipmentStationTransaction({
  gameplay,
  prepareStation,
  preview,
  validateAccess,
  receiveOutput,
  participants = [],
}) {
  const coordinator = gameplay?.coordinator;
  if (
    !gameplay ||
    gameplay.dead ||
    !(coordinator instanceof TransactionCoordinator) ||
    !synchronous(gameplay.prepareInventory) ||
    !synchronous(prepareStation) ||
    !synchronous(preview) ||
    !synchronous(validateAccess) ||
    (receiveOutput !== undefined && !synchronous(receiveOutput)) ||
    !Array.isArray(participants)
  )
    return refusal("missing_participant");

  let result;
  let player;
  let source;
  try {
    if (validateAccess() !== true) return refusal("station_unavailable");
    player = gameplay.prepareInventory((owned) => {
      result = preview(owned.experienceTotal, gameplay.mode);
      if (result?.ok !== true) return false;
      if (result.experienceBefore !== owned.experienceTotal) {
        result = refusal("stale_experience");
        return false;
      }
      if (
        receiveOutput &&
        receiveOutput(owned, immutable(result.output)) !== true
      ) {
        result = refusal("output_capacity");
        return false;
      }
      owned.experienceTotal = result.experienceAfter;
      return true;
    });
    if (!player)
      return result?.ok === false ? result : refusal("player_rejected");
    if (result?.ok !== true) return refusal("invalid_preview");
    source = prepareStation(
      immutable({
        before: result.before,
        after: result.after,
      })
    );
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return refusal("preparation_failed");
  }
  const sources = Array.isArray(source) ? source : source ? [source] : [];
  if (!sources.length) return refusal("station_rejected");
  const staged = [player, ...sources, ...participants];
  const owners = new Set();
  try {
    for (const participant of staged) {
      if (
        !participant ||
        owners.has(participant.owner) ||
        coordinator.usage(participant.owner) === undefined
      )
        return refusal("invalid_participant");
      owners.add(participant.owner);
    }
  } catch {
    return refusal("invalid_participant");
  }

  const guardedPlayer = Object.freeze({
    ...player,
    validate: () =>
      gameplay.coordinator === coordinator &&
      validateAccess() === true &&
      player.validate() === true,
  });
  return Object.freeze({
    ok: true,
    prepared: true,
    participants: Object.freeze([guardedPlayer, ...sources, ...participants]),
    result,
  });
}
