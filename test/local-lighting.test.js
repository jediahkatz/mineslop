import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import {
  LOCAL_LIGHT_LIMITS,
  localLightStyle,
  selectLocalLightSources,
} from "../src/local-lighting.js";
import { MESH_EMITTER_LIMIT } from "../src/mesh-palette.js";
import { GameRenderer } from "../src/renderer.js";

function group(emitters, visible = true) {
  const result = new THREE.Group();
  result.userData.emitters = emitters;
  result.visible = visible;
  return result;
}

test("local selection has a fixed bucket/emitter bound independent of loaded-world size", (t) => {
  const chunks = new Map();
  for (let z = -8; z <= 8; z++)
    for (let x = -8; x <= 8; x++)
      chunks.set(
        `${x},${z}`,
        group(
          Array.from({ length: 100 }, (_, index) => ({
            id: BLOCK.TORCH,
            x: x * 16 + 0.5 + (index % 4),
            y: 20,
            z: z * 16 + 0.5,
          }))
        )
      );
  chunks.values = chunks[Symbol.iterator] = () =>
    assert.fail("selection must not scan all loaded columns");
  let lookups = 0;
  const get = chunks.get.bind(chunks);
  chunks.get = (key) => {
    lookups++;
    return get(key);
  };
  const stats = {};
  const sources = selectLocalLightSources(
    chunks,
    { x: -0.5, y: 20, z: -0.5 },
    1000,
    [],
    stats
  );
  assert.equal(sources.length, LOCAL_LIGHT_LIMITS.maxSources);
  assert.equal(lookups, LOCAL_LIGHT_LIMITS.maxColumns);
  assert.equal(stats.columns, lookups);
  assert.equal(stats.emitters, lookups * MESH_EMITTER_LIMIT);
  assert.ok(stats.emitters <= LOCAL_LIGHT_LIMITS.maxEmitters);
  assert.equal(stats.selected, sources.length);
  assert.ok(sources.every((source) => source.x < 5 && source.x > -17));
  t.diagnostic(JSON.stringify({ loadedColumns: chunks.size, ...stats }));
});

test("real source power prioritizes a usable torch over weak ambient decoration", () => {
  const torch = { id: BLOCK.TORCH, x: 3, y: 0, z: 0 };
  const magma = { id: BLOCK.MAGMA_BLOCK, x: 1, y: 0, z: 0 };
  const sources = selectLocalLightSources(
    new Map([["0,0", group([magma, torch])]]),
    { x: 0, y: 0, z: 0 },
    1
  );
  assert.deepEqual(sources, [torch]);
  assert.ok(
    localLightStyle(magma.id).intensity < localLightStyle(torch.id).intensity
  );
  assert.ok(
    localLightStyle(magma.id).distance < localLightStyle(torch.id).distance
  );
  assert.equal(localLightStyle(BLOCK.STONE), null);
  assert.equal(localLightStyle(torch.id), localLightStyle(torch.id));
});

test("near-equal sources retain their slot but removal, movement and hidden chunks win immediately", () => {
  const first = { id: BLOCK.TORCH, x: 6, y: 0, z: 8 };
  const second = { id: BLOCK.TORCH, x: 10, y: 0, z: 8 };
  const column = group([first, second]);
  const chunks = new Map([["0,0", column]]);
  assert.deepEqual(
    selectLocalLightSources(chunks, { x: 8, y: 0, z: 8 }, 1, [{ ...second }]),
    [second]
  );
  assert.deepEqual(
    selectLocalLightSources(chunks, { x: 6, y: 0, z: 8 }, 1, [second]),
    [first],
    "retention cannot beat a materially nearer source"
  );
  column.userData.emitters = [first];
  assert.deepEqual(
    selectLocalLightSources(chunks, { x: 8, y: 0, z: 8 }, 1, [second]),
    [first]
  );
  column.visible = false;
  assert.deepEqual(
    selectLocalLightSources(chunks, { x: 8, y: 0, z: 8 }, 1, [first]),
    []
  );
});

test("duplicate, malformed, non-emissive and distant entries cannot occupy the light budget", () => {
  const source = { id: BLOCK.TORCH, x: 0.5, y: 0.5, z: 0.5 };
  const column = group([
    null,
    { ...source, x: NaN },
    { ...source, id: BLOCK.STONE },
    { ...source, id: 65535 },
    { ...source, y: 100 },
    source,
    { ...source },
  ]);
  const chunks = new Map([["0,0", column]]);
  assert.deepEqual(selectLocalLightSources(chunks, { x: 0, y: 0, z: 0 }, 2), [
    source,
  ]);
  const stats = {};
  assert.deepEqual(selectLocalLightSources(chunks, null, 2, [], stats), []);
  assert.deepEqual(stats, { columns: 0, emitters: 0, selected: 0 });
  assert.deepEqual(
    selectLocalLightSources(chunks, source, 0),
    [],
    "zero requested lights require no source reads"
  );
});

test("renderer refreshes only on schedule and clears both sources when their bucket disappears", () => {
  const column = group([
    { id: BLOCK.TORCH, x: 3, y: 20, z: 0.5 },
    { id: BLOCK.GLOW_BERRIES, x: 4, y: 20, z: 0.5 },
  ]);
  const graphics = Object.assign(Object.create(GameRenderer.prototype), {
    chunks: new Map([["0,0", column]]),
    quality: "high",
    lastLightTime: -Infinity,
    localLights: [new THREE.PointLight(), new THREE.PointLight()],
  });
  try {
    const position = new THREE.Vector3(1, 20, 1);
    graphics.updateLocalLights(1, position);
    assert.equal(graphics.lightStats.selected, 2);
    assert.ok(graphics.localLights.every((light) => light.intensity > 0));
    assert.ok(
      graphics.localLights.every(
        (light) => light.distance <= 10 && !light.castShadow
      ),
      "finite light pools do not allocate point-shadow maps"
    );
    graphics.chunks.clear();
    graphics.updateLocalLights(1.1, position);
    assert.equal(graphics.lastLightTime, 1);
    graphics.updateLocalLights(
      1 + LOCAL_LIGHT_LIMITS.refreshSeconds + 0.01,
      position
    );
    assert.equal(graphics.lightStats.selected, 0);
    assert.ok(graphics.localLights.every((light) => light.intensity === 0));
    assert.ok(
      graphics.localLights.every((light) => light.userData.emitter === null)
    );
  } finally {
    for (const light of graphics.localLights) light.dispose();
  }
});
