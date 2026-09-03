import { captureEntityContext } from "./entity-context.js";
import {
  HORSE_JUMP_CHARGE_SECONDS, HORSE_JUMP_MAX, HORSE_JUMP_MIN,
  HORSE_MAX_ELAPSED, HORSE_RADIUS, HORSE_RIDER_HEIGHT,
  HORSE_SEAT_HEIGHT, HORSE_STEP_SECONDS, HORSE_STRIDE_DISTANCE,
  horseMotion, horsePoint, horseSeat, horseSynchronous,
} from "./horse-definitions.js";
import {
  findHorseDismount, horseClear, horseEnvironment,
  horseExitValid, horseRiderPathClear,
} from "./horse-collision.js";
import { stepHorse } from "./horse-physics.js";
import { cloneHorseRecord } from "./horse-save.js";
import { advanceHorseTaming, pendingHorseBuck, unseatHorse } from "./horse-taming.js";
import { prepareHorseHit } from "./horse-actions.js";
import { aquaticSweepBounds, captureAquaticArea, finitePoint } from "./vehicle-water.js";
import { isDimension } from "./world-spec.js";

const fail = (reason) => ({ ok: false, handled: true, reason });
const idle = () => ({ moved: 0, steps: 0, exits: 0, observerErrors: [] });
const actionValid = (value) => value === undefined || horseSynchronous(value);

export function prepareHorseMount(domain, id, ownerId = "player", {
  hand = "main", validate, participants = [],
} = {}) {
  if (!domain._ready()) return fail("unavailable");
  if (!["main", "offhand"].includes(hand) || !actionValid(validate) || !Array.isArray(participants))
    return fail("invalid-mount");
  const mob = domain._base(id), actor = domain._actor(ownerId, hand);
  if (!mob || !actor || !domain._reachable(actor, mob)) return fail("inactive-or-out-of-reach");
  if (actor.stack !== null) return fail("empty-hand-required");
  if (domain.mountFor(ownerId) || !domain._canMount(ownerId, id)) return fail("already-mounted-or-guarded");
  const next = domain._newRecord(mob);
  if (!next) return fail("horse-capacity-or-reserved-id");
  const environment = horseEnvironment(domain.world, mob.position, domain.hooks.sampleFluid);
  if (!environment || environment.hazardous || environment.water === "deep" || !environment.grounded)
    return fail("unsafe-mount");
  const position = horseSeat(mob.position);
  const pathOptions = { sampleFluid: domain.hooks.sampleFluid, checkHazards: true };
  if (!horseClear(domain.world, mob.position, true) ||
    !horseRiderPathClear(domain.world, actor.position, position, pathOptions)) return fail("no-seat-clearance");
  const loaded = captureAquaticArea(domain.world, domain.context,
    aquaticSweepBounds(actor.position, mob.position, HORSE_RADIUS, HORSE_SEAT_HEIGHT + HORSE_RIDER_HEIGHT));
  const actorGuard = domain._actorGuard(ownerId, hand, actor, true);
  if (!loaded || (validate && domain._invoke(validate) !== true)) return fail("stale-mount");
  next.rider = ownerId;
  next.motion = next.motion ?? horseMotion();
  const safeEnvironment = () => {
    const value = horseEnvironment(domain.world, mob.position, domain.hooks.sampleFluid);
    return !!value && !value.hazardous && value.water !== "deep" && value.grounded;
  };
  const own = domain._prepareRecord(id, next, {
    validate: () => loaded() && actorGuard() && !domain.mountFor(ownerId) &&
      domain._canMount(ownerId, id) && domain._reachable(actor, mob) &&
      horseClear(domain.world, mob.position, true) &&
      horseRiderPathClear(domain.world, actor.position, position, pathOptions) &&
      safeEnvironment() &&
      (!validate || validate() === true),
    events: [{ type: "mount", id, ownerId, position, tamed: next.tamed, saddled: next.saddle !== null }],
    clearExit: true, claim: true, resetInput: true, environment,
  });
  const base = domain.wildlife.prepareHorseEdit(mob, {
    retain: true, motion: { position: mob.position, yaw: mob.root.rotation.y, motion: next.motion },
  });
  return domain._plan("mount", id, [own, base, ...participants], { position: { ...position } });
}

