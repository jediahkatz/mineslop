// Authored geometry only. This does not load, edit, or observe the native GUI.
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { raycast } from "../src/raycast.js";
import { UNKNOWN_SKY_HEIGHT } from "../src/sky-columns.js";
import { daylightTunnel } from "./daylight-fixture.js";

export const ENTRANCE_SURFACES = [
  { name: "roof", point: { x: 2.53125, y: 11, z: 2.53125 }, normal: { x: 0, y: -1, z: 0 } },
  { name: "roof-edge", point: { x: 5.53125, y: 11, z: 1.21875 }, normal: { x: 0, y: -1, z: 0 } },
  { name: "wall", point: { x: 3.53125, y: 9.53125, z: 1 }, normal: { x: 0, y: 0, z: 1 } },
];

export function surfaceAirPoint({ point, normal }) {
  return {
    x: point.x + normal.x * 0.02,
    y: point.y + normal.y * 0.02,
    z: point.z + normal.z * 0.02,
  };
}

export function surfaceTunnel(fullDepth = false) {
  const fixture = daylightTunnel();
  fixture.world.admit(-2, 0);
  for (let x = -32; x < -8; x++)
    for (let z = 0; z <= 4; z++)
      fixture.world.put(x, 7, z, BLOCK.STONE);
  if (fullDepth) {
    fixture.world.admit(3, 0);
    fixture.world.admit(4, 0);
    for (let x = 48; x < 80; x++)
      for (let z = 0; z <= 4; z++) {
        fixture.world.put(x, 7, z, BLOCK.STONE);
        fixture.world.put(x, 11, z, BLOCK.STONE);
        if (z === 0 || z === 4)
          for (let y = 8; y < 11; y++) fixture.world.put(x, y, z, BLOCK.STONE);
      }
  }
  return fixture;
}

export function surfaceAccess(fixture, columns, daylight, x, forward = { x: -1, y: 0, z: 0 }) {
  const camera = fixture.position(x);
  const peak = {};
  let frames = 0;
  do {
    columns.begin(fixture.world);
    columns.updateField(camera, 4);
    for (const [name, value] of Object.entries(columns.stats))
      peak[name] = Math.max(peak[name] ?? 0, value);
    if (++frames > 81) throw new Error("Surface lighting exceeded its bounded cold-start queue");
  } while (columns.surfaceLight.pending);
  const access = daylight.sample(fixture.world, camera, forward);
  const surfaces = ENTRANCE_SURFACES.map((surface) => {
    const point = surfaceAirPoint(surface);
    const dx = Math.floor(point.x) - columns.origin.x;
    const dz = Math.floor(point.z) - columns.origin.y;
    const inside = dx >= 0 && dz >= 0 && dx < columns.size && dz < columns.size;
    const ceiling = inside ? columns.data[dz * columns.size + dx] : UNKNOWN_SKY_HEIGHT;
    const direction = {
      x: surface.point.x - camera.x,
      y: surface.point.y - camera.y,
      z: surface.point.z - camera.z,
    };
    const hit = raycast(fixture.world, camera, direction, Math.hypot(direction.x, direction.y, direction.z) + 0.01, { channel: "occlusion" });
    return {
      name: surface.name,
      known: ceiling !== undefined && ceiling !== UNKNOWN_SKY_HEIGHT,
      visible: !!hit && Math.hypot(hit.point.x - surface.point.x, hit.point.y - surface.point.y, hit.point.z - surface.point.z) < 0.0001,
      ceiling,
      mask: sampleDaylightAt(columns, point),
      hit: hit ? { block: [hit.x, hit.y, hit.z], point: hit.point, normal: hit.normal } : null,
    };
  });
  return {
    camera: camera.toArray(),
    access: { ...access },
    anchors: daylight.anchors.map((point) => ({ ...point })),
    surfaces,
    work: {
      ...columns.stats, rays: access.rays, cache: columns.cache.size, bytes: columns.data.byteLength,
      frames, peak, surface: columns.surfaceLight.resources(),
    },
  };
}
