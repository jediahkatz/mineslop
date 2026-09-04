import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { getBiomeTint } from "../src/chunk-mesh.js";
import { createMiningTextures } from "../src/mining-art.js";
import {
  buildChunkGeometry,
  createChunkMaterials,
  GameRenderer,
  qualityFogDistance,
} from "../src/renderer.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../src/terrain.js";
import { attachRendererLight, rendererLightWorld, settleRendererLight } from "./renderer-block-light-fixture.js";

const atlas = {
  texture: new THREE.Texture(),
  emissiveTexture: new THREE.Texture(),
  uvFor: () => [0, 0, 1, 1],
};
const worldWith = (blocks) => {
  const cells = new Map(blocks.map(([x, y, z, id]) => [`${x},${y},${z}`, id]));
  return { get: (x, y, z) => cells.get(`${x},${y},${z}`) ?? 0 };
};

function triangles(geometry) {
  return (geometry?.index.count ?? 0) / 3;
}

function dispose(batches) {
  Object.values(batches).forEach((geometry) => geometry?.dispose());
}

test("isolated block emits six outward-facing textured quads", () => {
  const batches = buildChunkGeometry(worldWith([[1, 2, 3, 1]]), 0, 0, atlas);
  const geometry = batches.opaque;
  assert.equal(triangles(geometry), 12);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  assert.equal(position.count, 24);
  for (let i = 0; i < geometry.index.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((n) => geometry.index.getX(i + n));
    const ab = [0, 1, 2].map(
      (axis) => position.array[b * 3 + axis] - position.array[a * 3 + axis]
    );
    const ac = [0, 1, 2].map(
      (axis) => position.array[c * 3 + axis] - position.array[a * 3 + axis]
    );
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const dot = cross.reduce(
      (sum, value, axis) => sum + value * normal.array[a * 3 + axis],
      0
    );
    assert.ok(dot > 0, "triangle winding points out of the block");
  }
  assert.ok([...uv.array].every((value) => value >= 0 && value <= 1));
  dispose(batches);
});

test("adjacent solid blocks omit their two shared faces", () => {
  const batches = buildChunkGeometry(
    worldWith([
      [1, 2, 3, 1],
      [2, 2, 3, 3],
    ]),
    0,
    0,
    atlas
  );
  assert.equal(triangles(batches.opaque), 20);
  dispose(batches);
});

test("chunk meshing culls neighbors across positive and negative boundaries", () => {
  const world = worldWith([
    [-1, 2, 0, 3],
    [0, 2, 0, 3],
  ]);
  const left = buildChunkGeometry(world, -1, 0, atlas);
  const right = buildChunkGeometry(world, 0, 0, atlas);
  assert.equal(triangles(left.opaque), 10);
  assert.equal(triangles(right.opaque), 10);
  dispose(left);
  dispose(right);
});

test("glass, water, and leaves are separate batches with internal faces culled", () => {
  for (const [id, batch] of [
    [9, "glass"],
    [11, "water"],
    [6, "foliage"],
  ]) {
    const batches = buildChunkGeometry(
      worldWith([
        [1, 2, 3, id],
        [2, 2, 3, id],
      ]),
      0,
      0,
      atlas
    );
    assert.equal(triangles(batches[batch]), 20);
    assert.equal(batches.opaque, null);
    assert.ok(
      [...batches[batch].getAttribute("position").array].every(Number.isFinite)
    );
    dispose(batches);
  }
});

test("flowers render as crossed foliage planes, not solid cubes", () => {
  const batches = buildChunkGeometry(worldWith([[1, 2, 3, 18]]), 0, 0, atlas);
  assert.equal(triangles(batches.foliage), 4);
  assert.equal(batches.opaque, null);
  dispose(batches);
});

