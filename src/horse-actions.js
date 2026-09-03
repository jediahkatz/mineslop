import {
  HORSE_MAX_SPEED, horseFood, horsePoint, horseSynchronous, isHorseSaddle,
} from "./horse-definitions.js";
import {
  findHorseDeathExit, horseBounds, horseBoxes, horseDeathExitValid, horseExitValid,
} from "./horse-collision.js";
import { cloneHorseRecord, horseDataArray } from "./horse-save.js";
import { applyHorseSlotAction } from "./horse-slots.js";
import { horseStableDraw } from "./horse-taming.js";
import { ownedSlot } from "./inventory-domain.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { ITEM } from "./items.js";
import { captureAquaticArea, finitePoint } from "./vehicle-water.js";
import { contributeResidentEditBatch, RESIDENT_EDIT_LIMITS } from "./wildlife-resident-batch.js";
import { horseResidentEdit } from "./wildlife-resident-edit.js";

const fail = (reason) => ({ ok: false, handled: true, reason });
const clamp = (value, bound) => Math.max(-bound, Math.min(bound, value));
const handAllowed = (hand) => hand === "main" || hand === "offhand";
const currentAction = (value) => value === undefined || horseSynchronous(value);

function heldCost(domain, actor, hand) {
  const request = { ownerId: "player", hand, stack: cloneStack(actor.stack, domain.context),
    handRevision: actor.handRevision, slotKey: actor.slotKey, count: 1, wear: 0 };
  if (domain.hooks.prepareHandCost) return domain._callback("prepareHandCost", request, domain.gameplay);
  // Creative main hand is an explicitly unlimited palette; the offhand and
  // every UI-owned slot remain finite even in Creative.
  if (domain.gameplay.mode === "creative" && hand === "main")
    return domain.gameplay.prepareHandCost(hand, { ...request, notify: false });
  const selected = domain.gameplay.selected;
  return domain._inventory((draft) => {
    const slot = ownedSlot(draft, hand === "main" ? "inventory" : "offhand", hand === "main" ? selected : 0);
    const stack = slot.get();
    if (!stack || stack.id !== actor.stack.id || stack.count < 1) return false;
    slot.set(stack.count === 1 ? null : { ...cloneStack(stack, domain.context), count: stack.count - 1 });
    return true;
  });
}

function prepareDrops(domain, stacks, position, reason) {
  if (!stacks.length) return null;
  const payload = { stacks: stacks.map((stack) => cloneStack(stack, domain.context)),
    position: horsePoint(position), dimension: domain.world.dimension,
    velocity: { x: 0, y: 1.5, z: 0 }, pickupDelay: 0.4, reason };
  if (domain.hooks.prepareDrops) return domain._callback("prepareDrops", payload, domain.overflow);
  const participant = domain.overflow?.prepareEnqueue(payload.stacks, payload.position, payload.dimension,
    { velocity: payload.velocity, pickupDelay: payload.pickupDelay });
  return domain._validParticipant(participant) && participant.owner === domain.overflow ? participant : null;
}

function prepareExperience(domain, amount, position) {
  const payload = { amount, position: horsePoint(position), dimension: domain.world.dimension,
    velocity: { x: 0, y: 1, z: 0 }, pickupDelay: 0.4, reason: "horse-death" };
  if (domain.hooks.prepareExperience)
    return domain._callback("prepareExperience", payload, domain.experienceOrbs);
  const participant = domain.experienceOrbs?.prepareSpawn(amount, payload.position,
    { velocity: payload.velocity, pickupDelay: payload.pickupDelay });
  return domain._validParticipant(participant) && participant.owner === domain.experienceOrbs ? participant : null;
}

