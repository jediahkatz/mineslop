import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK as B } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import {
  AUDIT_POINTS, AUDIT_SEEDS, ORE_NAMES, auditOrePatch, findAuditTargets,
  oreRate, sumAuditRows,
} from "./terrain-v5-audit-helpers.js";

const oreTotal = (row) => Object.values(row.ores).reduce((a, b) => a + b, 0);
const rows = (samples, field, accept = () => true) => sumAuditRows(samples.flatMap(
  (sample) => Object.entries(sample[field]).filter(([key]) => accept(key)).map(([, value]) => value)
));
const targetRows = (samples, label) => samples.filter((s) => s.label === label);

test("real v4/v5 chunk distributions, host eligibility, depth, exposure and complete vein groups", {
  timeout: 600000,
}, async (t) => {
  const baseline = { "4/overworld": [], "5/overworld": [], "4/nether": [], "5/nether": [] };
  const targets = [], targetColumns = [];
  for (const seed of AUDIT_SEEDS.slice(0, 3)) {
    for (const dimension of ["overworld", "nether"])
      for (const version of [4, 5]) {
        const generator = createGenerator(seed, dimension, version);
        for (const [x, z] of [AUDIT_POINTS[0], AUDIT_POINTS[4], AUDIT_POINTS[6]])
          baseline[`${version}/${dimension}`].push(auditOrePatch(generator, { x, z }));
        if (version === 5 && dimension === "overworld") {
          const found = findAuditTargets(generator);
          assert.deepEqual(found.missing, [], `bounded targets for ${seed}`);
          for (const point of found.points) {
            targets.push({ ...auditOrePatch(generator, point), label: point.label });
            if (point.label === "ordinary") targetColumns.push({ seed, ...point });
          }
        }
      }
  }
  const overworld = [...baseline["5/overworld"], ...targets];
  const nether = baseline["5/nether"];

  await t.test("abundance drops materially without losing mineable resources", () => {
    for (const dimension of ["overworld", "nether"]) {
      const before = sumAuditRows(baseline[`4/${dimension}`]);
      const after = sumAuditRows(baseline[`5/${dimension}`]);
      assert.ok(oreTotal(after) > 0);
      assert.ok(oreTotal(after) / after.host < oreTotal(before) / before.host * 0.65);
      assert.ok(oreTotal(after) / after.host < 0.045, "original v5 balancing guard, not a vanilla percentage");
    }
    const ores = sumAuditRows(overworld).ores;
    for (const name of ORE_NAMES.slice(0, 8)) assert.ok(ores[name] > 0, name);
  });

  await t.test("actual ore cells replace matching natural rock, including the stone/deepslate variants", () => {
    for (const sample of [...overworld, ...nether]) {
      assert.ok(sample.naturalChecks > 0);
      assert.equal(sample.actualHostMismatches, 0);
      assert.equal(sample.naturalAirDebris, 0);
    }
    const stone = rows(overworld, "byHost", (key) => key === "stone");
    const deep = rows(overworld, "byHost", (key) => key === "deepslate");
    assert.ok(deep.ores.diamond > stone.ores.diamond);
    assert.ok(stone.ores.copper > deep.ores.copper);
  });

  await t.test("debris and emeralds are small isolated finds; common deposits are not one uniform cube", () => {
    for (const [samples, name] of [[overworld, "emerald"], [nether, "ancient_debris"]]) {
      const sizes = samples.flatMap((s) => Object.keys(s.groups[name].complete).map(Number));
      assert.ok(sizes.length > 0, `${name} complete groups actually sampled`);
      assert.ok(sizes.every((size) => size >= 1 && size <= 3), name);
      const censored = samples.flatMap((s) => Object.keys(s.groups[name].censored).map(Number));
      assert.ok(censored.every((size) => size <= 3), name);
    }
    for (const name of ["coal", "iron", "copper", "diamond"]) {
      const sizes = overworld.flatMap((s) => Object.keys(s.groups[name].complete).map(Number));
      assert.ok(new Set(sizes).size >= 3, name);
      assert.ok(Math.max(...sizes) <= 192, `${name}: guard against giant connected accumulations`);
    }
  });

  await t.test("depth trends, no upper iron hole, and accessible mountain and badlands ores", () => {
    const deep = rows(overworld, "byBand", (key) => Number(key) < -32);
    const shallow = rows(overworld, "byBand", (key) => Number(key) >= 0 && Number(key) < 16);
    assert.ok(oreRate(deep, "diamond") > oreRate(shallow, "diamond") * 2);
    const mountains = targetRows(targets, "mountain");
    for (const band of ["80", "96", "112", "128"]) {
      const layer = rows(mountains, "byBand", (key) => key === band);
      assert.ok(layer.host > 1000 && layer.ores.iron > 0, `iron remains present at Y=${band}..${Number(band) + 15}`);
    }
    const surface = rows(mountains, "byExposure", (key) => key === "surface_air");
    assert.ok(surface.ores.coal > 0 && surface.ores.iron > 0);
    const highGold = rows(targetRows(targets, "badlands"), "byBiomeBand", (key) => {
      const [biome, band] = key.split(":");
      return ["badlands", "wooded_badlands", "eroded_badlands"].includes(biome) && Number(band) >= 64;
    });
    assert.ok(highGold.ores.gold > 0, "actual stone interbeds yield high badlands gold");
    assert.equal(rows(overworld, "byBand", (key) => Number(key) < 0).ores.coal, 0);
    assert.equal(rows(overworld, "byBand", (key) => Number(key) >= 112).ores.copper, 0);
    assert.equal(rows(overworld, "byBand", (key) => Number(key) >= 16).ores.diamond, 0);
  });

  await t.test("dripstone enriches copper in matched depth bands, and diamond air exposure is suppressed", () => {
    const caveBand = (name) => rows(overworld, "byCaveBand",
      (key) => key === `${name}:32` || key === `${name}:48`);
    const drip = caveBand("dripstone_caves"), lush = caveBand("lush_caves");
    assert.ok(drip.host > 10000 && lush.host > 10000);
    assert.ok(oreRate(drip, "copper") > oreRate(lush, "copper") * 1.3);
    const exposed = rows(overworld, "byExposureBand", (key) =>
      ["cave_air:-64", "cave_air:-48", "cave_air:-32"].includes(key));
    const buried = rows(overworld, "byExposureBand", (key) =>
      ["buried:-64", "buried:-48", "buried:-32"].includes(key));
    assert.ok(exposed.host > 1000 && buried.ores.diamond > 0);
    assert.ok(oreRate(exposed, "diamond") < oreRate(buried, "diamond") * 0.8);
  });

  await t.test("Nether ceilings and detached shelves contain resources; debris favors low rock", () => {
    const roof = rows(nether, "byNetherDomain", (key) => key === "ceiling");
    const shelves = rows(nether, "byNetherDomain", (key) => key === "shelf");
    assert.ok(roof.host > 1000 && roof.ores.nether_quartz > 0 && roof.ores.nether_gold > 0);
    assert.ok(shelves.host > 0 && shelves.ores.nether_quartz + shelves.ores.nether_gold > 0);
    const oldRoof = rows(baseline["4/nether"], "byNetherDomain", (key) => key === "ceiling");
    assert.equal(oldRoof.ores.nether_quartz + oldRoof.ores.nether_gold, 0);
    const low = rows(nether, "byBand", (key) => Number(key) >= 0 && Number(key) < 32);
    const high = rows(nether, "byBand", (key) => Number(key) >= 48);
    assert.ok(oreRate(low, "ancient_debris") > oreRate(high, "ancient_debris"));
  });

  await t.test("real generated stone transitions to deepslate only in Y=8..0", () => {
    const stone = new Set([B.STONE, ...ORE_NAMES.slice(0, 8).map((n) => B[`${n.toUpperCase()}_ORE`])]);
    const deep = new Set([B.DEEPSLATE, ...ORE_NAMES.slice(0, 8).map((n) => B[`DEEPSLATE_${n.toUpperCase()}_ORE`])]);
    const levels = new Map([-8, -1, 0, 1, 4, 7, 8].map((y) => [y, { stone: 0, deep: 0 }]));
    for (const { seed, x, z } of targetColumns) {
      const chunk = createGenerator(seed, "overworld", 5).generateChunk(x / 16, z / 16);
      for (const [y, counts] of levels)
        for (const id of chunk.blocks.subarray((y + 64) * 256, (y + 65) * 256)) {
          counts.stone += Number(stone.has(id)); counts.deep += Number(deep.has(id));
        }
    }
    for (const y of [-8, -1, 0]) {
      assert.equal(levels.get(y).stone, 0, `no ordinary stone at ${y}`);
      assert.ok(levels.get(y).deep > 0);
    }
    assert.equal(levels.get(8).deep, 0);
    const fraction = (y) => levels.get(y).deep / (levels.get(y).stone + levels.get(y).deep);
    assert.ok(fraction(1) > fraction(4) && fraction(4) > fraction(7));
    assert.ok(fraction(4) > 0.3 && fraction(4) < 0.7);
  });
});

test("actual End chunks remain completely ore-free", { timeout: 30000 }, () => {
  const generator = createGenerator("v5-end-ores", "end", 5);
  for (const [x, z] of [[0, 0], [1792, -2048]]) {
    const result = auditOrePatch(generator, { x, z });
    assert.equal(oreTotal(result), 0);
    assert.equal(generator.counters.oreCells, 0);
  }
});