test("ceiling vine segments meet their rock anchor and berry tips supply bounded real light", () => {
  const batches = buildChunkGeometry(
    worldWith([
      [3, 25, 5, BLOCK.STONE],
      [3, 24, 5, BLOCK.CAVE_VINE],
      [3, 23, 5, BLOCK.GLOW_BERRIES],
    ]),
    0,
    0,
    atlas
  );
  assert.equal(
    triangles(batches.opaque),
    12,
    "the rock ceiling remains real geometry"
  );
  assert.equal(triangles(batches.foliage), 4);
  assert.equal(
    triangles(batches.berryFoliage),
    4,
    "berry tips are lit cutouts, not full-bright plants or cubes"
  );
  assert.equal(batches.emissive, null);
  const vine = batches.foliage.getAttribute("position");
  const tip = batches.berryFoliage.getAttribute("position");
  assert.equal(
    Math.max(...Array.from({ length: vine.count }, (_, i) => vine.getY(i))),
    25
  );
  assert.equal(
    Math.max(...Array.from({ length: tip.count }, (_, i) => tip.getY(i))),
    24
  );
  assert.deepEqual(batches.berryFoliage.userData.emitters, [
    { x: 3.5, y: 23.3, z: 5.5, id: BLOCK.GLOW_BERRIES },
  ]);
  dispose(batches);

  const crowded = buildChunkGeometry(
    worldWith(
      Array.from({ length: 32 }, (_, i) => [
        i % 16,
        20,
        Math.floor(i / 16),
        BLOCK.GLOW_BERRIES,
      ])
    ),
    0,
    0,
    atlas
  );
  assert.ok(
    crowded.berryFoliage.userData.emitters.length <= 12,
    "existing chunk light budget"
  );
  dispose(crowded);
});

test("masked berries and unlit sources share one emitter budget without displacing placed torches", () => {
  const batches = buildChunkGeometry(
    worldWith([
      ...Array.from({ length: 32 }, (_, i) => [
        i % 16,
        20,
        Math.floor(i / 16),
        BLOCK.GLOW_BERRIES,
      ]),
      [15, 20, 15, BLOCK.TORCH],
    ]),
    0,
    0,
    atlas
  );
  const sources = Object.values(batches).flatMap(
    (geometry) => geometry?.userData.emitters ?? []
  );
  assert.equal(sources.length, 12);
  assert.deepEqual(batches.emissive.userData.emitters, [
    { x: 15.5, y: 20.7, z: 15.5, id: BLOCK.TORCH },
  ]);
  assert.equal(batches.berryFoliage.userData.emitters.length, 11);
  dispose(batches);
});

test("green berry foliage uses scene lighting and only its fruit mask self-emits", () => {
  const materials = createChunkMaterials(atlas);
  try {
    for (const name of ["foliage", "berryFoliage", "opaque"]) {
      assert.equal(materials[name].isMeshLambertMaterial, true, name);
      assert.equal(materials[name].map, atlas.texture);
    }
    assert.equal(materials.foliage.emissive.getHex(), 0);
    assert.equal(materials.opaque.emissive.getHex(), 0);
    assert.equal(materials.berryFoliage.emissiveMap, atlas.emissiveTexture);
    assert.ok(materials.berryFoliage.emissive.getHex() > 0);
    assert.ok(
      materials.berryFoliage.emissiveIntensity > 0 &&
        materials.berryFoliage.emissiveIntensity < 1
    );
    assert.ok(materials.berryFoliage.alphaTest > 0);
    assert.equal(materials.berryFoliage.side, THREE.DoubleSide);
    assert.equal(
      materials.emissive.isMeshBasicMaterial,
      true,
      "native torches/lava keep their existing rendering path"
    );
  } finally {
    Object.values(materials).forEach((material) => material.dispose());
  }
});

test("empty chunks allocate no geometry", () => {
  const batches = buildChunkGeometry(worldWith([]), 0, 0, atlas);
  assert.ok(Object.values(batches).every((geometry) => geometry === null));
});

test("the highest world layer renders and blocks above it do not", () => {
  const batches = buildChunkGeometry(
    worldWith([
      [1, WORLD_HEIGHT - 1, 2, BLOCK.STONE],
      [4, WORLD_HEIGHT, 2, BLOCK.STONE],
    ]),
    0,
    0,
    atlas
  );
  assert.equal(triangles(batches.opaque), 12);
  const positions = batches.opaque.getAttribute("position");
  assert.equal(
    Math.max(
      ...Array.from({ length: positions.count }, (_, i) => positions.getY(i))
    ),
    WORLD_HEIGHT
  );
  dispose(batches);
});

