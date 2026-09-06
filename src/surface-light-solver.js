const SIDE = 48, PLANE = SIDE * SIDE, BLOCKED = 255, UNLIT = 254;
export const SURFACE_PAGE_CELLS = 18 * 18 * 16;

/** Same six-connected daylight flood; every initialization, seed, flood and
 * output cell consumes a visit. One-cell output apron stays inside the solve.
 */
export class SurfaceLightSolver {
  constructor(height) {
    this.distance = new Uint8Array(PLANE * height);
    this.queue = new Uint32Array(PLANE * height);
  }

  begin(sources, minY, height) {
    this.sources = sources;
    this.minY = minY;
    this.height = height;
    this.depth = Math.max(0, ...sources.map((s) => s?.depth ?? 0));
    this.count = this.depth * PLANE;
    this.cursor = this.head = this.tail = 0;
    this.phase = this.count ? "fill" : "output";
    this.pages = [];
    this.page = null;
  }

  step(budget, stats) {
    const d = this.distance;
    while (budget.take("visits")) {
      if (this.phase === "fill") {
        const i = this.cursor++, y = Math.floor(i / PLANE), z = Math.floor(i / SIDE) % SIDE, x = i % SIDE;
        const source = this.sources[Math.floor(z / 16) * 3 + Math.floor(x / 16)];
        const column = (z % 16) * 16 + x % 16, at = y * 256 + column;
        d[i] = !source ? BLOCKED : y + this.minY >= source.heights[column] ? 0 :
          source.blocked[at >>> 5] & (1 << (at & 31)) ? BLOCKED : UNLIT;
        stats.surfaceVoxelVisits++;
        if (this.cursor === this.count) { this.phase = "seed"; this.cursor = 0; }
      } else if (this.phase === "seed") {
        const i = this.cursor++, y = Math.floor(i / PLANE), z = Math.floor(i / SIDE) % SIDE, x = i % SIDE;
        if (d[i] === UNLIT && x > 0 && x < 47 && z > 0 && z < 47 &&
          (d[i - 1] === 0 || d[i + 1] === 0 || d[i - SIDE] === 0 || d[i + SIDE] === 0 ||
            (y > 0 && d[i - PLANE] === 0) || (y + 1 < this.depth && d[i + PLANE] === 0))) {
          d[i] = 1; this.queue[this.tail++] = i;
        }
        stats.surfaceVoxelVisits++;
        if (this.cursor === this.count) this.phase = "flood";
      } else if (this.phase === "flood") {
        if (this.head === this.tail) { this.phase = "output"; this.cursor = 0; continue; }
        const i = this.queue[this.head++], value = d[i] + 1;
        stats.surfaceFloodVisits++;
        if (value >= 16) continue;
        const x = i % SIDE, z = Math.floor(i / SIDE) % SIDE;
        const spread = (at) => {
          if (d[at] !== UNLIT) return;
          d[at] = value;
          this.queue[this.tail++] = at;
        };
        if (x > 0) spread(i - 1);
        if (x < 47) spread(i + 1);
        if (z > 0) spread(i - SIDE);
        if (z < 47) spread(i + SIDE);
        if (i >= PLANE) spread(i - PLANE);
        if (i + PLANE < this.count) spread(i + PLANE);
      } else {
        const i = this.cursor++, y = Math.floor(i / 324), z = Math.floor(i / 18) % 18, x = i % 18;
        const local = i % SURFACE_PAGE_CELLS;
        const source = this.sources[Math.floor((z + 15) / 16) * 3 + Math.floor((x + 15) / 16)];
        const value = y < this.depth ? d[y * PLANE + (z + 15) * SIDE + x + 15] : source ? 0 : BLOCKED;
        const light = value < 16 ? 16 - value : 0;
        if (local === 0) { this.constant = light; this.page = null; }
        if (light !== this.constant && !this.page) {
          this.page = new Uint8Array(SURFACE_PAGE_CELLS);
          this.page.fill(this.constant, 0, local);
        }
        if (this.page) this.page[local] = light;
        stats.surfaceOutputVisits = (stats.surfaceOutputVisits ?? 0) + 1;
        if (local === SURFACE_PAGE_CELLS - 1) this.pages.push(this.page ?? this.constant);
        if (this.cursor === this.height * 324) return true;
      }
    }
    return false;
  }

  resources() {
    const output = new Set(this.pages ?? []);
    if (this.page) output.add(this.page);
    return this.distance.byteLength + this.queue.byteLength +
      [...output].reduce((n, page) => n + (page?.byteLength ?? 0), 0);
  }
}
