import { BLOCK, BLOCKS } from "./blocks.js";
import { MESH_EMITTER_LIMIT } from "./mesh-palette.js";
import { CHUNK_SIZE } from "./terrain.js";

export const LOCAL_LIGHT_LIMITS = Object.freeze({
  refreshSeconds: 0.3,
  searchRadius: 18,
  chunkRadius: 2,
  maxSources: 2,
  maxColumns: 25,
  maxEmitters: 25 * MESH_EMITTER_LIMIT,
});

const styles = new Map();
const LEGACY_LEVELS = new Map([
  [BLOCK.TORCH, 14],
  [BLOCK.GLOW_BERRIES, 10],
  [BLOCK.SCULK, 6],
  [BLOCK.GLOWSTONE, 15],
  [BLOCK.LAVA, 15],
]);

export function localLightStyle(id) {
  if (styles.has(id)) return styles.get(id);
  const block = BLOCKS[id];
  if (!block?.emissive) return null;
  const level = Math.max(
    0,
    Math.min(15, block.lightLevel ?? LEGACY_LEVELS.get(id) ?? 12)
  );
  const style = Object.freeze({
    intensity: 8 * (level / 15) ** 2,
    distance: 4 + level * 0.4,
    color:
      id === BLOCK.TORCH
        ? "#ffd18b"
        : id === BLOCK.LAVA
          ? "#ffaf65"
          : block.color,
  });
  styles.set(id, style);
  return style;
}

function sameSource(a, b) {
  return a && b && a.id === b.id && a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Only rendered chunk buckets are consulted; never query or generate voxels. */
export function selectLocalLightSources(
  chunks,
  position,
  count,
  previous = [],
  stats = {}
) {
  Object.assign(stats, { columns: 0, emitters: 0, selected: 0 });
  const limit = Number.isFinite(count)
    ? Math.max(0, Math.min(LOCAL_LIGHT_LIMITS.maxSources, Math.floor(count)))
    : 0;
  if (
    !limit ||
    !position ||
    ![position.x, position.y, position.z].every(Number.isFinite)
  )
    return [];
  const cx = Math.floor(position.x / CHUNK_SIZE);
  const cz = Math.floor(position.z / CHUNK_SIZE);
  const selected = [];
  const retainedSources = previous.slice(0, LOCAL_LIGHT_LIMITS.maxSources);
  const radius = LOCAL_LIGHT_LIMITS.chunkRadius;
  for (let z = cz - radius; z <= cz + radius; z++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      stats.columns++;
      const group = chunks.get(`${x},${z}`);
      if (!group?.visible) continue;
      const emitters = group.userData.emitters ?? [];
      for (let i = 0; i < Math.min(emitters.length, MESH_EMITTER_LIMIT); i++) {
        stats.emitters++;
        const emitter = emitters[i];
        if (!emitter) continue;
        const distance =
          (emitter.x - position.x) ** 2 +
          (emitter.y - position.y) ** 2 +
          (emitter.z - position.z) ** 2;
        if (
          !Number.isFinite(distance) ||
          distance >= LOCAL_LIGHT_LIMITS.searchRadius ** 2 ||
          selected.some((entry) => sameSource(entry.emitter, emitter))
        )
          continue;
        const style = localLightStyle(emitter.id);
        if (!style?.intensity) continue;
        const retained = retainedSources.some((source) =>
          sameSource(source, emitter)
        );
        const score =
          (style.intensity / (1 + distance)) * (retained ? 1.15 : 1);
        let at = 0;
        while (at < selected.length && selected[at].score >= score) at++;
        if (at < limit) selected.splice(at, 0, { emitter, score });
        if (selected.length > limit) selected.pop();
      }
    }
  }
  stats.selected = selected.length;
  return selected.map(({ emitter }) => emitter);
}
