import { BLOCK } from "./blocks.js";
import { MAX_STRUCTURE_PROGRESS_MARKERS } from "./exploration-markers.js";
import { freezeProgressData } from "./progression-common.js";

const samePosition = (a, b) =>
  a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const sameMarker = (a, b) => a && b &&
  ["id", "structureId", "type", "key", "role", "dimension"]
    .every((key) => a[key] === b[key]) && samePosition(a.position, b.position);

/**
 * Read only the supplied resident descriptors: never ensure/admit, discover,
 * resolve a map, roll loot or establish Settlement ownership. Four structures
 * matches GameEcologyMarkers' host cap (its nearby radius remains 64).
 *
 * `untouched` is an eligible entitlement, not a preview roll. `nonempty` and
 * `empty` describe actual initialized slots, including legacy unclaimed slots.
 * `destroyed` includes replacements; `unknown` includes unadmitted/unloaded
 * anchors and missing ownership. None of these observations owns inventory.
 */
export function observeExplorationLoot(service, descriptors) {
  if (!service.active || !Array.isArray(descriptors) || descriptors.length > 4 ||
      descriptors.some((descriptor) => !descriptor ||
        !["shipwreck", "ocean_ruin"].includes(descriptor.kind) ||
        descriptor.dimension !== service.world.dimension ||
        !Array.isArray(descriptor.markers) ||
        descriptor.markers.length > MAX_STRUCTURE_PROGRESS_MARKERS ||
        descriptor.markers.some((marker) => !marker ||
          ![marker.position?.x, marker.position?.y, marker.position?.z]
            .every(Number.isSafeInteger))))
    return null;
  const { world, index, exploration, settlement } = service;
  const { epoch, dimension, generator, _editRevision: worldRevision } = world;
  const revision = service._revision, ledgerRevision = exploration.revision;
  const settlementRevision = settlement.revision;
  const reads = [];
  const structures = descriptors.map((descriptor) => ({
    id: descriptor.id,
    containers: descriptor.markers.filter((marker) => marker.type === "container")
      .map((declared) => {
        const entry = index.byId(declared.id);
        const key = `${Math.floor(declared.position.x / 16)},${Math.floor(declared.position.z / 16)}`;
        const column = index.columns.get(key), chunk = world.chunks.get(key);
        reads.push({
          id: declared.id, entry, key, column, chunk,
          incarnation: chunk?.incarnation, revision: chunk?.revision,
          invalidated: entry?.invalidated,
        });
        const result = {
          id: declared.id,
          position: { ...declared.position },
          status: "unknown",
        };
        if (!entry || entry.kind !== descriptor.kind ||
            entry.marker.structureId !== descriptor.id ||
            entry.marker.dimension !== dimension ||
            entry.declaration?.id !== declared.id ||
            !samePosition(entry.marker.position, declared.position) ||
            ["structureId", "dimension", "type", "key", "role", "table", "block"].some((key) =>
              entry.declaration[key] !== declared[key]))
          return result;
        const marker = entry.marker;
        const claim = exploration.container(marker);
        const at = exploration.containerAt(dimension, marker.position);
        if ((at && !sameMarker(at.marker, marker)) ||
            (claim && !sameMarker(claim.marker, marker)) ||
            claim?.state === "destroyed" || !index.live(entry) ||
            !index.eligible(entry))
          return { ...result, status: "destroyed" };
        const station = settlement.inspectContainer(world, {
          ...marker.position, dimension, id: BLOCK.CHEST,
        });
        if (!station || station.kind !== "chest") return result;
        if (station.initialized)
          return { ...result, status: station.slots.some((stack) =>
            stack && stack.count > 0) ? "nonempty" : "empty" };
        // A materialized/cleared claim with no Settlement record is missing
        // ownership, never permission to refill or promise fresh loot.
        return claim ? result : { ...result, status: "untouched" };
      }),
  }));
  return Object.freeze({
    structures: freezeProgressData(structures),
    validate: () => service.active && service._revision === revision &&
      service.index === index && service.exploration === exploration &&
      service.settlement === settlement && world.epoch === epoch &&
      world.dimension === dimension && world.generator === generator &&
      world._editRevision === worldRevision &&
      exploration.revision === ledgerRevision &&
      settlement.revision === settlementRevision &&
      reads.every((read) => index.byId(read.id) === read.entry &&
        read.entry?.invalidated === read.invalidated &&
        index.columns.get(read.key) === read.column &&
        world.chunks.get(read.key) === read.chunk &&
        read.chunk?.incarnation === read.incarnation &&
        read.chunk?.revision === read.revision),
  });
}
