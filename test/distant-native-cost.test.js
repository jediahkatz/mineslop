import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as THREE from "three";
import { createGenerator } from "../src/terrain.js";
import { DistantTerrain } from "../src/distant-terrain.js";

const ref = process.env.LOD_NATIVE_BASELINE;
const root = new URL("../", import.meta.url);
const sourceURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function baseline() {
  const read = (name) => execFileSync("git", ["show", `${ref}:src/${name}`], { cwd: fileURLToPath(root), encoding: "utf8" });
  const resolve = (source, terraceURL, gridURL) => source.replace(/from "([^"]+)"/g, (_, spec) =>
    `from "${spec === "three" ? import.meta.resolve("three") :
      spec === "./distant-terraces.js" && terraceURL ? terraceURL :
      spec === "./distant-grid.js" && gridURL ? gridURL : new URL(`src/${spec}`, root).href}"`);
  const gridURL = sourceURL(resolve(read("distant-grid.js")));
  const terraceURL = sourceURL(resolve(read("distant-terraces.js"), undefined, gridURL));
  return (await import(sourceURL(resolve(read("distant-terrain.js"), terraceURL, gridURL)))).DistantTerrain;
}
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, worst: sorted.at(-1) ?? 0 };
};

function run(Type, dimension, quality, target) {
  const generator = createGenerator("cedar-valley", dimension, 3);
  const terrainHeight = generator.terrainHeight;
  let heightReads = 0, biomeReads = 0;
  generator.terrainHeight = (...args) => { heightReads++; return terrainHeight(...args); };
  const getBiome = generator.getBiome;
  generator.getBiome = (...args) => { biomeReads++; return getBiome(...args); };
  const world = { seed: "cedar-valley", generatorVersion: 3, dimension, generator, chunks: new Map(), edits: new Map(), _editRevision: 0 };
  const lod = new Type(new THREE.Scene(), world);
  const updates = [], busy = [], cpu = [], publications = [], landmarkPublications = [];
  const publish = lod._publish;
  lod._publish = (...args) => {
    const start = performance.now();
    try { return publish.apply(lod, args); }
    finally { publications.push(performance.now() - start); }
  };
  let bytes = 0, vertices = 0, meshes = 0, draws = 0;
  const retainedBuffers = new Set();
  const retain = (array) => { if (ArrayBuffer.isView(array)) retainedBuffers.add(array.buffer); };
  try {
    for (let frame = 0; frame < 1080; frame++) {
      const x = target.x + Math.floor(frame / 360) * 32;
      const cx = Math.floor(x / 16), cz = Math.floor(target.z / 16);
      const coverage = new Set();
      if (frame % 360 < 180)
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) coverage.add(`${cx + dx},${cz + dz}`);
      if (frame === 540 && dimension === "end") {
        const pillar = generator.getEndPillars()[0];
        world.edits.set(`end:${pillar.x},${pillar.top + 1},${pillar.z}`, { id: 0 });
        world._editRevision++;
      }
      const wasBusy = lod._job || lod._landmarks?.job;
      const landmarkMesh = lod._landmarks?.group.children[0];
      const before = process.cpuUsage(), start = performance.now();
      lod.update({ x, z: target.z }, { quality, outdoors: true, coverage, budgetMs: quality === "high" ? 2 : 1 });
      const elapsed = performance.now() - start, used = process.cpuUsage(before);
      updates.push(elapsed);
      cpu.push((used.user + used.system) / 1000);
      if (wasBusy || lod._job || lod._landmarks?.job || lod.lastWork.units ||
          lod._landmarks?.lastColumns) busy.push(elapsed);
      if (lod._landmarks?.group.children[0] && lod._landmarks.group.children[0] !== landmarkMesh)
        landmarkPublications.push(elapsed);
      assert.ok(lod.lastWork.samples <= 128 && lod.lastWork.units <= 512);
      assert.ok((lod._landmarks?.lastColumns ?? 0) <= 4);
      if (frame % 360 === 359) assert.ok(lod.ready && !lod._job, "native view completes before the next sweep");
    }
    lod.group.traverse((object) => {
      if (!object.isMesh) return;
      meshes++;
      if (object.visible && object.geometry.drawRange.count) draws++;
      vertices += object.geometry.attributes.position.count;
      bytes += object.geometry.index.array.byteLength;
      retain(object.geometry.index.array);
      retain(object.userData.landmarkSource?.indices);
      for (const attribute of Object.values(object.geometry.attributes)) {
        bytes += attribute.array.byteLength;
        retain(attribute.array);
      }
    });
    for (const value of Object.values(lod._active.data)) retain(value);
    for (const value of Object.values(lod._active.data.terraces)) retain(value);
    assert.equal(world.chunks.size, 0);
    return {
      update: stats(updates), busy: stats(busy), cpu: stats(cpu),
      publication: stats(publications), landmarkPublicationUpdate: stats(landmarkPublications),
      totalMs: updates.reduce((a, b) => a + b, 0), heightReads, biomeReads,
      bytes, vertices, meshes, draws,
      retainedTypedBytes: [...retainedBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      refined: lod._active.data.refinement?.size ?? 0,
      pillars: lod._landmarks?.group.userData.renderablePillars ?? 0,
    };
  } finally { lod.dispose(); }
}

test("matched native badlands/End camera updates retain bounded CPU, memory and query work", {
  skip: !ref && "set LOD_NATIVE_BASELINE to compare the shipped LOD",
}, async (t) => {
  const Old = await baseline();
  const native = createGenerator("cedar-valley", "overworld", 3);
  const badlands = native.locateBiome("eroded_badlands", { x: 0, z: 0 });
  for (const dimension of ["end", "overworld"])
    for (const quality of ["low", "high"]) {
      const target = dimension === "end" ? { x: 0, z: 90 } : badlands;
      for (let repeat = 0; repeat < 3; repeat++) {
        const order = repeat % 2 ? [DistantTerrain, Old] : [Old, DistantTerrain];
        const result = {};
        for (const Type of order) result[Type === Old ? "baseline" : "current"] = run(Type, dimension, quality, target);
        t.diagnostic(JSON.stringify({ dimension, quality, repeat, target, result }));
      }
    }
});
