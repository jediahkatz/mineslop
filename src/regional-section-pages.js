import * as THREE from "three";
import { SectionPagePlan, disposeSectionPage } from "./section-pages.js";

export const REGION_COLUMNS = 4;

export function sectionRegionKey(cx, cz) {
  return `${Math.floor(cx / REGION_COLUMNS)},${Math.floor(cz / REGION_COLUMNS)}`;
}

/** Count actual color-pass submissions. Three renders transparent DoubleSide
 * materials twice unless forceSinglePass is set. Shadow passes are additional
 * and reported separately by the renderer (one per active shadow camera).
 */
export function meshSubmissionCount(mesh) {
  return mesh.material.transparent && mesh.material.side === THREE.DoubleSide &&
    !mesh.material.forceSinglePass ? 2 : 1;
}

export function geometryBuffers(geometry, buffers = new Set()) {
  if (!geometry) return buffers;
  for (const a of [...Object.values(geometry.attributes), geometry.index]) {
    if (a?.array) buffers.add(a.array.buffer);
  }
  return buffers;
}

export function bufferBytes(buffers) {
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

export function sectionRegion(renderer, cx, cz) {
  renderer.sectionRegions ??= new Map();
  const key = sectionRegionKey(cx, cz);
  let region = renderer.sectionRegions.get(key);
  if (!region) {
    region = new THREE.Group();
    const [rx, rz] = key.split(",").map(Number);
    region.position.set(rx * REGION_COLUMNS * 16, 0, rz * REGION_COLUMNS * 16);
    region.userData = {
      sectionRegion: true, key, sections: new Map(), sectionRanges: new Map(),
      pageDescriptors: [], pages: [], pageRevision: 0,
    };
    renderer.sectionRegions.set(key, region);
    renderer.scene.add(region);
  }
  return region;
}

export function regionalPagePlan(renderer, cx, cz, sy, group, limits) {
  const region = sectionRegion(renderer, cx, cz);
  group.userData.pageOffset = [cx * 16 - region.position.x, cz * 16 - region.position.z];
  const plan = new SectionPagePlan(region, sy, group, {
    ...limits, canonical: true, palette: renderer.geometryPalette, sectionKey: `${cx},${cz},${sy}`,
  });
  plan.draws = plan.pages.length + plan.transparentMeshes.reduce(
    (sum, mesh) => sum + meshSubmissionCount(mesh), 0);
  return plan;
}

export function invalidateRegionalPlans(renderer, region, except) {
  let cancelled = false;
  for (const job of renderer.sectionJobs?.values() ?? []) {
    if (!job.pagePlan || job.pagePlan === except || job.pagePlan.column !== region) continue;
    job.pagePlan.dispose();
    job.pagePlan = null;
    cancelled = true;
  }
  const compaction = renderer.sectionCompaction;
  if (compaction?.region === region && compaction.plan !== except) {
    compaction.plan.dispose();
    renderer.sectionCompaction = null;
    if (renderer.meshStats) renderer.meshStats.compactionBlocked = null;
    cancelled = true;
  }
  if (cancelled) renderer.meshResourceRevision = (renderer.meshResourceRevision ?? 0) + 1;
}

/** Logical columns never own regional GPU geometries. Only this module may
 * dispose them. Publication replaces all range views before disposing old pages.
 */
export function publishRegionalPages(renderer, column, sy, plan, transaction) {
  const region = plan.column;
  if (!plan.done || region.userData.pageRevision !== plan.revision)
    return false;
  const oldPages = region.userData.pages;
  const attached = [];
  try {
    for (const page of plan.pages) {
      if (page.mesh.parent === region) continue;
      attached.push(page.mesh);
      region.add(page.mesh);
    }
  } catch (error) {
    for (const mesh of attached) if (mesh.parent === region) region.remove(mesh);
    throw error;
  }
  if (transaction && !transaction.validate()) {
    for (const mesh of attached) if (mesh.parent === region) region.remove(mesh);
    return false;
  }
  plan.bindCanonicalRanges();
  region.userData.sections.set(plan.sectionKey, { group: plan.group });
  region.visible = column.visible ||
    [...region.userData.sections.values()].some(({ group }) => group.parent?.visible);
  Object.assign(region.userData, {
    pages: plan.pages.map((page) => page.mesh), pageDescriptors: plan.pages,
    sectionRanges: plan.ranges, pageRevision: plan.revision + 1,
  });
  for (const section of region.userData.sections.values()) {
    const owner = section.group === plan.group ? column : section.group.parent;
    if (!owner) continue;
    owner.userData.sectionRanges = plan.ranges;
    owner.userData.sectionRegion = region;
    // Compatibility/introspection only; meshes are attached to region, never
    // added to this array's logical column (which would reparent shared pages).
    owner.userData.pages = region.userData.pages;
  }
  plan.transferred = true;
  invalidateRegionalPlans(renderer, region, plan);
  for (const mesh of oldPages) {
    if (region.userData.pages.includes(mesh)) continue;
    const retire = () => { region.remove(mesh); disposeSectionPage(mesh.geometry); };
    if (transaction) transaction.deferRetire(retire); else retire();
  }
  return true;
}

/** Unload without a synchronous regional copy or killing neighbours. Removed
 * index ranges become degenerate triangles in-place; surviving indices and
 * attribute views stay valid. Retained dead bytes remain counted, then the next
 * affected-band publication compacts them. Empty pages/regions free immediately.
 */
export function releaseRegionalColumn(renderer, key) {
  const column = renderer.chunks.get(key);
  const region = column?.userData.sectionRegion;
  if (!region) return;
  invalidateRegionalPlans(renderer, region);
  for (const [sectionKey, section] of region.userData.sections) {
    if (section.group.parent !== column) continue;
    region.userData.sections.delete(sectionKey);
    for (const source of section.group.children) {
      const range = region.userData.sectionRanges.get(source);
      if (!range) continue;
      const index = range.mesh.geometry.index;
      index.array.fill(0, range.start, range.start + range.count);
      index.addUpdateRange(range.start, range.count);
      index.needsUpdate = true;
      region.userData.sectionRanges.delete(source);
    }
  }
  for (const page of region.userData.pageDescriptors) {
    const vertexBytes = Object.values(page.mesh.geometry.attributes).reduce(
      (sum, a) => sum + a.itemSize * a.array.BYTES_PER_ELEMENT, 0);
    page.retainedDeadBytes = (page.retainedDeadBytes ?? 0) + page.sources.reduce((sum, mesh) =>
      sum + (mesh.parent?.parent === column
        ? mesh.geometry.attributes.position.count * vertexBytes +
          mesh.geometry.index.count * page.mesh.geometry.index.array.BYTES_PER_ELEMENT : 0), 0);
    page.sources = page.sources.filter((mesh) => mesh.parent?.parent !== column && !mesh.userData.waterRetired);
    if (page.sources.length) continue;
    region.remove(page.mesh);
    disposeSectionPage(page.mesh.geometry);
  }
  region.userData.pageDescriptors = region.userData.pageDescriptors.filter((p) => p.sources.length);
  region.userData.pages = region.userData.pageDescriptors.map((p) => p.mesh);
  for (const section of region.userData.sections.values())
    if (section.group.parent) section.group.parent.userData.pages = region.userData.pages;
  column.userData.pages = [];
  column.userData.sectionRegion = null;
  region.userData.pageRevision++;
  if (!region.userData.sections.size) {
    renderer.scene.remove(region);
    renderer.sectionRegions.delete(region.userData.key);
  }
  renderer.meshResourceRevision = (renderer.meshResourceRevision ?? 0) + 1;
}

export function pruneEmptySectionRegions(renderer) {
  const pending = new Set([...(renderer.sectionJobs?.values() ?? [])]
    .map((job) => job.pagePlan?.column));
  for (const [key, region] of renderer.sectionRegions ?? []) {
    // Logical detach precedes metered page disposal. Keep its accounting root
    // and retirement identity until the final owner-release operation.
    if (region.userData.sections.size || region.userData.pages.length ||
        region.userData.waterRetirement || pending.has(region)) continue;
    renderer.scene.remove(region);
    renderer.sectionRegions.delete(key);
  }
}
