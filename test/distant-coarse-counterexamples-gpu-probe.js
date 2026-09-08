import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";
import { buildChunkGeometry } from "../src/chunk-mesh.js";
import { BLOCK } from "../src/blocks.js";
import { shapeWorld, shapeAtlas } from "./shape-fixture.js";

const biome = { id: "plains", category: "grassland", dimension: "overworld",
  color: "#83ac52", grassColor: "#83ac52", waterColor: "#4e9cac" };
const at = new THREE.Vector3(8, 48, 8.5);
const options = { radius: 12, quality: "medium", outdoors: true, budgetMs: 4,
  coverage: new Set(["0,0"]) };
function finish(lod, predicate, settings = options) {
  for (let i = 0; i < 2000; i++) {
    lod.update(at, settings);
    if (predicate()) return;
  }
  throw new Error("Counterexample did not reach its required publication state");
}

export function runCoarseCounterexamplesGPU() {
  const world = shapeWorld([], { generatorVersion: 3 });
  world.seed = "coarse-native-seam";
  world.spec = { ...world.spec, minY: 0, maxY: 96, seaLevel: 0 };
  world.generator = { terrainHeight: (_x, z) => z % 16 === 0 ? 63 : 31,
    getBiome: () => biome, getTrees: () => [] };
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++)
    for (let y = 0; y <= world.generator.terrainHeight(x, z); y++)
      world.put(x, y, z, BLOCK.STONE);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const native = new THREE.Group();
  const batches = buildChunkGeometry(world, 0, 0, shapeAtlas);
  for (const geometry of Object.values(batches))
    if (geometry?.isBufferGeometry) native.add(new THREE.Mesh(geometry, material));
  scene.add(native);
  const lod = new DistantTerrain(scene, world);
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setSize(64, 64);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0, 0);
  const target = new THREE.WebGLRenderTarget(64, 64);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 512);
  camera.position.copy(at);
  camera.lookAt(32, 32, 8.5);
  const capture = () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(64 * 64 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels);
    renderer.setRenderTarget(null);
    let drawn = 0;
    for (let i = 3; i < pixels.length; i += 4) drawn += pixels[i] > 0;
    return drawn;
  };
  let unknown;
  try {
    finish(lod, () => lod.ready && lod._active.data.request.bootstrap);
    const coarse = { drawn: capture(), complete: lod.terrainCoverageComplete,
      nativeMeshes: native.children.length, horizon: lod.fogDistance };
    finish(lod, () => lod.ready && !lod._active.data.request.bootstrap);
    const refined = { drawn: capture(), complete: lod.terrainCoverageComplete,
      horizon: lod.fogDistance };
    // Paired positive control: hiding all actual geometry must turn the entire
    // render target into background, so a decorative sky cannot pass the test.
    native.visible = false; lod.group.visible = false;
    const hiddenDrawn = capture();
    const unknownWorld = { seed: "unknown-interior", generatorVersion: 3,
      dimension: "overworld", spec: world.spec, generator: {
        terrainHeight: (x, z) => x === 8 && z === 8 ? NaN : 31,
        getBiome: () => biome,
      } };
    unknown = new DistantTerrain(new THREE.Scene(), unknownWorld);
    const settings = { ...options, coverage: new Set() };
    finish(unknown, () => !!unknown._active, settings);
    const unknownCoarse = { complete: unknown.terrainCoverageComplete,
      horizon: unknown.fogDistance, unknown: [...unknown._active.data.unknownChunks] };
    finish(unknown, () => unknown._active && !unknown._active.data.request.bootstrap, settings);
    const unknownRefined = { complete: unknown.terrainCoverageComplete,
      horizon: unknown.fogDistance, unknown: [...unknown._active.data.unknownChunks] };
    return { coarse, refined, hiddenDrawn, unknownCoarse, unknownRefined };
  } finally {
    unknown?.dispose(); lod.dispose();
    for (const mesh of native.children) mesh.geometry.dispose();
    material.dispose(); renderer.dispose(); target.dispose();
  }
}
