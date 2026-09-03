import { getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { hash, noise } from "./noise.js";
import { remember, V4_LIMITS } from "./terrain-v4-config.js";
import { V4_CORAL_FAMILIES } from "./terrain-v4-content.js";
import { forEachV4Owner } from "./terrain-v4-writer.js";

export const V4_MARINE_SPACING = 32;
export const V4_MARINE_REACH = 12;
const SEA = 63;
const EMPTY = Object.freeze([]);

export const isV4ReefColumn = (col) =>
  col?.id === "warm_ocean" &&
  col.temperature >= 0.8 &&
  col.depth >= 4 &&
  col.depth <= 42;

export function createV4Marine({ salt, sampleColumn, counters }) {
  const cache = new Map();

  function getFeatures(gx, gz) {
    if (!Number.isSafeInteger(gx) || !Number.isSafeInteger(gz)) return EMPTY;
    const key = `${gx},${gz}`;
    if (cache.has(key)) return cache.get(key);
    counters.marineCells++;
    const x =
      gx * V4_MARINE_SPACING + 8 + Math.floor(hash(gx, gz, salt ^ 34613) * 16);
    const z =
      gz * V4_MARINE_SPACING + 8 + Math.floor(hash(gx, gz, salt ^ 49529) * 16);
    const col = sampleColumn(x, z);
    const chance = hash(gx, gz, salt ^ 55903);
    const features = [];
    if (
      isV4ReefColumn(col) &&
      noise(x / 119, z / 119, salt ^ 51031) > 0.42 &&
      chance < 0.78
    ) {
      const rotation = hash(gx, gz, salt ^ 15541) * Math.PI * 2;
      const colonies = [];
      // A reef is a patch of several neighboring colonies, not isolated pink
      // voxels. Family, footprint, height and spacing have independent channels.
      for (let i = 0; i < V4_CORAL_FAMILIES.length; i++) {
        const channel = salt ^ Math.imul(i + 1, 27457);
        const angle =
          rotation +
          (i * Math.PI * 2) / 5 +
          (hash(gx, gz, channel) - 0.5) * 0.5;
        const distance = 3 + hash(gx, gz, channel ^ 1553) * 4;
        const px = x + Math.round(Math.cos(angle) * distance);
        const pz = z + Math.round(Math.sin(angle) * distance);
        const root = sampleColumn(px, pz);
        if (!isV4ReefColumn(root) || Math.abs(root.top - col.top) > 8) continue;
        colonies.push(
          Object.freeze({
            x: px,
            z: pz,
            family: V4_CORAL_FAMILIES[(i + Math.floor(chance * 5)) % 5],
            radiusX: 1.6 + hash(gx, gz, channel ^ 5021) * 1.4,
            radiusZ: 1.5 + hash(gx, gz, channel ^ 6883) * 1.5,
            height: 2 + Math.floor(hash(gx, gz, channel ^ 10331) * 5),
          })
        );
      }
      if (colonies.length)
        features.push(
          Object.freeze({
            kind: "reef",
            x,
            z,
            colonies: Object.freeze(colonies),
            bounds: Object.freeze({
              minX: x - 10,
              minZ: z - 10,
              maxX: x + 11,
              maxZ: z + 11,
            }),
          })
        );
    } else if (
      col?.frozen &&
      getBiomeById(col.id).category === "ocean" &&
      col.depth > 6 &&
      chance < 0.34 &&
      noise(x / 139, z / 139, salt ^ 51913) > 0.35
    ) {
      features.push(
        Object.freeze({
          kind: "iceberg",
          x,
          z,
          radiusX: 4 + hash(gx, gz, salt ^ 16057) * 5,
          radiusZ: 3 + hash(gx, gz, salt ^ 45053) * 5,
          height: 7 + Math.floor(hash(gx, gz, salt ^ 63149) * 17),
          keel: 11 + Math.floor(hash(gx, gz, salt ^ 22943) * 19),
          tilt: hash(gx, gz, salt ^ 54403) * 3 - 1.5,
          bounds: Object.freeze({
            minX: x - 9,
            minZ: z - 8,
            maxX: x + 10,
            maxZ: z + 9,
          }),
        })
      );
    }
    return remember(cache, key, Object.freeze(features), V4_LIMITS.marine);
  }

  function reef(feature, put) {
    for (const colony of feature.colonies) {
      const block = B[`${colony.family}_CORAL_BLOCK`];
      const fan = B[`${colony.family}_CORAL_FAN`];
      const coral = B[`${colony.family}_CORAL`];
      const rx = Math.ceil(colony.radiusX);
      const rz = Math.ceil(colony.radiusZ);
      for (let dz = -rz; dz <= rz; dz++)
        for (let dx = -rx; dx <= rx; dx++) {
          const distance =
            (dx * dx) / colony.radiusX ** 2 + (dz * dz) / colony.radiusZ ** 2;
          if (distance > 1) continue;
          const x = colony.x + dx;
          const z = colony.z + dz;
          const col = sampleColumn(x, z);
          // Per-voxel-column climate gating prevents a cross-border feature
          // from growing live coral in an adjacent cold or fresh-water biome.
          if (!isV4ReefColumn(col)) continue;
          const variation = hash(x, z, salt ^ 26513);
          const height = Math.max(
            1,
            Math.floor(
              colony.height * (0.45 + Math.sqrt(1 - distance) * 0.65) +
                variation
            )
          );
          const top = Math.min(SEA - 2, col.top + height);
          for (let y = col.top + 1; y <= top; y++)
            put(x, y, z, block, { mode: "water" });
          const accent = hash(x, z, salt ^ 49783);
          const core = dx === 0 && dz === 0;
          const ledge = dx === 1 && dz === 0;
          if (top >= col.top + 1 && (core || ledge || accent < 0.78))
            put(
              x,
              top + 1,
              z,
              core ? coral : ledge || accent < 0.5 ? fan : coral,
              { mode: "water" }
            );
        }
    }
  }

  function iceberg(feature, put) {
    const rx = Math.ceil(feature.radiusX);
    const rz = Math.ceil(feature.radiusZ);
    for (let dz = -rz; dz <= rz; dz++)
      for (let dx = -rx; dx <= rx; dx++) {
        const distance =
          (dx * dx) / feature.radiusX ** 2 + (dz * dz) / feature.radiusZ ** 2;
        if (distance > 1) continue;
        const x = feature.x + dx;
        const z = feature.z + dz;
        const col = sampleColumn(x, z);
        if (!col?.frozen || getBiomeById(col.id).category !== "ocean") continue;
        const shape = 1 - distance;
        const top =
          SEA +
          Math.max(
            0,
            Math.floor(
              feature.height * shape ** 0.65 +
                (feature.tilt * dx) / feature.radiusX +
                noise(x / 7, z / 7, salt ^ 24571) * 2
            )
          );
        const low = Math.max(
          col.top + 1,
          SEA - Math.floor(feature.keel * shape ** 0.45)
        );
        for (let y = low; y <= top; y++)
          put(
            x,
            y,
            z,
            y === top && y > SEA + 4
              ? B.SNOW_BLOCK
              : y < SEA - 5 && distance < 0.6
                ? B.BLUE_ICE
                : B.PACKED_ICE,
            { mode: "ice" }
          );
      }
  }

  function decorate(bounds, writer) {
    forEachV4Owner(bounds, V4_MARINE_SPACING, V4_MARINE_REACH, (gx, gz) => {
      for (const feature of getFeatures(gx, gz)) {
        if (feature.kind === "reef") reef(feature, writer.put);
        else iceberg(feature, writer.put);
      }
    });
  }

  function plants(col, put) {
    if (!col || col.waterLevel !== SEA || col.frozen || col.temperature < 0.23)
      return;
    const { x, z, depth } = col;
    const ocean = getBiomeById(col.id).category === "ocean";
    const patch =
      noise(x / 53, z / 53, salt ^ 33941) * 0.72 +
      noise(x / 19, z / 19, salt ^ 23431) * 0.28;
    const chance = hash(x, z, salt ^ 38569);
    // Kelp forests occupy cool/temperate/lukewarm lit shelves; neither tropical
    // coral gardens, frozen seas, nor the lightless abyss gets a kelp carpet.
    if (
      ocean &&
      col.temperature < 0.8 &&
      depth >= 6 &&
      depth <= 62 &&
      patch > 0.39 &&
      chance < 0.035 + patch * 0.31
    ) {
      const height = Math.min(
        depth - 1,
        3 + Math.floor(hash(x, z, salt ^ 17047) * 20 + patch * 5)
      );
      for (let dy = 1; dy <= height; dy++)
        if (!put(x, col.top + dy, z, B.KELP, { mode: "water" })) break;
    } else if (
      depth >= 2 &&
      depth <= 35 &&
      [B.SAND, B.GRAVEL, B.CLAY, B.MUD].includes(col.surface) &&
      chance < (0.07 + patch * 0.27) * (1 - depth / 55)
    ) {
      if (
        put(x, col.top + 1, z, B.SEAGRASS, { mode: "water" }) &&
        chance < 0.025 &&
        depth >= 3
      )
        put(x, col.top + 2, z, B.SEAGRASS, { mode: "water" });
    }
  }

  return {
    getFeatures,
    decorate,
    plants,
    get cacheSize() {
      return cache.size;
    },
  };
}
