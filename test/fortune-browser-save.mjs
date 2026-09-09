// Generate a finite, explicitly authored starting-tool save for manual GUI
// verification on a NEW browser origin. The coal, footing and world are native.
// Never import this fixture over a user's original world.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { World } from "../src/world.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

const output = process.argv[2];
assert.ok(output?.endsWith(".voxelcraft.json"),
  "Supply a new .voxelcraft.json output file; existing files are never overwritten");
const stand = { x: -321.5, y: 82, z: 276.5 };
const at = { x: -320, y: 82, z: 276 };
const cleanup = [];
try {
  const world = new World("cedar-valley", { generatorVersion: 4, useWorker: false });
  const f = await gameMobFixture({ after: (work) => cleanup.push(work) }, {
    world, generatorFactory: null, spawnPosition: stand, activate: false,
  });
  assert.equal(world.chunks.size, 9);
  assert.equal(world.get(at.x, at.y, at.z), BLOCK.COAL_ORE);
  assert.equal(isSafeRespawnPosition(world, stand), true);
  const stations = f.progression.services.stations;
  assert.equal(stations.load({ ...stations.serialize(), randomState: 0x12345678 }), true);
  f.activate();
  f.hold("DIAMOND_PICKAXE", {
    data: { version: 1, name: "Fortune verification pick", enchantments: { fortune: 3 } },
  });
  f.aim({ x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 });
  f.game.updateTarget();
  assert.equal(f.game.target?.id, BLOCK.COAL_ORE);
  assert.deepEqual({ x: f.game.target.x, y: f.game.target.y, z: f.game.target.z }, at);
  assert.equal(world.edits.size, 0);
  const file = exportWorldFile(f.snapshot());
  const checked = parseWorldFile(file);
  assert.equal(checked.world.generatorVersion, 4);
  assert.equal(checked.gameplay.mode, "survival");
  await writeFile(resolve(output), file, { flag: "wx" });
  console.log(JSON.stringify({
    output: resolve(output), sha256: createHash("sha256").update(file).digest("hex"),
    source: "native v4 cedar-valley", generatedChunks: world.generator.counters.chunkGenerations,
    authoredPrerequisites: ["starting cave approach", "one Fortune III pick", "fixed saved effects RNG"],
    worldEdits: 0, target: at, standing: stand, mode: checked.gameplay.mode,
    expectedFirstCoalDrop: 2, expectedToolWear: 1,
  }));
} finally {
  for (const work of cleanup.reverse()) work();
}