test("diagonal AO outside a chunk darkens the shared top corner", () => {
  const batches = buildChunkGeometry(
    worldWith([
      [15, 2, 15, BLOCK.STONE],
      [16, 3, 15, BLOCK.STONE],
      [15, 3, 16, BLOCK.STONE],
      [16, 3, 16, BLOCK.STONE],
    ]),
    0,
    0,
    atlas
  );
  const geometry = batches.opaque;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const color = geometry.getAttribute("color");
  const corner = Array.from({ length: position.count }, (_, i) => i).find(
    (i) =>
      position.getX(i) === 16 &&
      position.getZ(i) === 16 &&
      position.getY(i) === 3 &&
      normal.getY(i) === 1
  );
  assert.notEqual(corner, undefined);
  assert.ok(Math.abs(color.getX(corner) - 0.52) < 0.001);
  dispose(batches);
});

test("all foliage species share a cutout batch without internal canopy faces", () => {
  const batches = buildChunkGeometry(
    worldWith([
      [1, 2, 3, BLOCK.SPRUCE_LEAVES],
      [2, 2, 3, BLOCK.CHERRY_LEAVES],
    ]),
    0,
    0,
    atlas
  );
  assert.equal(triangles(batches.foliage), 20);
  dispose(batches);
});

test("cross plants retain outward unit normals and lily pads lie flat", () => {
  for (const id of [BLOCK.BAMBOO, BLOCK.FERN, BLOCK.CHORUS, BLOCK.LILY_PAD]) {
    const batches = buildChunkGeometry(worldWith([[1, 2, 3, id]]), 0, 0, atlas);
    const geometry = batches.foliage;
    assert.equal(triangles(geometry), id === BLOCK.LILY_PAD ? 2 : 4);
    const normals = geometry.getAttribute("normal");
    for (let i = 0; i < normals.count; i++)
      assert.ok(
        Math.abs(
          Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i)) - 1
        ) < 0.001
      );
    if (id === BLOCK.LILY_PAD) {
      const positions = geometry.getAttribute("position");
      assert.ok(
        Array.from({ length: positions.count }, (_, i) =>
          positions.getY(i)
        ).every((y) => Math.abs(y - 2.06) < 0.001)
      );
    }
    dispose(batches);
  }
});

test("torches, lava and portal blocks stay in the unlit emissive batch", () => {
  for (const id of [
    BLOCK.TORCH,
    BLOCK.LAVA,
    BLOCK.GLOWSTONE,
    BLOCK.NETHER_PORTAL,
    BLOCK.SCULK,
  ]) {
    const batches = buildChunkGeometry(worldWith([[0, 3, 0, id]]), 0, 0, atlas);
    assert.ok(batches.emissive, BLOCKS[id].name);
    assert.equal(batches.opaque, null);
    assert.ok(
      [...batches.emissive.getAttribute("color").array].every(
        (value) => value >= 0.9
      )
    );
    assert.ok(batches.emissive.userData.emitters.length > 0);
    dispose(batches);
  }
});

test("biome colors affect grass, foliage and water but retain pink blossom and bark palettes", () => {
  const dry = {
    grassColor: "#b3aa52",
    foliageColor: "#989540",
    waterColor: "#657b50",
  };
  const lush = {
    grassColor: "#52a24a",
    foliageColor: "#388538",
    waterColor: "#3385c7",
  };
  for (const [id, face] of [
    [BLOCK.GRASS, "top"],
    [BLOCK.LEAVES, "side"],
    [BLOCK.WATER, "top"],
  ]) {
    assert.notDeepEqual(
      getBiomeTint(id, face, dry),
      getBiomeTint(id, face, lush)
    );
  }
  for (const [id, face] of [
    [BLOCK.GRASS, "side"],
    [BLOCK.OAK_LOG, "side"],
    [BLOCK.CHERRY_LEAVES, "side"],
    [BLOCK.PALE_LEAVES, "side"],
  ]) {
    assert.deepEqual(getBiomeTint(id, face, dry), [1, 1, 1]);
  }
  const world = worldWith([[1, 3, 1, BLOCK.WATER]]);
  world.getBiome = () => dry;
  const batches = buildChunkGeometry(world, 0, 0, atlas);
  const color = batches.water.getAttribute("color");
  assert.notEqual(color.getX(0), color.getZ(0));
  dispose(batches);
});

