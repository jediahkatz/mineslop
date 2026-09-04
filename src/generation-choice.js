// A new-world opt-in, not the set of supported archive generator versions.
// Keep legacy callers pinned to Classic even if the terrain default changes.
export function newWorldGeneratorVersion(value = 3) {
  if (value !== 3 && value !== 7)
    throw new RangeError("Choose Classic (3) or Expanded (experimental, 7).");
  return value;
}

export function generationChoiceFromInput(value) {
  if (value !== "3" && value !== "7")
    throw new RangeError("Choose Classic (3) or Expanded (experimental, 7).");
  return newWorldGeneratorVersion(Number(value));
}
