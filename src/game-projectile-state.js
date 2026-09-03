import { normalizePlayerProjectilesSnapshot } from "./pearl-save.js";

export const LOCAL_PROJECTILE_OWNER = "local-player";

/** Absence is a legacy empty pool; a present malformed pool is never discarded. */
export function normalizeProjectileServicesSnapshot(saved, context) {
  if (saved == null) return {};
  if (
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(saved))
  )
    return null;
  const property = Object.getOwnPropertyDescriptor(saved, "playerProjectiles");
  if (!property) return {};
  if (!Object.hasOwn(property, "value") || !property.enumerable) return null;
  if (property.value === undefined) return {};
  const playerProjectiles = normalizePlayerProjectilesSnapshot(
    property.value,
    context
  );
  return playerProjectiles ? { playerProjectiles } : null;
}
