import assert from "node:assert/strict";
import { BlockLightField } from "../src/block-light-field.js";
import { DaylightMaterial } from "../src/daylight-material.js";
import { SkyColumns } from "../src/sky-columns.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";
import { settleLight } from "./block-light-fixture.js";

// Authored cells; real admission, voxel reads, edits and revision invalidation.
export function rendererLightWorld(t, cells, spawn = { x: 1, y: 14, z: 1 }) {
  const world = new World("renderer-block-light", {
    generatorVersion: 3,
    useWorker: false,
    generatorFactory: (_seed, dimension, version) => {
      const spec = getWorldSpec(version, dimension);
      return {
        getSpawn: () => spawn,
        generateChunk(cx, cz) {
          const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
          for (const [x, y, z, id] of cells) {
            if (Math.floor(x / 16) !== cx || Math.floor(z / 16) !== cz) continue;
            blocks[(y - spec.minY) * 256 + (z - cz * 16) * 16 + x - cx * 16] = id;
          }
          return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks, biomes: new Uint8Array(256) };
        },
      };
    },
  });
  world.generate(0);
  t.after(() => world.dispose());
  return world;
}

export function attachRendererLight(t, graphics) {
  t.mock.method(performance, "now", () => 0);
  if (graphics.atmosphere) {
    graphics.skyColumns = new SkyColumns();
    graphics.skyColumns.begin(graphics.world);
    graphics.daylightMaterial = new DaylightMaterial(graphics.skyColumns, graphics.scene);
    graphics.blockLight = graphics.daylightMaterial.blockLight;
    for (const material of Object.values(graphics.materials))
      graphics.daylightMaterial.install(material);
    t.after(() => {
      graphics.daylightMaterial.dispose();
      graphics.skyColumns.dispose();
    });
  } else {
    graphics.blockLight = new BlockLightField();
    t.after(() => graphics.blockLight.dispose());
  }
  graphics.world.onMutation = (event) => graphics.onWorldMutation(graphics.world, event);
}

export function settleRendererLight(graphics) {
  const report = settleLight(graphics.blockLight, graphics.world, graphics.camera.position, graphics.renderRadius);
  assert.equal(graphics.blockLight.radius, graphics.renderRadius);
  if (graphics.daylightMaterial) graphics.daylightMaterial.update(graphics.atmosphere);
  graphics.updateLocalLights(1, graphics.camera.position);
  return report;
}
