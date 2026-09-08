// Factories register their immutable, total Overworld field, not a generator
// version number. A replaced sampler permanently revokes that registration.
const totalFields = new WeakMap();
const worlds = new WeakMap();
export function registerTotalSurface(generator, bounds) {
  totalFields.set(generator, {
    height: generator.terrainHeight, column: generator.sampleColumn,
    bounds: Object.freeze({ ...bounds }), revoked: false,
  });
  return generator;
}

export function surfaceIdentity(world) {
  const generator = world.generator;
  const values = [generator, generator.terrainHeight, generator.sampleColumn,
    world.epoch ?? world._epoch, world.surfaceRevision, world.generatorVersion, world.dimension];
  let record = worlds.get(world);
  if (!record || values.some((value, i) => value !== record.values[i])) {
    record = { values, token: {} };
    worlds.set(world, record);
  }
  const field = totalFields.get(generator);
  if (field && (field.height !== generator.terrainHeight || field.column !== generator.sampleColumn))
    field.revoked = true;
  return record.token;
}

export function certifySurfaceRegion(world, bounds) {
  const token = surfaceIdentity(world), field = totalFields.get(world.generator);
  if (world.dimension !== "overworld" || !field || field.revoked ||
      !["minX", "maxX", "minZ", "maxZ"].every(key => Number.isSafeInteger(bounds[key])) ||
      bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ ||
      bounds.minX < field.bounds.minX || bounds.maxX > field.bounds.maxX ||
      bounds.minZ < field.bounds.minZ || bounds.maxZ > field.bounds.maxZ)
    return null;
  return Object.freeze({ world, token, bounds: Object.freeze({ ...bounds }) });
}

export function surfaceCertificateCurrent(certificate, world, bounds = certificate?.bounds) {
  return !!certificate && certificate.world === world &&
    certificate.token === surfaceIdentity(world) &&
    !!certifySurfaceRegion(world, bounds) &&
    certificate.bounds.minX <= bounds.minX && certificate.bounds.maxX >= bounds.maxX &&
    certificate.bounds.minZ <= bounds.minZ && certificate.bounds.maxZ >= bounds.maxZ;
}

// Unknown custom fields are validated at every integer column, near-to-far.
// Geometry can publish before this finishes, but unvalidated chunks stay unknown.
export class SurfaceRegionValidation {
  constructor(world, bounds, center, minY, cache = new Map()) {
    this.world = world;
    this.identity = surfaceIdentity(world);
    this.bounds = bounds;
    this.minY = minY;
    this.cache = cache;
    this.unknown = new Set();
    this.invalid = new Set();
    this.chunks = [];
    this.cursor = 0;
    this.column = 0;
    this.valid = true;
    for (let z = bounds.minZ / 16; z < bounds.maxZ / 16; z++)
      for (let x = bounds.minX / 16; x < bounds.maxX / 16; x++) {
        const key = `${x},${z}`, previous = cache.get(key);
        if (previous?.identity === this.identity) {
          if (!previous.valid) { this.unknown.add(key); this.invalid.add(key); }
        } else {
          this.unknown.add(key);
          this.chunks.push({ x, z, key });
        }
      }
    this.chunks.sort((a, b) =>
      Math.max(Math.abs(a.x - center.cx), Math.abs(a.z - center.cz)) -
      Math.max(Math.abs(b.x - center.cx), Math.abs(b.z - center.cz)));
  }

  get done() { return this.cursor === this.chunks.length; }

  step(maxSamples, deadline) {
    let samples = 0;
    if (surfaceIdentity(this.world) !== this.identity) return samples;
    while (!this.done && samples < maxSamples && performance.now() < deadline) {
      const chunk = this.chunks[this.cursor];
      const x = chunk.x * 16 + this.column % 16;
      const z = chunk.z * 16 + Math.floor(this.column / 16);
      const height = this.world.generator.terrainHeight(x, z);
      this.valid &&= Number.isFinite(height) && height >= this.minY;
      if (!this.valid) this.invalid.add(chunk.key);
      samples++;
      if (++this.column === 256) {
        this.cache.set(chunk.key, { identity: this.identity, valid: this.valid });
        if (this.cache.size > 4096) this.cache.delete(this.cache.keys().next().value);
        if (this.valid) this.unknown.delete(chunk.key);
        this.column = 0;
        this.valid = true;
        this.cursor++;
      }
    }
    return samples;
  }
}