export function prepareHorseFeed(domain, id, {
  ownerId = "player", hand = "main", validate, participants = [],
} = {}) {
  if (!domain._ready()) return fail("unavailable");
  if (!handAllowed(hand) || !currentAction(validate) || !Array.isArray(participants)) return fail("invalid-feed");
  const mob = domain._base(id), actor = domain._actor(ownerId, hand);
  if (!mob || !domain._reachable(actor, mob)) return fail("inactive-or-out-of-reach");
  if (!isValidStack(actor.stack, domain.context)) return fail("invalid-hand");
  const food = horseFood(actor.stack.id), next = domain._newRecord(mob);
  if (!food) return fail("not-horse-food");
  if (!next) return fail("horse-capacity-or-reserved-id");
  const health = Math.min(mob.spec.health, mob.health + food.heal);
  const temper = next.tamed ? next.temper : Math.min(100, next.temper + food.temper);
  if (health === mob.health && temper === next.temper) return fail("horse-does-not-need-food");
  next.temper = temper;
  const loaded = captureAquaticArea(domain.world, domain.context, horseBounds(mob.position));
  const actorGuard = domain._actorGuard(ownerId, hand, actor, true);
  if (!loaded || (validate && domain._invoke(validate) !== true)) return fail("stale-feed");
  const own = domain._prepareRecord(id, next, {
    validate: () => loaded() && actorGuard() && domain._reachable(actor, mob) &&
      (!validate || validate() === true),
    events: [{ type: "feed", id, ownerId, position: horsePoint(mob.position), health, temper }],
  });
  const base = domain.wildlife.prepareHorseEdit(mob, { health, retain: true });
  const cost = heldCost(domain, actor, hand);
  if (!cost) return fail("hand-cost-rejected");
  return domain._plan("feed", id, [own, base, cost, ...participants], {
    handCostCommitted: true, health, temper, tamed: next.tamed,
  });
}

export function prepareHorseSlotAction(domain, id, action, {
  ownerId = "player", validate, participants = [],
} = {}) {
  if (!domain._ready()) return fail("unavailable");
  if (!currentAction(validate) || !Array.isArray(participants)) return fail("invalid-slot-action");
  const mob = domain._base(id), actor = domain._actor(ownerId);
  const entry = domain._living.get(id);
  if (!mob || !entry?.tamed || !domain._reachable(actor, mob)) return fail("horse-inventory-unavailable");
  const next = cloneHorseRecord(entry, domain.context);
  const actorGuard = domain._actorGuard(ownerId, "main", actor);
  const loaded = captureAquaticArea(domain.world, domain.context, horseBounds(mob.position));
  if (!loaded || (validate && domain._invoke(validate) !== true)) return fail("stale-slot-action");
  let result;
  const inventory = domain._inventory((draft) => {
    result = applyHorseSlotAction(next, draft, action, domain.context);
    return result.ok === true;
  });
  if (!inventory) return fail(result?.reason ?? "inventory-rejected");
  const own = domain._prepareRecord(id, next, {
    validate: () => loaded() && actorGuard() && domain._reachable(actor, mob) &&
      (!validate || validate() === true),
    events: [{ type: "saddle-slot", id, saddled: next.saddle !== null }],
  });
  const base = domain.wildlife.prepareHorseEdit(mob);
  const drops = result.drops ?? [], sinks = [];
  if (drops.length) {
    const sink = prepareDrops(domain, drops, actor.position, "horse-inventory-drop");
    if (!sink) return fail("drop-rejected");
    sinks.push(sink);
  }
  return domain._plan("slot", id, [own, base, inventory, ...sinks, ...participants], {
    saddle: next.saddle && cloneStack(next.saddle, domain.context),
    dropsCommitted: true, handCostCommitted: true,
  });
}

/** Bare hands mount; saddle use/explicit inventory requests open the real panel.
 * Opening is presentation-only (zero participants), not an ownership grant.
 * Every subsequent slot preparation independently rechecks reach and ownership.
 */
