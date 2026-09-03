import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DistantTerrain } from "../src/distant-terrain.js";
import {
  GameRenderer,
  hasTerrainRoof,
  qualityFogDistance,
  terrainFogRange,
} from "../src/renderer.js";
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
} from "../src/terrain.js";
import {
  probeGroundColumn,
  sampleGroundCoverage,
} from "./realtime/ground-coverage.js";

const plains = {
  id: "plains",
  category: "grassland",
  dimension: "overworld",
  color: "#83ac52",
  grassColor: "#83ac52",
  waterColor: "#4e9cac",
};
const inside = (x, z) =>
  x >= WORLD_MIN && x < WORLD_MAX && z >= WORLD_MIN && z < WORLD_MAX;

// Real scene, camera, indexed meshes and renderer/LOD update methods; only the
// WebGL context and unrelated lighting work are omitted in these logic tests.
function fixture(quality = "medium") {
  const world = {
    seed: "streaming-coverage",
    dimension: "overworld",
    generatorVersion: 3,
    _epoch: 0,
    chunks: new Map(),
    dirtyChunks: new Set(),
    removedChunks: new Set(),
    generator: {
      terrainHeight: (x, z) => (inside(x, z) ? 31 : -1),
      getBiome: () => plains,
    },
    get: () => BLOCK.AIR,
    getBiome(x, z, y) {
      return this.generator.getBiome(x, z, y);
    },
  };
  const graphics = Object.create(GameRenderer.prototype);
  const material = new THREE.MeshBasicMaterial();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#fff", 10, 45);
  Object.assign(graphics, {
    world,
    scene,
    quality,
    biome: plains,
    dimension: world.dimension,
    chunkGenerator: world.generator,
    chunkEpoch: world._epoch,
    chunks: new Map(),
    viewCenter: null,
    camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 512),
    distant: new DistantTerrain(scene, world),
    waterTime: { value: 0 },
    renderer: { shadowMap: {} },
    localLights: [],
    materials: { water: material },
    atmosphere: {
      dimension: "overworld",
      sunlight: { shadow: {} },
      update() {},
      setBiome(biome) {
        this.dimension = biome.dimension;
        this.underground = biome.category === "cave";
      },
    },
    updateShadows() {},
    updateLocalLights() {},
    resize() {},
  });
  graphics.camera.position.set(8, 64, 8);
  graphics.camera.rotation.set(-1.1, -0.4, 0, "YXZ");
  let time = 0;
  const sample = {
    graphics,
    world,
    add(cx, cz, { empty = false, placeholder = false } = {}) {
      if (!inside(cx * CHUNK_SIZE, cz * CHUNK_SIZE)) return;
      const key = `${cx},${cz}`;
      graphics.removeChunk(key);
      const group = new THREE.Group();
      group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
      group.userData = { cx, cz, meshed: !placeholder, emitters: [] };
      if (!empty && !placeholder) {
        const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(CHUNK_SIZE / 2, 32, CHUNK_SIZE / 2);
        group.add(new THREE.Mesh(geometry, material));
      }
      graphics.chunks.set(key, group);
      world.chunks.set(key, { cx, cz });
      scene.add(group);
      return group;
    },
    fill() {
      const cx = Math.floor(graphics.camera.position.x / CHUNK_SIZE);
      const cz = Math.floor(graphics.camera.position.z / CHUNK_SIZE);
      for (
        let z = cz - graphics.renderRadius;
        z <= cz + graphics.renderRadius;
        z++
      )
        for (
          let x = cx - graphics.renderRadius;
          x <= cx + graphics.renderRadius;
          x++
        )
          if (!graphics.chunks.has(`${x},${z}`)) sample.add(x, z);
    },
    step() {
      graphics.update(0, (time += 0.05), graphics.camera.position);
      scene.updateMatrixWorld(true);
      graphics.camera.updateMatrixWorld(true);
    },
    warm() {
      for (let frame = 0; frame < 300; frame++) {
        sample.step();
        if (graphics.distant.ready && !graphics.distant._job) return;
      }
      assert.fail("bounded ground job did not publish");
    },
    dispose() {
      graphics.distant.dispose();
      for (const key of graphics.chunks.keys()) graphics.removeChunk(key);
      material.dispose();
    },
  };
  return sample;
}

function assertGround(sample) {
  const coverage = sampleGroundCoverage(sample);
  assert.ok(coverage.expected > 0);
  assert.equal(
    coverage.drawn,
    coverage.expected,
    "all expected ground has real indexed draw geometry"
  );
  assert.ok(
    coverage.inViewUnfogged > 0,
    "ground remains visible under Three's actual view-depth fog"
  );
  assert.equal(sample.graphics.distant.group.visible, true);
}

