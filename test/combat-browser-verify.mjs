// Read-only verification of this fixture's actual exported checkpoints.
// File contents alone do not prove GUI provenance; pair them with the recording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BLOCK } from "../src/blocks.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { ITEM } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { parseWorldFile } from "../src/storage.js";

const targetId = "overworld:ecology:0";
const anvilPosition = [4610, 68, -6143];
const sword = (durability, enchanted) => ({
  id: ITEM.IRON_SWORD, count: 1, durability,
  ...(enchanted ? { data: { version: 1, enchantments: { sharpness: 3 }, repairCost: 1 } } : {}),
});
const book = {
  id: ITEM.ENCHANTED_BOOK, count: 1,
  data: { version: 1, enchantments: { sharpness: 3 } },
};
const fluidResources = (fluids) => ({
  ...fluids,
  dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
});

function inspect(saved, label, { durability, health, paid }) {
  const { context, ...components } = normalizeWorldComponents(saved);
  assert.deepEqual({ ...saved, ...components }, saved, `${label}: noncanonical or contradictory owners`);
  assert.equal(context.seed, "cedar-valley");
  assert.equal(context.generatorVersion, 4);
  assert.equal(saved.world.dimension, "overworld");
  const owned = saved.gameplay;
  assert.equal(owned.mode, "survival");
  assert.equal(owned.dead, false);
  assert.equal(owned.health, 20);
  assert.deepEqual(owned.slots, paid
    ? [sword(durability, true), ...Array(35).fill(null)]
    : [sword(250, false), book, ...Array(34).fill(null)], `${label}: exact finite inventory`);
  assert.equal(owned.selected, 0);
  assert.equal(owned.cursor, null);
  assert.equal(owned.offhand, null);
  assert.ok(Object.values(owned.equipment).every((stack) => stack === null));
  assert.ok(owned.craftingGrid.every((stack) => stack === null));
  assert.deepEqual(owned.crafting, []);
  assert.deepEqual(owned.experience, paid
    ? { total: 0, level: 0, progress: 0 }
    : { total: 27, level: 3, progress: 0 });
  assert.deepEqual(saved.progression.statusEffects.effects, []);
  assert.deepEqual(saved.pickups.items, []);
  assert.deepEqual(saved.overflow.entries, []);
  assert.deepEqual(saved.experienceOrbs.orbs, []);
  for (const copy of [
    saved.mobStates.overworld, saved.mobsByDimension.overworld,
    saved.ecology.mobsByDimension.overworld,
  ])
    assert.deepEqual(copy, saved.mobs, `${label}: all Wildlife compatibility copies agree`);
  const matches = saved.mobs.entities.filter((mob) => mob.id === targetId);
  assert.equal(matches.length, 1, `${label}: one original victim`);
  const target = matches[0];
  assert.equal(target.kind, "turtle");
  assert.equal(target.life, 1);
  assert.equal(target.health, health);
  assert.equal(saved.mobs.killed.includes(targetId), false);
  const entries = saved.ecology.ecology.entries.filter((entry) => entry.id === targetId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].alive, true);
  assert.deepEqual(entries[0].homeBeach, { x: 4608.5, y: 68, z: -6143.5 });
  const stations = saved.progression.stations.stations;
  if (paid) {
    assert.equal(stations.length, 1);
    assert.deepEqual(stations[0], {
      dimension: "overworld", x: 4610, y: 68, z: -6143, kind: "anvil",
      record: { version: 1, left: null, right: null },
    }, `${label}: no retained input or duplicate output`);
  } else assert.deepEqual(stations, []);
  assert.equal(saved.world.edits.length, 1);
  assert.deepEqual(saved.world.edits[0].slice(0, 4), ["overworld", ...anvilPosition]);
  return {
    label, targetId, life: target.life, targetHealth: health,
    swordDurability: durability, sharpness: paid ? 3 : 0, repairCost: paid ? 1 : 0,
    books: paid ? 0 : 1, experience: owned.experience.total,
    effectsRandomState: saved.progression.stations.randomState,
    playerHealth: owned.health, looseItems: 0, xpOrbs: 0,
  };
}

export function verifyCombatExports(initial, paid, { hit, restored = [] } = {}) {
  const reports = [
    inspect(initial, "unpaid start", { durability: 250, health: 30, paid: false }),
    inspect(paid, "paid anvil, before hit", { durability: 250, health: 30, paid: true }),
  ];
  assert.deepEqual(initial.world.edits[0], ["overworld", ...anvilPosition, BLOCK.ANVIL, 0, 0]);
  const random = nextEnchantingSeed(initial.progression.stations.randomState);
  assert.equal(paid.progression.stations.randomState, random, "one anvil wear draw");
  assert.deepEqual(paid.progression.stations.player, initial.progression.stations.player,
    "anvil payment never rerolls the enchanting table seed");
  assert.deepEqual(paid.world.edits[0], [
    "overworld", ...anvilPosition,
    random / 0x100000000 < 0.12 ? BLOCK.CHIPPED_ANVIL : BLOCK.ANVIL, 0, 0,
  ]);
  if (!hit) {
    assert.equal(restored.length, 0, "restoration needs a hit checkpoint");
    return reports;
  }
  reports.push(inspect(hit, "one native hit", { durability: 249, health: 22, paid: true }));
  assert.deepEqual(hit.progression, paid.progression, "offense pays no progression RNG or station inputs");
  assert.deepEqual(hit.world, paid.world, "combat leaves the anvil and native terrain unchanged");
  assert.ok(hit.gameplay.exhaustion >= paid.gameplay.exhaustion + 0.1 - 1e-9,
    "melee exhaustion is paid; real intervening frames may also add survival exhaustion");
  for (const [index, backup] of restored.entries()) {
    reports.push(inspect(backup, `cold/restored checkpoint ${index + 1}`,
      { durability: 249, health: 22, paid: true }));
    assert.deepEqual(Object.keys(backup).sort(), Object.keys(hit).sort());
    for (const key of Object.keys(hit)) {
      if (key === "fluids")
        assert.deepEqual(fluidResources(backup[key]), fluidResources(hit[key]),
          "restoration preserves fluid resources and clock, not resident scan metadata");
      else assert.deepEqual(backup[key], hit[key], `cold/restored owner: ${key}`);
    }
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length >= 2,
    "Usage: node test/combat-browser-verify.mjs unpaid.json paid.json [hit.json [cold-or-restored.json ...]]");
  const snapshots = paths.map((path) => {
    const text = readFileSync(path, "utf8");
    const parsed = parseWorldFile(text);
    assert.deepEqual(parsed, JSON.parse(text), `${path}: export parser preserves every owner`);
    return parsed;
  });
  const [initial, paid, hit, ...restored] = snapshots;
  const reports = verifyCombatExports(initial, paid, { hit, restored });
  reports.forEach((report, index) => console.log(JSON.stringify({ file: resolve(paths[index]), ...report })));
  console.log(JSON.stringify({
    checkpointVerification: "PASS", checkpoints: reports.length,
    source: "actual supplied exported files; correlate with the GUI recording",
  }));
}
