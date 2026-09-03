import { V4_LIMITS } from "./terrain-v4-config.js";
import { forEachV4Owner } from "./terrain-v4-writer.js";

/**
 * Explicit low-level extension seam. The shared native factory supplies its
 * frozen structure manifest; unit fixtures may still provide their own entries.
 *
 * A decorator is {id, spacing, reach, maxWrites, maxSamples?, dimensions?,
 *   describe({gx,gz,seed,salt,dimension,spec,sampleColumn}) -> Descriptor[],
 *   emit(descriptor, put) -> void}.
 *
 * Describe/emit must be pure. Descriptors are structured-cloneable data with
 * half-open integer bounds {minX,minY,minZ,maxX,maxY,maxZ}. They are owned by the
 * global spacing cell; reach bounds their spill beyond that cell. Neither
 * callback receives clipped bounds or access to local generated cells.
 */
export function createV4Decorators(decorators, context, counters) {
  if (!Array.isArray(decorators) || decorators.length > V4_LIMITS.decorators)
    throw new RangeError("Terrain v4 accepts at most eight feature decorators");
  const ids = new Set();
  const entries = decorators.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id.length ||
      entry.id.length > 80 ||
      ids.has(entry.id) ||
      !Number.isInteger(entry.spacing) ||
      entry.spacing < 16 ||
      entry.spacing > 256 ||
      !Number.isInteger(entry.reach) ||
      entry.reach < 0 ||
      entry.reach > 64 ||
      !Number.isInteger(entry.maxWrites) ||
      entry.maxWrites < 1 ||
      entry.maxWrites > 65536 ||
      !Number.isInteger(entry.maxSamples ?? 64) ||
      (entry.maxSamples ?? 64) < 1 ||
      (entry.maxSamples ?? 64) > 256 ||
      typeof entry.describe !== "function" ||
      typeof entry.emit !== "function" ||
      (entry.dimensions !== undefined &&
        (!Array.isArray(entry.dimensions) ||
          entry.dimensions.some(
            (dimension) => !["overworld", "nether", "end"].includes(dimension)
          )))
    )
      throw new TypeError("Invalid v4 feature decorator");
    ids.add(entry.id);
    return Object.freeze({ ...entry, dimensions: entry.dimensions?.slice() });
  });

  return function decorate(bounds, writer) {
    const structures = [];
    for (const entry of entries) {
      if (entry.dimensions && !entry.dimensions.includes(context.dimension))
        continue;
      forEachV4Owner(bounds, entry.spacing, entry.reach, (gx, gz) => {
        counters.decoratorCells++;
        let samples = 0;
        const descriptors = entry.describe({
          ...context,
          gx,
          gz,
          sampleColumn: (x, z) => {
            counters.decoratorSamples++;
            if (++samples > (entry.maxSamples ?? 64))
              throw new RangeError(
                `Terrain decorator ${entry.id} exceeded its sample budget`
              );
            return context.sampleColumn(x, z);
          },
        });
        if (!Array.isArray(descriptors) || descriptors.length > 8)
          throw new TypeError(
            `Terrain decorator ${entry.id} must return at most eight descriptors`
          );
        counters.decoratorDescriptors += descriptors.length;
        let writes = 0;
        for (const descriptor of descriptors) {
          const area = descriptor?.bounds;
          if (
            !area ||
            !["minX", "minY", "minZ", "maxX", "maxY", "maxZ"].every((key) =>
              Number.isSafeInteger(area[key])
            ) ||
            area.minX >= area.maxX ||
            area.minY >= area.maxY ||
            area.minZ >= area.maxZ ||
            area.minX < gx * entry.spacing - entry.reach ||
            area.maxX > (gx + 1) * entry.spacing + entry.reach ||
            area.minZ < gz * entry.spacing - entry.reach ||
            area.maxZ > (gz + 1) * entry.spacing + entry.reach ||
            area.minY < context.spec.minY ||
            area.maxY > context.spec.maxY
          )
            throw new RangeError(
              `Terrain decorator ${entry.id} emitted out-of-owner bounds`
            );
          if (
            area.maxX <= bounds.minX ||
            area.minX >= bounds.minX + bounds.width ||
            area.maxZ <= bounds.minZ ||
            area.minZ >= bounds.minZ + bounds.depth
          )
            continue;
          const data = structuredClone(descriptor);
          structures.push({ ...data, owner: entry.id, gx, gz });
          entry.emit(data, (x, y, z, id, options) => {
            counters.decoratorWrites++;
            if (++writes > entry.maxWrites)
              throw new RangeError(
                `Terrain decorator ${entry.id} exceeded its write budget`
              );
            if (
              ![x, y, z].every(Number.isSafeInteger) ||
              x < area.minX ||
              x >= area.maxX ||
              y < area.minY ||
              y >= area.maxY ||
              z < area.minZ ||
              z >= area.maxZ
            )
              throw new RangeError(
                `Terrain decorator ${entry.id} wrote outside its descriptor`
              );
            // A clipped write must not influence the following writes. Do not
            // return writer.put's local success/failure to the decorator.
            writer.put(x, y, z, id, options);
          });
        }
      });
    }
    return structures;
  };
}
