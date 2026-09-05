import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { BIOME_PROFILES, getBiomeById } from "../src/biomes.js";
import { installDistantSurface } from "../src/distant-surface-material.js";
import { DistantTerrain, DISTANT_TERRAIN_LIMITS } from "../src/distant-terrain.js";
import { DISTANT_TERRACE_LIMITS } from "../src/distant-terraces.js";
import { getBiomeTint } from "../src/mesh-palette.js";
import { createGenerator } from "../src/terrain.js";
import { strata } from "../src/terrain-profiles.js";
import { DaylightMaterial } from "../src/daylight-material.js";

const atlas = () => ({
  texture: new THREE.DataTexture(new Uint8Array(4), 1, 1),
  uvFor: (id, face) => [id / 4096, face === "top" ? 0.5 : 0, (id + 1) / 4096, 1],
});
function shaderFor(material) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader);
  return shader;
}
function finish(lod, position, quality = "low", allowRejectedVegetation = false) {
  for (let tick = 0; tick < 2400; tick++) {
    lod.update(position, { outdoors: true, quality, budgetMs: 4 });
    assert.ok(lod.lastWork.samples <= DISTANT_TERRAIN_LIMITS.samplesPerUpdate);
    assert.ok(lod.lastWork.units <= DISTANT_TERRAIN_LIMITS.workPerUpdate);
    if ((lod.ready || (allowRejectedVegetation && lod._active && lod._vegetationRejected)) &&
      !lod._job && !lod._vegetationJob && !lod._landmarks?.job) return lod._active;
  }
  assert.fail("bounded atlas surface did not finish");
}

test("atlas shader shares native texture, owns only bounded rectangle lookup, and preserves default meshes", () => {
  const shared = atlas(), material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const version = installDistantSurface(material, shared);
  const shader = shaderFor(material);
  const uniforms = shader.uniforms;
  assert.equal(uniforms.uLodAtlas.value, shared.texture);
  assert.equal(uniforms.uLodVersion, version);
  assert.deepEqual(uniforms.uLodBandIds.value, strata);
  const tiles = uniforms.uLodTiles.value;
  assert.equal(tiles.image.width, 2);
  assert.equal(tiles.image.height, Math.max(...BLOCK_CATALOG.map((b) => b.id)) + 1);
  assert.ok(tiles.image.data.byteLength < 128 * 1024, "catalog-sized lookup, not per-view atlas copies");
  assert.equal(tiles.generateMipmaps, false);
  for (const id of [BLOCK.GRASS, BLOCK.END_STONE, BLOCK.DIRT, BLOCK.ORANGE_TERRACOTTA]) {
    assert.deepEqual([...tiles.image.data.subarray(id * 8, id * 8 + 4)], shared.uvFor(id, "side"));
    assert.deepEqual([...tiles.image.data.subarray(id * 8 + 4, id * 8 + 8)], shared.uvFor(id, "top"));
  }
  assert.deepEqual(material.defaultAttributeValues.lodBlocks, [0, 0, 0]);
  assert.match(shader.fragmentShader, /if \(vLodBlocks.x > 0.5\)/);
  assert.match(shader.fragmentShader, /y >= top - 3.0 \? vLodBlocks.y/);
  assert.match(shader.fragmentShader, /y < top - 3.0/);
  assert.match(shader.fragmentShader, /top - y > 10.0/);
  assert.doesNotMatch(shader.fragmentShader, /lodGrain|uLodBands/);
  let lookupDisposals = 0, atlasDisposals = 0;
  tiles.addEventListener("dispose", () => lookupDisposals++);
  shared.texture.addEventListener("dispose", () => atlasDisposals++);
  material.dispose();
  material.dispose();
  assert.equal(lookupDisposals, 2, "lookup ownership survives context-recovery disposal");
  assert.equal(atlasDisposals, 0);
});

test("no-atlas fixtures retain the existing material and flat lattice fast path", () => {
  const world = { seed: "compatibility", dimension: "overworld", generatorVersion: 3,
    generator: { getBiome: () => getBiomeById("plains"), terrainHeight: () => 32 } };
  const lod = new DistantTerrain(new THREE.Scene(), world);
  try {
    const { data, terrain } = finish(lod, { x: 0, z: 0 });
    assert.equal(data.blockData, null);
    assert.equal(terrain.geometry.getAttribute("lodBlocks"), undefined);
    assert.equal(data.terraces.positions.buffer, data.positions.buffer);
    assert.match(shaderFor(lod._terrainMaterial).fragmentShader, /lodGrain/);
  } finally { lod.dispose(); }
});

