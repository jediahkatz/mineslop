import * as THREE from "three";
import { BLOCK, BLOCKS } from "./blocks.js";
import { geometryEpoch, geometryWorldSpec } from "./geometry-world.js";

export const DISTANT_LANDMARK_LIMITS = Object.freeze({
  pillars: 10, columnsPerUpdate: 4, vertices: 200000, indices: 300000,
});
const faces = [
  [[-1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[1, 0, 0], [1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, -1, 0], [0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, -1], [1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  [[0, 0, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
];
const data = () => ({
  positions: [], normals: [], colors: [], indices: [], parts: [],
  bounds: new THREE.Box3(),
});
const tint = (id) => new THREE.Color(BLOCKS[id].color).toArray();
const colors = new Map();

export function pillarFootprint(pillar) {
  if (!pillar.body) return Array.from({ length: 25 }, (_, i) => [i % 5 - 2, Math.floor(i / 5) - 2])
    .filter(([dx, dz]) => dx * dx + dz * dz <= 5);
  const { columns, columnMask, minY, maxY, blockCount } = pillar.body;
  if (!Array.isArray(columns) || columns.length > 25 ||
      !Number.isSafeInteger(minY) || !Number.isSafeInteger(maxY) || minY >= maxY)
    throw new RangeError("Invalid native pillar body");
  let mask = 0;
  for (const [dx, dz] of columns) {
    if (![dx, dz].every((v) => Number.isInteger(v) && Math.abs(v) <= 2))
      throw new RangeError("Invalid native pillar footprint");
    const bit = 1 << ((dz + 2) * 5 + dx + 2);
    if (mask & bit) throw new RangeError("Duplicate native pillar column");
    mask |= bit;
  }
  if (mask !== columnMask || blockCount !== columns.length * (maxY - minY))
    throw new RangeError("Inconsistent native pillar mask or block count");
  return columns;
}

// Renderer integration passes this separately from whole-column coverage.
// Completed empty sections own their volume too; pending sections do not.
export function landmarkDetailSections(chunks) {
  const result = new Set();
  for (const [key, column] of chunks) {
    if (!column.visible || !column.parent) continue;
    for (const [sy, section] of column.userData.sections ?? []) {
      const group = section.group;
      if (!group?.visible || group.parent !== column ||
          group.children.length !== section.draws) continue;
      if (group.children.every((child) => {
        const count = child.geometry?.index?.count ??
          child.geometry?.getAttribute("position")?.count ?? 0;
        return child.isMesh && child.visible && child.material.visible !== false &&
          child.geometry.drawRange.count > 0 && child.geometry.drawRange.start < count;
      }))
        result.add(`${key},${sy}`);
    }
  }
  return result;
}

function box(target, pillar, x, low, z, high, block) {
  if (!colors.has(block)) colors.set(block, tint(block));
  const color = colors.get(block);
  target.bounds.expandByPoint(new THREE.Vector3(x, low, z));
  target.bounds.expandByPoint(new THREE.Vector3(x + 1, high, z + 1));
  const start = target.indices.length;
  for (const [normal, ...corners] of faces) {
    const first = target.positions.length / 3;
    for (const [dx, dy, dz] of corners) {
      target.positions.push(x + dx, low + dy * (high - low), z + dz);
      target.normals.push(...normal);
      target.colors.push(...color);
    }
    target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  if (target.positions.length / 3 > DISTANT_LANDMARK_LIMITS.vertices ||
      target.indices.length > DISTANT_LANDMARK_LIMITS.indices)
    throw new RangeError("Native landmark geometry exceeds fixed limits");
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), sy = Math.floor(low / 16);
  target.parts.push({
    pillar, x, z, low, high, nativeId: block,
    column: `${cx},${cz}`, section: `${cx},${cz},${sy}`, start, count: target.indices.length - start,
  });
}

function* mesh(source, material, geometries) {
  const geometry = new THREE.BufferGeometry();
  geometries.push(geometry);
  for (const [name, values] of [
    ["position", source.positions], ["normal", source.normals], ["color", source.colors],
  ]) {
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, 3));
    yield;
  }
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(source.indices.length), 1));
  yield;
  const indices = new Uint32Array(source.indices);
  yield;
  geometry.boundingBox = source.bounds.isEmpty()
    ? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()) : source.bounds;
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  const result = new THREE.Mesh(geometry, material);
  result.userData.landmarkSource = { parts: source.parts, indices };
  return result;
}

