import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { defaultFluidFor, normalizeCell } from "../src/block-state.js";
import { FluidSystem } from "../src/fluids.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";

/** Authored deterministic cells, NOT natural-terrain or visual evidence. */
export function fluidFixture(
  t,
  {
    generatorVersion = 4,
    dimension = "overworld",
    radius = 1,
    floor = 0,
    base = BLOCK.AIR,
    initial = [],
    limits,
    prepareDrops,
    connect = true,
  } = {}
) {
  const generatorFactory = (seed, dimension, version) => {
    const spec = getWorldSpec(version, dimension);
    return {
      getSpawn: () => ({ x: 8.5, y: floor + 1.01, z: 8.5 }),
      generateChunk(cx, cz) {
        const blocks = new Uint16Array((spec.maxY - spec.minY) * 256).fill(
          base
        );
        if (floor >= spec.minY && floor < spec.maxY)
          blocks.fill(
            BLOCK.STONE,
            (floor - spec.minY) * 256,
            (floor - spec.minY + 1) * 256
          );
        const sections = new Map();
        const cells = initial
          .filter(
            ([x, y, z]) =>
              Math.floor(x / 16) === cx &&
              Math.floor(z / 16) === cz &&
              y >= spec.minY &&
              y < spec.maxY
          )
          .map(([x, y, z, value]) => ({
            x,
            y,
            z,
            cell: normalizeCell(
              typeof value === "number" ? { id: value } : value
            ),
          }));
        for (const { x, y, z, cell } of cells)
          blocks[(y - spec.minY) * 256 + (z - cz * 16) * 16 + x - cx * 16] =
            cell.id;
        for (const { x, y, z, cell } of cells) {
          if (!cell.state && cell.fluid === defaultFluidFor(cell.id)) continue;
          const sy = Math.floor(y / 16);
          if (!sections.has(sy)) sections.set(sy, { sy });
          const section = sections.get(sy);
          const at = (y - sy * 16) * 256 + (z - cz * 16) * 16 + x - cx * 16;
          if (cell.state) {
            section.states ??= new Uint16Array(4096);
            section.states[at] = cell.state;
          }
          if (cell.fluid !== defaultFluidFor(cell.id)) {
            if (!section.fluids) {
              section.fluids = new Uint8Array(4096);
              const start = (sy * 16 - spec.minY) * 256;
              for (let i = 0; i < 4096; i++)
                section.fluids[i] = defaultFluidFor(blocks[start + i]);
            }
            section.fluids[at] = cell.fluid;
          }
        }
        return {
          cx,
          cz,
          minY: spec.minY,
          maxY: spec.maxY,
          blocks,
          biomes: new Uint8Array(256),
          sections: [...sections.values()],
        };
      },
    };
  };
  const world = new World("authored-fluid-fixture", {
    generatorVersion,
    dimension,
    generatorFactory,
    useWorker: false,
  }).generate(radius);
  const fluids = new FluidSystem(world, { limits, prepareDrops });
  if (connect) world.onMutation = (event) => fluids.onMutation(event);
  t.after(() => {
    fluids.dispose();
    world.dispose();
  });
  const put = (x, y, z, value) => {
    const after = normalizeCell(
      typeof value === "number" ? { id: value } : value
    );
    const before = world.getCell(x, y, z);
    assert.ok(before, "authored write target is loaded");
    assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
  };
  return { world, fluids, put };
}

export function fluidSteps(fluids, count, dt = 0.25) {
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 4096);
  for (let i = 0; i < count; i++) fluids.update(dt);
}

export function waterLine(world, x0, x1, y = 1, z = 8) {
  return Array.from({ length: x1 - x0 + 1 }, (_, i) =>
    world.getFluid(x0 + i, y, z)
  );
}

export function retainedPlantDrops(world) {
  const owner = { drops: [], plants: [], revision: 0, accept: true };
  assert.equal(world.coordinator.register(owner, 0), true);
  const prepareDrops = (drops, context) => {
    const revision = owner.revision;
    const beforeBytes = world.coordinator.usage(owner);
    const next = structuredClone(drops);
    const plants = structuredClone(context.plants);
    let used = false;
    return {
      owner,
      beforeBytes,
      afterBytes: beforeBytes + next.length * 128,
      validate: () => owner.accept && !used && revision === owner.revision,
      publish() {
        used = true;
        owner.revision++;
        owner.drops.push(...next);
        owner.plants.push(...plants);
      },
    };
  };
  return { owner, prepareDrops };
}
