// A section's immutable boundary certificate is derived from its actual mesh,
// before publication/packing. Two batches, four sides, sixteen unit intervals.
export const NATIVE_BOUNDARY_SLOTS = 128;

function interior(geometry) {
  if (!geometry) return true;
  const sphere = geometry.boundingSphere;
  return !!sphere && sphere.radius >= 0 &&
    sphere.center.x - sphere.radius > 0 && sphere.center.x + sphere.radius < 16 &&
    sphere.center.z - sphere.radius > 0 && sphere.center.z + sphere.radius < 16;
}

export class NativeBoundaryProfile {
  constructor(parts) {
    this.data = new Float32Array(NATIVE_BOUNDARY_SLOTS * 3);
    this.data.minimumTop = Infinity;
    this.data.maximumTop = -Infinity;
    for (let i = 0; i < NATIVE_BOUNDARY_SLOTS; i++) {
      this.data[i * 3] = -Infinity;
      this.data[i * 3 + 1] = Infinity;
      this.data[i * 3 + 2] = -Infinity;
    }
    // A single interior part has no boundary triangles. Reuse its already
    // computed sphere in constant time, so paid interior edits need no extra
    // scheduler turn. Multipart/transformed/uncertain meshes stay metered.
    this.parts = parts.length === 1 && !parts[0].transform &&
      interior(parts[0].opaque) && interior(parts[0].water) ? [] : parts;
    this.part = 0;
    this.batch = 0;
    this.index = 0;
  }
  get done() { return this.part === this.parts.length; }
  step(limit, deadline) {
    let work = 0;
    while (!this.done && work < limit && performance.now() < deadline) {
      const geometry = this.parts[this.part][this.batch ? "water" : "opaque"];
      if (!geometry?.index || this.index >= geometry.index.count) {
        this.index = 0;
        if (++this.batch === 2) { this.batch = 0; this.part++; }
        continue;
      }
      const p = geometry.attributes.position;
      const ids = [0, 1, 2].map(i => geometry.index.getX(this.index + i));
      const points = ids.map(i => [p.getX(i), p.getY(i), p.getZ(i)]);
      const matrix = this.parts[this.part].transform?.elements;
      if (matrix) for (const v of points) {
        const [x, y, z] = v;
        v[0] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        v[1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        v[2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      }
      const normal = geometry.attributes.normal;
      const up = normal && ids.every(i => normal.getY(i) > 0);
      for (let side = 0; side < 4; side++) {
        const axis = side < 2 ? 0 : 2, along = side < 2 ? 2 : 0;
        const boundary = side % 2 ? 16 : 0;
        const edge = points.filter(v => Math.abs(v[axis] - boundary) < 1e-5);
        if (edge.length < 2) continue;
        const lo = Math.max(0, Math.min(...edge.map(v => v[along])));
        const hi = Math.min(16, Math.max(...edge.map(v => v[along])));
        for (let u = Math.floor(lo); u < Math.ceil(hi); u++) {
          if (u + 0.5 < lo || u + 0.5 > hi) continue;
          const at = (this.batch * 64 + side * 16 + u) * 3;
          if (up) {
            const a = edge.reduce((a, b) => a[along] < b[along] ? a : b);
            const b = edge.reduce((a, b) => a[along] > b[along] ? a : b);
            const t = b[along] === a[along] ? 0 : (u + 0.5 - a[along]) / (b[along] - a[along]);
            const top = a[1] + (b[1] - a[1]) * t;
            this.data[at] = Math.max(this.data[at], top);
            this.data.minimumTop = Math.min(this.data.minimumTop, top);
            this.data.maximumTop = Math.max(this.data.maximumTop, top);
          } else if (edge.length === 3) {
            this.data[at + 1] = Math.min(this.data[at + 1], ...edge.map(v => v[1]));
            this.data[at + 2] = Math.max(this.data[at + 2], ...edge.map(v => v[1]));
          }
        }
      }
      this.index += 3;
      work++;
    }
    if (this.done) { this.parts = []; this.part = 0; }
    return work;
  }
}

// Use the very same per-batch publication result as the detail mask. CPU-ready
// profiles do not own an edge until their physical section batch is drawn.
export function publishedNativeBoundaries(chunks, batches, previous, owners, work) {
  const columns = new Map();
  let checks = 0;
  for (const [key, column] of chunks) {
    checks++;
    const profiles = [];
    const sources = column.userData.nativeBoundarySources ??
      [...(column.userData.sections ?? [])].map(([sy, section]) => [sy, section.group.userData.nativeBoundary]);
    for (const buffer of column.userData.nativeBoundaryOwners ?? []) { owners?.add(buffer); checks++; }
    for (const [sy, data] of sources) {
      checks++;
      const bits = batches.get(`${key},${sy}`) ?? 0;
      if (data && !column.userData.nativeBoundaryOwners) owners?.add(data.buffer);
      if (data && (bits & 9)) profiles.push({ data, bits: bits & 9 });
    }
    if (profiles.length) columns.set(key, profiles);
  }
  const changed = new Set(previous?.keys() ?? []);
  for (const [key, profiles] of columns) {
    checks += profiles.length + 1;
    const old = previous?.get(key);
    if (old?.length === profiles.length &&
        profiles.every((p, i) => p.data === old[i].data && p.bits === old[i].bits))
      changed.delete(key);
    else changed.add(key);
  }
  if (work) work.units = Math.ceil(checks / 256);
  if (previous && !changed.size) return previous;
  columns.changedKeys = changed;
  return columns;
}
