import assert from "node:assert/strict";
import { normalizeEcologySnapshot } from "../src/expansion-ecology.js";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { DIMENSIONS } from "../src/world-spec.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseFixture, horseRecord } from "./horse-fixture.js";

/** Authored complete archive, not a native population or movement claim. */
export function ecologyHorseArchive(context, {
  horseCount = 1, legacyCount = 0, legacyKind = "sheep", tombstones = 2,
} = {}) {
  const living = Array.from({ length: horseCount }, (_, index) =>
    horseRecord(`horse:retained:${index}`, index % 2 ? {
      tamed: true, tamingTicksLeft: 0,
      saddle: { id: ITEM.SADDLE, count: 1, data: { version: 1, name: `Retained saddle ${index}` } },
    } : {}));
  const horses = { ...emptyHorseSnapshot(context), entries: [
    ...living,
    ...Array.from({ length: tombstones }, (_, index) => ({
      id: `horse:dead:${index}`, dimension: DIMENSIONS[index % DIMENSIONS.length], alive: false,
    })),
  ] };
  const bases = [
    ...Array.from({ length: legacyCount }, (_, index) => mobRecord(context, "overworld", {
      id: `legacy:${index}`, kind: legacyKind, health: MOB_SPECIES[legacyKind].health,
      position: { x: -10.5 + index % 7 * 2, y: 1, z: -10.5 + Math.floor(index / 7) * 2 },
    })),
    ...living.map((entry, index) => mobRecord(context, "overworld", {
      id: entry.id, kind: "horse", health: MOB_SPECIES.horse.health,
      position: { x: 8.5 + index % 3 * 3, y: 1, z: 8.5 + Math.floor(index / 3) * 3 },
    })),
  ];
  return {
    horses,
    saved: {
      version: 1, ecology: normalizeEcologySnapshot(undefined, context),
      mobsByDimension: Object.fromEntries(DIMENSIONS.map((dimension) => [
        dimension, mobSnapshot(context, dimension, dimension === "overworld" ? bases : []),
      ])),
    },
  };
}

/** Real horse/base/resource owners and the real Ecology adoption API.
 * The read hook is deliberately replaceable at its source so tests can detect
 * a host that caches the initial value. No ownership method is stubbed.
 */
export function ecologyHorseFixture(t, {
  load = true, horseCount = 1, legacyCount = 0, legacyKind = "sheep", tombstones = 2, ...worldOptions
} = {}) {
  const f = horseFixture(t, { ...worldOptions, bind: false });
  const archive = ecologyHorseArchive(f.context, { horseCount, legacyCount, legacyKind, tombstones });
  assert.equal(f.horses.load(archive.horses), true);
  f.saved = archive.saved;
  f.readHorses = () => f.horses.serialize();
  f.hookReads = 0;
  const hosts = [];
  f.createHost = (options = {}) => {
    const host = new GameEcologyServices({
      world: f.world, context: f.context, coordinator: f.coordinator,
      gameplay: f.gameplay, overflow: f.overflow, experienceOrbs: f.experience,
      saved: f.saved,
      readHorses: () => { f.hookReads++; return f.readHorses(); },
      ...options,
    });
    hosts.push(host);
    return host;
  };
  t.after(() => {
    for (const host of hosts) assert.equal(host.dispose(), true);
  });
  f.host = f.createHost();
  f.loadWildlife = () => f.wildlife.load(f.saved.mobsByDimension[f.world.dimension], {
    context: f.context, horses: f.horses.serialize(), ecology: f.host.ecology,
  });
  if (load) assert.equal(f.loadWildlife(), true);
  f.adoptionState = (candidate = f.wildlife) => ({
    ...f.ownership(), ecology: f.host.ecology.serialize(),
    archived: structuredClone(f.host._savedMobs),
    candidateBase: candidate.serialize(), candidateRevision: candidate._ecologyRevision,
    activeIds: candidate.entities.map((mob) => mob.id),
    dormantIds: [...candidate.dormantEcology.keys(), ...candidate.dormantHorses.keys()],
    retainedIds: [...candidate._retainedHorseIds],
    registrations: [f.world, f.gameplay, f.overflow, f.experience, f.horses,
      f.host.ecology, candidate].map((owner) => f.coordinator.usage(owner)),
    sceneChildren: [...f.scene.children], meshCount: candidate.mesh.count,
  });
  return f;
}
