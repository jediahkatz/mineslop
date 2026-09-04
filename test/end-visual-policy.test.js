import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DistantTerrain } from "../src/distant-terrain.js";
import { DISTANT_GRID_LIMITS, DISTANT_QUALITY } from "../src/distant-grid.js";
import { END_VISUAL_HORIZON, endVisualFog, visualHorizon } from "../src/end-visual-policy.js";
import { geometryWorldSpec } from "../src/geometry-world.js";
import { qualityFogDistance, terrainFogRange } from "../src/renderer.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { expectedPillarBoxes, fogTransmission } from "./distant-native-coverage.mjs";

function fogAt(camera, world, quality, overrides = {}) {
  const detailFar = qualityFogDistance({ low: 2, medium: 3, high: 4 }[quality]);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const top = world.generator.terrainHeight(camera.position.x, camera.position.z);
  const spec = geometryWorldSpec(world);
  return endVisualFog({
    dimension: "end", outdoors: true, horizonVisible: true,
    terrainComplete: true,
    availableDistance: END_VISUAL_HORIZON, horizontalFar: END_VISUAL_HORIZON,
    detailFar, eyeY: camera.position.y, minY: spec.minY, forward,
    base: terrainFogRange(camera, top >= spec.minY ? top + 1 : undefined,
      detailFar * 0.9, END_VISUAL_HORIZON),
    ...overrides,
  });
}

test("fixed End window has high's existing bounds at every quality, position and version", () => {
  assert.equal(GENERATOR_VERSION, 3);
  const lod = Object.create(DistantTerrain.prototype);
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    lod.world = { generatorVersion: version };
    for (const coordinate of [-4000, -340, -321, -320, -319, -0.1, 0, 319, 320, 321, 340, 4000]) {
      const position = { x: coordinate, z: -coordinate };
      const high = lod._request(position, 4, "high", "end", new Set());
      for (const quality of ["low", "medium", "high"]) {
        const request = lod._request(position, 2, quality, "end", new Set());
        assert.equal(request.horizon, 448);
        assert.deepEqual(request.bounds, high.bounds);
        assert.ok(request.bounds.maxX - request.bounds.minX <= DISTANT_GRID_LIMITS.chunkSpan * 16);
        assert.equal(visualHorizon("overworld", quality), DISTANT_QUALITY[quality].horizon);
        assert.equal(visualHorizon("nether", quality), DISTANT_QUALITY[quality].horizon);
      }
    }
  }
});

test("missing coverage, dormant LOD, caves, other dimensions retain exact existing fog", () => {
  const world = { generator: createGenerator("cedar-valley", "end", 7), dimension: "end" };
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
  camera.position.set(0, 165, 321); camera.lookAt(0, 85, 0);
  const base = { near: 1.2, far: 2 };
  for (const overrides of [
    { horizonVisible: false }, // includes underwater/lava/unknown camera medium
    { outdoors: false }, { dimension: "overworld" }, { dimension: "nether" },
    ...[0, 2, 32, 160, 320, 447.999, 448].map(availableDistance =>
      ({ availableDistance, terrainComplete: false })),
  ])
    assert.equal(fogAt(camera, world, "low", { base, ...overrides }), base);
  for (const quality of ["low", "medium", "high"]) {
    const detailFar = qualityFogDistance({ low: 2, medium: 3, high: 4 }[quality]);
    assert.deepEqual(fogAt(camera, world, quality, { base, horizontalFar: detailFar }), base);
    let prior = base;
    for (let distance = detailFar; distance <= 448; distance++) {
      const current = fogAt(camera, world, quality, { base, horizontalFar: distance });
      assert.ok(current.near >= prior.near && current.far >= prior.far);
      assert.ok(current.far - prior.far < 3);
      assert.ok(current.near < current.far);
      prior = current;
    }
    // A stale-but-complete mesh may approach its outer edge while replacement
    // work is stalled. Its available radius is not a boolean policy switch.
    prior = null;
    for (let distance = 448; distance >= 400; distance -= 0.25) {
      const current = fogAt(camera, world, quality,
        { horizontalFar: distance, availableDistance: distance });
      if (prior) {
        assert.ok(Math.abs(current.near - prior.near) < 1);
        assert.ok(Math.abs(current.far - prior.far) < 1);
      }
      prior = current;
    }
  }
});

for (const version of [1, 2, 3, 7]) for (const seed of ["cedar-valley", "mineslop-audit-2", ""]) {
  test(`v${version} ${JSON.stringify(seed)}: native cardinal approach/return fog and real camera depth`, (t) => {
    const generator = createGenerator(seed, "end", version);
    generator.generateChunk = generator.generateRegion = () => assert.fail("policy cannot load chunks");
    const world = { generator, dimension: "end", generatorVersion: version, spec: generator.spec };
    const boxes = expectedPillarBoxes(world);
    assert.equal(generator.getEndPillars().length, 10);
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 768);
    let minimum = 1, probes = 0, maxStep = 0;
    for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      let prior = null;
      const outward = Array.from({ length: 297 }, (_, i) => 64 + i);
      for (const radius of [...outward, ...outward.toReversed()]) {
        camera.position.set(dx * radius, version === 7 ? 165 : 105, dz * radius);
        camera.lookAt(0, version === 7 ? 85 : 40, 0);
        camera.updateMatrixWorld(true);
        const range = fogAt(camera, world, "low");
        for (const quality of ["medium", "high"])
          assert.deepEqual(fogAt(camera, world, quality), range);
        if (prior) {
          const delta = Math.max(Math.abs(range.near - prior.near), Math.abs(range.far - prior.far));
          maxStep = Math.max(maxStep, delta);
          assert.ok(delta < 4, `fog discontinuity at ${radius}`);
        }
        prior = range;
        // The requested overview/approach band; closer bodies may be outside
        // the camera frustum or behind the observer, not "missing" landmarks.
        if (radius < 260 || radius > 340) continue;
        const fog = new THREE.Fog("#222233", range.near, range.far);
        for (const { box } of boxes) for (const y of [box.min.y + 0.5, box.max.y - 0.5]) {
          const point = box.getCenter(new THREE.Vector3()); point.y = y;
          const projected = point.clone().project(camera);
          if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || projected.z <= -1) continue;
          const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
          const forward = camera.getWorldDirection(new THREE.Vector3());
          const referenceDepth = Math.max(8, 448 * Math.hypot(forward.x, forward.z)) +
            (camera.position.y - geometryWorldSpec(world).minY) * Math.max(0, -forward.y);
          assert.ok(Math.abs(range.far - referenceDepth) < 1e-9, "fog matches projected covered floor plane");
          assert.ok(depth < range.far, "native body/cap lies before fog end");
          const transmission = fogTransmission(camera, fog, point);
          minimum = Math.min(minimum, transmission); probes++;
          assert.ok(transmission >= 0.15,
            `native readability ${transmission} at (${camera.position.x},${camera.position.z})`);
        }
      }
    }
    t.diagnostic(JSON.stringify({ version, seed, probes, minimumTransmission: minimum, maxStep }));
  });
}

test("versions4–6 keep their native empty landmark declarations", () => {
  for (const version of [4, 5, 6])
    assert.equal(createGenerator("cedar-valley", "end", version).getEndPillars?.().length ?? 0, 0);
});
