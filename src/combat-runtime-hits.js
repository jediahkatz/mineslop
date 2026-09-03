import {
  adjustCombatDamage, decideCombatCredit, decideHurtWindow,
} from "./combat-rules.js";
import {
  COMBAT_RUNTIME_LIMITS, checkRuntime, finite, guardFunction, integer, runtimeArray,
} from "./combat-runtime-data.js";

export function runtimeDamage(provenance, difficulty, victimKind) {
  checkRuntime(typeof difficulty === "string", "explicit-difficulty-required");
  return adjustCombatDamage({
    attackKind: provenance.attackKind, responsibleKind: provenance.responsibleKind,
    victimKind, rawDamage: provenance.rawDamage, difficulty,
  });
}

export function runtimeHurtQuote(actor, provenance, difficulty) {
  const adjusted = runtimeDamage(provenance, difficulty, actor.actor.kind);
  const hurt = decideHurtWindow(actor.hurt, adjusted.difficultyAdjustedFullDamage);
  return Object.freeze({ adjusted, ...hurt });
}

export function runtimeDamagingMetadata(actor, provenance, quote, damage) {
  return Object.freeze({
    ...actor, hurt: quote.nextWindow,
    credit: decideCombatCredit(actor.credit, {
      committed: true, healthDamage: damage, responsibleKind: provenance.responsibleKind,
      responsibleSpecies: provenance.responsibleSpecies, playerOwnerId: provenance.playerOwnerId,
      damageOverTime: provenance.damageOverTime,
    }),
  });
}

const peerFields = ["owner", "beforeBytes", "afterBytes", "validate", "publish", "notify"];

export function runtimePeer(participant, coordinator, runtime) {
  checkRuntime(participant && typeof participant === "object" &&
    !Array.isArray(participant), "invalid-peer");
  const snapshot = Object.fromEntries(peerFields.map((field) => [field, participant[field]]));
  checkRuntime(snapshot.owner !== runtime && integer(snapshot.beforeBytes) &&
    integer(snapshot.afterBytes) && coordinator.usage(snapshot.owner) === snapshot.beforeBytes,
  "invalid-peer-owner");
  guardFunction(snapshot.validate);
  guardFunction(snapshot.publish);
  if (snapshot.notify !== undefined) guardFunction(snapshot.notify);
  return Object.freeze({
    participant, owner: snapshot.owner,
    current: () => peerFields.every((field) => participant[field] === snapshot[field]),
  });
}

/**
 * The FUTURE bridge supplies the selected real owner's result and exact
 * participants. Their shape is checked here, not their combat authorization.
 * A made-up {ok:true}, observer callback or missing owner is not a receipt.
 * Tests use actual ProgressionGearEffects plans, never fake successful owners.
 */
export function runtimeOwnerDamage(plan, maximum, coordinator, runtime) {
  checkRuntime(plan?.ok === true && plan.prepared === true &&
    plan.result?.ok === true && finite(plan.result.damage, maximum) &&
    plan.result.damage > 0, "damaging-owner-result-required");
  const result = plan.result, damage = result.damage, original = plan.participants;
  const participants = runtimeArray(original, COMBAT_RUNTIME_LIMITS.peerParticipants).slice();
  checkRuntime(participants.length > 0, "owner-participants-required");
  const peers = participants.map((part) => runtimePeer(part, coordinator, runtime));
  checkRuntime(new Set(peers.map((peer) => peer.owner)).size === peers.length, "duplicate-peer-owner");
  return Object.freeze({
    damage, peers: Object.freeze(peers),
    current: () => plan.ok === true && plan.prepared === true && plan.result === result &&
      result.ok === true && result.damage === damage && plan.participants === original &&
      original.length === participants.length &&
      participants.every((part, index) => original[index] === part) &&
      peers.every((peer) => peer.current()),
  });
}