export function prepareHorseDismount(domain, ownerId = "player", {
  reason = "input", validate, participants = [],
} = {}) {
  if (!domain._ready()) return fail("unavailable");
  if (!["input", "buck", "water"].includes(reason) || !actionValid(validate) || !Array.isArray(participants))
    return fail("invalid-dismount");
  const mount = domain.mountFor(ownerId), actor = domain._actor(ownerId);
  const mob = mount && domain._base(mount.id);
  if (!mount || !mob || !actor) return fail("not-mounted");
  const entry = domain._living.get(mount.id);
  const options = { sampleFluid: domain.hooks.sampleFluid, otherHorses: domain.wildlife.entities };
  const exit = findHorseDismount(domain.world, mob, options);
  if (!exit) return fail("no-safe-exit");
  const loaded = captureAquaticArea(domain.world, domain.context,
    aquaticSweepBounds(mob.position, exit.position, HORSE_RADIUS, HORSE_SEAT_HEIGHT + HORSE_RIDER_HEIGHT));
  const actorGuard = domain._actorGuard(ownerId, "main", actor);
  if (!loaded || (validate && domain._invoke(validate) !== true)) return fail("stale-dismount");
  const own = domain._prepareRecord(mount.id, unseatHorse(entry), {
    validate: () => loaded() && actorGuard() && horseExitValid(domain.world, mob, exit, options) &&
      (!validate || validate() === true),
    events: [{ type: "dismount", id: mount.id, ownerId, reason, exit }],
    exit, claim: true, resetInput: true,
  });
  const base = domain.wildlife.prepareHorseEdit(mob);
  return domain._plan("dismount", mount.id, [own, base, ...participants], { exit: structuredClone(exit) });
}

/** Accepted lifecycle intent only, not a fallback for a blocked Shift/buck. */
export function prepareHorsePassengerRelease(domain, ownerId = "player", {
  travelling = false, validate,
} = {}) {
  if (!domain._ready() || ownerId !== "player" || typeof travelling !== "boolean" || !actionValid(validate))
    return fail("invalid-departure");
  const mount = domain.mountFor(ownerId), pending = domain._pendingExit;
  if (!mount && !pending) return fail("not-mounted");
  const dimension = mount?.dimension ?? pending.dimension;
  const departed = () => {
    const actor = domain._invoke(domain.hooks.readOwner, ownerId, "main");
    return !!actor && (travelling || actor.dead === true || domain.gameplay.dead ||
      (isDimension(actor.dimension) && actor.dimension !== dimension)) && (!validate || validate() === true);
  };
  if (!departed()) return fail("use-safe-dismount");
  if (!mount) {
    // A same-frame dismount/death may still own an unconsumed exit pose. Pearl
    // travel must clear it even though no rider link remains, without editing a
    // permanent tombstone or manufacturing a third occupancy ledger.
    const revision = domain._revision, bytes = domain._bytes;
    const current = captureEntityContext(domain.world, domain.context);
    let used = false;
    const own = Object.freeze({
      owner: domain, beforeBytes: bytes, afterBytes: bytes,
      validate: () => !used && domain._ready() && current() && departed() &&
        domain._revision === revision && domain._bytes === bytes && domain._pendingExit === pending &&
        domain.mountFor(ownerId) === null,
      publish: () => {
        used = true;
        domain._pendingExit = null;
        domain._input = null;
        domain._revision++;
      },
      notify: () => domain._notify([{ type: "release", id: pending.id, ownerId,
        reason: travelling ? "travel" : "death" }]),
    });
    return domain._plan("release", pending.id, [own]);
  }
  const next = unseatHorse(domain._living.get(mount.id));
  const own = domain._prepareRecord(mount.id, next, {
    validate: departed, clearExit: true, claim: true, resetInput: true,
    events: [{ type: "release", id: mount.id, ownerId, reason: travelling ? "travel" : "death" }],
  });
  // No base mutation and no redundant Wildlife participant. Pearl extras stay
  // Horses + optional Fishing + vehicle host (and a genuinely needed handoff).
  return domain._plan("release", mount.id, [own]);
}