function streamingWorld(entries) {
  const chunks = new Map();
  for (const [cx, cz, cells = [[1, 2, 1, BLOCK.STONE]]] of entries) {
    const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    for (const [x, y, z, id] of cells)
      blocks[y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x] = id;
    chunks.set(`${cx},${cz}`, { cx, cz, blocks });
  }
  return {
    dimension: "overworld",
    chunks,
    dirtyChunks: new Set(chunks.keys()),
    removedChunks: new Set(),
    get() {
      throw new Error(
        "Meshing streaming chunks must read the cached voxel apron"
      );
    },
  };
}

function headlessRenderer(world) {
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    world,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    atlas,
    chunks: new Map(),
    quality: "low",
    viewCenter: null,
    dimension: world.dimension,
    materials: createChunkMaterials(atlas),
  });
  return renderer;
}

function disposeRenderer(renderer) {
  for (const key of renderer.chunks.keys()) renderer.removeChunk(key);
  Object.values(renderer.materials).forEach((material) => material.dispose());
}

test("a berry-only light survives a real chunk rebuild without emissive cube geometry", (t) => {
  const world = rendererLightWorld(t, [
    [3, 25, 5, BLOCK.STONE],
    [3, 24, 5, BLOCK.GLOW_BERRIES],
    [4, 23, 5, BLOCK.STONE],
  ]);
  const renderer = headlessRenderer(world);
  renderer.camera.position.set(3.5, 23, 5.5);
  renderer.localLights = [new THREE.PointLight(), new THREE.PointLight()];
  attachRendererLight(t, renderer);
  // Neighboring rock's top face: not the emitter cell or emissive plant art.
  const receiver = { x: 4.5, y: 24.02, z: 5.5 };
  try {
    renderer.rebuildDirty(Infinity);
    const group = renderer.chunks.get("0,0");
    assert.deepEqual(group.userData.emitters, [
      { x: 3.5, y: 24.3, z: 5.5, id: BLOCK.GLOW_BERRIES },
    ]);
    assert.ok(
      group.children.every(
        (mesh) => mesh.material !== renderer.materials.emissive
      )
    );
    const plant = group.children.find(
      (mesh) => mesh.material === renderer.materials.berryFoliage
    );
    assert.ok(plant?.castShadow && plant.receiveShadow);
    settleRendererLight(renderer);
    const lit = renderer.blockLight.sample(receiver);
    assert.equal(world.get(4, 23, 5), BLOCK.STONE);
    assert.equal(world.get(4, 24, 5), BLOCK.AIR);
    assert.ok(lit[0] > 0.3 && lit[1] > 0 && lit[2] > 0, "berry field reaches the neighboring stone receiver");
    assert.deepEqual(renderer.blockLight.sample({ x: 3.5, y: 25.5, z: 5.5 }), [0, 0, 0], "opaque rock interior is not a receiver");
    const page = renderer.blockLight.cache.get("0,0,1");
    renderer.removeChunk("0,0");
    settleRendererLight(renderer);
    assert.deepEqual(renderer.blockLight.sample(receiver), lit, "mesh removal cannot remove world emission");
    world.dirtyChunks.add("0,0");
    renderer.rebuildDirty(Infinity);
    settleRendererLight(renderer);
    assert.deepEqual(renderer.blockLight.sample(receiver), lit, "rebuilding unchanged geometry preserves light");
    assert.equal(renderer.blockLight.cache.get("0,0,1"), page, "unchanged field page is reused");

    assert.equal(world.set(3, 24, 5, BLOCK.AIR), true);
    settleRendererLight(renderer);
    assert.deepEqual(renderer.blockLight.sample(receiver), [0, 0, 0], "real World removal invalidates the light before remeshing");
    renderer.rebuildDirty(Infinity);
    settleRendererLight(renderer);
    assert.deepEqual(renderer.chunks.get("0,0").userData.emitters, []);
    assert.deepEqual(renderer.blockLight.sample(receiver), [0, 0, 0], "rebuild cannot resurrect a removed berry");
    t.diagnostic(JSON.stringify({ berryReceiver: receiver, lit, removed: renderer.blockLight.sample(receiver) }));
  } finally {
    disposeRenderer(renderer);
    renderer.localLights.forEach((light) => light.dispose());
  }
});