function* finalize(job, material, capMaterial) {
  const body = yield* mesh(job.body, material, job.geometries);
  const caps = yield* mesh(job.caps, capMaterial, job.geometries);
  return [body, caps];
}

/** No world.get/ensureArea/generateChunk calls. Known edits survive eviction. */
export class DistantLandmarks {
  constructor(parent, world, material = null) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = "Distant End landmarks";
    parent.add(this.group);
    this.ownsMaterial = !material;
    this.material = material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
    this.capMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.identity = null;
    this.job = null;
    this.viewKey = null;
    this.lastColumns = 0;
  }

  clear() {
    this.cancelJob();
    this.editState = null;
    this.pendingRebuild = false;
    for (const child of [...this.group.children]) {
      child.geometry.dispose();
      child.removeFromParent();
    }
    this.viewKey = null;
    this.group.userData.renderablePillars = 0;
  }

  cancelJob() {
    this.job?.finalizer?.return();
    for (const geometry of this.job?.geometries ?? []) geometry.dispose();
    this.job = null;
  }

  sourceCurrent(identity) {
    const world = this.world;
    const spec = geometryWorldSpec(world);
    return identity && identity.generator === world.generator &&
      identity.api === world.generator?.getEndPillars &&
      identity.heightSource === world.generator?.terrainHeight &&
      identity.epoch === geometryEpoch(world) && identity.seed === world.seed &&
      identity.version === world.generatorVersion &&
      identity.minY === spec.minY && identity.maxY === spec.maxY;
  }

  current(identity) {
    return this.sourceCurrent(identity) && identity.edits === this.world.edits &&
      identity.editRevision === this.world._editRevision && identity.editCount === this.world.edits?.size;
  }

  editsChanged() {
    let changed = false;
    for (const record of this.editState) {
      const id = this.world.edits?.get(record[0])?.id ?? record[1];
      if (id !== record[2]) changed = true;
      record[2] = id;
    }
    return changed;
  }

  suppressEditedParts() {
    for (const child of this.group.children)
      for (const part of child.userData.landmarkSource.parts) {
        part.invalid = false;
        for (let y = part.low; y < part.high; y++)
          if ((this.world.edits?.get(`end:${part.x},${y},${part.z}`)?.id ?? part.nativeId) !== part.nativeId) {
            part.invalid = true;
            break;
          }
      }
    this.viewKey = null;
  }

  update({ coverage = new Set(), detailSections = new Set(), budgetMs = 1 } = {}) {
    if (this.disposed) return;
    this.lastColumns = 0;
    if (this.world.dimension !== "end" || typeof this.world.generator?.getEndPillars !== "function") {
      this.clear();
      this.identity = null;
      return;
    }
    if (!this.current(this.identity)) {
      const retain = this.sourceCurrent(this.identity) && this.editState;
      if (!retain || this.editsChanged()) {
        if (retain) {
          this.cancelJob();
          this.suppressEditedParts();
        } else this.clear();
        this.pendingRebuild = true;
      }
      const world = this.world;
      const spec = geometryWorldSpec(world);
      this.identity = {
        generator: world.generator, api: world.generator.getEndPillars,
        heightSource: world.generator.terrainHeight,
        epoch: geometryEpoch(world), seed: world.seed, version: world.generatorVersion,
        edits: world.edits, editRevision: world._editRevision, editCount: world.edits?.size,
        minY: spec.minY, maxY: spec.maxY,
      };
    }
    const started = performance.now();
    if (!this.job && (this.pendingRebuild || !this.group.children.length) && budgetMs > 0) {
      const pillars = this.identity.api.call(this.identity.generator);
      if (pillars.length > DISTANT_LANDMARK_LIMITS.pillars)
        throw new RangeError("Too many native End pillars");
      const columns = [];
      for (const pillar of pillars) {
        const footprint = pillarFootprint(pillar);
        for (const [dx, dz] of footprint)
          columns.push({ pillar, x: pillar.x + dx, z: pillar.z + dz, body: true });
        if (pillar.cap && !footprint.some(([dx, dz]) =>
          pillar.x + dx === pillar.cap.x && pillar.z + dz === pillar.cap.z))
          columns.push({ pillar, x: pillar.cap.x, z: pillar.cap.z, body: false });
      }
      this.job = { columns, cursor: 0, body: data(), caps: data(), geometries: [], editState: [] };
      this.pendingRebuild = false;
    }
    while (this.job && this.lastColumns < DISTANT_LANDMARK_LIMITS.columnsPerUpdate &&
           performance.now() - started < Math.max(0, Math.min(2, budgetMs))) {
      if (this.job.cursor === this.job.columns.length) {
        // Convert at most one bounded attribute per update. Both meshes remain
        // detached until all buffers are ready; coverage still updates atomically.
        this.job.finalizer ??= finalize(this.job, this.material, this.capMaterial);
        const next = this.job.finalizer.next();
        if (next.done) {
          for (const child of [...this.group.children]) {
            child.geometry.dispose();
            child.removeFromParent();
          }
          this.group.add(...next.value);
          this.editState = this.job.editState;
          this.job = null;
          this.viewKey = null;
        }
        break;
      }
      this.column(this.job.columns[this.job.cursor++]);
      this.lastColumns++;
    }
    const key = [...coverage].sort().join(";") + "/" + [...detailSections].sort().join(";");
    if (this.group.children.length && key !== this.viewKey) {
      const visible = new Set();
      for (const child of this.group.children) {
        let count = 0;
        const source = child.userData.landmarkSource;
        for (const part of source.parts) {
          if (part.invalid || coverage.has(part.column) || detailSections.has(part.section)) continue;
          child.geometry.index.array.set(source.indices.subarray(part.start, part.start + part.count), count);
          count += part.count;
          visible.add(part.pillar);
        }
        child.geometry.setDrawRange(0, count);
        child.geometry.index.needsUpdate = true;
        child.visible = count > 0;
      }
      this.group.userData.renderablePillars = visible.size;
      this.viewKey = key;
    }
  }

  column({ pillar, x, z, body = true }) {
    // Expanded descriptors are authoritative; never re-derive their foundation
    // or mask from a legacy radius or a sampled height.
    const nativeTop = pillar.body ? null : this.identity.generator.terrainHeight(x, z);
    const block = pillar.body?.block ?? BLOCK.OBSIDIAN;
    const low = Math.max(this.identity.minY, pillar.body?.minY ?? Math.max(1, pillar.base, nativeTop + 1));
    const high = body ? Math.min(this.identity.maxY, pillar.body?.maxY ?? pillar.top + 1) : low;
    let run = null;
    for (let y = low; y <= high; y++) {
      const key = `end:${x},${y},${z}`;
      const edit = this.world.edits?.get(key);
      if (y < high) this.job.editState.push([key, block, edit?.id ?? block]);
      const solid = y < high && (!edit || edit.id === block);
      if (run !== null && (!solid || y % 16 === 0)) {
        box(this.job.body, pillar.id, x, run, z, y, block);
        run = null;
      }
      if (solid && run === null) run = y;
    }
    const cap = pillar.cap ?? { x: pillar.x, z: pillar.z, y: pillar.top + 1, block: BLOCK.GLOWSTONE };
    const edit = this.world.edits?.get(`end:${x},${cap.y},${z}`);
    if (x === cap.x && z === cap.z && cap.y >= this.identity.minY &&
        cap.y < this.identity.maxY && (pillar.body || cap.y > nativeTop)) {
      this.job.editState.push([`end:${x},${cap.y},${z}`, cap.block, edit?.id ?? cap.block]);
      if (!edit || edit.id === cap.block)
        box(this.job.caps, pillar.id, x, cap.y, z, cap.y + 1, cap.block);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    if (this.ownsMaterial) this.material.dispose();
    this.capMaterial.dispose();
    this.group.removeFromParent();
  }
}
