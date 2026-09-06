// Authored geometry only. This does not load, edit, or observe the native GUI.
import { BLOCK } from "../src/blocks.js";
import { sampleDaylightAt } from "../src/daylight-material.js";
import { raycast } from "../src/raycast.js";
import { UNKNOWN_SKY_HEIGHT } from "../src/sky-columns.js";
import { daylightTunnel } from "./daylight-fixture.js";
import { flushColumns } from "./light-renderer-fixture.js";

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

const haloPrepared = new WeakSet();
export function completeLightingHalo(world, positions = null, radius = 4) {
  if (!positions && haloPrepared.has(world)) return;
  haloPrepared.add(world);
  const keys = [...world.chunks.keys()];
  let top = world.spec.minY;
  for (const key of keys) {
    const blocks = world.chunks.get(key).blocks;
    for (let i = blocks.length - 1; i >= 0; i--)
      if (blocks[i] !== BLOCK.AIR) { top = Math.max(top, world.spec.minY + Math.floor(i / 256) + 1); break; }
  }
  const centers = positions ? positions.map((p) => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`) : keys;
  const halo = positions ? radius + 2 : 2;
  for (const key of centers) {
    const [cx, cz] = key.split(",").map(Number);
    for (let dz = -halo; dz <= halo; dz++) for (let dx = -halo; dx <= halo; dx++)
      if (!world.chunks.has(`${cx + dx},${cz + dz}`)) {
        // Previously missing cells were opaque boundaries, not another open
        // tunnel mouth. Make that boundary explicit below the authored roof.
        const chunk = world.admit(cx + dx, cz + dz);
        chunk.blocks.fill(BLOCK.STONE, 0, (top - world.spec.minY) * 256);
      }
  }
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
  // Native lighting now requires the source and shape halos to be loaded
  // before certifying a receiver. Keep the authored boundary columns explicit.
  completeLightingHalo(fixture.world);
  return fixture;
}

export function surfaceAccess(fixture, columns, daylight, x, forward = { x: -1, y: 0, z: 0 }) {
  const camera = fixture.position(x);
  const peak = {};
  let frames = 0;
  do {
    columns.begin(fixture.world);
    columns.updateField(camera, 4);
    flushColumns(columns);
    for (const [name, value] of Object.entries(columns.stats))
      peak[name] = Math.max(peak[name] ?? 0, value);
    if (++frames > 4096) throw new Error("Surface lighting exceeded its resumable cold-start queue");
  } while (columns.surfaceLight.pending || columns.requests.size || columns.surfaceLight.store.queue.size || columns.skyUploads.size);
  const access = daylight.sample(fixture.world, camera, forward);
  const surfaces = ENTRANCE_SURFACES.map((surface) => {
    const point = surfaceAirPoint(surface);
    const dx = Math.floor(point.x) - columns.origin.x;
    const dz = Math.floor(point.z) - columns.origin.y;
    const inside = dx >= 0 && dz >= 0 && dx < columns.size && dz < columns.size;
    const ceiling = inside ? columns.ceiling(point.x, point.z) : UNKNOWN_SKY_HEIGHT;
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