test("streamed snapshots cull across negative boundaries without world.get calls", () => {
  const world = streamingWorld([
    [-1, 0, [[15, 2, 0, BLOCK.STONE]]],
    [0, 0, [[0, 2, 0, BLOCK.STONE]]],
  ]);
  const left = buildChunkGeometry(world, -1, 0, atlas);
  const right = buildChunkGeometry(world, 0, 0, atlas);
  assert.equal(triangles(left.opaque), 10);
  assert.equal(triangles(right.opaque), 10);
  dispose(left);
  dispose(right);
});

test("far chunk geometry uses local coordinates so floating point detail is preserved", () => {
  const world = streamingWorld([
    [1_000_000, -1_000_000, [[2, 80, 14, BLOCK.GLASS]]],
  ]);
  const batches = buildChunkGeometry(world, 1_000_000, -1_000_000, atlas);
  const position = batches.glass.getAttribute("position");
  assert.ok(
    Array.from({ length: position.count }, (_, i) => position.getX(i)).every(
      (x) => x === 2 || x === 3
    )
  );
  assert.ok(
    Array.from({ length: position.count }, (_, i) => position.getZ(i)).every(
      (z) => z === 14 || z === 15
    )
  );
  dispose(batches);
});

test("unloaded chunks never turn into phantom meshes", () => {
  const world = streamingWorld([]);
  assert.ok(
    Object.values(buildChunkGeometry(world, 4, 2, atlas)).every(
      (geometry) => geometry === null
    )
  );
  world.dirtyChunks.add("4,2");
  const renderer = headlessRenderer(world);
  assert.equal(renderer.rebuildDirty(Infinity), 0);
  assert.equal(renderer.chunks.size, 0);
  assert.equal(world.dirtyChunks.size, 0);
  disposeRenderer(renderer);
});

test("dirty rebuilds respect their per-frame budget and retain pending work", () => {
  const world = streamingWorld([
    [0, 0],
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]);
  const renderer = headlessRenderer(world);
  const rebuilt = renderer.rebuildDirty();
  assert.ok(rebuilt > 0 && rebuilt <= 2);
  assert.equal(renderer.chunks.size, rebuilt);
  assert.equal(world.dirtyChunks.size, 5 - rebuilt);
  assert.ok(renderer.chunks.has("0,0"), "nearest chunk builds first");
  assert.equal(renderer.rebuildDirty(0), 0);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.chunks.size, 5);
  assert.equal(world.dirtyChunks.size, 0);
  disposeRenderer(renderer);
});

test("eviction disposes removed geometry even when rebuilding is paused", () => {
  const world = streamingWorld([
    [0, 0],
    [1, 0],
  ]);
  const renderer = headlessRenderer(world);
  renderer.rebuildDirty(Infinity);
  let disposed = 0;
  renderer.chunks
    .get("0,0")
    .children[0].geometry.addEventListener("dispose", () => disposed++);
  world.chunks.delete("0,0");
  world.removedChunks.add("0,0");
  world.dirtyChunks.add("0,0");
  assert.equal(renderer.rebuildDirty(0), 0);
  assert.equal(disposed, 1);
  assert.equal(renderer.chunks.has("0,0"), false);
  assert.equal(world.removedChunks.size, 0);
  assert.equal(world.dirtyChunks.has("0,0"), false);
  disposeRenderer(renderer);
});

test("padding is not meshed until it enters the render radius", () => {
  const world = streamingWorld([
    [0, 0],
    [3, 0],
  ]);
  const renderer = headlessRenderer(world);
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.chunks.has("3,0"), false);
  renderer.camera.position.x = CHUNK_SIZE;
  renderer.rebuildDirty(Infinity);
  assert.equal(renderer.chunks.has("3,0"), true);
  assert.equal(renderer.chunks.get("3,0").position.x, 3 * CHUNK_SIZE);
  disposeRenderer(renderer);
});