export function prepareHorseInteraction(domain, id, {
  ownerId = "player", hand = "main", inventory = false, validate, participants = [],
} = {}) {
  if (!domain._ready()) return fail("unavailable");
  if (!handAllowed(hand) || typeof inventory !== "boolean" ||
    !currentAction(validate) || !Array.isArray(participants)) return fail("invalid-interaction");
  const mob = domain._base(id), actor = domain._actor(ownerId, hand);
  if (!mob || !actor || !domain._reachable(actor, mob)) return fail("inactive-or-out-of-reach");
  if (inventory || isHorseSaddle(actor.stack)) {
    if (!domain._living.get(id)?.tamed) return fail("untamed-horse");
    if (validate && domain._invoke(validate) !== true) return fail("stale-interaction");
    return { ok: true, handled: true, action: "inventory", id,
      view: domain.getHorse(id), participants: [] };
  }
  if (horseFood(actor.stack?.id))
    return prepareHorseFeed(domain, id, { ownerId, hand, validate, participants });
  if (actor.stack !== null) return fail("empty-hand-required");
  return domain.prepareMount(id, ownerId, { hand, validate, participants });
}

/**
 * advance is internal bounded physics state, used to commit a damaging landing
 * with health/death in the SAME transaction. No reset-fall-then-veto loophole.
 * Player attacks supply their one prepared Gameplay wear/cost participant.
 */
export function prepareHorseHit(domain, id, amount, direction, options = {}, advance = null) {
  const batch = domain.wildlife?.beginResidentEditBatch();
  if (!batch) return fail("unavailable");
  const contribution = contributeHorseHit(domain, batch, id, amount, direction, options, advance);
  if (contribution.ok === false) return contribution;
  const plan = domain.wildlife.finalizeResidentEditBatch(batch, {
    contributions: [contribution], participants: contribution.peers,
  });
  return plan ? domain._plan("hit", id, plan.participants, plan.results[0]) : fail("invalid-resident-batch");
}

/** Incomplete until the caller finalizes Wildlife with this token and EVERY
 * peer token. Failure poisons that batch even when the caller ignores this result.
 * This is the existing direct-player/environment policy, not distant credit.
 */
export function contributeHorseHit(domain, batch, id, amount, direction, options = {}, advance = null) {
  let failure;
  const contribution = contributeResidentEditBatch(domain.wildlife, batch, (add) => {
    const prepared = prepareHorseHitParts(domain, id, amount, direction, options, advance, add);
    if (prepared.ok === false) { failure = prepared; return null; }
    return prepared;
  });
  return contribution ?? failure ?? fail("invalid-resident-batch");
}

