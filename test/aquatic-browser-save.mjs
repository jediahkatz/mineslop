// A new-origin GUI starting checkpoint, never a replacement for a user's world.
// Native terrain and normal Game population provide the full-health cod.
// One plain sword and the initial underwater approach are authored prerequisites.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ingredientMobLoot } from "../src/ingredient-mob-loot.js";
import { ITEM } from "../src/items.js";
import {
  approachNativeAquatic, checkedAquaticArchive, freezeAquaticResources, nativeAquaticResources,
} from "./native-aquatic-resource-fixture.js";

const output = process.argv[2];
assert.ok(output?.endsWith(".voxelcraft.json"),
  "Supply a new .voxelcraft.json path; existing files are never overwritten");
const cleanup = [];
try {
  const proof = await nativeAquaticResources({ after: (work) => cleanup.push(work) });
  const selected = await approachNativeAquatic(proof, "cod");
  await freezeAquaticResources(proof);
  const { text, saved } = checkedAquaticArchive(proof);
  assert.equal(proof.f.world.edits.size, 0);
  assert.equal(saved.gameplay.mode, "survival");
  assert.equal(saved.gameplay.health, 20);
  assert.equal(saved.gameplay.experience.total, 0);
  assert.deepEqual(saved.gameplay.slots, [
    { id: ITEM.IRON_SWORD, count: 1, durability: 250 }, ...Array(35).fill(null),
  ]);
  assert.deepEqual(saved.pickups.items, []);
  assert.deepEqual(saved.overflow.entries, []);
  assert.deepEqual(saved.experienceOrbs.orbs, []);
  assert.equal(selected.mob.health, 3);
  const expected = ingredientMobLoot(proof.f.world, selected.mob, true);
  await writeFile(resolve(output), text, { flag: "wx" });
  console.log(JSON.stringify({
    output: resolve(output), sha256: createHash("sha256").update(text).digest("hex"),
    source: "native v4 cedar-valley", fixtureVersion: proof.evidence.fixtureVersion,
    nativePopulationFrames: proof.evidence.populationFrames,
    generatedColumns: proof.generated.chunks, admitted: proof.evidence.admissions,
    target: { id: selected.mob.id, kind: selected.mob.kind, health: selected.mob.health, life: selected.mob.life },
    player: selected.pose, expectedDrops: expected.drops, expectedExperience: expected.experience,
    expectedSwordWear: 1, worldEdits: 0,
    authoredPrerequisites: ["one plain iron sword", "initial underwater starting/approach positions"],
    caveat: "starting checkpoint only; GUI input and actual exports still require independent verification",
  }));
} finally {
  for (const work of cleanup.reverse()) work();
}
