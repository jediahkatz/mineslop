import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import {
  miningExperience,
  playerKillExperience,
} from "../src/experience-rewards.js";

test("eligible Survival ore harvests earn bounded XP, not failed harvests or Creative edits", () => {
  const drops = [{ id: 276, count: 1 }];
  assert.equal(
    miningExperience(BLOCK.DIAMOND_ORE, drops, "survival", () => 0),
    3
  );
  assert.equal(
    miningExperience(BLOCK.DIAMOND_ORE, drops, "survival", () => 1),
    7
  );
  assert.equal(miningExperience(BLOCK.DIAMOND_ORE, [], "survival"), 0);
  assert.equal(miningExperience(BLOCK.DIAMOND_ORE, drops, "creative"), 0);
  assert.equal(
    miningExperience(BLOCK.DIAMOND_ORE, [{ id: 276, count: 0 }], "survival"),
    0
  );
  for (const id of [
    BLOCK.STONE,
    BLOCK.OAK_LOG,
    BLOCK.IRON_ORE,
    BLOCK.GOLD_ORE,
    BLOCK.COPPER_ORE,
  ])
    assert.equal(miningExperience(id, drops, "survival"), 0);
  assert.equal(
    miningExperience(BLOCK.COAL_ORE, drops, "survival", () => -1),
    0
  );
  assert.equal(
    miningExperience(BLOCK.REDSTONE_ORE, drops, "survival", () => NaN),
    1
  );
});

test("kill awards require a confirmed player hit and are not derived from generic drops", () => {
  const zombie = { kind: "zombie", spec: { temperament: "hostile" } };
  const cow = { kind: "cow", spec: { temperament: "passive" } };
  const killed = { hit: true, killed: true };
  assert.equal(playerKillExperience(zombie, killed, "survival"), 5);
  assert.equal(
    playerKillExperience(cow, killed, "survival", () => 0),
    1
  );
  assert.equal(
    playerKillExperience(cow, killed, "survival", () => 1),
    3
  );
  assert.equal(
    playerKillExperience({ ...zombie, kind: "slime" }, killed, "survival"),
    1
  );
  assert.equal(
    playerKillExperience(zombie, { hit: true, killed: false }, "survival"),
    0
  );
  assert.equal(
    playerKillExperience(zombie, { hit: false, killed: true }, "survival"),
    0
  );
  assert.equal(playerKillExperience(zombie, killed, "creative"), 0);
  assert.equal(playerKillExperience(zombie, null, "survival"), 0);
});

test("deep ores inherit mineral XP and Nether ores use their declared ranges", () => {
  assert.equal(
    miningExperience(
      BLOCK.DEEPSLATE_DIAMOND_ORE,
      [{ id: ITEM.DIAMOND, count: 2 }],
      "survival",
      () => 0
    ),
    3
  );
  assert.equal(
    miningExperience(
      BLOCK.DEEPSLATE_LAPIS_ORE,
      [{ id: ITEM.LAPIS, count: 4 }],
      "survival",
      () => 1
    ),
    5
  );
  assert.equal(
    miningExperience(
      BLOCK.NETHER_QUARTZ_ORE,
      [{ id: ITEM.QUARTZ, count: 1 }],
      "survival",
      () => 1
    ),
    5
  );
  assert.equal(
    miningExperience(
      BLOCK.NETHER_GOLD_ORE,
      [{ id: ITEM.GOLD_NUGGET, count: 3 }],
      "survival",
      () => 1
    ),
    1
  );
  assert.equal(
    miningExperience(
      BLOCK.DEEPSLATE_IRON_ORE,
      [{ id: ITEM.RAW_IRON, count: 1 }],
      "survival"
    ),
    0
  );
});

test("collecting an intact ore block does not also award its mining XP", () => {
  for (const id of [
    BLOCK.DIAMOND_ORE,
    BLOCK.DEEPSLATE_DIAMOND_ORE,
    BLOCK.NETHER_QUARTZ_ORE,
  ]) {
    assert.equal(
      miningExperience(id, [{ id, count: 1 }], "survival", () => 1),
      0
    );
  }
});