test("a dimension switch rebuilds identical chunk keys instead of reusing the previous dimension", () => {
  const world = streamingWorld([[0, 0]]);
  const renderer = headlessRenderer(world);
  renderer.rebuildDirty(Infinity);
  const old = renderer.chunks.get("0,0");
  let disposed = false;
  old.children[0].geometry.addEventListener("dispose", () => {
    disposed = true;
  });
  world.dimension = "nether";
  renderer.rebuildDirty(Infinity);
  assert.equal(disposed, true);
  assert.notEqual(renderer.chunks.get("0,0"), old);
  disposeRenderer(renderer);
});

test("fog ends before the loaded edge and tightens around unfinished meshes", () => {
  const entries = [];
  for (let z = -2; z <= 2; z++)
    for (let x = -2; x <= 2; x++) entries.push([x, z, []]);
  const renderer = headlessRenderer(streamingWorld(entries));
  renderer.camera.position.set(8, 20, 8);
  renderer.rebuildDirty(Infinity);
  const full = renderer.streamingFogDistance(renderer.camera.position);
  assert.equal(full, qualityFogDistance(renderer.renderRadius));
  assert.ok(full < renderer.renderRadius * CHUNK_SIZE);
  renderer.removeChunk("2,0");
  assert.ok(renderer.streamingFogDistance(renderer.camera.position) < full);
  disposeRenderer(renderer);
});

