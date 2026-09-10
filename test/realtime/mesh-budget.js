import { renderDistanceLayout, streamingDistanceLayout } from "../../src/render-distance.js";

/** Count cached buffers separately from attached, visible and drawable chunks. */
export function chunkMeshCounts(graphics) {
  let visibleChunkMeshes = 0;
  let drawnChunkMeshes = 0;
  for (const group of graphics.chunks.values()) {
    if (!group.visible || group.parent !== graphics.scene) continue;
    visibleChunkMeshes++;
    let draws = false;
    group.traverseVisible((mesh) => {
      if (!mesh.isMesh || mesh.material.visible === false) return;
      const geometry = mesh.geometry;
      const count =
        geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
      if (geometry.drawRange.count > 0 && geometry.drawRange.start < count)
        draws = true;
    });
    drawnChunkMeshes += Number(draws);
  }
  return {
    retainedChunkMeshes: graphics.chunks.size,
    visibleChunkMeshes,
    drawnChunkMeshes,
  };
}

export function streamingWithinBudget(maxima, radius) {
  let detail, streaming;
  try {
    detail = renderDistanceLayout(radius);
    streaming = streamingDistanceLayout(radius);
  } catch {
    return false;
  }
  const counts = [
    maxima.cachedChunks,
    maxima.requestedChunks,
    maxima.inFlightChunks,
    maxima.retainedChunkMeshes,
    maxima.visibleChunkMeshes,
    maxima.drawnChunkMeshes,
  ];
  return (
    counts.every((value) => Number.isInteger(value) && value >= 0) &&
    maxima.cachedChunks <= streaming.retainedChunks &&
    // Logical requests include the R+2 source/shape halo, just like residency.
    // Physical worker slots remain a separate two-job ceiling.
    maxima.requestedChunks <= streaming.demandChunks &&
    maxima.inFlightChunks <= 2 &&
    maxima.retainedChunkMeshes <= detail.sourceChunks &&
    maxima.visibleChunkMeshes <= detail.visibleChunks &&
    maxima.drawnChunkMeshes <= maxima.visibleChunkMeshes
  );
}
