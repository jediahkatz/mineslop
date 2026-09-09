/**
 * Named, immutable per-resident rolls. Preparing/retrying a reward never
 * advances motion, status, fishing or world RNG and needs no extra save field.
 * Keep this key and hash stable: existing spider/ghast v1 quotes use it.
 */
export function mobLootRoll(world, mob, version) {
  const key = JSON.stringify([
    String(world.seed), world.dimension, world.generatorVersion, mob.id,
    mob.kind, version,
  ]);
  return (name) => {
    let hash = 2166136261;
    for (const char of `${key}:${name}`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
  };
}