function prepareHorseHitParts(domain, id, amount, direction, {
  ownerId = "player", playerKill = false, retaliate = true, validate, participants = [],
} = {}, advance, add) {
  if (!domain._ready()) return fail("unavailable");
  if (!Number.isFinite(amount) || amount <= 0 || typeof playerKill !== "boolean" ||
    typeof retaliate !== "boolean" || !horseDataArray(participants, RESIDENT_EDIT_LIMITS.peers) ||
    !currentAction(validate) || (playerKill && !horseSynchronous(validate))) return fail("invalid-hit");
  const mob = domain._base(id), actor = playerKill ? domain._actor(ownerId) : null;
  if (!mob || (playerKill && !domain._reachable(actor, mob))) return fail("inactive-or-out-of-reach");
  const state = domain._newRecord(mob);
  if (!state) return fail("horse-capacity-or-reserved-id");
  const actorGuard = playerKill ? domain._actorGuard(ownerId, "main", actor) : () => true;
  const damage = Math.min(mob.health, amount, 1000), killed = damage === mob.health;
  // Once the horse is removed, only the real rider envelope must remain
  // admitted. An unknown neighbor outside it cannot block an otherwise clear
  // exact-seat release merely because the disappearing horse is wider.
  const bounds = killed && state.rider !== null && !domain.gameplay.dead
    ? horseBoxes(mob.position)[1] : horseBounds(mob.position);
  const loaded = captureAquaticArea(domain.world, domain.context, bounds);
  if (!loaded || (validate && domain._invoke(validate) !== true)) return fail("stale-hit");
  const projected = advance ? { id, position: advance.physics.position, yaw: advance.physics.yaw } : mob;
  const position = horsePoint(projected.position);
  let next = advance?.entry ?? cloneHorseRecord(state, domain.context);
  let movement = advance?.physics, exit = advance?.exit;
  const events = [...(advance?.events ?? [])], sinks = [], drops = [];
  const exitOptions = { sampleFluid: domain.hooks.sampleFluid, otherHorses: domain.wildlife.entities };
  let experience = 0;
  if (killed) {
    if (state.rider !== null && !domain.gameplay.dead) {
      exit = findHorseDeathExit(domain.world, projected, movement?.motion ?? state.motion, exitOptions);
      if (!exit) return fail("no-safe-exit");
    }
    next = { id, dimension: state.dimension, alive: false };
    const leather = { id: ITEM.LEATHER, count: 1 +
      Math.floor(horseStableDraw(domain.context, id, state.dimension, "leather") * 2) };
    if (!isValidStack(leather, domain.context)) return fail("missing-horse-loot");
    drops.push(leather);
    if (state.saddle) drops.push(cloneStack(state.saddle, domain.context));
    // ONE overflow participant retains both leather and the exact saddle.
    const sink = prepareDrops(domain, drops, position, "horse-death");
    if (!sink) return fail("drop-rejected");
    sinks.push(sink);
    if (playerKill) {
      experience = 1 + Math.floor(horseStableDraw(domain.context, id, state.dimension, "experience") * 3);
      const xp = prepareExperience(domain, experience, position);
      if (!xp) return fail("experience-rejected");
      sinks.push(xp);
    }
    events.push({ type: "death", id, position, ownerId: state.rider, ...(exit ? { exit } : {}) });
  } else {
    if (!advance && state.motion && finitePoint(direction)) {
      const length = Math.hypot(direction.x, direction.z), strength = Math.min(7, 2.5 + damage * 0.4);
      if (length) {
        next.motion.vx = clamp(next.motion.vx + direction.x / length * strength, HORSE_MAX_SPEED);
        next.motion.vz = clamp(next.motion.vz + direction.z / length * strength, HORSE_MAX_SPEED);
        movement = { position, yaw: mob.root.rotation.y, motion: next.motion };
      }
    }
    events.push({ type: "hurt", id, damage, position });
  }
  const own = domain._prepareRecord(id, next, {
    validate: () => loaded() && actorGuard() &&
      (!validate || validate() === true) && (!advance?.validate || advance.validate()) &&
      (!playerKill || domain._reachable(actor, mob)) &&
      (!exit || (killed ? horseDeathExitValid : horseExitValid)(domain.world, projected, exit, exitOptions)),
    events, exit, claim: state.rider !== null || !!advance,
    clearExit: killed && state.rider !== null && !exit,
    input: advance?.input, stride: advance?.stride,
    environment: advance ? { grounded: movement.motion.grounded, water: movement.water } : undefined,
  });
  const base = horseResidentEdit(domain.wildlife, mob, {
    health: killed ? mob.health : mob.health - damage,
    remove: killed, retain: !killed, motion: movement, direction, retaliate,
  });
  if (!base || !add("horse", base)) return fail("invalid-resident-edit");
  return { peers: [own, ...sinks, ...participants], result: {
    hit: true, killed, damage, entityId: id, kind: "horse",
    drops: drops.map((stack) => cloneStack(stack, domain.context)), experience,
    dropsCommitted: true, experienceCommitted: true,
    handCostCommitted: participants.some((part) => part?.owner === domain.gameplay),
    ...(exit ? { exit: structuredClone(exit) } : {}),
  } };
}
