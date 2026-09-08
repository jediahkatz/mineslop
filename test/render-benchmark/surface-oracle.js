import * as THREE from "three";
import { BLOCK } from "../../src/blocks.js";
import { raycast } from "../../src/raycast.js";
import { intersectPhysicalLightMeshes } from "../lighting-physical-geometry.js";
import { visibilityAt } from "./oracles.js";
import { distantDetailBatches } from "../../src/distant-detail-mask.js";
import { sectionGeometryCovered } from "../../src/section-pages.js";

const cubes = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.GRASS, BLOCK.SAND, BLOCK.GRAVEL,
  BLOCK.SNOW, BLOCK.SNOW_BLOCK, BLOCK.PODZOL]);

export function classifySurface({ expectedDistance, nativeDistances, fallbackDistances, transmission, known }) {
  if (!known) return "unknown-residency";
  if (!Number.isFinite(expectedDistance)) return "no-native-expectation";
  if (!Number.isFinite(transmission) || transmission < 0.02) return "fog-hidden";
  const near = nativeDistances.filter(d => Math.abs(d - expectedDistance) < 0.035);
  const far = fallbackDistances.filter(d => Math.abs(d - expectedDistance) < 0.035);
  if (near.length && far.length) return "duplicate-ownership";
  if (near.length) return "native-match";
  // A coarse fallback can legitimately differ from the native voxel surface.
  if (fallbackDistances.length) return "fallback-approximation";
  if (nativeDistances.some(d => d < expectedDistance)) return "physical-occlusion";
  return "missing-surface";
}

export function surfaceCensus(g) {
  const r = g.graphics, camera = r.camera, result = [];
  camera.updateMatrixWorld(true);
  for (const x of [-0.6, 0, 0.6]) for (const y of [-0.6, -0.3, 0]) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), camera); ray.far = 48;
    const expected = raycast(g.world, ray.ray.origin, ray.ray.direction, 48, { channel: "occlusion" });
    if (!expected || !cubes.has(expected.id)) {
      result.push({ screen: [x, y], status: "no-opaque-cube-expectation" }); continue;
    }
    let known = true;
    const unknownRayColumns = new Set();
    // Include the full ray apron; missing inputs do not establish clear sight.
    for (let d = 0; d < expected.distance; d += 0.5) {
      const p = ray.ray.at(d, new THREE.Vector3());
      for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1])
        if (!g.world.isLoaded(p.x + dx, p.z + dz)) {
          known = false;
          unknownRayColumns.add(`${Math.floor((p.x + dx) / 16)},${Math.floor((p.z + dz) / 16)}`);
        }
    }
    const native = intersectPhysicalLightMeshes(r, ray);
    const allFallback = intersectPhysicalLightMeshes(r, ray, camera, [r.distant.group]);
    const masked = h => {
      const a = h.object.geometry.attributes.lodDetailBatch;
      const batch = a ? Math.round(a.getX(h.face.a)) : h.object.material === r.distant._waterMaterial ? 3 : 0;
      return r.distant.detailMask.owns(h.point,
        h.face.normal.clone().transformDirection(h.object.matrixWorld), batch);
    };
    const fallback = allFallback.filter(h => !masked(h));
    const point = new THREE.Vector3(expected.point.x, expected.point.y, expected.point.z);
    const depth = -point.applyMatrix4(camera.matrixWorldInverse).z;
    const transmission = visibilityAt(r.scene.fog.near, r.scene.fog.far, depth);
    const status = classifySurface({
      expectedDistance: expected.distance, nativeDistances: native.map(h => h.distance),
      fallbackDistances: fallback.map(h => h.distance), transmission, known,
    });
    const row = { screen: [x, y], status, expectedDistance: expected.distance, transmission,
      expectedPoint: { ...expected.point }, block: [expected.x, expected.y, expected.z], blockId: expected.id,
      expectedNormal: { ...expected.normal },
      nativeDistance: native[0]?.distance ?? null, fallbackDistance: fallback[0]?.distance ?? null };
    if (["missing-surface", "duplicate-ownership", "physical-occlusion"].includes(status)) {
      const key = `${Math.floor(expected.x / 16)},${Math.floor(expected.z / 16)}`, sy = Math.floor(expected.y / 16);
      const column = r.chunks.get(key), section = column?.userData.sections?.get(sy), stamp = section?.stamp;
      const mask = r.distant.detailMask;
      const describe = (h, lod = false) => ({
        point: h.point.toArray(), distance: h.distance, faceIndex: h.faceIndex,
        mesh: h.object.uuid, geometry: h.object.geometry.uuid, batch: h.object.userData.batch ?? null,
        layers: h.object.layers.mask, drawRange: { start: h.object.geometry.drawRange.start,
          count: Number.isFinite(h.object.geometry.drawRange.count) ? h.object.geometry.drawRange.count : "unbounded-range",
          available: h.object.geometry.index?.count ?? h.object.geometry.attributes.position.count },
        matrixWorld: h.object.matrixWorld.toArray(), masked: lod ? masked(h) : false,
      });
      row.witness = {
        camera: { position: camera.position.toArray(), matrixWorld: camera.matrixWorld.toArray(),
          projectionMatrix: camera.projectionMatrix.toArray(), layers: camera.layers.mask },
        ray: { origin: ray.ray.origin.toArray(), direction: ray.ray.direction.toArray(), far: ray.far },
        sectionKey: `${key},${sy}`, columnMounted: column?.parent === r.scene, columnVisible: column?.visible ?? null,
        sectionCovered: !!section && sectionGeometryCovered(column, section, camera),
        sectionBytes: section?.bytes ?? null, dirtyTicket: g.world.dirtySectionRevisions.get(`${key},${sy}`) ?? null,
        publication: stamp ? { ticket: stamp.ticket ?? null, epoch: stamp.epoch, dimension: stamp.dimension,
          neighbors: stamp.neighbors.map(n => ({ key: n.key, incarnation: n.incarnation, revision: n.revision,
            sections: n.sections, currentIncarnation: g.world.chunks.get(n.key)?.incarnation ?? null,
            currentRevision: g.world.chunks.get(n.key)?.revision ?? null })) } : null,
        ownership: {
          physicalBatchBits: distantDetailBatches(r.chunks, camera).get(`${key},${sy}`) ?? 0,
          maskAtExpectedFace: [0, 1, 2, 3].map(batch => mask.owns(new THREE.Vector3(expected.point.x, expected.point.y, expected.point.z),
            new THREE.Vector3(expected.normal.x, expected.normal.y, expected.normal.z), batch)),
          maskOrigin: mask.origin.value.toArray(), maskSize: mask.size.value.toArray(), maskVersion: mask.version,
          lodUnknownAtColumn: r.distant._active?.data.unknownChunks?.has(key) ?? null,
          lodUnknownColumns: r.distant._active?.data.unknownChunks?.size ?? null,
          unknownRayColumns: [...unknownRayColumns],
        },
        nativeHits: native.slice(0, 8).map(h => describe(h)),
        lodHitsIncludingMasked: allFallback.slice(0, 8).map(h => describe(h, true)),
      };
    }
    result.push(row);
  }
  return result;
}
