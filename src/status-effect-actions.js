import { acceptsBrewingStack } from "./brewing.js";
import { draftHand } from "./gameplay-hand-actions.js";
import { EQUIPMENT_SLOTS } from "./inventory-domain.js";
import {
  cloneStack,
  isValidStack,
  normalizeStack,
  takeStack,
} from "./inventory-slots.js";
import {
  normalizeStackData,
  resolveItemStats,
  sameStackKind,
} from "./item-stack-data.js";
import { normalizeSupportedPotion } from "./potion-rules.js";
import { projectStatusHealth } from "./status-effects.js";
import { TransactionInvariantError } from "./transactions.js";

const synchronous = (value) =>
  typeof value === "function" &&
  Object.prototype.toString.call(value) === "[object Function]";
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const noEdit = () => true;

function sameCoordinator(gameplay, effects) {
  return (
    gameplay &&
    !gameplay.dead &&
    !gameplay._disposed &&
    gameplay.coordinator === effects?.coordinator &&
    gameplay.coordinator?.usage?.(gameplay) !== undefined &&
    synchronous(gameplay._prepareState)
  );
}

// A timer-only application still depends on the target surviving, not being
// reloaded/replaced, and remaining attached to this coordinator before commit.
function guardTarget(gameplay, participant) {
  const revision = gameplay.revision;
  const coordinator = gameplay.coordinator;
  const health = gameplay.health;
  const mode = gameplay.mode;
  const context = gameplay.context;
  const seed = context?.seed;
  const generatorVersion = context?.generatorVersion;
  const specForDimension = context?.specForDimension;
  const reservation = coordinator.usage(gameplay);
  return Object.freeze({
    ...participant,
    validate: () =>
      !gameplay.dead &&
      !gameplay._disposed &&
      gameplay.revision === revision &&
      gameplay.health === health &&
      gameplay.mode === mode &&
      gameplay.coordinator === coordinator &&
      coordinator.usage(gameplay) === reservation &&
      reservation !== undefined &&
      gameplay.context === context &&
      context?.seed === seed &&
      context?.generatorVersion === generatorVersion &&
      context?.specForDimension === specForDimension &&
      participant.validate() === true,
  });
}

/**
 * The existing Gameplay full-state preparer owns health AND its owned inventory.
 * Never combine a prepareHandCost and a second Gameplay health participant.
 * prepareInventory alone cannot apply instant effects atomically.
 */
function prepareGameplay(
  gameplay,
  plan,
  { editOwned = noEdit, notify = true, target, hand } = {}
) {
  if (!synchronous(editOwned) || typeof notify !== "boolean") return null;
  let projected;
  const participant = gameplay._prepareState(
    (draft) => {
      if (editOwned(draft.owned) !== true) return false;
      const protectionFactor = Math.min(
        20,
        EQUIPMENT_SLOTS.reduce((total, slot) => {
          const stack = draft.owned.equipment[slot];
          return (
            total +
            (stack
              ? resolveItemStats(stack, {
                  context: gameplay.context,
                  damageType: "magic",
                }).protectionFactor
              : 0)
          );
        }, 0)
      );
      projected = projectStatusHealth(draft, plan, {
        invulnerable: gameplay.mode === "creative",
        protectionFactor,
        target,
      });
      draft.health = projected.health;
      draft.dead = projected.dead;
      draft.deathCause = projected.deathCause;
      if (projected.damageTaken > 0) draft.timers.regen = 0;
      return true;
    },
    { notify, selfUseHands: hand ? [hand] : [] }
  );
  if (!participant || !projected) return null;
  return {
    projected,
    // Death is a lifecycle event even on otherwise quiet timer updates.
    participant: projected.dead
      ? Object.freeze({
          ...participant,
          notify() {
            try {
              participant.notify?.();
            } finally {
              gameplay.onDeath?.(projected.deathCause);
            }
          },
        })
      : participant,
  };
}

function jointPlan(gameplay, participants, result) {
  if (!Array.isArray(participants)) return null;
  const owners = new Set();
  for (const participant of participants) {
    if (
      !record(participant) ||
      owners.has(participant.owner) ||
      gameplay.coordinator.usage(participant.owner) === undefined ||
      (participant.owner?.coordinator !== undefined &&
        participant.owner.coordinator !== gameplay.coordinator)
    )
      return null;
    owners.add(participant.owner);
  }
  return { participants, result };
}

/**
 * Apply a potion to one target without spending a carried item (e.g. impact).
 * The caller includes the projectile's single-use retirement and all affected
 * targets in ONE shared-coordinator commit. No caller should execute this
 * returned gameplayPlan separately after its participants have committed.
 */
export function prepareStatusApplication(
  gameplay,
  effects,
  potion,
  { splash, target, notify = true, participants = [] } = {}
) {
  if (!sameCoordinator(gameplay, effects) || !Array.isArray(participants))
    return null;
  const application = effects.preparePotion(potion, { splash, target, notify });
  if (!application) return null;
  const health = application.gameplayPlan.health.length
    ? prepareGameplay(gameplay, application.gameplayPlan, { notify, target })
    : null;
  if (application.gameplayPlan.health.length && !health) return null;
  const effect = health?.projected.dead
    ? effects.prepareClear(undefined, { notify })
    : application.participant;
  if (!effect) return null;
  return jointPlan(
    gameplay,
    [
      guardTarget(gameplay, effect),
      ...(health ? [health.participant] : []),
      ...participants,
    ],
    {
      ok: true,
      applied: application.applied,
      splashWater: application.splashWater,
      gameplayPlan: application.gameplayPlan,
      ...(health ? { health: { ...health.projected } } : {}),
    }
  );
}

