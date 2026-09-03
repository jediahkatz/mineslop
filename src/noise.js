export const clamp = (value, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
export const smooth = (value) => value * value * (3 - 2 * value);
export const mix = (a, b, amount) => a + (b - a) * amount;

export function seedHash(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++)
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Integer-coordinate hashing remains stable across workers and negative chunks.
// These two functions also preserve the exact generator-v1 noise.
export function hash(x, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function noise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const tz = smooth(z - iz);
  return mix(
    mix(hash(ix, iz, seed), hash(ix + 1, iz, seed), tx),
    mix(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), tx),
    tz
  );
}

export function fractal(x, z, seed) {
  return (
    noise(x, z, seed) * 0.68 +
    noise(x * 2.03 + 17, z * 2.03 - 31, seed ^ 7907) * 0.23 +
    noise(x * 4.07 - 13, z * 4.07 + 19, seed ^ 17041) * 0.09
  );
}

// Search in whole rings, without allocating a map proportional to world size.
export function* squareSpiral(radius) {
  yield [0, 0];
  for (let ring = 1; ring <= radius; ring++) {
    for (let x = -ring; x < ring; x++) yield [x, -ring];
    for (let z = -ring; z < ring; z++) yield [ring, z];
    for (let x = ring; x > -ring; x--) yield [x, ring];
    for (let z = ring; z > -ring; z--) yield [-ring, z];
  }
}
