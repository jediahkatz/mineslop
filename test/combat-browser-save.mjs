// UNPAID starting fixture for a NEW browser origin. Never import over a user's
// original world. This does not perform or claim a working GUI demonstration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertUnpaidCombat, checkedCombatArchive, freezeNativeCombat,
  nativeCombatFixture, nativeTurtleState,
} from "./native-combat-fixture.js";

const output = process.argv[2];
assert.ok(process.argv.length === 3 && output?.endsWith(".voxelcraft.json"),
  "Supply exactly one NEW .voxelcraft.json output file; existing files are never overwritten");
const cleanup = [];
try {
  const proof = await nativeCombatFixture({ after: (work) => cleanup.push(work) });
  assertUnpaidCombat(proof);
  await freezeNativeCombat(proof);
  const { text, saved } = checkedCombatArchive(proof);
  assert.deepEqual(saved.player, proof.poses.initial);
  assert.equal(saved.world.seed, "cedar-valley");
  assert.equal(saved.world.generatorVersion, 4);
  assert.equal(saved.gameplay.mode, "survival");
  assert.equal(saved.gameplay.experience.total, 27);
  assert.equal(saved.gameplay.slots[0].data, undefined, "starting sword is still plain and unpaid");
  await writeFile(resolve(output), text, { flag: "wx" });
  console.log(JSON.stringify({
    output: resolve(output), bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    fixture: "UNPAID native combat start; not a GUI demo",
    nativeProvenance: {
      seed: saved.world.seed, generatorVersion: saved.world.generatorVersion,
      dimension: saved.world.dimension, useWorker: false, generatorFactory: "production default",
      discovery: proof.evidence.discovery, beach: proof.column, scheduler: proof.evidence.scheduler,
      admission: proof.admission, observations: proof.evidence.observations,
    },
    authoredPrerequisites: proof.evidence.authoredPrerequisites,
    poses: proof.poses, anvil: proof.anvil, target: nativeTurtleState(proof),
    finiteItems: saved.gameplay.slots.map((stack, index) => stack && { index, ...stack }).filter(Boolean),
    experience: saved.gameplay.experience, worldEdits: saved.world.edits,
    expectedPayment: { book: 1, levels: 3, experience: [27, 0], repairCost: 1, anvilWearDraws: 1 },
    expectedFirstHit: {
      targetId: proof.targetId, health: [30, 22], swordDurability: [250, 249],
      sharpness: 3, loot: 0, experienceGain: 0, offenseRandomDraws: 0,
    },
    instructions: [
      "Import only on a NEW browser origin/profile, never over an original world.",
      "The initial pose faces the supplied anvil. No payment or attack has occurred.",
      "Use the anvil, put slot 0 sword in the left input and slot 1 book in the right input.",
      "Take the 3-level result, return the cursor sword to slot 0, then close the anvil normally.",
      "Use the reported hit pose to face the native turtle and land ONE normal primary hit.",
      "All ordinary AI remains enabled; keep UI sequences short or pause between them.",
      "This CPU fixture does not resolve old native-retention or original Game frame-budget failures.",
    ],
  }, null, 2));
} finally {
  for (const work of cleanup.reverse()) work();
}
