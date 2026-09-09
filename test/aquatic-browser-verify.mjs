// Read-only checks for actual exports from the native aquatic resource fixture.
// These assertions do not establish GUI provenance; pair exports with a recording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { parseWorldFile } from "../src/storage.js";

const COD_TARGET = "overworld:126,-768:w";
const sword = (durability) => ({ id: ITEM.IRON_SWORD, count: 1, durability });
const fluidResources = (fluids) => ({
  ...fluids,
  dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
});

function inspect(saved, label) {
  const { context, ...components } = normalizeWorldComponents(saved);
  assert.deepEqual({ ...saved, ...components }, saved, `${label}: every owner is canonical`);
  assert.equal(context.seed, "cedar-valley");
  assert.equal(context.generatorVersion, 4);
  assert.equal(saved.world.dimension, "overworld");
  assert.equal(saved.player.flying, false);
  const owned = saved.gameplay;
  assert.equal(owned.mode, "survival");
  assert.equal(owned.dead, false);
  assert.equal(owned.health, 20);
  assert.equal(owned.selected, 0);
  assert.equal(owned.cursor, null);
  assert.equal(owned.offhand, null);
  assert.ok(Object.values(owned.equipment).every((stack) => stack === null));
  assert.ok(owned.craftingGrid.every((stack) => stack === null));
  assert.deepEqual(owned.crafting, []);
  assert.deepEqual(saved.pickups.items, []);
  assert.deepEqual(saved.overflow.entries, []);
  assert.deepEqual(saved.experienceOrbs.orbs, []);
  for (const copy of [
    saved.mobStates.overworld, saved.mobsByDimension.overworld,
    saved.ecology.mobsByDimension.overworld,
  ])
    assert.deepEqual(copy, saved.mobs, `${label}: Wildlife compatibility copies agree`);
}

export function verifyAquaticExports(initial, collected, {
  targetIds = [COD_TARGET], restored = [],
} = {}) {
  assert.ok(Array.isArray(targetIds) && targetIds.length > 0);
  assert.equal(new Set(targetIds).size, targetIds.length);
  inspect(initial, "native start");
  assert.deepEqual(initial.world.edits, [], "the starting habitat is unedited");
  assert.deepEqual(initial.gameplay.slots, [sword(250), ...Array(35).fill(null)]);
  assert.equal(initial.gameplay.experience.total, 0);
  const drops = new Map();
  let strikes = 0, experience = 0;
  const deaths = targetIds.map((id) => {
    const matches = initial.mobs.entities.filter((mob) => mob.id === id);
    assert.equal(matches.length, 1, "each target has one initial resident identity");
    const mob = matches[0];
    assert.ok(["cod", "squid"].includes(mob.kind));
    assert.equal(mob.health, mob.kind === "cod" ? 3 : 10, "native full-health prerequisite");
    assert.equal(initial.mobs.killed.includes(id), false);
    const quote = ingredientMobLoot(initial.world, mob, true);
    const hits = Math.ceil(mob.health / 6);
    strikes += hits;
    experience += quote.experience;
    for (const drop of quote.drops)
      drops.set(drop.id, (drops.get(drop.id) ?? 0) + drop.count);
    return { id, kind: mob.kind, life: mob.life, healthBefore: mob.health,
      strikes: hits, drops: quote.drops, experience: quote.experience };
  });
  const inventory = [
    sword(250 - strikes), ...[...drops].map(([id, count]) => ({ id, count })),
  ];
  inventory.push(...Array(36 - inventory.length).fill(null));
  // Each separately collected physical orb uses the existing six-draw Mending
  // receiver even for this unenchanted kit. The kill itself uses no such RNG.
  const collectionRandomDraws = deaths.length * 6;
  let effectsRandomState = initial.progression.stations.randomState;
  for (let draw = 0; draw < collectionRandomDraws; draw++)
    effectsRandomState = nextEnchantingSeed(effectsRandomState);

  function checkCollected(saved, label) {
    inspect(saved, label);
    assert.deepEqual(saved.gameplay.slots, inventory, `${label}: exact finite acquired inventory`);
    assert.equal(saved.gameplay.experience.total, experience, `${label}: physically collected XP`);
    assert.deepEqual(saved.world, initial.world, `${label}: resources require no authored terrain`);
    assert.deepEqual([...saved.mobs.killed].sort(), [...initial.mobs.killed, ...targetIds].sort(),
      `${label}: only the selected identities retire`);
    for (const id of targetIds)
      assert.equal(saved.mobs.entities.some((mob) => mob.id === id), false,
        `${label}: no live copy of a retired victim`);
    assert.deepEqual(saved.progression.stations, {
      ...initial.progression.stations, randomState: effectsRandomState,
    }, `${label}: only the existing physical-XP collection RNG budget`);
    assert.equal(saved.fishing.randomState, initial.fishing.randomState);
    assert.equal(saved.playerProjectiles.randomState, initial.playerProjectiles.randomState);
    assert.ok(saved.gameplay.exhaustion >= initial.gameplay.exhaustion + strikes * 0.1 - 1e-9,
      `${label}: each successful primary strike pays exhaustion`);
    return {
      label, deaths, strikes, swordDurability: 250 - strikes, experience,
      collectionRandomDraws, effectsRandomState,
      playerHealth: saved.gameplay.health, looseItems: 0, xpOrbs: 0,
      worldEdits: saved.world.edits.length,
    };
  }

  const reports = [checkCollected(collected, "native resources collected")];
  for (const [index, saved] of restored.entries()) {
    reports.push(checkCollected(saved, `cold/restored checkpoint ${index + 1}`));
    assert.deepEqual(Object.keys(saved).sort(), Object.keys(collected).sort());
    for (const key of Object.keys(collected))
      assert.deepEqual(key === "fluids" ? fluidResources(saved[key]) : saved[key],
        key === "fluids" ? fluidResources(collected[key]) : collected[key],
        `cold/restored owner and clock: ${key}`);
  }
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length >= 2,
    "Usage: node test/aquatic-browser-verify.mjs initial.json collected.json [cold-or-restored.json ...]");
  const [initial, collected, ...restored] = paths.map((path) => {
    const text = readFileSync(path, "utf8"), saved = parseWorldFile(text);
    assert.deepEqual(saved, JSON.parse(text), `${path}: export parsing is lossless`);
    return saved;
  });
  const reports = verifyAquaticExports(initial, collected, { restored });
  reports.forEach((report, index) =>
    console.log(JSON.stringify({ file: resolve(paths[index + 1]), ...report })));
  console.log(JSON.stringify({
    checkpointVerification: "PASS", checkpoints: reports.length + 1,
    source: "supplied exported files; establish live input separately with the GUI recording",
  }));
}