for (const quality of ["low", "medium", "high"]) {
  test(`${quality}: movement, missing/refilled rows and reversals keep drawn ground at normal and high altitude`, () => {
    const sample = fixture(quality);
    const { graphics } = sample;
    try {
      sample.fill();
      sample.warm();
      const ground = graphics.distant._active;
      const radius = graphics.renderRadius;
      for (const altitude of [64, 152]) {
        graphics.camera.position.set(8, altitude, 8);
        sample.step();
        assertGround(sample);
        const previousFog = graphics.scene.fog.far;
        for (let z = -radius; z <= radius; z++)
          graphics.removeChunk(`${radius},${z}`);
        sample.step();
        assertGround(sample);
        assert.ok(
          graphics.scene.fog.far >= previousFog - 0.00001,
          "a missing row does not retract fog"
        );
        const retained = graphics.chunks.get(`${-radius},0`);
        graphics.camera.position.x += CHUNK_SIZE;
        sample.step();
        assertGround(sample);
        assert.equal(graphics.chunks.get(`${-radius},0`), retained);
        assert.equal(
          retained.visible,
          false,
          "cached row costs no draws outside the detail radius"
        );
        graphics.camera.position.x -= CHUNK_SIZE;
        sample.step();
        assertGround(sample);
        assert.equal(graphics.chunks.get(`${-radius},0`), retained);
        assert.equal(
          retained.visible,
          true,
          "reversal reuses existing buffers immediately"
        );
        for (let z = -radius; z <= radius; z++) sample.add(radius, z);
        sample.step();
        assertGround(sample);
        assert.equal(
          graphics.distant._active,
          ground,
          "row ownership does not rebuild ground vertices"
        );
        assert.ok(graphics.chunks.size <= (2 * (radius + 1) + 1) ** 2);
      }
    } finally {
      sample.dispose();
    }
  });
}

test("coverage uses attached, visible draw geometry and distinguishes intentional empty chunks", () => {
  const sample = fixture();
  const { graphics } = sample;
  try {
    const group = sample.add(0, 0);
    sample.warm();
    const geometry = group.children[0].geometry;
    const at = () => probeGroundColumn(graphics, 8.31, 8.31, 32, "underfoot");
    assert.equal(at().source, "detail");
    geometry.setDrawRange(0, 0);
    sample.step();
    assert.equal(at().source, "distant");
    geometry.setDrawRange(0, Infinity);
    group.visible = false;
    sample.step();
    assert.equal(at().source, "distant");
    group.visible = true;
    group.children[0].visible = false;
    sample.step();
    assert.equal(at().source, "distant");
    graphics.scene.remove(group);
    assert.equal(graphics.detailCoverage().has("0,0"), false);
    sample.add(0, 0, { placeholder: true });
    sample.step();
    assert.equal(
      at().source,
      "distant",
      "a loaded/queued chunk is not mesh coverage"
    );
    sample.add(0, 0, { empty: true });
    sample.step();
    assert.equal(graphics.detailCoverage().has("0,0"), true);
    assert.equal(
      at().source,
      null,
      "LOD must not refill an authoritative edited-away chunk"
    );
  } finally {
    sample.dispose();
  }
});

test("quality changes reuse current fallback while a different detail radius fills", () => {
  const sample = fixture("low");
  const { graphics } = sample;
  try {
    sample.fill();
    sample.warm();
    const old = graphics.distant._active;
    graphics.setQuality("high");
    sample.step();
    assert.equal(graphics.distant._active, old);
    assertGround(sample);
    assert.ok(
      graphics.detailCoverage().size < (graphics.renderRadius * 2 + 1) ** 2
    );
    graphics.setQuality("medium");
    sample.warm();
    assertGround(sample);
    assert.equal(graphics.distant._active.data.request.quality, "medium");
    graphics.setQuality("low");
    sample.warm();
    assertGround(sample);
    assert.ok(
      graphics.chunks.size <= (2 * (graphics.renderRadius + 1) + 1) ** 2
    );
  } finally {
    sample.dispose();
  }
});