function capturedPotion(gameplay, use, catalog, form) {
  if (
    !record(use) ||
    !["main", "offhand"].includes(use.hand) ||
    !Number.isSafeInteger(use.handRevision) ||
    use.handRevision < 0 ||
    !isValidStack(use.stack, gameplay.context) ||
    gameplay.getHandRevision(use.hand) !== use.handRevision
  )
    return null;
  const current = gameplay.getHandStack(use.hand);
  if (
    !current ||
    current.count !== 1 ||
    !sameStackKind(current, use.stack, gameplay.context) ||
    !acceptsBrewingStack(0, current, catalog, gameplay.context)
  )
    return null;
  try {
    const potion = normalizeStackData(
      current.id,
      current.data,
      gameplay.context
    )?.potion;
    if (potion?.form !== form) return null;
    normalizeSupportedPotion(potion);
    return cloneStack(current, gameplay.context);
  } catch {
    return null;
  }
}

/**
 * Called AFTER the held drink-use cycle. `use` captures {hand,stack,handRevision}
 * at use start; changing slot/metadata and changing back invalidates that use.
 * Preview edits only drafts. Potion debit, plain empty-bottle return, timed
 * effects and instant health all publish together or none publish.
 */
export function preparePotionConsumption(
  gameplay,
  effects,
  use,
  { catalog, notify = true, participants = [] } = {}
) {
  if (!sameCoordinator(gameplay, effects) || !Array.isArray(participants))
    return null;
  const stack = capturedPotion(gameplay, use, catalog, "drinkable");
  if (!stack) return null;
  const application = effects.preparePotion(stack.data.potion, { notify });
  if (!application) return null;
  const selected = gameplay.selected;
  const bottle = normalizeStack(
    { id: catalog.emptyBottle, count: 1 },
    gameplay.context
  );
  const prepared = prepareGameplay(gameplay, application.gameplayPlan, {
    notify,
    hand: use.hand,
    editOwned(owned) {
      if (gameplay.mode === "creative") return true;
      const slot = draftHand(owned, use.hand, selected);
      if (
        !sameStackKind(slot.get(), stack, gameplay.context) ||
        slot.get().count !== 1
      )
        return false;
      const cell = [slot.get()];
      if (takeStack(cell, 0, 1)?.count !== 1) return false;
      slot.set(cloneStack(bottle, gameplay.context));
      return true;
    },
  });
  if (!prepared) return null;
  const effect = prepared.projected.dead
    ? effects.prepareClear(undefined, { notify })
    : application.participant;
  if (!effect) return null;
  return jointPlan(
    gameplay,
    [guardTarget(gameplay, effect), prepared.participant, ...participants],
    {
      ok: true,
      consumed: gameplay.mode !== "creative",
      gameplayPlan: application.gameplayPlan,
      health: { ...prepared.projected },
    }
  );
}

/**
 * Timers and their pulse health changes are one transaction. Most frames touch
 * only the bounded effect owner, not Gameplay's inventory or save projection.
 * Use the returned segments for time-dependent hazards; do not advance the
 * same timers a second time from Gameplay.update or a sleep/day-time path.
 */
export function prepareStatusAdvance(
  gameplay,
  effects,
  dt,
  { paused = false, notify = false, target, participants = [] } = {}
) {
  if (!sameCoordinator(gameplay, effects) || !Array.isArray(participants))
    return null;
  const advance = effects.prepareAdvance(dt, { paused, notify });
  if (!advance) return null;
  if (!advance.participant)
    return jointPlan(gameplay, [...participants], {
      ok: true,
      changed: false,
      gameplayPlan: advance.gameplayPlan,
      segments: advance.segments,
      elapsedSeconds: advance.elapsedSeconds,
    });
  const health = advance.gameplayPlan.health.length
    ? prepareGameplay(gameplay, advance.gameplayPlan, { notify, target })
    : null;
  if (advance.gameplayPlan.health.length && !health) return null;
  const effect = health?.projected.dead
    ? effects.prepareClear(undefined, { notify })
    : advance.participant;
  if (!effect) return null;
  return jointPlan(
    gameplay,
    [
      guardTarget(gameplay, effect),
      ...(health ? [health.participant] : []),
      ...participants,
    ],
    {
      ok: true,
      changed: true,
      gameplayPlan: advance.gameplayPlan,
      segments: advance.segments,
      elapsedSeconds: advance.elapsedSeconds,
      expired: advance.expired,
      ...(health ? { health: { ...health.projected } } : {}),
    }
  );
}

/**
 * A thrown bottle is lost, not returned. prepareProjectile must retain its full
 * canonical stack payload and produce a participant on this same coordinator.
 * Effects happen at impact via prepareStatusApplication, never at throw preview.
 * The projectile owner is responsible for loaded-world/collision/lifetime guards.
 */
export function prepareSplashThrow(
  gameplay,
  use,
  { catalog, prepareProjectile, notify = true, participants = [] } = {}
) {
  if (
    !gameplay ||
    gameplay.dead ||
    gameplay._disposed ||
    !synchronous(prepareProjectile) ||
    !synchronous(gameplay.prepareHandCost) ||
    typeof notify !== "boolean" ||
    !Array.isArray(participants)
  )
    return null;
  const stack = capturedPotion(gameplay, use, catalog, "splash");
  if (!stack) return null;
  const source = gameplay.prepareHandCost(use.hand, {
    count: 1,
    stack,
    handRevision: use.handRevision,
    notify,
  });
  if (!source) return null;
  let projectile;
  try {
    projectile = prepareProjectile(cloneStack(stack, gameplay.context));
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return null;
  }
  if (!projectile) return null;
  return jointPlan(gameplay, [source, projectile, ...participants], {
    ok: true,
    projectileCommitted: true,
    consumed: gameplay.mode !== "creative",
  });
}
