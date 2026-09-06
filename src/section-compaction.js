import { MESH_PART_LIMITS } from "./mesh-partitions.js";
import { MeshBudgetError } from "./mesh-geometry.js";
import { regionalPagePlan, publishRegionalPages } from "./regional-section-pages.js";

export function hasRegionalDeadRanges(renderer) {
  for (const region of renderer.sectionRegions?.values() ?? [])
    if (region.userData.pageDescriptors.some((page) => page.retainedDeadBytes > 0)) return true;
  return false;
}

/** Private one-page replacement. Normal admission preserves page-sized
 * headroom; compaction gets exclusive staging priority between section jobs.
 */
export function stepSectionCompaction(renderer, limits, resources, deadline, maxBytes) {
  let task = renderer.sectionCompaction;
  if (task && (task.world !== renderer.world ||
      renderer.sectionRegions.get(task.region.userData.key) !== task.region ||
      task.plan.revision !== task.region.userData.pageRevision ||
      task.group.parent !== task.column)) {
    task.plan.dispose();
    renderer.sectionCompaction = task = null;
    renderer.meshStats.compactionBlocked = null;
    renderer.meshResourceRevision++;
  }
  if (!task) {
    if (renderer.sectionJobs.size) return false;
    let selected;
    for (const region of renderer.sectionRegions?.values() ?? []) {
      const page = region.userData.pageDescriptors.find((p) => p.retainedDeadBytes > 0);
      if (page) { selected = { region, page }; break; }
    }
    if (!selected) return false;
    const { region, page } = selected;
    const group = page.sources[0].parent, column = group.parent;
    const { cx, cz } = column.userData;
    const sy = group.userData.sy;
    let plan;
    try {
      plan = regionalPagePlan(renderer, cx, cz, sy, group, {
        ...MESH_PART_LIMITS, ...renderer.sectionMeshLimits,
        minSection: column.userData.requiredSections[0], compactPage: page,
      });
    } catch (error) {
      if (!(error instanceof MeshBudgetError)) throw error;
      renderer.meshStats.compactionBlocked = { reason: "compaction-part-budget" };
      return true;
    }
    renderer.sectionCompaction = task = { world: renderer.world, region, column, group, sy, plan };
  }
  const stats = resources();
  if (stats.combinedCpuBytes > limits.maxCpuBytes ||
      stats.gpuBytes + task.plan.stagingBytes > limits.maxGpuBytes ||
      stats.stagingBytes > limits.maxStagingBytes) {
    renderer.meshStats.compactionBlocked = {
      reason: "compaction-reservation", replacementBytes: task.plan.stagingBytes, ...stats,
    };
    return true;
  }
  renderer.meshStats.compactionBlocked = null;
  try {
    renderer.meshStats.lastSliceCopyBytes += task.plan.step(maxBytes, deadline);
  } catch (error) {
    task.plan.dispose();
    renderer.sectionCompaction = null;
    renderer.meshResourceRevision++;
    throw error;
  }
  if (task.plan.done) {
    try {
      if (publishRegionalPages(renderer, task.column, task.sy, task.plan)) {
        renderer.meshStats.compactions = (renderer.meshStats.compactions ?? 0) + 1;
        renderer.meshResourceRevision++;
      }
    } finally {
      task.plan.dispose();
      renderer.sectionCompaction = null;
    }
  }
  return true;
}
