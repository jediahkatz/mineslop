// Machine damage kinds are independent of the text shown on the death screen.
// Explicit source kinds win; these aliases cover older environment callers.
const aliases = new Map([
  ["the void", "void"],
  ["ender-pearl", "pearl"],
  ["an explosion", "explosion"],
  ["blaze_fireball", "fireball"],
  ["guardian_beam", "magic"],
]);

export function playerDamageKind(cause, kind) {
  const value = kind ?? cause;
  return aliases.get(value) ?? (typeof value === "string" ? value : "generic");
}
