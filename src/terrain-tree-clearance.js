import { CAVE_CELL_SIZE } from "./terrain-caves.js";
import { writeTree } from "./terrain-trees.js";

// Native decoration skips reserved mouth air. Reject the entire tree before
// publishing either representation, so a bank-rooted branch is not severed in
// the voxels while its complete canopy still appears in distant scenery.
export function treeClearsCaves(tree, column, getFeatures) {
  const { bounds } = tree;
  const features = [];
  for (
    let gz = Math.floor(bounds.minZ / CAVE_CELL_SIZE);
    gz <= Math.floor((bounds.maxZ - 1) / CAVE_CELL_SIZE);
    gz++
  )
    for (
      let gx = Math.floor(bounds.minX / CAVE_CELL_SIZE);
      gx <= Math.floor((bounds.maxX - 1) / CAVE_CELL_SIZE);
      gx++
    )
      for (const feature of getFeatures(gx, gz)) {
        const area = feature.bounds;
        if (
          bounds.maxX > area.minX &&
          bounds.minX <= area.maxX &&
          bounds.maxZ > area.minZ &&
          bounds.minZ <= area.maxZ &&
          (feature.kind === "ravine" ||
            bounds.minY <= Math.max(feature.mouth.y + 5, feature.chamber.high))
        )
          features.push(feature);
      }
  if (!features.length) return true;
  const columns = new Map();
  let clear = true;
  writeTree(tree, (x, y, z) => {
    if (
      !clear ||
      !features.some(
        ({ bounds: area }) =>
          x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ
      )
    )
      return;
    const key = `${x},${z}`;
    if (!columns.has(key)) columns.set(key, column(x, z));
    const col = columns.get(key);
    if (col.caveMouth && y >= col.entrance.low && y <= col.entrance.high)
      clear = false;
  });
  return clear;
}
