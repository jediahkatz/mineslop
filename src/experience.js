// Java stores total experience as a signed integer. Never persist a derived bar.
export const MAX_EXPERIENCE = 2147483647;

export const isValidExperience = (total) =>
  Number.isSafeInteger(total) && total >= 0 && total <= MAX_EXPERIENCE;

export function experienceForLevel(level) {
  if (!Number.isSafeInteger(level) || level < 0)
    throw new RangeError("Invalid experience level");
  const total =
    level <= 16
      ? level * level + 6 * level
      : level <= 31
        ? (5 * level * level - 81 * level + 720) / 2
        : (9 * level * level - 325 * level + 4440) / 2;
  if (!Number.isSafeInteger(total)) throw new RangeError("Experience overflow");
  return total;
}

export function experienceToNextLevel(level) {
  experienceForLevel(level);
  return level < 16
    ? 2 * level + 7
    : level < 31
      ? 5 * level - 38
      : 9 * level - 158;
}

/** Exact level boundaries, including the slope changes at levels 16 and 31. */
export function experienceState(total) {
  if (!isValidExperience(total))
    throw new RangeError("Invalid experience total");
  let low = 0;
  let high = Math.floor(Math.sqrt(total)) + 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (experienceForLevel(middle) <= total) low = middle;
    else high = middle;
  }
  return {
    total,
    level: low,
    progress: (total - experienceForLevel(low)) / experienceToNextLevel(low),
  };
}