test("quality changes update the mesh radius, fog and GPU feature budgets", () => {
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  const renderer = headlessRenderer(
    streamingWorld([
      [0, 0],
      [3, 0],
    ])
  );
  renderer.renderer = { setPixelRatio() {}, shadowMap: {} };
  renderer.atmosphere = { dimension: "overworld", sunlight: { shadow: {} } };
  renderer.localLights = [{}, {}];
  renderer.scene.fog = new THREE.Fog("#ffffff", 1, 10);
  renderer.resize = () => {};
  try {
    renderer.setQuality("low");
    renderer.rebuildDirty(Infinity);
    const shortFog = renderer.scene.fog.far;
    assert.equal(renderer.chunks.has("3,0"), false);
    assert.equal(renderer.localLights[0].visible, true);
    assert.equal(renderer.localLights[1].visible, false);
    assert.equal(renderer.renderer.shadowMap.enabled, false);
    renderer.setQuality("high");
    renderer.rebuildDirty(Infinity);
    assert.equal(renderer.chunks.has("3,0"), true);
    assert.ok(renderer.scene.fog.far > shortFog);
    assert.ok(renderer.localLights.every((light) => light.visible));
    assert.equal(renderer.renderer.shadowMap.enabled, true);
    renderer.setQuality("medium");
    assert.equal(renderer.renderer.shadowMap.enabled, false);
  } finally {
    disposeRenderer(renderer);
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("placed torches illuminate nearby cave geometry even in Performance quality", (t) => {
  for (const quality of ["low", "medium", "high"]) {
    const world = rendererLightWorld(t, [
      [3, 14, -3, BLOCK.TORCH],
      [4, 13, -3, BLOCK.STONE],
      [15, 13, -15, BLOCK.STONE],
    ], { x: 1, y: 14, z: -1 });
    const renderer = headlessRenderer(world);
    renderer.quality = quality;
    renderer.camera.position.set(1, 14, -1);
    renderer.localLights = [new THREE.PointLight(), new THREE.PointLight()];
    attachRendererLight(t, renderer);
    const receiver = { x: 4.5, y: 14.02, z: -2.5 };
    try {
      settleRendererLight(renderer);
      const lit = renderer.blockLight.sample(receiver);
      assert.equal(world.get(4, 13, -3), BLOCK.STONE);
      assert.equal(world.get(4, 14, -3), BLOCK.AIR);
      assert.ok(lit[0] > 0.7 && lit[1] > lit[2] && lit[2] > 0, `${quality}: warm torch illumination reaches adjacent stone`);
      assert.ok(lit[0] > lit[1], quality);
      assert.equal(renderer.blockLight.valid[renderer.blockLight.index(0, -1, 0)], 255, "receiver page is published, not merely queued");
      assert.deepEqual(renderer.blockLight.sample({ x: 15.5, y: 14.02, z: -14.5 }), [0, 0, 0], "loaded distant stone stays dark: light is local, not cave-wide");
      assert.equal(world.set(3, 14, -3, BLOCK.AIR), true);
      settleRendererLight(renderer);
      assert.deepEqual(renderer.blockLight.sample(receiver), [0, 0, 0], "removing a torch removes its field");
      assert.equal(world.set(3, 14, -3, BLOCK.TORCH), true);
      settleRendererLight(renderer);
      assert.deepEqual(renderer.blockLight.sample(receiver), lit, "placing a torch restores the same field");
      t.diagnostic(JSON.stringify({ quality, torchReceiver: receiver, lit, restored: renderer.blockLight.sample(receiver) }));
    } finally {
      disposeRenderer(renderer);
      for (const light of renderer.localLights) light.dispose();
    }
  }
});

test("mining progress highlights the actual target and clears safely", () => {
  const renderer = Object.create(GameRenderer.prototype);
  renderer.target = new THREE.Object3D();
  renderer.target.material = new THREE.LineBasicMaterial();
  renderer.miningOverlay = new THREE.Object3D();
  renderer.miningOverlay.material = new THREE.MeshBasicMaterial();
  renderer.miningTextures = createMiningTextures();
  renderer.setTarget({ x: -12, y: 80, z: 25 }, 0.5);
  assert.deepEqual(renderer.target.position.toArray(), [-11.5, 80.5, 25.5]);
  assert.ok(renderer.miningOverlay.position.equals(renderer.target.position));
  assert.equal(renderer.miningOverlay.visible, true);
  assert.ok(renderer.miningOverlay.material.opacity > 0);
  assert.equal(renderer.miningOverlay.material.map, renderer.miningTextures[5]);
  assert.equal(renderer.target.material.color.getHex(), 0);
  renderer.setTarget({ x: -12, y: 80, z: 25 }, 1);
  assert.equal(renderer.miningOverlay.material.map, renderer.miningTextures[9]);
  renderer.setTarget({ block: [1, 2, 3] }, NaN);
  assert.equal(renderer.miningOverlay.visible, false);
  assert.deepEqual(renderer.target.position.toArray(), [1.5, 2.5, 3.5]);
  renderer.setTarget(null, 1);
  assert.equal(renderer.target.visible, false);
  assert.equal(renderer.miningOverlay.visible, false);
  renderer.target.material.dispose();
  renderer.miningOverlay.material.dispose();
  for (const texture of renderer.miningTextures) texture.dispose();
});

test("an available distant horizon survives partial detail rows but not submersion", () => {
  let medium = 0;
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    quality: "medium",
    camera: new THREE.PerspectiveCamera(),
    scene: new THREE.Scene(),
    biome: { dimension: "overworld", category: "grassland" },
    world: { dimension: "overworld", get: () => medium },
    waterTime: { value: 0 },
    atmosphere: { update() {} },
    chunks: new Map(
      Array.from({ length: 48 }, (_, i) => [String(i), new THREE.Group()])
    ),
    syncVisibleChunks() {},
    updateShadows() {},
    updateLocalLights() {},
    streamingFogDistance: () => 45,
    distant: {
      ready: true,
      fogDistance: 160,
      group: new THREE.Group(),
      update() {
        this.group.visible = true;
      },
    },
  });
  renderer.scene.fog = new THREE.Fog("#fff", 10, 45);
  renderer.update(0, 1, renderer.camera.position);
  assert.equal(renderer.distant.group.visible, true);
  assert.equal(renderer.scene.fog.far, 160);
  renderer.chunks.set("last-corner", new THREE.Group());
  renderer.update(0, 1.1, renderer.camera.position);
  assert.equal(renderer.distant.group.visible, true);
  assert.ok(renderer.scene.fog.far > 45);
  renderer.chunks.delete("last-corner");
  renderer.update(0, 1.2, renderer.camera.position);
  assert.equal(renderer.distant.group.visible, true);
  assert.equal(renderer.scene.fog.far, 160);
  renderer.chunks.set("last-corner", new THREE.Group());
  medium = BLOCK.WATER;
  renderer.update(0, 1.3, renderer.camera.position);
  assert.equal(renderer.distant.group.visible, false);
  assert.ok(renderer.scene.fog.far <= 20);
});
