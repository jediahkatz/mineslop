import { normalizeProgressionServicesSnapshot } from "./game-progression-services.js";
import {
  LOCAL_PROJECTILE_OWNER,
  normalizeProjectileServicesSnapshot,
} from "./game-projectile-state.js";

/**
 * Full-archive adapter for save preflight and detached staging. Only an absent
 * progression field migrates; never turn an explicit broken sidecar into empty
 * escrow. Inspect descriptors before generic archive cloning can invoke getters.
 */
export function normalizeProgressionArchive(saved, context) {
  if (
    saved != null &&
    (typeof saved !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(saved)))
  )
    return null;
  const property = saved == null
    ? undefined
    : Object.getOwnPropertyDescriptor(saved, "progression");
  if (property && (
    !Object.hasOwn(property, "value") ||
    !property.enumerable ||
    property.value === undefined
  ))
    return null;
  const pearls = normalizeProjectileServicesSnapshot(saved, context);
  if (!pearls) return null;
  const ownerId = pearls.playerProjectiles?.ownerId ?? LOCAL_PROJECTILE_OWNER;
  const life = pearls.playerProjectiles?.life ?? 0;
  const progression = normalizeProgressionServicesSnapshot(property?.value, context, { ownerId });
  if (!progression ||
      progression.potionProjectiles.projectiles.some((potion) => potion.life !== life))
    return null;
  return { progression };
}
