import { captureEntityContext } from "./entity-context.js";
import { getItem } from "./items.js";

const undead = new Set(["zombie", "skeleton", "husk", "stray", "drowned"]);
export const meleeTargetFamily = (kind) =>
  undead.has(kind) ? "undead" : kind === "spider" ? "arthropod" : "other";

/**
 * A read observation, not another Gameplay participant. The attack's ONE cost
 * participant must validate it alongside its victim/reward peers. An installed
 * but stale progression host refuses; only standalone legacy games lack a host.
 */
function captureCombatEffects(game, hand) {
  const { world, gameplay, player, wildlife } = game;
  if (!world || !gameplay || !player || !["main", "offhand"].includes(hand))
    return null;
  const host = game.progressionIntegration ?? null;
  const services = game.progressionServices ?? null;
  const damageHost = gameplay.damageHost ?? null;
  // Reuse the composition boundary's existing world/player/pearl-life guard.
  const live = host?._captureRewardHost?.();
  const gear = host?.gear ?? null, effects = services?.effects ?? null;
  if ((host || services || damageHost) &&
      (!live || !gear || !effects || damageHost !== host ||
        host.services !== services || host.world !== world ||
        host.gameplay !== gameplay || gear.gameplay !== gameplay ||
        gear.effects !== effects))
    return null;
  const coordinator = gameplay.coordinator, context = gameplay.context;
  const currentContext = captureEntityContext(world, context);
  const mode = gameplay.mode, revision = gameplay.revision;
  const handRevision = gameplay.getHandRevision(hand);
  const effectsRevision = effects?.revision;
  const effectsBytes = effects ? coordinator.usage(effects) : null;
  const current = () => game.active === true && !game.paused && !game.building &&
    !game.failed && !game.overlayOpen && !game.closingScreens &&
    !gameplay.dead && !gameplay._disposed && !wildlife?.disposed &&
    game.world === world && game.gameplay === gameplay &&
    game.player === player && game.wildlife === wildlife &&
    gameplay.coordinator === coordinator && gameplay.context === context &&
    gameplay.mode === mode && currentContext() &&
    (game.progressionIntegration ?? null) === host &&
    (game.progressionServices ?? null) === services &&
    (gameplay.damageHost ?? null) === damageHost &&
    (!host || (live() && host.gear === gear && services.effects === effects &&
      gear.gameplay === gameplay && gear.effects === effects &&
      effects.revision === effectsRevision && effects.coordinator === coordinator &&
      effectsBytes !== undefined && coordinator.usage(effects) === effectsBytes));
  const validate = () => current() && gameplay.revision === revision &&
    gameplay.getHandRevision(hand) === handRevision;
  if (!validate()) return null;
  const stack = gameplay.getHandStack(hand), item = getItem(stack?.id);
  return { stack, item, gear, validate, current };
}

/**
 * Status modifies the RAW attribute, then the caller's charge/critical scale,
 * then enchantments (attack-strength-scaled, never critical-scaled). Game's
 * existing full-hit cadence passes the defaults; this does not invent a clock.
 */
export function observeMeleeAttack(game, targetFamily, {
  baseMultiplier = 1, attackStrength = 1,
} = {}) {
  if (!["undead", "arthropod", "other"].includes(targetFamily) ||
      !Number.isFinite(baseMultiplier) || baseMultiplier < 0 ||
      !Number.isFinite(attackStrength) || attackStrength < 0 || attackStrength > 1)
    return null;
  const source = captureCombatEffects(game, "main");
  if (!source) return null;
  const { stack, item, gear, validate, current } = source;
  // Bow melee uses the ordinary one-point attribute, never projectile damage.
  const raw = item?.tool === "bow" ? 1 : item?.damage ?? 1;
  const scaled = (gear ? gear.attackDamage(raw, { kind: "melee" }) : raw) * baseMultiplier;
  if (!Number.isFinite(scaled)) return null;
  const amount = gear
    ? gear.meleeDamage(scaled, stack, { targetFamily, attackStrength })
    : scaled;
  return Object.freeze({ amount, stack, item, validate, current });
}

/** Power precedes the existing hitscan charge/rounding; no melee status bonus. */
export function observeBowAttack(game, hand, strength) {
  if (!Number.isFinite(strength) || strength < 0.1 || strength > 1) return null;
  const source = captureCombatEffects(game, hand);
  if (!source || source.item?.tool !== "bow") return null;
  const { stack, item, gear, validate, current } = source;
  const raw = item.damage ?? 6;
  const amount = Math.max(1, Math.round((gear ? gear.bowDamage(raw, stack) : raw) * strength));
  return Object.freeze({ amount, validate, current });
}