function chargedInput(domain, entry, controls, dt) {
  const current = domain._input?.id === entry.id ? domain._input : null;
  const input = current ? { ...current } :
    { id: entry.id, down: false, charge: 0, blockedUntilRelease: true };
  const pressed = controls.jump === true;
  const controlled = entry.rider !== null && entry.tamed && entry.saddle !== null;
  let jumpVelocity = 0;
  if (!controlled || !entry.motion.grounded) {
    input.charge = 0;
    input.blockedUntilRelease = pressed;
  } else if (input.blockedUntilRelease) {
    if (!pressed) input.blockedUntilRelease = false;
  } else if (pressed) {
    input.charge = Math.min(1, input.charge + dt / HORSE_JUMP_CHARGE_SECONDS);
  } else if (input.down) {
    jumpVelocity = HORSE_JUMP_MIN + (HORSE_JUMP_MAX - HORSE_JUMP_MIN) * input.charge;
    input.charge = 0;
  }
  input.down = pressed;
  return { input, jumpVelocity };
}

/** Only chunk references/revisions, not cells/save JSON, are pinned per frame. */
function motionGuard(domain, mob) {
  const current = captureEntityContext(domain.world, domain.context);
  const world = domain.world, revision = domain._revision;
  const editRevision = world._editRevision, wildlife = domain.wildlife;
  const baseRevision = wildlife._ecologyRevision, chunks = [];
  if (world.chunks instanceof Map) {
    const at = mob.position;
    for (let cx = Math.floor((at.x - 4) / 16); cx <= Math.floor((at.x + 4) / 16); cx++)
      for (let cz = Math.floor((at.z - 4) / 16); cz <= Math.floor((at.z + 4) / 16); cz++) {
        const key = `${cx},${cz}`, chunk = world.chunks.get(key);
        chunks.push({ key, chunk, revision: chunk?.revision, incarnation: chunk?.incarnation });
      }
  }
  return () => current() && domain._revision === revision && !domain.gameplay.dead &&
    domain.wildlife === wildlife && wildlife._ecologyRevision === baseRevision &&
    world._editRevision === editRevision &&
    chunks.every(({ key, chunk, revision, incarnation }) => world.chunks.get(key) === chunk &&
      chunk?.revision === revision && chunk?.incarnation === incarnation);
}

