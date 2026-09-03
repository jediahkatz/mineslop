import {
  COMBAT_COLLISION_LIMITS, COMBAT_CONTACT_EPSILON, traceCombatSegment,
} from "./combat-collision.js";
import {
  actorKey, checkRuntime, guardFunction, runtimeActor, runtimeActors, runtimeArray, sameActor,
} from "./combat-runtime-data.js";

function candidatesFrom(reader, scope) {
  const values = runtimeArray(reader(), COMBAT_COLLISION_LIMITS.candidates);
  const actors = runtimeActors(values, scope);
  return Object.freeze(actors.map((actor, index) => Object.freeze({
    ...actor, box: Object.freeze(runtimeArray(values[index].box, 6).slice()),
  })));
}

/**
 * The bridge supplies a COMPLETE freshly read physical roster, including
 * immune/unavailable bodies, never dormant byId. This wrapper supplies the
 * actual World, immutable segment/envelope and exact live runtime token.
 * Neither this reader nor the collision helper proves Game/owner authority.
 */
export function traceRuntimeMotion(scope, shot, to, readCandidates) {
  guardFunction(readCandidates);
  const facts = () => {
    if (!scope.current() || !scope.hasTicket(shot.token)) return null;
    return {
      world: scope.world, ticket: shot.token, from: shot.position, to,
      radius: shot.radius, sourceEnvelope: shot.envelope,
      candidates: candidatesFrom(readCandidates, scope),
    };
  };
  const initial = facts();
  checkRuntime(initial !== null, "stale-shot");
  const trace = traceCombatSegment(initial, facts);
  checkRuntime(trace.kind !== "invalid", `collision-${trace.reason}`);
  const selected = trace.contact?.kind === "actor"
    ? initial.candidates.find((actor) => actorKey(actor) === trace.contact.actor.key) : null;
  const victim = selected ? runtimeActor(selected, scope) : null;
  return Object.freeze({ trace, victim });
}

const close = (a, b) => Math.abs(a - b) <= COMBAT_CONTACT_EPSILON;

/** Extra pin to the previously admitted pending contact, using the helper's
 * declared tolerance. The actual fresh nearest query is ALWAYS the helper.
 */
function samePendingContact(pending, probe) {
  const a = pending.contact, b = probe.trace.contact;
  if (probe.trace.kind !== "contact" || a.kind !== b.kind ||
      !close(a.fraction, b.fraction) ||
      !a.box.every((value, index) => close(value, b.box[index])) ||
      ["center", "point", "normal"].some((field) =>
        ["x", "y", "z"].some((axis) => !close(a[field][axis], b[field][axis]))) ||
      pending.sourceEnvelopeExited !== probe.trace.sourceEnvelopeExited) return false;
  return a.kind === "actor" ? sameActor(pending.victim, probe.victim)
    : ["x", "y", "z", "part", "id", "state", "fluid"].every((field) => a.cell[field] === b.cell[field]);
}

export function traceRuntimeContact(scope, shot, readCandidates) {
  checkRuntime(shot.pending?.kind === "contact", "pending-contact-required");
  const probe = traceRuntimeMotion(scope, shot, shot.pending.to, readCandidates);
  checkRuntime(samePendingContact(shot.pending, probe), "stale-pending-contact");
  return probe;
}
