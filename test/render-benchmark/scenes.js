export const SCENES = Object.freeze({
  classic: { seed: "cedar-valley", version: 3 },
  expanded: { seed: "cedar-valley", version: 7 },
  // Historical misqualified capture identity: retain it, never relabel as river.
  river: { seed: "birch-river", version: 3, qualification: "historical-dense-only-water-absent" },
  "dense-river-v1": {
    seed: "cedar-valley", version: 3,
    spawnOrigin: { x: 358.5, y: 34.01, z: -850.5 },
    yaw: -Math.PI / 2, pitch: -0.3,
    region: { minDepth: 2, maxDistance: 48, minWater: 32, minFoliage: 128, minColumns: 2 },
  },
});

export function captureConfiguration(capture = "performance", configuration = "default") {
  if (!["performance", "correctness"].includes(capture)) throw new Error("Unknown capture mode");
  if (!["default", "page-local-candidate"].includes(configuration)) throw new Error("Unknown candidate configuration");
  return { capture, configuration, heavyCensus: capture === "correctness",
    experimentalPageLocalUpdates: configuration === "page-local-candidate" };
}

export function cameraRegionGate(profile, limits) {
  if (!profile || !limits) return false;
  return profile.water.cameraSurfaceCells >= limits.minWater &&
    profile.foliage.cameraSurfaceCells >= limits.minFoliage &&
    profile.water.columns >= limits.minColumns && profile.foliage.columns >= limits.minColumns &&
    profile.water.lineOfSightWitnesses.length > 0 && profile.foliage.lineOfSightWitnesses.length > 0;
}