function prepareAdvance(domain, mob, entry, physics, dt, input) {
  const guard = motionGuard(domain, mob);
  let next = { ...cloneHorseRecord(entry, domain.context), motion: { ...physics.motion } };
  const taming = advanceHorseTaming(next, dt, domain.context);
  next = taming.entry;
  const events = [];
  if (taming.outcome) events.push({
    type: taming.outcome === "tamed" ? "tamed" : "taming-failed", id: mob.id,
    temper: next.temper, failedAttempts: next.failedAttempts, position: horsePoint(physics.position),
  });
  let exit = null;
  const projected = { id: mob.id, position: physics.position, yaw: physics.yaw };
  const exitOptions = { sampleFluid: domain.hooks.sampleFluid, otherHorses: domain.wildlife.entities };
  if (entry.rider !== null && (pendingHorseBuck(next) || physics.requestExit)) {
    exit = findHorseDismount(domain.world, projected, exitOptions);
    if (exit) {
      events.push({ type: "dismount", id: mob.id, ownerId: entry.rider,
        reason: pendingHorseBuck(next) ? "buck" : "water", exit });
      next = unseatHorse(next);
    }
  }
  if (!next.rider && next.motion?.grounded) next.motion = null;
  let stride = physics.motion.grounded && physics.water !== "deep" && physics.water !== null
    ? (domain._strides.get(entry.id) ?? 0) + physics.strideDistance : 0;
  if (stride >= HORSE_STRIDE_DISTANCE) {
    stride %= HORSE_STRIDE_DISTANCE;
    events.push({ type: "horse-step", id: mob.id, blockId: physics.supportBlock,
      position: horsePoint(physics.position) });
  }
  const advance = { entry: next, physics, exit, events, validate: guard, input, stride };
  if (physics.fallDamage > 0) {
    return prepareHorseHit(domain, mob.id, physics.fallDamage, null,
      { retaliate: false, playerKill: false }, advance);
  }
  const own = domain._prepareRecord(mob.id, next, {
    validate: () => guard() &&
      (!exit || horseExitValid(domain.world, projected, exit, exitOptions)),
    events, exit, claim: true, trustedMotion: true, input, stride,
    environment: { grounded: physics.motion.grounded, water: physics.water },
  });
  const base = domain.wildlife.prepareHorseEdit(mob, { motion: physics });
  return domain._plan("motion", mob.id, [own, base], { moved: physics.moved, exited: !!exit });
}

export function updateHorses(domain, dt, { viewer, controls = {}, frameId } = {}) {
  domain.beginFrame(frameId ?? ++domain._autoFrame);
  const result = idle();
  if (!domain._ready() || domain._updating || domain.gameplay.dead ||
    !Number.isFinite(dt) || dt <= 0) return result;
  if (viewer !== undefined && !finitePoint(viewer)) return result;
  const current = captureEntityContext(domain.world, domain.context);
  domain._updating = true;
  try {
    for (const selected of [...domain._living.values()]) {
      if (selected.dimension !== domain.world.dimension || (!selected.rider && !selected.motion)) continue;
      let mob = domain._base(selected.id), entry = domain._living.get(selected.id);
      if (!mob || !entry) continue;
      let command = controls[entry.rider] ?? {};
      if (entry.rider && (command.dismount || pendingHorseBuck(entry))) {
        const dismounted = domain.dismount(entry.rider, { reason: pendingHorseBuck(entry) ? "buck" : "input" });
        if (dismounted.ok) {
          result.exits++;
          result.observerErrors.push(...dismounted.observerErrors);
          continue;
        }
      }
      for (let remaining = Math.min(dt, HORSE_MAX_ELAPSED); remaining > 1e-8; remaining -= HORSE_STEP_SECONDS) {
        entry = domain._living.get(selected.id);
        mob = domain._base(selected.id);
        if (!current() || !mob || !entry?.motion || (!entry.rider && entry.motion.grounded)) break;
        const step = Math.min(remaining, HORSE_STEP_SECONDS);
        command = controls[entry.rider] ?? {};
        const input = entry.rider ? chargedInput(domain, entry, command, step)
          : { input: undefined, jumpVelocity: 0 };
        // Snapshot the real World/base before invoking an injected fluid reader.
        const guard = motionGuard(domain, mob);
        const physics = stepHorse(domain.world, mob, entry.motion, step, command, {
          mounted: entry.rider !== null,
          controlled: entry.rider !== null && entry.tamed && entry.saddle !== null && !pendingHorseBuck(entry),
          jumpVelocity: input.jumpVelocity, sampleFluid: domain.hooks.sampleFluid,
        });
        if (!guard() || physics.frontier) break;
        const plan = prepareAdvance(domain, mob, entry, physics, step, input.input);
        const committed = domain.commit(plan);
        if (!committed.ok) break;
        result.steps++;
        result.moved += Number(physics.moved);
        result.exits += Number(!!committed.exited || !!committed.exit);
        result.observerErrors.push(...committed.observerErrors);
        if (committed.killed || !domain._living.get(selected.id)?.motion) break;
      }
    }
  } finally {
    domain._updating = false;
  }
  return result;
}