test("high ground covers the partially fogged horizon before its low canopy upgrades", (t) => {
  t.mock.method(performance, "now", () => 0);
  const sample = fixture("low");
  const { graphics, world } = sample;
  const { camera, distant } = graphics;
  try {
    // Replay the camera and north-horizon column from native failure frame 42.
    // Keep the measured local/far ground heights without generating full chunks.
    world.generator.terrainHeight = (_x, z) => (z < 320 ? 60 : 59);
    world.generator.getTrees = () => [];
    // The recorded native flight holds Shift: Player widens its 75° base FOV
    // by 5°. At the non-sprinting FOV this horizon point is just off screen.
    camera.fov = 80;
    camera.updateProjectionMatrix();
    camera.position.set(
      307.51991868577437,
      105.76773460107628,
      447.2776347113601
    );
    camera.rotation.set(-0.9934199999999969, -0.884, 0, "YXZ");
    sample.fill();
    for (const group of graphics.chunks.values())
      group.children[0].geometry.translate(0, 28, 0);
    sample.warm();
    const lowCanopy = distant._vegetation;
    assert.equal(lowCanopy.request.quality, "low");
    assert.equal(lowCanopy.bounds.minZ, 240);

    graphics.setQuality("high");
    camera.position.set(
      307.51991868577437,
      105.76773460107628,
      452.6559851072913
    );
    sample.warm();
    const ground = distant._active;
    assert.equal(ground.data.request.key, "19,28:4:high");
    assert.equal(distant._vegetation, lowCanopy);
    assert.equal(distant._vegetationJob.request.quality, "high");
    assert.equal(distant._vegetationJob.job.done, false);

    camera.position.set(
      323.0407208858717,
      105.76773460107628,
      447.2776347113601
    );
    sample.step();
    const horizon = () =>
      probeGroundColumn(
        graphics,
        323.0407208858716,
        239.27763471136012,
        61,
        "horizon"
      );
    const point = horizon();
    assert.ok(point.z < lowCanopy.bounds.minZ);
    assert.ok(point.z > ground.data.bounds.minZ);
    assert.equal(point.inView, true);
    assert.equal(point.horizontalDistance, 208);
    assert.equal(point.fogByHorizontalDistance, 1);
    assert.ok(point.fogByViewDepth > 0 && point.fogByViewDepth < 1);
    assert.ok(Math.abs(point.viewDepth - 109.49729873059492) < 0.00001);
    assert.equal(point.source, "distant");
    assert.ok(Math.abs(point.renderedHeight - 61) < 0.00001);
    assert.equal(distant.fogDistance, 160, "the canopy still limits fog");
    assert.equal(graphics.renderRadius, 4, "no larger detail radius");
    assertGround(sample);

    const near = () =>
      probeGroundColumn(graphics, 312.31, 440.31, 60, "requested-detail");
    assert.equal(near().source, "detail");
    graphics.removeChunk("19,27");
    sample.step();
    assert.equal(near().source, "distant", "missing detail refills at once");
    assert.equal(horizon().source, "distant");
    sample.add(19, 27).children[0].geometry.translate(0, 28, 0);
    sample.step();
    assert.equal(near().source, "detail", "drawn detail takes ownership back");
    assert.equal(distant._vegetation, lowCanopy);
    assertGround(sample);

    const indexVersion = ground.terrain.geometry.index.version;
    for (
      let frame = 0;
      frame < 300 && distant._vegetation === lowCanopy;
      frame++
    )
      sample.step();
    assert.notEqual(distant._vegetation, lowCanopy);
    assert.equal(distant._vegetation.request.quality, "high");
    assert.equal(distant._active, ground);
    assert.equal(ground.terrain.geometry.index.version, indexVersion);
    assert.equal(horizon().source, "distant");
    assertGround(sample);
  } finally {
    sample.dispose();
  }
});

test("teleports and both true world edges do not retain a false center hole or out-of-bounds fog blockers", () => {
  const sample = fixture("high");
  const { graphics } = sample;
  try {
    sample.fill();
    sample.warm();
    const original = graphics.distant._active;
    for (const [x, z] of [
      [12008, -17000],
      [WORLD_MIN + 0.25, WORLD_MAX - 0.25],
      [WORLD_MAX - 0.25, WORLD_MIN + 0.25],
    ]) {
      graphics.camera.position.set(x, 152, z);
      sample.step();
      assert.equal(
        graphics.distant.ready,
        false,
        "the old viewport is hidden on an actual teleport"
      );
      sample.fill();
      assert.equal(
        graphics.streamingFogDistance(graphics.camera.position),
        qualityFogDistance(graphics.renderRadius)
      );
      sample.warm();
      assertGround(sample);
      assert.notEqual(graphics.distant._active, original);
      const points =
        graphics.distant._active.terrain.geometry.getAttribute("position");
      for (let i = 0; i < points.count; i++) {
        assert.ok(
          Math.abs(points.getX(i)) < 512 && Math.abs(points.getZ(i)) < 512
        );
      }
    }
  } finally {
    sample.dispose();
  }
});