for (const colorMode of ["RGB", "RGBA"]) {
  test(`atlas tint uses a three-component swizzle with Three's ${colorMode} color path`, () => {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    installDistantSurface(material, atlas());
    const shader = shaderFor(material);
    // Current Three promotes both color attribute widths to a vec4 varying.
    // Multiplication by the whole varying compiled in older Three but now
    // fails even for an RGB BufferAttribute.
    assert.match(THREE.ShaderChunk.color_pars_fragment, /varying vec4 vColor/);
    assert.match(THREE.ShaderChunk.color_vertex, colorMode === "RGBA"
      ? /#ifdef USE_COLOR_ALPHA\s+vColor \*= color;/
      : /#elif defined\( USE_COLOR \)\s+vColor.rgb \*= color;/);
    assert.match(shader.fragmentShader,
      /#if defined\(USE_COLOR\) \|\| defined\(USE_COLOR_ALPHA\)\s+if \(up && y >= top\) diffuseColor.rgb \*= vColor.rgb;/);
    assert.doesNotMatch(shader.fragmentShader, /diffuseColor.rgb \*= vColor;/);
    assert.deepEqual(material.defaultAttributeValues.lodBlocks, [0, 0, 0]);
    material.dispose();
  });
}

test("daylight wrapping retains atlas uniforms, exterior lighting and the program key", () => {
  const shared = atlas(), material = new THREE.MeshLambertMaterial({ vertexColors: true });
  installDistantSurface(material, shared);
  // Exercise the real hook-chaining method without allocating unused fields.
  const lighting = { installed: new WeakSet(), binding: 1, uniforms: { uDaylightEnabled: { value: 1 } } };
  DaylightMaterial.prototype.install.call(lighting, material, true);
  const shader = shaderFor(material);
  assert.equal(shader.uniforms.uLodAtlas.value, shared.texture);
  assert.equal(shader.uniforms.uDaylightEnabled, lighting.uniforms.uDaylightEnabled);
  assert.match(shader.fragmentShader, /#define MINESLOP_EXTERIOR_DAYLIGHT/);
  assert.match(shader.fragmentShader, /texture2D\(uLodAtlas/);
  assert.match(material.customProgramCacheKey(), /^distant-surface-native-atlas-v2:daylight-/);
  material.dispose();
});

for (const flat of [false, true]) {
  test(`atlas ${flat ? "flat" : "stepped"} caps and risers use one owning palette across biome boundaries`, () => {
    const biomes = ["plains", "snowy_plains", "badlands"].map(getBiomeById);
    let samples = 0;
    const height = flat ? () => 64 : (x, z) => 64 + Math.floor(10 * Math.sin(x / 27) * Math.cos(z / 31));
    const generator = {
      terrainHeight(x, z) { samples++; return height(x, z); },
      getBiome: (x) => biomes[Math.abs(Math.floor(x / 16)) % biomes.length],
      generateRegion() { assert.fail("LOD must not generate voxels"); },
    };
    const lod = new DistantTerrain(new THREE.Scene(), { generator, seed: "owners", generatorVersion: 3 }, { atlas: atlas() });
    try {
      const { data, terrain } = finish(lod, { x: -24, z: -24 });
      const emitted = data.terraces;
      assert.equal(samples, data.count, "one height sample per lattice vertex");
      assert.equal(terrain.geometry.getAttribute("lodBlocks").array, emitted.blockData);
      assert.ok(emitted.blockData instanceof Uint16Array);
      for (const cell of data.cells) {
        if (!cell.valid) continue;
        const owner = cell.anchor ?? cell.ring[0], offset = owner * 3;
        const x = data.originX + data.positions[offset], z = data.originZ + data.positions[offset + 2];
        const biome = generator.getBiome(x, z), profile = BIOME_PROFILES[biome.id];
        const expected = [profile.surface, profile.soil, profile.rock];
        const tint = new Float32Array(getBiomeTint(profile.surface, "top", biome));
        for (let i = cell.terraceStart; i < cell.terraceStart + cell.terraceCount; i++) {
          const start = emitted.indices[i] * 3;
          assert.deepEqual([...emitted.blockData.subarray(start, start + 3)], expected);
          assert.deepEqual([...emitted.colors.subarray(start, start + 3)], [...tint]);
          assert.deepEqual([...emitted.surfaceData.subarray(start, start + 3)], [...data.surfaceData.subarray(offset, offset + 3)]);
        }
      }
      assert.ok(emitted.positions.length / 3 <= DISTANT_TERRACE_LIMITS.vertices);
      assert.ok(emitted.indices.length <= DISTANT_TERRACE_LIMITS.indices);
      const blocks = terrain.geometry.getAttribute("lodBlocks");
      lod.update({ x: -24, z: -24 }, { outdoors: true, quality: "low", coverage: new Set(["-2,-2"]), budgetMs: 0 });
      assert.equal(terrain.geometry.getAttribute("lodBlocks"), blocks);
      assert.equal(samples, data.count, "cutouts do not resample material data");
    } finally { lod.dispose(); }
  });
}

for (const dimension of ["overworld", "end"]) for (const quality of ["low", "high"]) {
  test(`native v7 ${dimension}/${quality} atlas retains sample, mesh and memory bounds`, (t) => {
    const generator = createGenerator("cedar-valley", dimension, 7);
    generator.generateChunk = generator.generateRegion = () => assert.fail("no voxel generation in LOD");
    const world = { generator, seed: "cedar-valley", generatorVersion: 7, dimension, spec: generator.spec, chunks: new Map() };
    const shared = atlas(), lod = new DistantTerrain(new THREE.Scene(), world, { atlas: shared });
    try {
      const position = dimension === "end" ? { x: 0, z: 260 } : { x: 0, z: 0 };
      const { data, terrain } = finish(lod, position, quality, true);
      if (lod._vegetationRejected) {
        // This dense native high-quality pose already exceeds canopy admission.
        // The surface change must preserve that conservative no-partial-forest
        // behavior; it must not turn budget rejection into rendered coverage.
        const baseline = new DistantTerrain(new THREE.Scene(), world);
        try {
          finish(baseline, position, quality, true);
          assert.equal(baseline.vegetationRejections, lod.vegetationRejections);
          assert.equal(baseline.ready, false);
          assert.equal(lod.ready, false);
          assert.equal(baseline._active.data.count, data.count);
        } finally { baseline.dispose(); }
      }
      let bytes = 0, meshes = 0;
      lod.group.traverse((mesh) => {
        if (!mesh.isMesh) return;
        meshes++;
        bytes += mesh.geometry.index.array.byteLength;
        for (const attribute of Object.values(mesh.geometry.attributes)) bytes += attribute.array.byteLength;
        if (mesh !== terrain) assert.equal(mesh.geometry.getAttribute("lodBlocks"), undefined);
      });
      assert.ok(bytes < 12 * 1024 * 1024);
      assert.ok(meshes <= 3);
      assert.ok(data.count <= 16384);
      assert.equal(world.chunks.size, 0);
      for (let i = 0; i < data.count; i++) {
        const x = data.originX + data.positions[i * 3], z = data.originZ + data.positions[i * 3 + 2];
        const column = generator.sampleColumn(x, z);
        assert.equal(data.blockData[i * 3], column.surface);
        assert.equal(data.blockData[i * 3 + 1], column.soil);
        if (dimension === "overworld") assert.equal(data.blockData[i * 3 + 2], BLOCK.STONE);
        assert.equal(data.surfaceData[i * 3 + 1],
          Number.isFinite(column.landTop) ? column.landTop : world.spec.minY);
      }
      assert.equal(lod._surfaceVersion.value, 7);
      t.diagnostic(JSON.stringify({ dimension, quality, samples: data.count, meshes, bytes,
        ready: lod.ready, vegetationRejections: lod.vegetationRejections }));
    } finally { lod.dispose(); }
  });
}

test("v7 badlands uses native soil above two-block strata and stone beneath the banded cap", () => {
  const generator = createGenerator("cedar-valley", "overworld", 7);
  const position = generator.locateBiome("badlands", { x: 0, z: 0 });
  assert.ok(position);
  const lod = new DistantTerrain(new THREE.Scene(), {
    generator, seed: "cedar-valley", generatorVersion: 7, dimension: "overworld", spec: generator.spec,
  }, { atlas: atlas() });
  try {
    const { data } = finish(lod, position, "low", true);
    const bands = shaderFor(lod._terrainMaterial).uniforms.uLodBandIds.value;
    let checked = 0;
    for (let i = 0; i < data.count && checked < 8; i++) {
      if (!data.badlands[i]) continue;
      const x = data.originX + data.positions[i * 3], z = data.originZ + data.positions[i * 3 + 2];
      const col = generator.sampleColumn(x, z);
      if (col.top !== col.landTop || col.landTop < 80) continue;
      const raster = generator.generateRegion(x, z, 1, 1);
      const at = (y) => raster.blocks[y - generator.spec.minY];
      if (at(col.landTop) !== col.surface) continue;
      assert.deepEqual([...data.blockData.subarray(i * 3, i * 3 + 3)], [col.surface, col.soil, BLOCK.STONE]);
      assert.equal(data.surfaceData[i * 3], col.strataOffset);
      assert.equal(data.surfaceData[i * 3 + 1], col.landTop);
      for (let depth = 1; depth <= 3; depth++) assert.equal(at(col.landTop - depth), col.soil);
      for (let depth = 4; depth <= 10; depth++) {
        const y = col.landTop - depth;
        if (at(y) === BLOCK.AIR) continue; // Render-only LOD intentionally omits caves.
        const layer = Math.floor((y + col.strataOffset) / 2);
        assert.equal(at(y), bands[((layer % 12) + 12) % 12]);
      }
      checked++;
    }
    assert.ok(checked > 0, "test native badlands, not an unrelated neighboring biome");
  } finally { lod.dispose(); }
});
