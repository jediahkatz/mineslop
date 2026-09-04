import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { CONDUIT_FRAME, CONDUIT_WATER } from "../src/conduit-rules.js";
import { gameMobFixture, gameMobGenerator } from "./game-mob-integration-fixture.js";

export const CONDUIT_AT = Object.freeze({ x: 8, y: 68, z: 8 });

export function putCell(world, position, cell) {
  const { x, y, z } = position;
  assert.equal(world.applyCells([{
    x, y, z, before: world.getCell(x, y, z),
    after: normalizeCell(typeof cell === "number" ? { id: cell } : cell),
  }]), true);
}

export function buildConduit(world, count = 42, at = CONDUIT_AT) {
  const cells = new Map();
  const put = (dx, dy, dz, cell) => {
    const p = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
    cells.set(`${p.x},${p.y},${p.z}`, { ...p, after: normalizeCell(cell) });
  };
  for (const [dx, dy, dz] of CONDUIT_WATER) put(dx, dy, dz, { id: BLOCK.WATER });
  CONDUIT_FRAME.forEach(([dx, dy, dz], i) =>
    put(dx, dy, dz, { id: i < count ? BLOCK.PRISMARINE : BLOCK.WATER }));
  put(0, 0, 0, { id: BLOCK.CONDUIT, fluid: FLUID.WATER_SOURCE });
  assert.equal(world.applyCells([...cells.values()].map((cell) => ({
    ...cell, before: world.getCell(cell.x, cell.y, cell.z),
  }))), true);
  return at;
}

export function conduitGenerator(...args) {
  const base = gameMobGenerator(...args);
  return { ...base, generateChunk(cx, cz) {
    const chunk = base.generateChunk(cx, cz);
    if (base.dimension === "overworld")
      chunk.blocks.fill(BLOCK.WATER, (65 - chunk.minY) * 256, (105 - chunk.minY) * 256);
    return chunk;
  } };
}

export async function conduitFixture(t, options = {}) {
  const f = await gameMobFixture(t, {
    generatorVersion: 4, generatorFactory: conduitGenerator,
    spawnPosition: { x: 8.5, y: 68, z: 12.5 }, ...options,
  });
  t.after(() => f.game.conduitServices.dispose());
  return Object.assign(f, { conduit: f.game.conduitServices });
}
