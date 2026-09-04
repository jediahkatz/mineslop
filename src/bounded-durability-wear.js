import { finite, integer, randomUnit } from "./enchantment-domain.js";
import { ITEMS } from "./items.js";

export const MAX_WEAR_DURABILITY = Math.max(
  ...Object.values(ITEMS).map((item) => item.durability ?? 0)
);
const UNIFORM_STEPS = 0x100000000;

/**
 * min(Binomial(uses, chance), remaining), by inverse CDF, not mean rounding.
 * Work <= remaining <= the registered maximum durability, independent of uses.
 * Large counts are the integer represented by the caller's finite JS number;
 * there is no raw-damage clamp or loop/allocation proportional to that count.
 *
 * Stations supply a uint32 / 2^32 roll. Use the midpoint of that discrete bin
 * (also quantizing other valid inputs to this grid), so neither endpoint can
 * select a vanishing tail just because it underflowed. CDF quantization error
 * is at most 2^-33, apart from double-precision arithmetic. This is a discrete
 * inverse-CDF sample, not a claim of arbitrary-precision continuous randomness.
 *
 * Log PMF recurrence and log-sum-exp avoid exp(-uses*p) underflow followed by
 * failure to recover near the mode. Even -Infinity for astronomically small
 * lower-tail mass is safe: it remains below every representable midpoint.
 * The entire tail at/above remaining belongs to the broken-stack outcome.
 */
export function boundedDurabilityWear(uses, chance, remaining, roll = 0) {
  if (!Number.isFinite(uses) || !Number.isInteger(uses) || uses < 0)
    throw new RangeError("Invalid durability use count");
  finite(chance, "durability use probability", 0, 1);
  integer(remaining, "remaining durability", 0, MAX_WEAR_DURABILITY);
  randomUnit(roll);
  const cap = Math.min(uses, remaining);
  if (!cap || !chance) return 0;
  if (chance === 1) return cap;
  const logUniform = Math.log((Math.floor(roll * UNIFORM_STEPS) + 0.5) / UNIFORM_STEPS);
  const logFailure = Math.log1p(-chance);
  const logOdds = Math.log(chance) - logFailure;
  let logMass = uses * logFailure, logCdf = -Infinity, compensation = 0;
  for (let loss = 0; loss < cap; loss++) {
    const high = Math.max(logCdf, logMass), low = Math.min(logCdf, logMass);
    logCdf = high === -Infinity ? high : high + Math.log1p(Math.exp(low - high));
    if (logUniform < logCdf) return loss;
    // Compensate the long log recurrence: its normalization drift otherwise
    // becomes significant relative to the uppermost uint32 tail probabilities.
    const step = Math.log(uses - loss) - Math.log(loss + 1) + logOdds - compensation;
    const next = logMass + step;
    compensation = Number.isFinite(next) ? (next - logMass) - step : 0;
    logMass = next;
  }
  return cap;
}
