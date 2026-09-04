import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_STATE as S,
  defaultFluidFor,
  FLUID,
  isValidCell,
} from "../src/block-state.js";
import { BLOCK as B, BLOCKS } from "../src/blocks.js";
import { createGenerator } from "../src/terrain.js";
import { newV4Counters, V4_SPECS } from "../src/terrain-v4-config.js";
import { requireTerrainV4Content } from "../src/terrain-v4-content.js";
import { createV4Writer, readV4RegionCell } from "../src/terrain-v4-writer.js";

test("v4 requires real registrations and axis metadata instead of coercing missing IDs to AIR", () => {
  assert.doesNotThrow(() => requireTerrainV4Content());
  const ids = { ...B };
  delete ids.FIRE_CORAL_BLOCK;
  assert.throws(() => requireTerrainV4Content(ids, BLOCKS), /FIRE_CORAL_BLOCK/);
  const definitions = BLOCKS.slice();
  definitions[B.OAK_LOG] = { ...BLOCKS[B.OAK_LOG], directional: undefined };
  assert.throws(
    () => requireTerrainV4Content(B, definitions),
    /OAK_LOG\.directional/
  );
  definitions[B.OAK_LOG] = BLOCKS[B.OAK_LOG];
  definitions[B.TUBE_CORAL_FAN] = {
    ...BLOCKS[B.TUBE_CORAL_FAN],
    aquatic: false,
  };
  assert.throws(
    () => requireTerrainV4Content(B, definitions),
    /TUBE_CORAL_FAN\.aquatic/
  );
});

test("the opt-in dispatch leaves all historical encodings on Uint8", () => {
  for (const version of [1, 2, 3]) {
    const chunk = createGenerator(
      "v4-dispatch",
      "nether",
      version
    ).generateChunk(-1, 0);
    assert.ok(chunk.blocks instanceof Uint8Array);
    assert.equal(chunk.blocks.length, 96 * 256);
  }
  const modern = createGenerator("v4-dispatch", "nether", 4).generateChunk(
    -1,
    0
  );
  assert.ok(modern.blocks instanceof Uint16Array);
  assert.equal(modern.blocks.length, (modern.maxY - modern.minY) * 256);
  assert.throws(
    () => createGenerator("v4-dispatch", "overworld", 7),
    /version/
  );
});

function writer(bounds = { minX: -16, minZ: -16, width: 16, depth: 16 }) {
  return createV4Writer({
    ...bounds,
    spec: V4_SPECS.overworld,
    counters: newV4Counters(),
  });
}

test("authored writer fixture preserves negative-Y log axes and prunes canonical planes", () => {
  const output = writer();
  output.set(-1, -1, -1, B.OAK_LOG, S.AXIS_Z);
  const first = output.finish(true);
  assert.equal(first.blocks[63 * 256 + 255], B.OAK_LOG);
  assert.equal(first.sections.length, 1);
  assert.equal(first.sections[0].sy, -1);
  assert.equal(first.sections[0].states.length, 4096);
  assert.equal(first.sections[0].states[4095], S.AXIS_Z);
  assert.equal(first.sections[0].fluids, undefined);
  output.set(-1, -1, -1, B.OAK_LOG);
  assert.equal(output.finish(true).sections, undefined);
  assert.throws(
    () => output.set(-1, -1, -1, undefined),
    /Invalid v4 terrain cell/
  );
  assert.throws(
    () => output.set(-1, -1, -1, B.OAK_LOG, S.AXIS_X | S.AXIS_Z),
    /Invalid/
  );
});

test("authored flooded-section fixture keeps all default sources when one host allocates a plane", () => {
  const output = writer();
  // Authored source-water fixture, not evidence of generated ocean terrain.
  for (let y = -16; y < 0; y++)
    output.blocks.fill(B.WATER, (y + 64) * 256, (y + 65) * 256);
  output.set(-15, -15, -15, B.KELP);
  output.set(-14, -15, -15, B.SEAGRASS);
  output.set(-13, -15, -15, B.BRAIN_CORAL_FAN);
  assert.equal(output.finish(true).sections, undefined);
  output.set(-16, -16, -16, B.OAK_SLAB, 0, FLUID.WATER_SOURCE);
  const result = output.finish(true);
  const section = result.sections[0];
  assert.equal(section.sy, -1);
  assert.equal(section.states, undefined);
  assert.equal(section.fluids.length, 4096);
  assert.ok(section.fluids.every((fluid) => fluid === FLUID.WATER_SOURCE));
  for (let local = 0; local < 4096; local++) {
    const id = result.blocks[48 * 256 + local];
    assert.ok(isValidCell({ id, fluid: section.fluids[local] }));
  }
  output.set(-16, -16, -16, B.WATER);
  assert.equal(output.finish(true).sections, undefined);
  assert.equal(defaultFluidFor(B.KELP), FLUID.WATER_SOURCE);
});

test("authored nonaligned region fixture stores auxiliary planes by absolute chunk and section", () => {
  const bounds = { minX: -17, minZ: -1, width: 19, depth: 3 };
  const output = writer(bounds);
  output.set(-17, -16, -1, B.OAK_LOG, S.AXIS_X);
  output.set(0, -1, 0, B.BIRCH_LOG, S.AXIS_Z);
  output.set(1, 16, 1, B.OAK_SLAB, 0, FLUID.WATER_SOURCE);
  assert.equal(output.set(2, -1, 0, B.STONE), false);
  const result = { ...bounds, ...output.finish() };
  assert.deepEqual(readV4RegionCell(result, -17, -16, -1), {
    id: B.OAK_LOG,
    state: S.AXIS_X,
    fluid: FLUID.NONE,
  });
  assert.deepEqual(readV4RegionCell(result, 0, -1, 0), {
    id: B.BIRCH_LOG,
    state: S.AXIS_Z,
    fluid: FLUID.NONE,
  });
  assert.deepEqual(readV4RegionCell(result, 1, 16, 1), {
    id: B.OAK_SLAB,
    state: 0,
    fluid: FLUID.WATER_SOURCE,
  });
  assert.equal(readV4RegionCell(result, 2, -1, 0), null);
  for (const section of result.sections) {
    assert.ok(Number.isInteger(section.cx) && Number.isInteger(section.cz));
    if (section.states) assert.equal(section.states.length, 4096);
    if (section.fluids) assert.equal(section.fluids.length, 4096);
  }
});