test("dimension transitions clear stale views and retain genuine End void instead of inventing terrain", () => {
  const sample = fixture();
  const { graphics, world } = sample;
  try {
    sample.fill();
    sample.warm();
    const generator = world.generator;
    const old = graphics.distant._active;
    world.dimension = "nether";
    world._epoch++;
    graphics.biome = { dimension: "nether", category: "nether" };
    sample.step();
    assert.equal(graphics.chunks.size, 0);
    assert.equal(graphics.distant.ready, false);
    assert.equal(old.group.parent, null);
    world.dimension = "end";
    world._epoch++;
    graphics.biome = { dimension: "end", category: "void" };
    world.generator = {
      terrainHeight: () => -1,
      getBiome: () => graphics.biome,
    };
    sample.warm();
    assert.equal(graphics.distant._active.terrain.geometry.drawRange.count, 0);
    assert.equal(graphics.distant._active.water, null);
    assert.equal(sampleGroundCoverage(sample).expected, 0);
    world.dimension = "overworld";
    world._epoch++;
    world.generator = generator;
    graphics.biome = plains;
    sample.warm();
    assertGround(sample);
  } finally {
    sample.dispose();
  }
});

test("high-flight fog projects horizontal coverage into view depth, with a nonzero vertical-look fade", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(8, 152, 8);
  for (const pitch of [-0.2, -1.1, -Math.PI / 2]) {
    camera.rotation.set(pitch, -0.4, 0, "YXZ");
    const fog = terrainFogRange(camera, 32, 40, 256);
    const underfoot = new THREE.Vector3(8, 32, 8).applyMatrix4(
      camera.matrixWorldInverse
    );
    assert.ok(-underfoot.z <= fog.near + 0.00001);
    assert.ok(fog.far > fog.near);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const horizontal = Math.hypot(forward.x, forward.z);
    if (horizontal > 0.1) {
      const edge = new THREE.Vector3(
        8 + (forward.x / horizontal) * 256,
        32,
        8 + (forward.z / horizontal) * 256
      ).applyMatrix4(camera.matrixWorldInverse);
      assert.ok(
        Math.abs(-edge.z - fog.far) < 0.00001,
        "fog endpoint uses shader depth, not Euclidean range"
      );
    }
  }
});

test("fog above a carved ravine uses the visible floor rather than the generator's removed roof", () => {
  const sample = fixture("low");
  const { graphics, world } = sample;
  try {
    world.generator.terrainHeight = () => 104;
    world.heightAt = () => 31;
    graphics.camera.position.y = 152;
    graphics.camera.rotation.x = -1.35;
    sample.fill();
    sample.warm();
    const ground = probeGroundColumn(graphics, 8, 8, 32, "underfoot");
    assert.equal(ground.source, "detail");
    assert.equal(ground.renderedHeight, 32);
    assert.equal(ground.fogByViewDepth, 0);
  } finally {
    sample.dispose();
  }
});

test("open cave entrances retain the outdoor atmosphere, while a real roof and fluid fog still win", () => {
  const sample = fixture();
  const { graphics, world } = sample;
  try {
    sample.add(0, 0);
    const cave = { ...plains, id: "lush_caves", category: "cave" };
    graphics.camera.position.y = 48;
    assert.equal(hasTerrainRoof(world, graphics.camera.position), false);
    graphics.setBiome(cave);
    assert.equal(graphics.biome, plains);
    sample.warm();
    assertGround(sample);
    world.get = (_x, y) => (y === 70 ? BLOCK.STONE : BLOCK.AIR);
    assert.equal(hasTerrainRoof(world, graphics.camera.position), true);
    graphics.setBiome(cave);
    sample.step();
    assert.equal(graphics.atmosphere.underground, true);
    assert.equal(graphics.distant.ready, false);
    world.get = () => BLOCK.AIR;
    graphics.setBiome(cave);
    sample.warm();
    assertGround(sample);
    for (const fluid of [BLOCK.WATER, BLOCK.LAVA]) {
      world.get = () => fluid;
      sample.step();
      assert.equal(graphics.distant.group.visible, false);
      assert.ok(graphics.scene.fog.far <= (fluid === BLOCK.WATER ? 20 : 4));
    }
    graphics.camera.position.y = WORLD_HEIGHT + 1;
    assert.equal(hasTerrainRoof(world, graphics.camera.position), false);
  } finally {
    sample.dispose();
  }
});
